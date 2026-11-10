import { registerReaderShelfOperations } from './reading-room-shelf-operations'
import { registerReaderDocumentOperations } from './reading-room-document-operations'
import { setFolioZoteroEvidenceReader, zoteroSourceQuote } from './folio-zotero-evidence'
import { app, ipcMain, shell, session, type IpcMainInvokeEvent } from 'electron'
import { ReadingRoomContexts } from './reading-room-context'
import { readerRegistry } from './reading-room-policy'
import { createReaderResources, installReaderResources } from './reading-room-resources'
import { readerHostDirectory } from './reading-room-host-directory'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  selection: string
  roomWidth: number
  viewState: ReadingRoomViewState | null
}

import { DEFAULT_ROOM_WIDTH, MIN_ROOM_WIDTH, isRecord, allOutboxEntries, zoteroOutboxCounts, citationSelection, annotationFromOutbox, clampRoomWidth, readerBundleDirectory, e2eDocument, shelfIndexOptions, zoteroDatabasePath, zoteroDataDirectory, bundledZoteroPluginFile, createShelfLoader, type ReadingRoomOutboxCounts } from './reading-room-inputs'
export { zoteroDatabasePath, bundledZoteroPluginFile } from './reading-room-inputs'
export type { ReadingRoomOutboxCounts } from './reading-room-inputs'

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
  const resources = createReaderResources(bundleDirectory, readerHostDirectory(entryFile))
  installReaderResources(session.defaultSession, resources)
  const contexts = new ReadingRoomContexts()
  const handle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any): void => {
    ipcMain.handle(channel, (event, ...args) => contexts.run(event, () => listener(event, ...args)))
  }
  handle('reading-room:get-reader-notices', () => resources.notices())
  handle('reading-room:create-reader-lease', (_event, input: unknown) => {
    const context = contexts.current()
    if (!isRecord(input) || input.selection !== context.selection || (input.slot !== 0 && input.slot !== 1) || !currentDocument()) throw new Error('The reader selection is stale.')
    const grant = readerRegistry.create(context.owner, input.slot, documentIdentity(currentDocument()!))
    return { id: grant.id, origin: grant.origin, url: grant.url, nonce: grant.nonce, generation: grant.generation, slot: grant.slot }
  })
  handle('reading-room:release-reader-lease', (_event, id: unknown) => {
    const context = contexts.current()
    const grant = typeof id === 'string' ? readerRegistry.grants.get(id) : undefined
    // Closing a previous selection must be possible after the owner's selection epoch changes.
    if (!grant || grant.owner.id !== context.owner.id || grant.owner.top !== context.owner.top) throw new Error('Reader lease owner mismatch.')
    readerRegistry.revoke(grant.id)
  })
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
    owner: number
    epoch: number
    libraryId: number
  }>()
  const seededDocument = e2eDocument()
  function currentDocument(): ReadingRoomDocument | null {
    const context = contexts.current()
    return (context.draftPath ? store.getDraftDocument(context.draftPath) : context.unboundDocument) ?? seededDocument ?? null
  }
  function bookmarks() { return createReadingRoomBookmarks({ currentDocument, store }) }
  function rememberDocument(document: ReadingRoomDocument): void {
    const context = contexts.current()
    if (context.draftPath) store.saveDraftDocument(context.draftPath, document)
    else context.unboundDocument = document
    store.recordRecentDocument(document)
  }
  function documentIdentity(document: ReadingRoomDocument): string {
    return JSON.stringify([document.libraryId, document.attachmentKey, document.path])
  }
  function requireReaderLease(input: unknown): () => void {
    if (!isRecord(input)) throw new Error('Reader lease is required.')
    const grant = readerRegistry.owned(input.lease, contexts.current().owner)
    const document = currentDocument()
    if (!document || grant.documentIdentity !== documentIdentity(document)) throw new Error('Reader document identity mismatch.')
    const completeOwner = contexts.admitCompletion()
    const admitted = { id: grant.id, generation: grant.generation, documentIdentity: grant.documentIdentity,
      owner: { ...grant.owner } }
    return () => {
      completeOwner()
      if (!grant.live || readerRegistry.grants.get(admitted.id) !== grant
        || grant.generation !== admitted.generation || grant.documentIdentity !== admitted.documentIdentity
        || grant.owner.id !== admitted.owner.id || grant.owner.top !== admitted.owner.top
        || grant.owner.origin !== admitted.owner.origin) {
        throw new Error('The admitted reader lease is no longer live.')
      }
    }
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
    contexts.checkIfBound()
    if (throughPlugin.kind === 'read') return { annotations: throughPlugin.annotations, read: { authoritative: true, startedAt } }
    const databasePath = zoteroDatabasePath()
    const bracketed = await zoteroLibrary.read(() => readBracketed(databasePath, () => readAnnotations(
      createNodeSqliteDriver(), databasePath, libraryId, attachmentKey,
    )))
    contexts.checkIfBound()
    const authoritative = throughPlugin.code === 'zotero-closed' && bracketed.complete
    // The file read has the tags but not Zotero's modification stamp.
    const annotations = bracketed.value.map((annotation) => ({ ...annotation, zoteroState: { modified: null, tags: [...annotation.tags] } }))
    return { annotations, read: { authoritative, startedAt } }
  }

  const pluginWatcher = createZoteroPluginWatcher({
    ...(options.pluginWatcherClock ? { clock: options.pluginWatcherClock } : {}),
    drain: async () => {
      const report = await drainEverything()
    contexts.checkIfBound()
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
    contexts.checkIfBound()
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
        contexts.checkIfBound()
        librarySegments = new Map()
      }
    }
    contexts.checkIfBound()
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
        selection: contexts.current().selection,
        roomWidth,
        viewState,
      } satisfies ReadingRoomState
    }
    return {
      citationBaseLink: await citationBaseLinkFor(document, knownSegments),
      document,
      selection: contexts.current().selection,
      roomWidth,
      viewState,
    } satisfies ReadingRoomState
  }

  /**
   * The Room's state for one draft. The argument is the draft the Room is beside, and passing it is
   * how the Room is TOLD which draft it is beside — the renderer calls this again on every draft
   * switch, which is what makes "switch essay, switch reading" one code path with the launch restore.
   */
  handle('reading-room:get-state', async (_event, rawDraftPath: unknown) => {
    const previous = currentDocument()
    contexts.select(draftPathFrom(rawDraftPath))
    const next = currentDocument(), context = contexts.current()
    if (previous && next && previous.path === next.path && previous.attachmentKey === next.attachmentKey && previous.libraryId === next.libraryId) {
      for (const grant of readerRegistry.grants.values()) {
        if (grant.live && grant.owner.id === context.owner.id && grant.owner.top === context.owner.top && grant.documentIdentity === documentIdentity(next)) grant.owner.epoch = context.owner.epoch
      }
    }
    return await readingRoomState()
  })

  registerReaderShelfOperations({ handle, store, shelf, contexts, draftPathFrom, rememberDocument, readingRoomState })

  registerReaderDocumentOperations({ handle, store, contexts, requireReaderLease, currentDocument, readZoteroAnnotations, shelf, drainEverything, drainFacts })

  handle('reading-room:begin-area-quotation', (_event, input: unknown): string => {
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
      || !contexts.current().draftPath
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
      draftPath: contexts.current().draftPath!,
      owner: contexts.current().owner.id,
      epoch: contexts.current().owner.epoch,
      expiresAt: Date.now() + 5 * 60_000,
      libraryId: input.libraryId,
    })
    return receipt
  })

  handle('reading-room:record-area-quotation', async (_event, input: unknown): Promise<{
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
      || receipt.owner !== contexts.current().owner.id
      || receipt.epoch !== contexts.current().owner.epoch
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
    contexts.checkIfBound()
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
  handle('reading-room:drain-outbox', async (): Promise<{
    waiting: number
    rejected: number
    notWritten?: string
    notWrittenCode?: DrainSkipReason
  }> => {
    const before = zoteroOutboxCounts(store)
    if (before.waiting === 0) return before
    const report = await drainEverything()
    contexts.checkIfBound()
    return {
      ...zoteroOutboxCounts(store),
      ...drainFacts(report),
    }
  })

  /** Show the bundled WriteFlex plugin file in Finder, so he can install it in Zotero. */
  handle('reading-room:show-zotero-plugin', (): boolean => {
    const file = bundledZoteroPluginFile()
    if (!file) return false
    shell.showItemInFolder(file)
    return true
  })

  /** Both sync signals cross IPC explicitly; the renderer never infers one from the other. */
  handle(
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
    contexts.check()
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
  handle('reading-room:refused-highlights', (): Promise<RefusedHighlight[]> => refusedList())

  /** Try a refused insert again. The row is requeued and a drain is attempted at once. */
  handle('reading-room:retry-refused', async (_event, id: unknown): Promise<{
    waiting: number
    rejected: number
    notWritten?: string
    notWrittenCode?: DrainSkipReason
  }> => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || !retryRefused(store, id)) {
      return zoteroOutboxCounts(store)
    }
    const report = await drainEverything()
    contexts.checkIfBound()
    return {
      ...zoteroOutboxCounts(store),
      ...drainFacts(report),
    }
  })

  /** Stop counting a refused row. The highlight is kept and still drawn; nothing is deleted. */
  handle('reading-room:dismiss-refused', (_event, id: unknown): ReadingRoomOutboxCounts => {
    if (typeof id === 'number' && Number.isSafeInteger(id)) dismissRefused(store, id)
    return zoteroOutboxCounts(store)
  })

  handle('reading-room:read-document', async (_event, input: unknown) => {
    requireReaderLease(input)
    const document = currentDocument()
    if (!document) throw new Error('The Reading Room can read only its remembered document.')
    const bytes = new Uint8Array(await readFile(document.path))
    contexts.check()
    requireReaderLease(input)
    if (currentDocument()?.path !== document.path) throw new Error('The reader document changed during its read.')
    return bytes
  })
  handle('reading-room:add-bookmark', (_event, input: unknown): ReadingBookmarkRow => {
    requireReaderLease(input)
    return bookmarks().add(input)
  })
  handle('reading-room:list-bookmarks', (): ReadingBookmarkRow[] => bookmarks().list())
  handle('reading-room:save-view-state', (_event, input: unknown) => {
    requireReaderLease(input)
    return bookmarks().savePosition(input)
  })

  handle('reading-room:save-width', (_event, rawWidth: unknown) => {
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
      ipcMain.removeHandler('reading-room:get-reader-notices')
      ipcMain.removeHandler('reading-room:create-reader-lease')
      ipcMain.removeHandler('reading-room:release-reader-lease')
      for (const grant of readerRegistry.grants.values()) readerRegistry.revoke(grant.id)
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
