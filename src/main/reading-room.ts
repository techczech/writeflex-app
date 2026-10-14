import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, extname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  SidecarStore,
  type OutboxEntry,
  type ReadingRoomDocument,
  type RecentDocument,
} from '@readflex/sidecar'
import { createNodeSqliteDriver } from '@readflex/sqlite-driver/node'
import {
  buildShelfIndex,
  openZoteroAnnotationWriteSession,
  readAnnotations,
  type ShelfIndex,
  type ShelfIndexOptions,
  type ShelfItem,
} from '@readflex/zotero-bridge'
import { discoverZoteroDataDirectory } from '@readflex/zotero-paths'
import {
  readingRoomDocumentFor,
  SHELF_ROW_LIMIT,
  shelfAuthorYear,
  shelfRow,
  type ShelfSearchResult,
} from './reading-room-shelf'
import { createReadingRoomBookmarks, type ReadingBookmarkRow } from './reading-room-bookmarks'
import {
  highlightsResult,
  mergeWithOutbox,
  withKeptEdits,
  type HighlightsResult,
} from './reading-room-highlights'
import {
  dismissRefused,
  keptEditKeys,
  reconcileKeptEdits,
  refusedHighlights,
  retryRefused,
  type RefusedHighlight,
} from './reading-room-refused'
import {
  annotationLink,
  itemSelectLink,
  pageLink,
  readLibrarySegments,
  type LibrarySegments,
} from './zotero-links'
import {
  annotationPayload,
  areaQuotationPayload,
  annotationPositionWithinCap,
  annotationTextWithinCap,
  citationAnnotation,
  drainOutboxToZotero,
  e2eZoteroLivenessProbes,
  findExactCitationAnnotation,
  isPdfCitationPosition,
  LOCAL_ONLY_COMPLEX_PDF_REASON,
  LOCAL_ONLY_NON_PDF_REASON,
  quotationComment,
  UNSUPPORTED_ZOTERO_EDIT_REASON,
  type CitationSelectionAnnotation,
  type DrainSkipReason,
  type SavedAnnotation,
} from './zotero-annotation-writes'
import { createZoteroLibraryAccess, type ZoteroLibraryAccess } from './zotero-library-access'

export type ReadingRoomViewState = Record<string, unknown>

export type ReadingRoomState = {
  citationBaseLink: string
  document: ReadingRoomDocument | null
  readerHtml: string
  roomWidth: number
  viewState: ReadingRoomViewState | null
}

const DEFAULT_ROOM_WIDTH = 448
const MIN_ROOM_WIDTH = 280

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

const OUTBOX_STATUSES = ['pending', 'retrying', 'confirmed', 'failed', 'conflict'] as const

function allOutboxEntries(store: SidecarStore): OutboxEntry[] {
  return OUTBOX_STATUSES
    .flatMap((status) => store.outboxByStatus(status))
    .sort((left, right) => left.id - right.id)
}

export type ReadingRoomOutboxCounts = {
  waiting: number
  rejected: number
}

/** Sync signals only. The painted union continues to read `outboxUnconfirmed` independently. */
function zoteroOutboxCounts(store: SidecarStore): ReadingRoomOutboxCounts {
  return {
    waiting: store.countOutboxWaiting(),
    rejected: store.countOutboxRejected(),
  }
}

function citationSelection(value: unknown): CitationSelectionAnnotation | null {
  if (
    !isRecord(value)
    || value.type !== 'highlight'
    || typeof value.position !== 'string'
    || typeof value.sortIndex !== 'string'
    || !value.sortIndex
  ) {
    return null
  }
  return {
    color: typeof value.color === 'string' ? value.color : null,
    pageLabel: typeof value.pageLabel === 'string' ? value.pageLabel : null,
    position: value.position,
    sortIndex: value.sortIndex,
    text: typeof value.text === 'string' ? value.text : null,
    type: 'highlight',
  }
}

function annotationFromOutbox(entry: OutboxEntry): SavedAnnotation | null {
  if (!entry.itemKey) return null
  try {
    const payload = JSON.parse(entry.payload) as ReturnType<typeof annotationPayload>
    if (
      payload.annotationType !== 'highlight'
      || typeof payload.annotationSortIndex !== 'string'
      || !payload.annotationSortIndex
    ) {
      return null
    }
    return {
      color: payload.annotationColor || null,
      comment: payload.annotationComment || null,
      key: entry.itemKey,
      pageLabel: payload.annotationPageLabel || null,
      position: JSON.stringify(payload.annotationPosition),
      sortIndex: payload.annotationSortIndex,
      tags: (payload.tags ?? [])
        .map((tag) => tag.tag)
        .filter((tag): tag is string => typeof tag === 'string'),
      text: payload.annotationText || null,
      type: 'highlight',
    }
  } catch {
    return null
  }
}

/**
 * There is no maximum (ADR-0033). A cap here would overrule the person about their own screen, and
 * the only real constraint — the draft staying usable — is a fact about the live window, which the
 * main process cannot see. The renderer clamps the stored width down to what the current window can
 * honour when it reads it, so a width dragged wide on a large display degrades on a laptop.
 */
function clampRoomWidth(width: number): number {
  return Math.max(MIN_ROOM_WIDTH, Math.round(width))
}

function readerBundleDirectory(entryFile: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'readflex-reader')
    : join(dirname(entryFile), '..', '..', 'node_modules', '@readflex', 'reader-embed', 'vendor')
}

function hostReaderHtml(source: string, bundleDirectory: string): string {
  const hostCss = `
    <base href="${pathToFileURL(`${join(bundleDirectory, 'reader')}${sep}`).href}">
    <style>
      :root {
        color-scheme: light !important;
        --sidebar-width: 0px !important;
        --bottom-placeholder-height: 0px !important;
      }
      body { background: #ffffff !important; }
      /* #reader-ui is not the reader's chrome — it is the reader's WHOLE React root, and the
         selection and annotation popups mount inside it. Hiding it hid the only way to make a
         highlight (usability review on 0.15.1: "no highlighting ui, I select and nothing happens"), so the
         root stays displayed and each piece of furniture the Room supplies itself is named and
         hidden here instead. Read-aloud has no UI in 0.12 (ADR-0024). */
      #reader-ui .toolbar,
      #reader-ui #sidebarContainer,
      #reader-ui .sidebar-resizer,
      #reader-ui .split-view-resizer,
      .read-aloud-annotation-popup { display: none !important; }
      /* Two elements match: the real #split-view holding the document iframes, and a second
         .split-view inside #reader-ui that carries the popups. The reader offsets both by its
         toolbar height, so with the toolbar hidden both must start at the top or every popup
         lands 41px below the text it belongs to. */
      #split-view, .split-view {
        inset-inline-start: 0 !important;
        top: 0 !important;
        bottom: 0 !important;
      }
    </style>`
  return source.replace('<head>', `<head>${hostCss}`)
}

function e2eDocument(): ReadingRoomDocument | null {
  if (process.env.WRITEFLEX_E2E !== '1') return null
  const path = process.env.WRITEFLEX_E2E_READING_DOCUMENT?.trim()
  if (!path || !existsSync(path)) return null
  const extension = extname(path).toLocaleLowerCase('en')
  return {
    attachmentKey: 'WRITEFLEXE2E',
    authorYear: 'Lakoff · 1987',
    itemKey: 'WRITEFLEXE2E',
    kind: extension === '.pdf' ? 'pdf' : 'snapshot',
    libraryId: 0,
    path,
    shortTitle: 'Women, Fire…',
  }
}

/**
 * A fixture library for the Shelf's own e2e coverage. It replaces the SOURCE the Shelf indexes, never
 * the path a person takes to open a document — the Shelf is reached, searched and opened through the
 * same IPC either way, which is the blindfold ADR-0025 names.
 */
function shelfIndexOptions(): ShelfIndexOptions {
  if (process.env.WRITEFLEX_E2E !== '1') return {}
  const directory = process.env.WRITEFLEX_E2E_ZOTERO_DIRECTORY?.trim()
  if (!directory) return {}
  return {
    betterBibtexDatabasePath: join(directory, 'better-bibtex.sqlite'),
    linkedAttachmentBaseDirectory: join(directory, 'linked'),
    storageDirectory: join(directory, 'storage'),
    zoteroDatabasePath: join(directory, 'zotero.sqlite'),
  }
}

/** Where `zotero.sqlite` is: the e2e fixture when one is set, otherwise Zotero's own preference
 *  (never a hardcoded ~/Zotero guess — ADR-0012 §2). */
export function zoteroDatabasePath(): string {
  const override = shelfIndexOptions().zoteroDatabasePath
  return override ?? join(discoverZoteroDataDirectory().path, 'zotero.sqlite')
}

type ShelfState = {
  index: ShelfIndex | null
  /** libraryId → the `zotero://` URL segment, so a group item's link is not silently wrong. */
  librarySegments: LibrarySegments
  items: ShelfItem[]
  byKey: Map<string, ShelfItem>
  error: string | null
  /** `zotero.sqlite`'s modification time when this index was built; the staleness signal. */
  builtFrom: number | null
}

/** The `zotero.sqlite` mtime, or null when it cannot be read. Never opens the file. */
function libraryModifiedAt(databasePath: string | undefined): number | null {
  try {
    return databasePath ? statSync(databasePath).mtimeMs : null
  } catch {
    return null
  }
}

/**
 * The in-memory Shelf index. Built once, on the first
 * Shelf request rather than at startup, so a launch that never opens the Room pays nothing and a
 * machine with no Zotero degrades to a message instead of a failed boot (ADR-0010).
 *
 * `refresh` rebuilds it when Zotero's database has changed on disk since the build — called only for
 * an empty query, which is the state the Shelf is raised in, so a session that adds a paper in Zotero
 * finds it without relaunching and no keystroke ever pays for a rebuild.
 */
function createShelfLoader(
  access: ZoteroLibraryAccess,
): { load: () => Promise<ShelfState>; refresh: () => void } {
  let pending: Promise<ShelfState> | null = null
  let current: ShelfState | null = null
  const load = (): Promise<ShelfState> => {
    pending ??= (async () => {
      // Off the current tick, so the handler's reply path is not the thing holding the build.
      await new Promise((resolve) => setImmediate(resolve))
      const options = shelfIndexOptions()
      try {
        // The Shelf build and the library-segment read are one read of `zotero.sqlite`, taken through
        // the gate so neither can be in flight while the drain probes the lock (ADR-0031).
        current = await access.read(() => {
          const index = buildShelfIndex(createNodeSqliteDriver(), options)
          const items = index.list()
          const databasePath = options.zoteroDatabasePath
            ?? join(index.zoteroDataDirectory.path, 'zotero.sqlite')
          const librarySegments = readLibrarySegments(createNodeSqliteDriver(), databasePath)
          return {
            builtFrom: libraryModifiedAt(databasePath),
            byKey: new Map(items.map((item) => [`${item.libraryId}:${item.itemKey}`, item])),
            error: null,
            index,
            items,
            librarySegments,
          } satisfies ShelfState
        })
      } catch (error) {
        current = {
          builtFrom: null,
          byKey: new Map<string, ShelfItem>(),
          librarySegments: new Map(),
          error: `The Shelf could not read your Zotero library. ${
            error instanceof Error ? error.message : String(error)
          }`,
          index: null,
          items: [],
        }
      }
      return current
    })()
    return pending
  }
  return {
    load,
    refresh() {
      if (!current?.index || current.builtFrom === null) return
      const path = shelfIndexOptions().zoteroDatabasePath
        ?? join(current.index.zoteroDataDirectory.path, 'zotero.sqlite')
      const modifiedAt = libraryModifiedAt(path)
      if (modifiedAt !== null && modifiedAt !== current.builtFrom) {
        current = null
        pending = null
      }
    },
  }
}

export async function registerReadingRoom(
  entryFile = fileURLToPath(import.meta.url),
): Promise<{ close(): void }> {
  const installedBundleDirectory = readerBundleDirectory(entryFile)
  const readerHtmlPath = join(installedBundleDirectory, 'reader', 'reader.html')
  // Bun's development install represents package files as symlinks. Resolve the known reader
  // entry first, then contain every custom-scheme request within that same physical vendor tree.
  // A packaged build contains ordinary copied files, so both paths collapse to the same directory.
  const bundleDirectory = dirname(dirname(await realpath(readerHtmlPath)))
  const readerHtml = hostReaderHtml(await readFile(readerHtmlPath, 'utf8'), bundleDirectory)
  const store = new SidecarStore(
    createNodeSqliteDriver(),
    join(app.getPath('userData'), 'reading-room', 'sidecar.sqlite'),
  )
  // Edits that older releases left counted as "refused" are reclassified before anything reads a
  // count. Idempotent, and a failure here must not stop the Room from opening: the worst case is the
  // old count, which is wrong but loses nothing.
  try {
    reconcileKeptEdits(store)
  } catch {
    // Left for the next launch.
  }
  const areaQuotationReceipts = new Map<string, {
    annotationKey: string
    attachmentKey: string
    draftPath: string
    expiresAt: number
    libraryId: number
  }>()
  /**
   * The draft the Room is currently open beside — the absolute path of its Markdown file, and the
   * scope of "which paper is open" (ReadFlex ADR-0032, decision 1). The renderer sets it through
   * `get-state` and `open-shelf-item`, which are the two calls that already carry a document
   * decision; every other handler reads whatever it names, so a draft switch moves them all together.
   *
   * Null means no draft is on screen (the Board tab, or an empty window). A paper opened then is held
   * in memory for the session only: nothing is persisted, because there is no scope to persist it in,
   * and inventing a global one is the bug being fixed.
   */
  let activeDraftPath: string | null = null
  let unboundDocument: ReadingRoomDocument | null = null
  /** The e2e fixture stands in for a paper any draft has yet to choose — never for the draft key
   *  itself, so the Shelf and the per-draft memory are still driven through the real IPC. */
  const seededDocument = e2eDocument()

  function currentDocument(): ReadingRoomDocument | null {
    const remembered = activeDraftPath
      ? store.getDraftDocument(activeDraftPath)
      : unboundDocument
    return remembered ?? seededDocument ?? null
  }

  const bookmarks = createReadingRoomBookmarks({ currentDocument, store })

  /** Remember a paper for the draft in hand, and record it in the global recents history. */
  function rememberDocument(document: ReadingRoomDocument): void {
    if (activeDraftPath) store.saveDraftDocument(activeDraftPath, document)
    else unboundDocument = document
    store.recordRecentDocument(document)
  }

  /** A draft path off the renderer: a non-empty string, or null for "no draft on screen". */
  function draftPathFrom(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null
  }

  /**
   * A write session on Zotero's own database (ADR-0031), opened per drain rather than held: the
   * liveness and schema checks have to be re-read each time because Zotero can be launched between
   * one highlight and the next, and a session held open would be the thing stopping him launching it.
   *
   * The pre-write copy lands in WriteFlex's own `userData`, which `assertNotInZoteroDataDirectory`
   * checks with no exception — only the write TARGET has one.
   *
   * The liveness probes are injected rather than left to their defaults, because the defaults ask the
   * machine and a test must be answered by its fixture (ADR-0031, correction). Outside the e2e
   * harness `e2eZoteroLivenessProbes` returns nothing and the machine is consulted, unchanged.
   */
  const zoteroWriteSession = () => {
    const liveness = e2eZoteroLivenessProbes()
    return openZoteroAnnotationWriteSession(createNodeSqliteDriver(), {
      backupDirectory: join(app.getPath('userData'), 'reading-room', 'zotero-backups'),
      databasePath: zoteroDatabasePath(),
      ...(liveness ? { liveness } : {}),
    })
  }

  /**
   * Single-writer discipline over Zotero's database inside this process (ADR-0031, second door). The
   * drain is exclusive against our own reads so that the exclusive-lock probe is never answering our
   * own contention; reads stay concurrent with each other, so the Shelf never waits behind painting.
   *
   * It lives here, and not in `@readflex/zotero-bridge`, because the bridge's read and write APIs are
   * synchronous — an async gate cannot be threaded through them — and this is the one place with async
   * control over both the reads and the drain.
   */
  const zoteroLibrary = createZoteroLibraryAccess()

  const shelf = createShelfLoader(zoteroLibrary)
  const citationBaseLinks = new Map<string, string>()

  function citationBaseLinkKey(document: ReadingRoomDocument): string {
    return `${document.libraryId}:${document.attachmentKey}`
  }

  /** Resolve a document's base link once. Reopening its draft reuses memory and never reopens Zotero. */
  async function citationBaseLinkFor(
    document: ReadingRoomDocument,
    knownSegments?: LibrarySegments,
  ): Promise<string> {
    const key = citationBaseLinkKey(document)
    const cached = citationBaseLinks.get(key)
    if (cached !== undefined) return cached
    let librarySegments = knownSegments
    if (!librarySegments) {
      try {
        librarySegments = await zoteroLibrary.read(() =>
          readLibrarySegments(createNodeSqliteDriver(), zoteroDatabasePath()))
      } catch {
        librarySegments = new Map()
      }
    }
    const link = pageLink(
      librarySegments,
      document.libraryId,
      document.attachmentKey,
      null,
    )
    citationBaseLinks.set(key, link)
    return link
  }

  /** The one state shape the Room begins a document from — restored on launch and returned by an
   *  open from the Shelf, so both drive the identical renderer path. */
  async function readingRoomState(
    knownSegments?: LibrarySegments,
  ): Promise<ReadingRoomState> {
    const remembered = currentDocument()
    // A remembered paper whose file has since gone (moved out of Zotero storage, or a library
    // relocated) falls back to the Shelf. Nothing is honest to show, and the Shelf is the entry state.
    const document = remembered && existsSync(remembered.path) ? remembered : null
    const storedPosition = document
      ? store.getPosition(document.libraryId, document.attachmentKey)?.position
      : null
    let viewState: ReadingRoomViewState | null = null
    if (storedPosition) {
      try {
        const parsed = JSON.parse(storedPosition) as unknown
        if (isRecord(parsed)) viewState = parsed
      } catch {
        viewState = null
      }
    }
    const roomWidth = clampRoomWidth(store.getLayout()?.roomWidth ?? DEFAULT_ROOM_WIDTH)
    if (!document) {
      return {
        citationBaseLink: '',
        document: null,
        readerHtml,
        roomWidth,
        viewState,
      } satisfies ReadingRoomState
    }
    return {
      citationBaseLink: await citationBaseLinkFor(document, knownSegments),
      document,
      readerHtml,
      roomWidth,
      viewState,
    } satisfies ReadingRoomState
  }

  /**
   * The Room's state for one draft. The argument is the draft the Room is beside, and passing it is
   * how the Room is TOLD which draft it is beside — the renderer calls this again on every draft
   * switch, which is what makes "switch essay, switch reading" one code path with the launch restore.
   */
  ipcMain.handle('reading-room:get-state', async (_event, rawDraftPath: unknown) => {
    activeDraftPath = draftPathFrom(rawDraftPath)
    return await readingRoomState()
  })

  /** Papers opened recently, newest first — global and persistent (ReadFlex ADR-0032, decision 3). */
  ipcMain.handle('reading-room:recent-documents', (): RecentDocument[] =>
    store.listRecentDocuments(12))

  ipcMain.handle('reading-room:search-shelf', async (_event, rawQuery: unknown): Promise<ShelfSearchResult> => {
    const query = typeof rawQuery === 'string' ? rawQuery : ''
    const trimmed = query.trim()
    // The Shelf is always raised on an empty query, so this is where a library changed in Zotero
    // since the index was built gets picked up — never mid-typing.
    if (!trimmed) shelf.refresh()
    const state = await shelf.load()
    const matches = state.index ? (trimmed ? state.index.search(trimmed) : state.items) : []
    return {
      diagnostics: state.index?.diagnostics.map((entry) => entry.message) ?? [],
      error: state.error,
      matched: matches.length,
      query,
      rows: matches
        .slice(0, SHELF_ROW_LIMIT)
        .map((item) => shelfRow(item, itemSelectLink(state.librarySegments, item.libraryId, item.itemKey))),
      total: state.items.length,
      zoteroDataDirectory: state.index?.zoteroDataDirectory.path ?? '',
    }
  })

  ipcMain.handle('reading-room:open-shelf-item', async (_event, input: unknown): Promise<ReadingRoomState> => {
    if (!isRecord(input) || typeof input.itemKey !== 'string' || typeof input.libraryId !== 'number') {
      throw new Error('Invalid Shelf selection.')
    }
    const attachmentKey = typeof input.attachmentKey === 'string' ? input.attachmentKey : null
    // The draft this open belongs to travels WITH the open, so the paper cannot land against a draft
    // the renderer has meanwhile left. A recents row is opened through this same handler — it carries
    // only keys, which is why a reindexed, retitled or moved paper still resolves.
    if ('draftPath' in input) activeDraftPath = draftPathFrom(input.draftPath)
    const state = await shelf.load()
    if (state.error) throw new Error(state.error)
    const item = state.byKey.get(`${input.libraryId}:${input.itemKey}`)
    if (!item) throw new Error('That item is no longer in the Shelf. Search again.')
    rememberDocument(readingRoomDocumentFor(item, attachmentKey))
    return await readingRoomState(state.librarySegments)
  })

  /** The remembered document's annotations. Read straight from Zotero rather than from the reader, so
   *  the harvest works with no document rendered — the posture the locked mockup is built around. */
  ipcMain.handle('reading-room:read-highlights', async (): Promise<HighlightsResult> => {
    const document = currentDocument()
    if (!document) {
      return { colours: [], error: null, forReader: [], rows: [], tags: [] }
    }
    try {
      // Zotero's marks AND the ones still owed to it, as one set (ADR-0029): a highlight made in this
      // session paints immediately and stays painted across a reopen, with or without a credential.
      // Through the gate, because this is the repaint a highlight triggers and it must not be in
      // flight while the drain probes the lock (ADR-0031).
      const annotations = await zoteroLibrary.read(() => readAnnotations(
        createNodeSqliteDriver(),
        zoteroDatabasePath(),
        document.libraryId,
        document.attachmentKey,
      ))
      const owed = store.outboxUnconfirmed()
        .filter((entry) => entry.parentItemKey === document.attachmentKey)
      return withKeptEdits(highlightsResult(mergeWithOutbox(annotations, owed)), keptEditKeys(owed))
    } catch (error) {
      return {
        colours: [],
        forReader: [],
        error: `The highlights for this document could not be read. ${
          error instanceof Error ? error.message : String(error)
        }`,
        rows: [],
        tags: [],
      }
    }
  })

  /**
   * The citation create path (ADR-0035). It writes only after the selected words actually arrive in
   * a draft, so copying for another destination does not create a Zotero mark.
   *
   * Exact reuse is restricted to this app's retained outbox rows: same library and attachment, same
   * page, byte-identical rect arrays. A confirmed row earns an annotation link. Every unconfirmed
   * state, including Zotero-open refusal, earns only the page link and keeps ADR-0036's result.
   */
  ipcMain.handle('reading-room:cite-selection', async (_event, input: unknown): Promise<{
    annotation: (SavedAnnotation & { isExternal: false }) | null
    confirmed: boolean
    link: string
    waiting: number
    rejected: number
    notWritten?: string
    notWrittenCode?: DrainSkipReason | 'document-mismatch'
  }> => {
    if (
      !isRecord(input)
      || typeof input.attachmentKey !== 'string'
      || typeof input.libraryId !== 'number'
      || typeof input.documentTitle !== 'string'
      || !input.documentTitle.trim()
    ) {
      throw new Error('Invalid citation selection.')
    }
    const document = currentDocument()
    if (
      !document
      || input.libraryId !== document.libraryId
      || input.attachmentKey !== document.attachmentKey
    ) {
      return {
        annotation: null,
        confirmed: false,
        link: '',
        ...zoteroOutboxCounts(store),
        notWrittenCode: 'document-mismatch',
      }
    }
    const selection = citationSelection(input.annotation)
    if (!selection) throw new Error('The reader selection cannot become a Zotero highlight.')

    const state = await shelf.load()
    let pageIndex: number | null = null
    try {
      const position = JSON.parse(selection.position) as { pageIndex?: unknown }
      if (typeof position.pageIndex === 'number' && Number.isFinite(position.pageIndex)) {
        pageIndex = Math.max(1, Math.round(position.pageIndex) + 1)
      }
    } catch {
      pageIndex = null
    }
    const fallbackLink = pageLink(
      state.librarySegments,
      document.libraryId,
      document.attachmentKey,
      pageIndex,
    )
    if (!isPdfCitationPosition(selection.position)) {
      return {
        annotation: null,
        confirmed: false,
        link: fallbackLink,
        ...zoteroOutboxCounts(store),
      }
    }
    if (
      !annotationPositionWithinCap(selection.position)
      || !annotationTextWithinCap(selection.text)
    ) {
      return {
        annotation: null,
        confirmed: false,
        link: fallbackLink,
        ...zoteroOutboxCounts(store),
      }
    }
    let entries = allOutboxEntries(store)
    let exact = findExactCitationAnnotation(
      entries,
      document.libraryId,
      document.attachmentKey,
      selection.position,
    )
    let annotation = exact ? annotationFromOutbox(exact) : null
    if (!annotation) {
      annotation = citationAnnotation(selection, input.documentTitle.trim())
      store.enqueueOutbox({
        itemKey: annotation.key,
        libraryId: document.libraryId,
        operation: 'create',
        parentItemKey: document.attachmentKey,
        payload: JSON.stringify(annotationPayload(annotation, document.attachmentKey)),
      })
    }

    const report = await zoteroLibrary.drain(() => drainOutboxToZotero(store, zoteroWriteSession))
    entries = allOutboxEntries(store)
    exact = findExactCitationAnnotation(
      entries,
      document.libraryId,
      document.attachmentKey,
      selection.position,
    )
    const retained = exact ? annotationFromOutbox(exact) : null
    if (retained) annotation = retained

    const written = exact?.status === 'confirmed' && exact.itemKey
      ? annotationLink(state.librarySegments, document.libraryId, document.attachmentKey, exact.itemKey)
      : fallbackLink
    return {
      annotation: { ...annotation, isExternal: false },
      confirmed: exact?.status === 'confirmed',
      link: written,
      ...zoteroOutboxCounts(store),
      ...(report.skippedReason ? { notWritten: report.skippedReason } : {}),
      ...(report.skipped ? { notWrittenCode: report.skipped } : {}),
    }
  })

  /**
   * A highlight made in the reader, on its way into Zotero's own database (ADR-0031).
   *
   * It is **queued first** and only then written: the renderer awaits this call and only then tells
   * the reader "saved", so the boundary the reader trusts is the durable local queue and never the
   * write (ADR-0014). If Zotero is open the write is refused and the entry simply stays queued —
   * still painted, because ADR-0029 draws the union of Zotero and the outbox.
   */
  ipcMain.handle('reading-room:save-annotations', async (_event, input: unknown): Promise<{
    queued: number
    waiting: number
    rejected: number
    /** Present when Zotero would not take the write, e.g. "Close Zotero and…". */
    notWritten?: string
    /** Which refusal it was, so a surface can name the cause without reading the sentence. */
    notWrittenCode?: DrainSkipReason
    /** Facts about marks deliberately kept here, independent of the Zotero drain result. */
    keptLocal?: {
      code: 'unsupported-position'
      count: number
      created: boolean
      reason: string
    }
  }> => {
    const document = currentDocument()
    if (!document) throw new Error('There is no open document to attach a highlight to.')
    if (!isRecord(input) || !Array.isArray(input.annotations)) {
      throw new Error('Invalid annotation payload.')
    }
    const operation = input.operation === 'update' ? 'update' : 'create'
    let queued = 0
    let keptLocalCount = 0
    let keptLocalReason: string | null = null
    for (const raw of input.annotations) {
      if (
        !isRecord(raw)
        || typeof raw.key !== 'string'
        || typeof raw.sortIndex !== 'string'
        || typeof raw.position !== 'string'
      ) continue
      const annotation = raw as unknown as SavedAnnotation
      const payload = annotationPayload(annotation, document.attachmentKey)
      const entry = store.enqueueOutbox({
        // The reader's OWN key, on a create as well as an update. ADR-0029 deduplicates the painted
        // union by annotation key, so a queued mark with no key could not be matched against the same
        // mark once Zotero has it — it would paint twice. The server's assigned key replaces this on
        // confirm, and confirmed rows are not painted, so the two can never collide.
        itemKey: annotation.key,
        libraryId: document.libraryId,
        operation,
        parentItemKey: document.attachmentKey,
        payload: JSON.stringify(
          operation === 'create' && annotation.type === 'image'
            ? { ...payload, readflexSourceKey: annotation.key }
            : payload,
        ),
      })
      if (
        document.kind !== 'pdf'
        ||
        !annotationPositionWithinCap(annotation.position)
        || !isPdfCitationPosition(annotation.position)
      ) {
        keptLocalReason = document.kind === 'pdf'
          ? LOCAL_ONLY_COMPLEX_PDF_REASON
          : LOCAL_ONLY_NON_PDF_REASON
        store.markOutboxLocalOnly(entry.id, keptLocalReason)
        keptLocalCount += 1
      } else if (operation === 'update') {
        // There is no write path for an edit yet (ADR-0031 covers the insert only), so Zotero is never
        // asked: the edit is stored, drawn (ADR-0029) and kept out of both sync counts from the start.
        // Queuing it as Zotero work would count it as "waiting" for a write that cannot happen, and
        // then as "refused" by a library that was never asked.
        store.markOutboxLocalOnly(entry.id, UNSUPPORTED_ZOTERO_EDIT_REASON)
      }
      queued += 1
    }
    // Now try to hand it to Zotero. A refusal is not a failure of the save. Exclusive against our own
    // reads, so the liveness probe and the lock are answering Zotero and nothing else (ADR-0031).
    const report = await zoteroLibrary.drain(() => drainOutboxToZotero(store, zoteroWriteSession))
    return {
      queued,
      ...zoteroOutboxCounts(store),
      ...(keptLocalReason
        ? {
            keptLocal: {
              code: 'unsupported-position' as const,
              count: keptLocalCount,
              created: operation === 'create',
              reason: keptLocalReason,
            },
          }
        : {}),
      ...(report.skippedReason ? { notWritten: report.skippedReason } : {}),
      ...(report.skipped ? { notWrittenCode: report.skipped } : {}),
    }
  })

  ipcMain.handle('reading-room:begin-area-quotation', (_event, input: unknown): string => {
    for (const [receipt, record] of areaQuotationReceipts) {
      if (record.expiresAt < Date.now()) areaQuotationReceipts.delete(receipt)
    }
    while (areaQuotationReceipts.size >= 100) {
      const oldest = areaQuotationReceipts.keys().next().value as string | undefined
      if (!oldest) break
      areaQuotationReceipts.delete(oldest)
    }
    if (
      !isRecord(input)
      || typeof input.annotationKey !== 'string'
      || !input.annotationKey.trim()
      || typeof input.attachmentKey !== 'string'
      || !input.attachmentKey.trim()
      || typeof input.libraryId !== 'number'
      || !Number.isSafeInteger(input.libraryId)
      || input.libraryId <= 0
      || !activeDraftPath
    ) throw new Error('Invalid Area quotation preparation.')
    const authorised = allOutboxEntries(store).some((entry) => {
      if (
        entry.operation !== 'create'
        || entry.libraryId !== input.libraryId
        || entry.parentItemKey !== input.attachmentKey
        || entry.localOnly !== 0
        || !['pending', 'retrying', 'confirmed'].includes(entry.status)
      ) return false
      try {
        const payload = JSON.parse(entry.payload) as ReturnType<typeof annotationPayload>
        return payload.annotationType === 'image'
          && (payload.readflexSourceKey === input.annotationKey || entry.itemKey === input.annotationKey)
      } catch {
        return false
      }
    })
    if (!authorised) throw new Error('The Area capture is not one ReadFlex created.')
    const receipt = randomUUID()
    areaQuotationReceipts.set(receipt, {
      annotationKey: input.annotationKey,
      attachmentKey: input.attachmentKey,
      draftPath: activeDraftPath,
      expiresAt: Date.now() + 5 * 60_000,
      libraryId: input.libraryId,
    })
    return receipt
  })

  ipcMain.handle('reading-room:record-area-quotation', async (_event, input: unknown): Promise<{
    recorded: boolean
    quotationError?: string
    quotationStatus: OutboxEntry['status']
    waiting: number
    rejected: number
    notWritten?: string
    notWrittenCode?: DrainSkipReason
  }> => {
    if (
      !isRecord(input)
      || typeof input.annotationKey !== 'string'
      || !input.annotationKey.trim()
      || typeof input.attachmentKey !== 'string'
      || !input.attachmentKey.trim()
      || typeof input.documentTitle !== 'string'
      || !input.documentTitle.trim()
      || typeof input.draftPath !== 'string'
      || !input.draftPath.trim()
      || typeof input.receipt !== 'string'
      || !input.receipt
      || typeof input.libraryId !== 'number'
      || !Number.isSafeInteger(input.libraryId)
      || input.libraryId <= 0
    ) throw new Error('Invalid Area quotation record.')
    const receipt = areaQuotationReceipts.get(input.receipt)
    areaQuotationReceipts.delete(input.receipt)
    if (
      !receipt
      || receipt.expiresAt < Date.now()
      || receipt.annotationKey !== input.annotationKey
      || receipt.attachmentKey !== input.attachmentKey
      || receipt.libraryId !== input.libraryId
      || receipt.draftPath !== input.draftPath
    ) throw new Error('The Area quotation receipt is missing, expired or belongs to another draft.')

    const entries = allOutboxEntries(store)
    let source: { entry: OutboxEntry; payload: ReturnType<typeof annotationPayload> } | null = null
    for (const entry of entries) {
      if (
        entry.operation !== 'create'
        || entry.libraryId !== input.libraryId
        || entry.parentItemKey !== input.attachmentKey
        || entry.localOnly !== 0
        || !['pending', 'retrying', 'confirmed'].includes(entry.status)
      ) continue
      try {
        const payload = JSON.parse(entry.payload) as ReturnType<typeof annotationPayload>
        if (
          payload.annotationType === 'image'
          && (payload.readflexSourceKey === input.annotationKey || entry.itemKey === input.annotationKey)
        ) {
          source = { entry, payload }
          break
        }
      } catch {
        // An unreadable row cannot authorise a comment update.
      }
    }
    if (!source) throw new Error('The Area capture is not one ReadFlex created, so no quotation was recorded.')

    const comment = quotationComment(input.documentTitle.trim())
    const sourceKey = source.payload.readflexSourceKey ?? input.annotationKey
    let quotation = entries.find((entry) => {
      if (
        entry.operation !== 'update'
        || entry.libraryId !== input.libraryId
        || entry.parentItemKey !== input.attachmentKey
        || !['pending', 'retrying', 'confirmed'].includes(entry.status)
      ) return false
      try {
        const payload = JSON.parse(entry.payload) as ReturnType<typeof annotationPayload>
        const marker = payload.readflexAreaQuotation
        return !!marker && marker.sourceKey === sourceKey && marker.comment === comment
      } catch {
        return false
      }
    }) ?? null
    if (!quotation) {
      quotation = store.enqueueOutbox({
        itemKey: sourceKey,
        libraryId: input.libraryId,
        operation: 'update',
        parentItemKey: input.attachmentKey,
        payload: JSON.stringify(areaQuotationPayload(source.payload, sourceKey, comment)),
      })
    }
    const report = await zoteroLibrary.drain(() => drainOutboxToZotero(store, zoteroWriteSession))
    const settled = allOutboxEntries(store).find((entry) => entry.id === quotation?.id) ?? quotation
    const recorded = settled?.status === 'confirmed'
    return {
      recorded,
      quotationStatus: settled!.status,
      ...(settled?.lastError ? { quotationError: settled.lastError } : {}),
      ...zoteroOutboxCounts(store),
      ...(report.skippedReason ? { notWritten: report.skippedReason } : {}),
      ...(report.skipped ? { notWrittenCode: report.skipped } : {}),
    }
  })

  /**
   * Ask Zotero to take whatever is still owed to it, and say why it would not (ADR-0036, decision 2).
   *
   * Before this, a write refused because Zotero was open waited for the NEXT `save-annotations` call to
   * trigger a drain — so a mark made while Zotero was open could sit indefinitely and then arrive at an
   * arbitrary moment. The Room calls this when it opens and when a document opens: both are cheap, and
   * both are moments the reader is already waiting.
   *
   * With an empty outbox it does not open a session at all. A refusal reported with nothing waiting
   * would be a message about no highlight, which is worse than saying nothing.
   */
  ipcMain.handle('reading-room:drain-outbox', async (): Promise<{
    waiting: number
    rejected: number
    notWritten?: string
    notWrittenCode?: DrainSkipReason
  }> => {
    const before = zoteroOutboxCounts(store)
    if (before.waiting === 0) return before
    const report = await zoteroLibrary.drain(() => drainOutboxToZotero(store, zoteroWriteSession))
    return {
      ...zoteroOutboxCounts(store),
      ...(report.skippedReason ? { notWritten: report.skippedReason } : {}),
      ...(report.skipped ? { notWrittenCode: report.skipped } : {}),
    }
  })

  /** Both sync signals cross IPC explicitly; the renderer never infers one from the other. */
  ipcMain.handle(
    'reading-room:outbox-counts',
    (): ReadingRoomOutboxCounts => zoteroOutboxCounts(store),
  )

  /** Names the paper a refused row belongs to: the Shelf index first, then the recents history. */
  async function refusedList(): Promise<RefusedHighlight[]> {
    // Nothing refused is the ordinary case, and it must cost nothing: no library read to name papers
    // for a list that is empty.
    if (store.countOutboxRejected() === 0) return []
    const byAttachment = new Map<string, { title: string; itemKey: string | null }>()
    for (const recent of store.listRecentDocuments(200)) {
      byAttachment.set(`${recent.libraryId}:${recent.attachmentKey}`, {
        itemKey: recent.itemKey,
        title: [recent.authorYear, recent.shortTitle].filter((part) => !!part?.trim()).join(' — '),
      })
    }
    const open = currentDocument()
    if (open) {
      byAttachment.set(`${open.libraryId}:${open.attachmentKey}`, {
        itemKey: open.itemKey,
        title: [open.authorYear, open.shortTitle].filter((part) => !!part?.trim()).join(' — '),
      })
    }
    // The library is the better source when it can be read; a library that cannot must not hide the
    // list, so its error is swallowed and the recents history (or the bare key) names the paper.
    const state = await shelf.load().catch(() => null)
    for (const item of state?.items ?? []) {
      for (const attachment of item.attachments) {
        byAttachment.set(`${item.libraryId}:${attachment.key}`, {
          itemKey: item.itemKey,
          title: [shelfAuthorYear(item), item.title].filter((part) => !!part?.trim()).join(' — '),
        })
      }
    }
    return refusedHighlights(
      store,
      (libraryId, attachmentKey) => byAttachment.get(`${libraryId}:${attachmentKey}`) ?? null,
    )
  }

  /** Every highlight Zotero would not take, across all documents — what the status-bar count counts. */
  ipcMain.handle('reading-room:refused-highlights', (): Promise<RefusedHighlight[]> => refusedList())

  /** Try a refused insert again. The row is requeued and a drain is attempted at once. */
  ipcMain.handle('reading-room:retry-refused', async (_event, id: unknown): Promise<{
    waiting: number
    rejected: number
    notWritten?: string
    notWrittenCode?: DrainSkipReason
  }> => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || !retryRefused(store, id)) {
      return zoteroOutboxCounts(store)
    }
    const report = await zoteroLibrary.drain(() => drainOutboxToZotero(store, zoteroWriteSession))
    return {
      ...zoteroOutboxCounts(store),
      ...(report.skippedReason ? { notWritten: report.skippedReason } : {}),
      ...(report.skipped ? { notWrittenCode: report.skipped } : {}),
    }
  })

  /** Stop counting a refused row. The highlight is kept and still drawn; nothing is deleted. */
  ipcMain.handle('reading-room:dismiss-refused', (_event, id: unknown): ReadingRoomOutboxCounts => {
    if (typeof id === 'number' && Number.isSafeInteger(id)) dismissRefused(store, id)
    return zoteroOutboxCounts(store)
  })

  ipcMain.handle('reading-room:read-document', async (_event, requestedPath: unknown) => {
    const document = currentDocument()
    if (!document || requestedPath !== document.path) {
      throw new Error('The Reading Room can read only its remembered document.')
    }
    return new Uint8Array(await readFile(document.path))
  })

  ipcMain.handle(
    'reading-room:add-bookmark',
    (_event, input: unknown): ReadingBookmarkRow => bookmarks.add(input),
  )

  ipcMain.handle(
    'reading-room:list-bookmarks',
    (): ReadingBookmarkRow[] => bookmarks.list(),
  )

  ipcMain.handle('reading-room:save-view-state', (_event, input: unknown) => {
    if (!isRecord(input) || !isRecord(input.viewState)) {
      throw new Error('Invalid Reading Room view state.')
    }
    const document = currentDocument()
    if (
      !document ||
      input.libraryId !== document.libraryId ||
      input.attachmentKey !== document.attachmentKey
    ) {
      throw new Error('The Reading Room view state does not match the active document.')
    }
    store.savePosition({
      itemKey: document.attachmentKey,
      libraryId: document.libraryId,
      position: JSON.stringify(input.viewState),
    })
  })

  ipcMain.handle('reading-room:save-width', (_event, rawWidth: unknown) => {
    if (typeof rawWidth !== 'number' || !Number.isFinite(rawWidth)) {
      throw new Error('Invalid Reading Room width.')
    }
    const current = store.getLayout()
    const roomWidth = clampRoomWidth(rawWidth)
    store.saveLayout({
      lastRoomView: 'document',
      roomWidth,
      side: current?.side ?? 'left',
    })
    return roomWidth
  })

  return {
    close() {
      ipcMain.removeHandler('reading-room:get-state')
      ipcMain.removeHandler('reading-room:recent-documents')
      ipcMain.removeHandler('reading-room:search-shelf')
      ipcMain.removeHandler('reading-room:open-shelf-item')
      ipcMain.removeHandler('reading-room:read-highlights')
      ipcMain.removeHandler('reading-room:cite-selection')
      ipcMain.removeHandler('reading-room:save-annotations')
      ipcMain.removeHandler('reading-room:begin-area-quotation')
      ipcMain.removeHandler('reading-room:record-area-quotation')
      ipcMain.removeHandler('reading-room:drain-outbox')
      ipcMain.removeHandler('reading-room:outbox-counts')
      ipcMain.removeHandler('reading-room:refused-highlights')
      ipcMain.removeHandler('reading-room:retry-refused')
      ipcMain.removeHandler('reading-room:dismiss-refused')
      ipcMain.removeHandler('reading-room:read-document')
      ipcMain.removeHandler('reading-room:add-bookmark')
      ipcMain.removeHandler('reading-room:list-bookmarks')
      ipcMain.removeHandler('reading-room:save-view-state')
      ipcMain.removeHandler('reading-room:save-width')
      areaQuotationReceipts.clear()
      store.close()
    },
  }
}
