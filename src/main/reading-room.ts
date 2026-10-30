import { setFolioZoteroEvidenceReader, zoteroSourceQuote } from './folio-zotero-evidence'
import { app, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
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
  readAnnotations,
  readCollections,
  type ShelfIndex,
  type ZoteroAnnotation,
  type ShelfIndexOptions,
  type ShelfItem,
} from '@readflex/zotero-bridge'
import { discoverZoteroDataDirectory } from '@readflex/zotero-paths'
import {
  readingRoomDocumentFor,
  shelfAuthorYear,
  shelfPage,
  shelfRow,
  type ShelfSearchResult,
} from './reading-room-shelf'
import {
  collectionNodes,
  type ShelfCollectionData,
  type ShelfCollectionNode,
} from '../shared/shelf-collections'
import { createReadingRoomBookmarks, type ReadingBookmarkRow } from './reading-room-bookmarks'
import {
  highlightsResult,
  mergeWithOutbox,
  retireConfirmed,
  type ZoteroRead,
  withKeptEdits,
  type HighlightsResult,
} from './reading-room-highlights'
import {
  dismissRefused,
  keptEditKeys,
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
  findExactCitationAnnotation,
  isPdfCitationPosition,
  LOCAL_ONLY_COMPLEX_PDF_REASON,
  LOCAL_ONLY_NON_PDF_REASON,
  quotationComment,
  readerSessionOf,
  validBaseline,
  type CitationSelectionAnnotation,
  type DrainReport,
  type DrainSkipReason,
  type SavedAnnotation,
  type ZoteroWriteAttempt,
} from './zotero-annotation-writes'
import { queueAnnotationChange, releaseKeptEdits } from './zotero-outbox-edits'
import { readBracketed } from './zotero-read-snapshot'
import {
  drainOutboxToZoteroPlugin,
  pingZoteroPlugin,
  readAnnotationsThroughPlugin,
  type ZoteroPluginConnection,
} from './zotero-plugin-transport'
import { createZoteroPluginWatcher, type WatcherClock } from './zotero-plugin-watcher'
import { MainProcessDiagnostics } from './shutdown'
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

/** Zotero's data directory, where the WriteFlex plugin leaves `writeflex/bridge.json`. Null when it
 *  cannot be worked out; the plugin is then reached on Zotero's default port without a key. */
function zoteroDataDirectory(): string | null {
  try {
    return dirname(zoteroDatabasePath())
  } catch {
    return null
  }
}

/**
 * The WriteFlex plugin file shipped with the app (`extraResources`), for him to install in Zotero.
 * In development it is the one `bun run build:zotero-plugin` left in `zotero-plugin/dist`.
 */
export function bundledZoteroPluginFile(): string | null {
  const directory = app.isPackaged
    ? join(process.resourcesPath, 'zotero-plugin')
    : join(app.getAppPath(), 'zotero-plugin', 'dist')
  try {
    const file = readdirSync(directory).filter((name) => /^writeflex-zotero-.+\.xpi$/.test(name)).sort().at(-1)
    return file ? join(directory, file) : null
  } catch {
    return null
  }
}

/** Collections for the Shelf, read-only from the same database file as the index. A library without
 *  collection tables, or one that cannot be read for them, simply has none: the Shelf still works. */
function readShelfCollections(databasePath: string): ShelfCollectionData {
  try {
    return readCollections(createNodeSqliteDriver(), databasePath)
  } catch {
    return { collections: [], itemCollections: {} }
  }
}

type ShelfState = {
  index: ShelfIndex | null
  /** libraryId → the `zotero://` URL segment, so a group item's link is not silently wrong. */
  librarySegments: LibrarySegments
  items: ShelfItem[]
  byKey: Map<string, ShelfItem>
  /** Zotero's collections and their members, read with the index and refreshed with it. */
  collections: ShelfCollectionData
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
        // The Shelf build and the library-segment read are one read of `zotero.sqlite`, through the gate.
        current = await access.read(() => {
          const index = buildShelfIndex(createNodeSqliteDriver(), options)
          const items = index.list()
          const databasePath = options.zoteroDatabasePath
            ?? join(index.zoteroDataDirectory.path, 'zotero.sqlite')
          const librarySegments = readLibrarySegments(createNodeSqliteDriver(), databasePath)
          const collections = readShelfCollections(databasePath)
          return {
            builtFrom: libraryModifiedAt(databasePath),
            byKey: new Map(items.map((item) => [`${item.libraryId}:${item.itemKey}`, item])),
            collections,
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
          collections: { collections: [], itemCollections: {} },
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

/** What the main process tells every window when the outbox changed without a renderer asking —
 *  the plugin watcher's drain. Same shape as a write result, so the renderer has one path for both. */
export type ReadingRoomOutboxNotice = ReadingRoomOutboxCounts & {
  notWritten?: string
  notWrittenCode?: DrainSkipReason
  /** Rows this drain wrote into Zotero. Success is announced only when this is above zero. */
  written?: number
  /** Rows this drain refused or found in conflict. They are listed with their reason. */
  refusedNow?: number
}

export type ReadingRoomOptions = {
  /** Called after a drain nobody in the renderer asked for (the plugin watcher's). */
  onOutboxChanged?: (notice: ReadingRoomOutboxNotice) => void
  /** Test seam: the plugin watcher's timer. */
  pluginWatcherClock?: WatcherClock
}

/** How many lines the Zotero write log keeps. One line per row per attempt; oldest go first. */
const ZOTERO_WRITE_LOG_LINES = 2_000

export async function registerReadingRoom(
  entryFile = fileURLToPath(import.meta.url),
  options: ReadingRoomOptions = {},
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
  /**
   * One line per write attempt or refusal, per outbox row: time, operation, key, outcome, reason. In
   * WriteFlex's own app data (`reading-room/zotero-writes.log`), bounded, never in Zotero's tree.
   */
  const writeLog = new MainProcessDiagnostics(
    join(app.getPath('userData'), 'reading-room', 'zotero-writes.log'),
    ZOTERO_WRITE_LOG_LINES,
  )
  const logAttempt = (attempt: ZoteroWriteAttempt): void => {
    void writeLog
      .record('zotero-write', { at: new Date().toISOString(), ...attempt })
      .catch(() => { /* a log that cannot be written must not stop a write */ })
  }
  // A row a drain was writing when the app last stopped is put back in the queue, marked as cut off,
  // before any drain runs: the write may or may not have reached Zotero, and the next one is told so.
  try {
    const recovered = store.recoverInterruptedSends()
    if (recovered > 0) {
      logAttempt({ key: null, operation: 'update', outbox: 0, outcome: 'recovered-interrupted-sends', reason: `${recovered} interrupted write(s) queued again` })
    }
  } catch {
    // Left for the next launch; a claimed row is only ever skipped, never lost.
  }
  // PDF edits and deletions older releases kept back (there was no write path for them) go back in
  // the queue, in their original order, before anything reads a count. Idempotent; a failure here
  // must not stop the Room from opening — the rows stay kept and nothing is lost.
  try {
    const released = releaseKeptEdits(store)
    if (released > 0) {
      logAttempt({ key: null, operation: 'update', outbox: 0, outcome: 'released-kept-edits', reason: `${released} kept edit(s) queued for Zotero` })
    }
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
   * Reads of `zotero.sqlite` (the Shelf, painting, links) go through this gate. WriteFlex no longer
   * writes that file at all (ADR-0047): writes go to the WriteFlex plugin inside Zotero.
   */
  const zoteroLibrary = createZoteroLibraryAccess()

  /**
   * How the WriteFlex plugin in Zotero is reached. The data directory is re-read per drain. With a test
   * library (the e2e override) only that library's bridge file is used, never Zotero's default port.
   */
  const pluginConnection: ZoteroPluginConnection = {
    dataDirectory: zoteroDataDirectory,
    ...(shelfIndexOptions().zoteroDatabasePath ? { defaultPort: null } : {}),
  }

  /** One drain at a time, in the order they were asked for; claims keep rows safe either way. */
  let drainChain: Promise<unknown> = Promise.resolve()

  /**
   * Send everything that is waiting, in queue order, in batches of 25. Stops at the first refusal
   * (nothing more can be sent) or when a batch was not full. The watcher is told whether the plugin
   * answered, so it neither repeats this drain nor misses Zotero coming back.
   */
  function drainEverything(): Promise<DrainReport> {
    const run = drainChain.then(async (): Promise<DrainReport> => {
      const batch = 25
      const rounds = Math.ceil(store.countOutboxWaiting() / batch) + 1
      // Totals across every batch: the renderer announces success only for rows actually written, and
      // shows a refusal when a row was refused, whichever batch it was in.
      const total: DrainReport = {
        attempted: 0, confirmed: 0, conflicted: 0, keptLocal: 0, rejected: 0, retrying: 0, skipped: null,
      }
      for (let round = 0; round < rounds; round += 1) {
        const report = await drainOutboxToZoteroPlugin(store, pluginConnection, batch, logAttempt)
        total.attempted += report.attempted
        total.confirmed += report.confirmed
        total.conflicted += report.conflicted
        total.keptLocal += report.keptLocal
        total.rejected += report.rejected
        total.retrying += report.retrying
        total.skipped = report.skipped
        if (report.skippedReason) total.skippedReason = report.skippedReason
        else delete total.skippedReason
        if (report.skipped || report.attempted < batch || store.countOutboxWaiting() === 0) break
      }
      if (total.skipped && total.skipped !== 'no-credential') pluginWatcher.poke({ reachable: false })
      else if (total.attempted > 0) pluginWatcher.poke({ reachable: true })
      else pluginWatcher.poke()
      return total
    })
    drainChain = run.catch(() => {})
    return run
  }

  /** What one drain did, for the renderer: written rows, refused rows, and why nothing was written. */
  function drainFacts(report: DrainReport): Pick<ReadingRoomOutboxNotice, 'written' | 'refusedNow' | 'notWritten' | 'notWrittenCode'> {
    return {
      refusedNow: report.rejected + report.conflicted,
      written: report.confirmed,
      ...(report.skippedReason ? { notWritten: report.skippedReason } : {}),
      ...(report.skipped ? { notWrittenCode: report.skipped } : {}),
    }
  }

  function drainResult(report: DrainReport): ReadingRoomOutboxNotice {
    return { ...zoteroOutboxCounts(store), ...drainFacts(report) }
  }

  /**
   * One document's annotations, and how far the read can be trusted (`ZoteroRead`):
   *
   * - the plugin answers: Zotero's own read, inside a Zotero transaction, signed -> authoritative;
   * - Zotero is closed: the immutable read of `zotero.sqlite`, bracketed (`readBracketed`): with no
   *   write-ahead log content and no change to either file while it ran, the database file was the
   *   whole committed state -> authoritative;
   * - anything else (Zotero open without a usable plugin, a log with content, a file that changed
   *   during the read): painted, but it retires nothing.
   *
   * The start time is taken before anything is asked, so a row confirmed after it is never retired by
   * this read.
   */
  async function readZoteroAnnotations(libraryId: number, attachmentKey: string): Promise<{ annotations: ZoteroAnnotation[]; read: ZoteroRead }> {
    const startedAt = Date.now()
    const throughPlugin = await readAnnotationsThroughPlugin(pluginConnection, libraryId, attachmentKey)
    if (throughPlugin.kind === 'read') return { annotations: throughPlugin.annotations, read: { authoritative: true, startedAt } }
    const databasePath = zoteroDatabasePath()
    const bracketed = await zoteroLibrary.read(() => readBracketed(databasePath, () => readAnnotations(
      createNodeSqliteDriver(), databasePath, libraryId, attachmentKey,
    )))
    const authoritative = throughPlugin.code === 'zotero-closed' && bracketed.complete
    // The file read has the tags but not Zotero's modification stamp.
    const annotations = bracketed.value.map((annotation) => ({ ...annotation, zoteroState: { modified: null, tags: [...annotation.tags] } }))
    return { annotations, read: { authoritative, startedAt } }
  }

  const pluginWatcher = createZoteroPluginWatcher({
    ...(options.pluginWatcherClock ? { clock: options.pluginWatcherClock } : {}),
    drain: async () => {
      const report = await drainEverything()
      options.onOutboxChanged?.(drainResult(report))
    },
    hasPending: () => store.countOutboxWaiting() > 0,
    isReachable: async () => (await pingZoteroPlugin(pluginConnection)).kind === 'ready',
  })
  // Anything left waiting from an earlier session starts the watch at once.
  pluginWatcher.poke()

  const shelf = createShelfLoader(zoteroLibrary)
  const unregisterEvidenceReader = setFolioZoteroEvidenceReader(async requests => {
    shelf.refresh()
    const state = await shelf.load()
    const annotations = new Map<string, Promise<ZoteroAnnotation[]>>()
    return Promise.all(requests.map(async request => {
      const annotation = /^zotero:\/\/open-pdf\/(library|groups\/\d+)\/items\/([A-Z\d]{8})\?annotation=([A-Z\d]{8})$/.exec(request.target)
      const item = state.items.find(value => itemSelectLink(state.librarySegments, value.libraryId, value.itemKey) === request.target || (annotation && value.attachments.some(attachment => attachment.key === annotation[2]) && annotationLink(state.librarySegments, value.libraryId, annotation[2], annotation[3]) === request.target))
      if (!state.index || state.error) return { target: request.target, state: 'Zotero not available' as const, highlights: [] }
      if (!item) return { target: request.target, state: 'not found in Zotero' as const, highlights: [] }
      const label = shelfAuthorYear(item)
      const highlights = await Promise.all(request.highlights.map(async target => {
        const match = /^zotero:\/\/open-pdf\/(library|groups\/\d+)\/items\/([A-Z\d]{8})\?annotation=([A-Z\d]{8})$/.exec(target)
        if (!match || !item.attachments.some(attachment => attachment.key === match[2]) || annotationLink(state.librarySegments, item.libraryId, match[2], match[3]) !== target) return null
        const key = `${item.libraryId}/${match[2]}`
        if (!annotations.has(key)) annotations.set(key, readZoteroAnnotations(item.libraryId, match[2]).then(value => value.annotations))
        const annotation = (await annotations.get(key)!).find(value => value.key === match[3])
        if (!annotation) return null
        const row = highlightsResult([annotation]).rows[0]
        return { target, quote: zoteroSourceQuote(annotation), bodyKind:row.bodyKind, label: row.pageLabel ? `${label}, p. ${row.pageLabel}` : label }
      }))
      return { target: request.target, state: 'ready' as const, title: item.title, label, itemTarget: itemSelectLink(state.librarySegments,item.libraryId,item.itemKey), highlights: highlights.filter((value): value is NonNullable<typeof value> => value !== null) }
    }))
  })
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

  /** The collection tree for the Shelf's filter: ids, names, parents, subtree item counts. Read-only. */
  ipcMain.handle('reading-room:shelf-collections', async (): Promise<ShelfCollectionNode[]> => {
    // Raised alongside the empty-query search: same staleness check, so tree, counts and the
    // remembered-choice fallback agree with the index the search will use.
    shelf.refresh()
    const state = await shelf.load()
    return collectionNodes(state.items, state.collections)
  })

  ipcMain.handle('reading-room:search-shelf', async (
    _event,
    rawQuery: unknown,
    rawCollection?: unknown,
  ): Promise<ShelfSearchResult> => {
    const query = typeof rawQuery === 'string' ? rawQuery : ''
    const trimmed = query.trim()
    // The Shelf is always raised on an empty query, so this is where a library changed in Zotero
    // since the index was built gets picked up — never mid-typing.
    if (!trimmed) shelf.refresh()
    const state = await shelf.load()
    const found = state.index ? (trimmed ? state.index.search(trimmed) : state.items) : []
    // The collection filter runs on the whole match set BEFORE the row limit, so a collection of
    // hundreds of items is searchable within. An id that is not a known collection is ignored.
    const page = shelfPage(found, state.collections, rawCollection)
    return {
      diagnostics: state.index?.diagnostics.map((entry) => entry.message) ?? [],
      error: state.error,
      matched: page.matched,
      query,
      rows: page.items
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
      const { annotations, read } = await readZoteroAnnotations(document.libraryId, document.attachmentKey)
      // This document's rows only, with no window: a long log elsewhere cannot hide its edits.
      const waiting = store.outboxUnconfirmedFor(document.libraryId, document.attachmentKey)
      // What Zotero confirmed stays painted from here until an authoritative read that started after
      // the confirmation, so a confirmed highlight never vanishes on reopen (ADR-0047).
      const settled = retireConfirmed(store.outboxConfirmedUnreadFor(document.libraryId, document.attachmentKey), read)
      if (settled.retired.length > 0) store.markOutboxRead(settled.retired)
      const owed = [...settled.stillShown, ...waiting].sort((left, right) => left.id - right.id)
      const shown = mergeWithOutbox(annotations, owed)
      const result = withKeptEdits(highlightsResult(shown), keptEditKeys(owed))
      const confirmed = new Set([...annotations.map(annotation => annotation.key), ...settled.stillShown.map(entry => entry.itemKey)])
      return { ...result, rows: result.rows.map(row => ({ ...row, zoteroKey: confirmed.has(row.key) ? row.key : null })) }
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

    const report = await drainEverything()
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
      ...drainFacts(report),
    }
  })

  /**
   * A highlight made in the reader, on its way into Zotero through the WriteFlex plugin (ADR-0047).
   *
   * It is **queued first** and only then written: the renderer awaits this call and only then tells
   * the reader "saved", so the boundary the reader trusts is the durable local queue and never the
   * write (ADR-0014). If Zotero is not open the entry simply stays queued —
   * still painted, because ADR-0029 draws the union of Zotero and the outbox.
   */
  ipcMain.handle('reading-room:save-annotations', async (_event, input: unknown): Promise<{
    queued: number
    waiting: number
    rejected: number
    /** Present when Zotero would not take the write, e.g. "Zotero is not open…". */
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
    const operation = input.operation === 'update' || input.operation === 'delete'
      ? input.operation
      : 'create'
    let queued = 0
    let keptLocalCount = 0
    let keptLocalReason: string | null = null
    // The before-state is the reader's, sent with each change: the mark as THAT reader instance showed
    // it (ADR-0047). Main keeps no copy of its own, so a list refreshed since cannot stand in for it.
    const before = Array.isArray(input.before) ? input.before : []
    // Which reader instance made the change: a create re-keyed because Zotero already held its key is
    // resolved to the new key only for that instance's later changes (ADR-0047).
    const readerSession = readerSessionOf({ readflexReaderSession: input.readerSession })
    // Each change is one sidecar transaction, and a row the drain has claimed is never folded into or
    // cancelled (see zotero-outbox-edits), so this may interleave freely with a drain in flight.
    for (const [index, raw] of input.annotations.entries()) {
      if (
        !isRecord(raw)
        || typeof raw.key !== 'string'
        || typeof raw.sortIndex !== 'string'
        || typeof raw.position !== 'string'
      ) continue
      const annotation = raw as unknown as SavedAnnotation
      const payload = annotationPayload(annotation, document.attachmentKey, undefined, {
        keepWholeComment: operation !== 'create',
      })
      // The reader's OWN key, on a create as well as an update or delete. ADR-0029 deduplicates the
      // painted union by annotation key, and a key Zotero replaces on insert is carried to every row
      // queued after it when the create is confirmed.
      const queuedChange = queueAnnotationChange(store, {
        itemKey: annotation.key,
        libraryId: document.libraryId,
        operation,
        parentItemKey: document.attachmentKey,
        payload: JSON.stringify({
          ...(operation === 'create' && annotation.type === 'image'
            ? { ...payload, readflexSourceKey: annotation.key }
            : payload),
          ...(readerSession ? { readflexReaderSession: readerSession } : {}),
        }),
      }, operation === 'create' ? null : validBaseline(before[index]))
      queued += 1
      // A fold landed in a row that is already classified; a cancel left nothing to classify.
      if (queuedChange.kind !== 'queued') continue
      const keptReason = document.kind !== 'pdf'
        ? LOCAL_ONLY_NON_PDF_REASON
        : operation !== 'delete'
            && (!annotationPositionWithinCap(annotation.position) || !isPdfCitationPosition(annotation.position))
          ? LOCAL_ONLY_COMPLEX_PDF_REASON
          : null
      if (keptReason) {
        keptLocalReason = keptReason
        store.markOutboxLocalOnly(queuedChange.entry.id, keptReason)
        keptLocalCount += 1
      }
    }
    // Now try to hand it to Zotero. A refusal is not a failure of the save.
    const report = await drainEverything()
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
      ...drainFacts(report),
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
    const report = await drainEverything()
    const settled = allOutboxEntries(store).find((entry) => entry.id === quotation?.id) ?? quotation
    const recorded = settled?.status === 'confirmed'
    return {
      recorded,
      quotationStatus: settled!.status,
      ...(settled?.lastError ? { quotationError: settled.lastError } : {}),
      ...zoteroOutboxCounts(store),
      ...drainFacts(report),
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
    const report = await drainEverything()
    return {
      ...zoteroOutboxCounts(store),
      ...drainFacts(report),
    }
  })

  /** Show the bundled WriteFlex plugin file in Finder, so he can install it in Zotero. */
  ipcMain.handle('reading-room:show-zotero-plugin', (): boolean => {
    const file = bundledZoteroPluginFile()
    if (!file) return false
    shell.showItemInFolder(file)
    return true
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
    const report = await drainEverything()
    return {
      ...zoteroOutboxCounts(store),
      ...drainFacts(report),
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

  ipcMain.handle('reading-room:save-view-state', (_event, input: unknown) => bookmarks.savePosition(input))

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
      unregisterEvidenceReader()
      pluginWatcher.stop()
      ipcMain.removeHandler('reading-room:show-zotero-plugin')
      ipcMain.removeHandler('reading-room:get-state')
      ipcMain.removeHandler('reading-room:recent-documents')
      ipcMain.removeHandler('reading-room:search-shelf')
      ipcMain.removeHandler('reading-room:shelf-collections')
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
