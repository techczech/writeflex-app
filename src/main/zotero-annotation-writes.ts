/**
 * Annotation writes — the path from a highlight made in the reader to Zotero owning it.
 *
 * ```
 * reader saves ──▶ payload mapping ──▶ OUTBOX (durable, local) ──▶ WriteFlex plugin in Zotero ──▶ confirmed
 *                                        ▲                              ▲
 *          the durability boundary: the reader             only while Zotero is OPEN, saved through
 *          is told "saved" HERE, never at the write        Zotero's own code (ADR-0047)
 * ```
 *
 * **ADR-0047 replaced the destination and kept everything else.** WriteFlex no longer writes
 * `zotero.sqlite` at all; each change goes to the WriteFlex plugin over Zotero's local HTTP server
 * (`zotero-plugin-transport.ts`), which saves it with Zotero's own item code. The payload shape below is
 * unchanged, and so is the outbox: a queue that survives "Zotero is not open, try later" is exactly what
 * the plugin route needs, and ADR-0029's painted union of Zotero-plus-outbox means the mark appears
 * immediately either way.
 */
import type { OutboxEntry } from '@readflex/sidecar'
import { generateZoteroObjectKey } from '@readflex/zotero-bridge'

/** The fields of one annotation as the reader showed them: the before-state of an edit or deletion. */
/**
 * What Zotero held for a mark beyond its fields when it was read: its tags and the item's
 * `clientDateModified`, which Zotero bumps on every saved change. A deletion is refused when either
 * differs (ADR-0047). `modified` is null when the read did not report it.
 */
export type ZoteroState = { modified: string | null; tags: string[] }

/** A `ZoteroState` as sent back by the reader, checked; null when not one. */
export function validZoteroState(value: unknown): ZoteroState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as Record<string, unknown>
  if (!Array.isArray(state.tags) || !state.tags.every((tag) => typeof tag === 'string')) return null
  if (state.modified !== null && state.modified !== undefined && typeof state.modified !== 'string') return null
  return { modified: (state.modified as string | null | undefined) ?? null, tags: [...state.tags as string[]] }
}

export type ZoteroAnnotationFields = {
  /** The annotation type as the reader showed it. Absent on rows queued before it was recorded. */
  type?: string
  /** On a deletion's baseline: what Zotero held beyond the fields, when the reader knew it. */
  zoteroState?: ZoteroState
  text: string | null
  comment: string | null
  color: string | null
  pageLabel: string | null
  sortIndex: string
  /** Position JSON as a string; compared structurally, not byte for byte. */
  position: string
}

/** The reader's annotation, as the seam hands it over. */
export type SavedAnnotation = {
  key: string
  type: 'highlight' | 'note' | 'image' | 'ink' | 'underline' | 'text'
  text: string | null
  comment: string | null
  color: string | null
  pageLabel: string | null
  sortIndex: string
  /** Reader-supplied position JSON, preserved verbatim. */
  position: string
  tags: string[]
}

/** The keyless annotation the reader seam exposes for a live text selection (ReadFlex ADR-0035). */
export type CitationSelectionAnnotation = Omit<SavedAnnotation, 'comment' | 'key' | 'tags'>

export const MAX_ANNOTATION_POSITION_BYTES = 32 * 1024
export const MAX_ANNOTATION_TEXT_BYTES = 64 * 1024
export const MAX_ANNOTATION_COMMENT_BYTES = 2 * 1024
export const MAX_CITATION_DOCUMENT_TITLE_CHARACTERS = 200
export const LOCAL_ONLY_NON_PDF_REASON =
  "Marks on web pages and EPUBs stay here for now — sending them to Zotero isn't built yet"
export const LOCAL_ONLY_COMPLEX_PDF_REASON =
  'This mark is too complex to send to Zotero, so it stays here'
/** Kept as the public name for the original web/EPUB sentence. */
export const LOCAL_ONLY_POSITION_REASON = LOCAL_ONLY_NON_PDF_REASON
/**
 * The sentence releases up to 0.27.0-alpha.1 stored on edits and deletions while no write path for
 * them existed (ADR-0031 then covered the insert only). **No longer written.** Kept so the one-time
 * release on open (`releaseKeptEdits`) can recognise those rows by exact text; any reword of an old
 * sentence belongs in `LEGACY_UNSUPPORTED_ZOTERO_EDIT_REASONS`.
 */
export const UNSUPPORTED_ZOTERO_EDIT_REASON =
  'Editing a highlight in Zotero itself is not something WriteFlex does yet, so this change is kept here.'

/**
 * Earlier wordings of `UNSUPPORTED_ZOTERO_EDIT_REASON` that may still sit in stored outbox rows (the
 * app was called ReadFlex then). Recognised on read; never written.
 */
export const LEGACY_UNSUPPORTED_ZOTERO_EDIT_REASONS: readonly string[] = [
  'Editing a highlight in Zotero itself is not something ReadFlex does yet, so this change is kept here.'
]

/**
 * An edit or deletion that does not record what the highlight looked like before it. Writing it
 * could put back text changed in Zotero since, so it is listed as a conflict and never sent.
 */
export const UNVERIFIABLE_CHANGE_REASON =
  'This change does not record what the highlight looked like before it, so it was not written in case it overwrites a change made in Zotero. Your version is kept here.'

/** A comment edited past what one annotation carries. Refused whole; never cut short. */
export const COMMENT_TOO_LONG_REASON =
  'This comment is longer than a Zotero highlight comment written from here can be, so the change was not written. Shorten it and it will be sent; the full text is kept here.'

/** True when a stored `last_error` is the current or any legacy kept-edit sentence. */
export function isUnsupportedZoteroEditReason(lastError: string | null | undefined): boolean {
  return (
    lastError === UNSUPPORTED_ZOTERO_EDIT_REASON ||
    (typeof lastError === 'string' && LEGACY_UNSUPPORTED_ZOTERO_EDIT_REASONS.includes(lastError))
  )
}

export function annotationPositionWithinCap(position: string): boolean {
  return Buffer.byteLength(position, 'utf8') <= MAX_ANNOTATION_POSITION_BYTES
}

export function annotationTextWithinCap(text: string | null): boolean {
  return text === null || Buffer.byteLength(text, 'utf8') <= MAX_ANNOTATION_TEXT_BYTES
}

function truncateWithEllipsis(value: string, maxCharacters: number): string {
  const characters = Array.from(value)
  return characters.length <= maxCharacters
    ? value
    : `${characters.slice(0, maxCharacters - 1).join('')}…`
}

function truncateUtf8WithEllipsis(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const ellipsis = '…'
  const contentBytes = maxBytes - Buffer.byteLength(ellipsis, 'utf8')
  let result = ''
  for (const character of value) {
    if (Buffer.byteLength(result + character, 'utf8') > contentBytes) break
    result += character
  }
  return `${result}${ellipsis}`
}

/**
 * The verified `api.zotero.org` annotation payload (ADR-0002, checked against the live API 2026-07-26).
 *
 * `annotation` is absent from the public `GET /itemTypes` list — that is a listing omission in Zotero's
 * documentation, not a missing capability, and the type is accepted. Do not "fix" it by removing it.
 */
export type ZoteroAnnotationPayload = {
  itemType: 'annotation'
  annotationType: SavedAnnotation['type']
  parentItem: string
  annotationText: string
  annotationComment: string
  annotationColor: string
  annotationPageLabel: string
  annotationSortIndex: string
  annotationPosition: Record<string, unknown>
  tags: Array<{ tag: string }>
  /** Present only on an update: the version the edit is based on, for conflict detection. */
  version?: number
  /** Main-process-only identity retained for Area creates; ignored by Zotero's field mapping. */
  readflexSourceKey?: string
  /** Main-process-only allowlist marker for the sole accepted local annotation update. */
  readflexAreaQuotation?: { sourceKey: string; comment: string }
  /**
   * Main-process-only: on an edit or deletion, the annotation as the reader showed it before the
   * change. The write is compare-and-set against it and writes only the fields that differ from it.
   */
  readflexBaseline?: ZoteroAnnotationFields | null
  /**
   * Main-process-only: the reader instance that made the change. A create re-keyed because Zotero
   * already held its key is resolved to the new key only for later changes from this same instance.
   */
  readflexReaderSession?: string
}

const READER_SESSION_PATTERN = /^[0-9a-f]{32}$/

/** The reader session a payload carries, when it is one; null otherwise. */
export function readerSessionOf(payload: { readflexReaderSession?: unknown } | null | undefined): string | null {
  const session = payload?.readflexReaderSession
  return typeof session === 'string' && READER_SESSION_PATTERN.test(session) ? session : null
}

export function areaQuotationPayload(
  source: ZoteroAnnotationPayload,
  sourceKey: string,
  comment: string,
): ZoteroAnnotationPayload {
  return {
    ...source,
    annotationComment: comment,
    readflexAreaQuotation: { sourceKey, comment },
  }
}

/** Zotero's own default highlight yellow, used when the reader hands over no colour. */
const DEFAULT_COLOUR = '#ffd400'

function parsePosition(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { pageIndex: 0, rects: [] }
  } catch {
    return { pageIndex: 0, rects: [] }
  }
}

/** Citation-created highlights are limited to structurally valid PDF positions in v1. */
export function isPdfCitationPosition(raw: string): boolean {
  const position = parsePosition(raw)
  return (
    typeof position.pageIndex === 'number'
    && Number.isFinite(position.pageIndex)
    && Array.isArray(position.rects)
    && position.rects.length > 0
    && position.rects.every((rect) =>
      Array.isArray(rect)
      && rect.length === 4
      && rect.every((value) => typeof value === 'number' && Number.isFinite(value)))
  )
}

/**
 * The API payload for one annotation. A thin field mapping in both directions rather than a translation
 * layer — which is the strongest practical argument for the split read/write path (ADR-0002).
 */
export function annotationPayload(
  annotation: SavedAnnotation,
  parentItemKey: string,
  version?: number,
  /** Edits and deletions keep the comment whole: a cut comment would be written over the real one. */
  options: { keepWholeComment?: boolean } = {},
): ZoteroAnnotationPayload {
  return {
    annotationColor: annotation.color ?? DEFAULT_COLOUR,
    annotationComment: options.keepWholeComment
      ? annotation.comment ?? ''
      : truncateUtf8WithEllipsis(annotation.comment ?? '', MAX_ANNOTATION_COMMENT_BYTES),
    annotationPageLabel: annotation.pageLabel ?? '',
    annotationPosition: parsePosition(annotation.position),
    annotationSortIndex: annotation.sortIndex,
    annotationText: annotation.text ?? '',
    annotationType: annotation.type,
    itemType: 'annotation',
    parentItem: parentItemKey,
    tags: annotation.tags.map((tag) => ({ tag })),
    ...(version === undefined ? {} : { version }),
  }
}

/**
 * Turn a live reader selection into a Zotero create. The key is generated here, locally, with the
 * same alphabet Zotero uses; the reader selection itself has no persisted identity yet.
 */
export function citationAnnotation(
  selection: CitationSelectionAnnotation,
  documentTitle: string,
  now: Date = new Date(),
  random: () => number = Math.random,
): SavedAnnotation {
  return {
    ...selection,
    comment: quotationComment(documentTitle, now),
    key: generateZoteroObjectKey(random),
    tags: [],
  }
}

/** The one shared human-readable statement that a draft actually quoted an annotation. */
export function quotationComment(documentTitle: string, now: Date = new Date()): string {
  const humanDate = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now)
  const boundedTitle = truncateWithEllipsis(
    documentTitle,
    MAX_CITATION_DOCUMENT_TITLE_CHARACTERS,
  )
  return truncateUtf8WithEllipsis(
    `Quoted in "${boundedTitle}" — ${humanDate}`,
    MAX_ANNOTATION_COMMENT_BYTES,
  )
}

/**
 * Find only a mark this app itself created, represented by its retained outbox row. Matching is
 * deliberately exact and narrow: same library and attachment, and byte-identical complete position
 * JSON. Text, overlap, proximity and sort order never participate.
 */
export function findExactCitationAnnotation(
  entries: readonly OutboxEntry[],
  libraryId: number,
  attachmentKey: string,
  selectionPosition: string,
): OutboxEntry | null {
  if (!isPdfCitationPosition(selectionPosition)) return null
  for (const entry of entries) {
    if (
      entry.operation !== 'create'
      || entry.libraryId !== libraryId
      || entry.parentItemKey !== attachmentKey
      || !entry.itemKey
    ) {
      continue
    }
    try {
      const payload = JSON.parse(entry.payload) as ZoteroAnnotationPayload
      if (payload.annotationType !== 'highlight') continue
      if (JSON.stringify(payload.annotationPosition) === selectionPosition) {
        return entry
      }
    } catch {
      // An unreadable outbox payload is handled by the drain and cannot establish exact identity.
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/** What the outbox needs from a transport, so tests can supply a stub and no library is required. */
export type ZoteroWriteTransport = (request: {
  libraryId: number
  operation: OutboxEntry['operation']
  itemKey: string | null
  /** The attachment the outbox row belongs to. Absent only in older stubs; the payload's
   *  `parentItem` is then used, which `annotationPayload` always sets to the same key. */
  parentItemKey?: string
  payload: ZoteroAnnotationPayload
  /**
   * True when an earlier write of this row was cut off (the app stopped mid-write). Zotero may already
   * hold it: a create must not be made twice, and an edit or deletion Zotero already shows is done.
   */
  resend?: boolean
}) => Promise<ZoteroWriteOutcome>

export type ZoteroWriteOutcome =
  /** The server took it; `itemKey` is the key it assigned to a create. */
  | { kind: 'confirmed'; itemKey?: string; note?: string }
  /** Someone else edited this annotation. Last writer wins; the loser is kept (ADR-0002). */
  | { kind: 'conflict'; reason: string; winningPayload?: string; code?: 'key-in-use' }
  /**
   * Try again later. `halt` stops this drain: Zotero or its plugin cannot take anything now, and
   * `code` says why. `uncertain` means the request may have reached Zotero (no answer came back), so
   * the next attempt is sent as a resend.
   */
  | { kind: 'retry'; reason: string; halt?: boolean; code?: DrainSkipReason; uncertain?: boolean }
  /** A person must look at it — malformed, forbidden, the parent is gone. */
  | { kind: 'rejected'; reason: string }
  /** Nothing is wrong and nothing was written: this kind of change has no write path. The entry
   *  is kept and drawn here, and is not a refusal. No transport in this module returns it any more;
   *  kept for stubs and older callers. */
  | { kind: 'kept-local'; reason: string }

/** The subset of the sidecar the drain touches, so the drain can be tested without a real store. */
export type OutboxStore = {
  outboxDue(limit?: number): OutboxEntry[]
  /** Returns false (row left waiting) when `sentRevision` is given and is not the stored revision. */
  markOutboxConfirmed(id: number, itemKey?: string, sentRevision?: number): boolean | void
  markOutboxFailed(id: number, reason: string, retryable?: boolean): void
  markOutboxConflict(id: number, losingPayload: string, reason: string): void
  /** Keep the entry drawn here and out of both sync counts. Never deletes or rewrites the payload. */
  markOutboxLocalOnly(id: number, reason: string): void
  outboxByStatus?(status: 'confirmed'): OutboxEntry[]
  /** The row as it is now. A drain re-reads every row before writing it, never a stale batch copy. */
  outboxEntry?(id: number): OutboxEntry | null
  /**
   * Claim a row before writing it: one sidecar transaction marks it as being sent at its current
   * payload revision, so no reader change can fold into or cancel it while the write is in flight.
   * Null when it is no longer due or another drain holds it.
   */
  claimOutboxForSending?(id: number): OutboxEntry | null
  /** Every row for one mark, oldest first — what keeps a mark's changes in order across drains. */
  outboxRowsForKey?(libraryId: number, parentItemKey: string, itemKey: string): OutboxEntry[]
  /** The key a create is written under when Zotero already used the reader's key. */
  outboxKeyReplacement?(libraryId: number, parentItemKey: string, readerKey: string, readerSession?: string | null): string | null
  /** Record the fresh key WriteFlex chose for a create whose key Zotero already used, for its reader session. */
  recordOutboxKeyReplacement?(libraryId: number, parentItemKey: string, readerKey: string, zoteroKey: string, readerSession?: string | null): void
  /** A send with no answer: waits again, marked so the next attempt is a resend. */
  markOutboxSendUncertain?(id: number, reason: string): void
}

/**
 * Why a drain wrote nothing more. Every one of these leaves the highlight safe in the queue: writing it
 * to Zotero is a later, repeatable act, and the reason is recorded on every row it held back
 * (`retrying`, attempt counted, reason stored) so it is never silent.
 *
 * - `zotero-closed` — nothing answers on Zotero's local port. The ordinary wait, not an error.
 * - `zotero-busy` — Zotero did not answer in time. Also a wait.
 * - `plugin-missing` / `plugin-outdated` — Zotero is open without the WriteFlex plugin, or with one that
 *   speaks another protocol. He installs the bundled plugin file.
 * - `plugin-not-paired` — the plugin did not accept WriteFlex's key.
 * - `no-credential` — no transport at all (tests and stubs).
 */
export type DrainSkipReason =
  | 'no-credential'
  | 'zotero-closed'
  | 'zotero-busy'
  | 'plugin-missing'
  | 'plugin-outdated'
  | 'plugin-not-paired'

export type DrainReport = {
  attempted: number
  confirmed: number
  conflicted: number
  retrying: number
  rejected: number
  /** Rows kept here by a transport that has no write path for them. Not refusals. */
  keptLocal: number
  /** Set when nothing was attempted and nothing was lost. */
  skipped: DrainSkipReason | null
  /** What to tell a person when `skipped` is set — a plain instruction, never a warning. */
  skippedReason?: string
}

/** One line of the write log: one attempt (or one refusal) for one outbox row. */
export type ZoteroWriteAttempt = {
  operation: OutboxEntry['operation']
  key: string | null
  outbox: number
  /** `confirmed`, `retry`, `rejected`, `conflict`, `kept-local`, or `refused:<code>`. */
  outcome: string
  reason?: string
}

export type ZoteroWriteAttemptLog = (attempt: ZoteroWriteAttempt) => void

export const SENT_REVISION_SUPERSEDED =
  'This change was replaced by a newer one while it was being written, so it is still waiting.'

/**
 * True when an edit or deletion must wait for an earlier change to the same mark that is still owed
 * to Zotero (waiting, or being written). Creates never wait. An earlier change Zotero refused does
 * not hold the later ones back: they are written or refused on their own, each with its reason.
 */
function waitsForEarlierChange(store: OutboxStore, entry: OutboxEntry): boolean {
  if (entry.operation === 'create' || !entry.itemKey || !store.outboxRowsForKey) return false
  return store
    .outboxRowsForKey(entry.libraryId, entry.parentItemKey, entry.itemKey)
    .some((row) =>
      row.id < entry.id
      && row.localOnly === 0
      && (row.status === 'pending' || row.status === 'retrying'))
}

/**
 * Write what is owed. With **nowhere to write the drain is a no-op** — entries stay queued, which is
 * the whole point of a durable outbox: the highlight is already safe, and writing it is a later,
 * repeatable act.
 */
export async function drainOutbox(
  store: OutboxStore,
  transport: ZoteroWriteTransport | null,
  limit = 25,
  log: ZoteroWriteAttemptLog = () => {},
): Promise<DrainReport> {
  const report: DrainReport = {
    attempted: 0,
    confirmed: 0,
    conflicted: 0,
    keptLocal: 0,
    rejected: 0,
    retrying: 0,
    skipped: null,
  }
  if (!transport) {
    report.skipped = 'no-credential'
    return report
  }
  const due = store.outboxDue(limit)
  for (let index = 0; index < due.length; index += 1) {
    // Yield between rows so a long drain never holds the main process (the editor stays live).
    if (index > 0) await new Promise<void>((resolve) => setImmediate(resolve))
    // Re-read: an earlier row in this batch may have changed this one (a confirmation, a cancel).
    const current = store.outboxEntry ? store.outboxEntry(due[index]!.id) : due[index]!
    if (
      !current
      || (current.status !== 'pending' && current.status !== 'retrying')
      || current.localOnly !== 0
    ) continue
    // A mark's changes reach Zotero in the order they were made: one whose earlier change is still
    // owed (or whose create never reached Zotero) waits, untouched, for a later drain.
    if (waitsForEarlierChange(store, current)) continue
    // Claim it: from here until its outcome is recorded, nothing may fold into it or cancel it.
    const entry = store.claimOutboxForSending ? store.claimOutboxForSending(current.id) : current
    if (!entry) continue
    const attempt = { key: entry.itemKey, operation: entry.operation, outbox: entry.id }
    let payload: ZoteroAnnotationPayload
    try {
      payload = JSON.parse(entry.payload) as ZoteroAnnotationPayload
    } catch {
      // Unparseable payload is not retryable and must not block the queue behind it.
      const reason = 'This highlight could not be read back for sending.'
      store.markOutboxFailed(entry.id, reason, false)
      report.attempted += 1
      report.rejected += 1
      log({ ...attempt, outcome: 'rejected', reason })
      continue
    }
    report.attempted += 1
    let outcome: ZoteroWriteOutcome
    try {
      outcome = await transport({
        itemKey: entry.itemKey,
        libraryId: entry.libraryId,
        operation: entry.operation,
        parentItemKey: entry.parentItemKey,
        payload,
        ...(entry.sendInterrupted === 1 ? { resend: true } : {}),
      })
    } catch (error) {
      // A thrown transport is a network fact, not a data fact: keep it queued.
      outcome = {
        kind: 'retry',
        reason: error instanceof Error ? error.message : 'The connection failed.',
      }
    }
    switch (outcome.kind) {
      case 'confirmed': {
        // Confirm only the revision that was sent. A row whose payload moved on stays waiting.
        const sentRevision = typeof entry.revision === 'number' ? entry.revision : undefined
        if (store.markOutboxConfirmed(entry.id, outcome.itemKey, sentRevision) === false) {
          report.retrying += 1
          log({ ...attempt, outcome: 'retry', reason: SENT_REVISION_SUPERSEDED })
          break
        }
        report.confirmed += 1
        log({ ...attempt, outcome: 'confirmed', ...(outcome.note ? { reason: outcome.note } : {}) })
        break
      }
      case 'conflict':
        store.markOutboxConflict(entry.id, entry.payload, outcome.reason)
        report.conflicted += 1
        log({ ...attempt, outcome: 'conflict', reason: outcome.reason })
        break
      case 'retry': {
        if (outcome.uncertain && store.markOutboxSendUncertain) {
          store.markOutboxSendUncertain(entry.id, outcome.reason)
        } else {
          store.markOutboxFailed(entry.id, outcome.reason, true)
        }
        report.retrying += 1
        const code = outcome.code ?? 'zotero-closed'
        log({ ...attempt, outcome: outcome.halt ? `refused:${code}` : 'retry', reason: outcome.reason })
        if (outcome.halt) {
          // Zotero or its plugin stopped taking writes mid-drain. The rest of the batch is held back
          // with the same reason.
          for (const rest of due.slice(index + 1)) {
            const current = store.outboxEntry ? store.outboxEntry(rest.id) : rest
            if (!current || (current.status !== 'pending' && current.status !== 'retrying') || current.localOnly !== 0) continue
            store.markOutboxFailed(current.id, outcome.reason, true)
            log({ key: current.itemKey, operation: current.operation, outbox: current.id, outcome: `refused:${code}`, reason: outcome.reason })
          }
          report.skipped = code
          report.skippedReason = outcome.reason
          return report
        }
        break
      }
      case 'rejected':
        store.markOutboxFailed(entry.id, outcome.reason, false)
        report.rejected += 1
        log({ ...attempt, outcome: 'rejected', reason: outcome.reason })
        break
      case 'kept-local':
        store.markOutboxLocalOnly(entry.id, outcome.reason)
        report.keptLocal += 1
        log({ ...attempt, outcome: 'kept-local', reason: outcome.reason })
        break
    }
  }
  return report
}

// ---------------------------------------------------------------------------
// Which mark a change means, and what it changes from
// ---------------------------------------------------------------------------

/**
 * Which annotation an edit or deletion means, decided per row at write time. The reader names a mark
 * by its own key. If the create was written under another key because Zotero already held the
 * reader's, the new key is used, but only for a change from the reader instance that made the create:
 * that instance alone shows the mark under the old key. Any other reader read the mark from Zotero
 * under its new key, so the old key in its changes means whatever Zotero holds under it.
 */
export function resolveTarget(
  store: Pick<OutboxStore, 'outboxKeyReplacement'> | undefined,
  libraryId: number,
  parentItemKey: string,
  readerKey: string,
  readerSession: string | null,
): { key: string; supersededKey: string | null } {
  if (!readerSession) return { key: readerKey, supersededKey: null }
  const replacement = store?.outboxKeyReplacement?.(libraryId, parentItemKey, readerKey, readerSession) ?? null
  return replacement && replacement !== readerKey
    ? { key: replacement, supersededKey: readerKey }
    : { key: readerKey, supersededKey: null }
}

/** A before-state as sent by the reader or stored on a row, checked field by field; null if unusable. */
export function validBaseline(value: unknown): ZoteroAnnotationFields | null {
  if (!value || typeof value !== 'object') return null
  const baseline = value as Record<string, unknown>
  const optionalText = (field: unknown) => field === null || field === undefined || typeof field === 'string'
  if (
    typeof baseline.sortIndex !== 'string'
    || typeof baseline.position !== 'string'
    || !optionalText(baseline.text)
    || !optionalText(baseline.comment)
    || !optionalText(baseline.color)
    || !optionalText(baseline.pageLabel)
  ) return null
  return {
    color: (baseline.color as string | null | undefined) ?? null,
    comment: (baseline.comment as string | null | undefined) ?? null,
    pageLabel: (baseline.pageLabel as string | null | undefined) ?? null,
    position: baseline.position,
    sortIndex: baseline.sortIndex,
    text: (baseline.text as string | null | undefined) ?? null,
    ...(typeof baseline.type === 'string' && baseline.type ? { type: baseline.type } : {}),
    ...(validZoteroState(baseline.zoteroState) ? { zoteroState: validZoteroState(baseline.zoteroState)! } : {}),
  }
}
