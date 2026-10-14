/**
 * Annotation writes — the path from a highlight made in the reader to Zotero owning it.
 *
 * ```
 * reader saves ──▶ payload mapping ──▶ OUTBOX (durable, local) ──▶ zotero.sqlite ──▶ confirmed
 *                                        ▲                            ▲
 *          the durability boundary: the reader                 only with Zotero CLOSED, after a
 *          is told "saved" HERE, never at the write             copy of the library (ADR-0031)
 * ```
 *
 * **ADR-0031 reversed the destination and kept everything else.** Writes go into the user's own
 * `zotero.sqlite`, refused while Zotero is running, rather than through `api.zotero.org`: network
 * credentials can also grant write access to shared group libraries, where an incorrect write
 * could affect other library members (ADR-0030). The
 * payload shape below is unchanged, because ADR-0002 verified it maps one-to-one onto the local
 * `itemAnnotations` columns — that verification is what makes the reversal cheap.
 *
 * The outbox is unchanged too, and matters more now than it did for the network: a queue that
 * survives "Zotero is open, try later" is exactly what a refusal needs, and ADR-0029's painted union
 * of Zotero-plus-outbox means the mark appears immediately either way.
 */
import type { OutboxEntry } from '@readflex/sidecar'
import type {
  NewZoteroAnnotation,
  WritableZoteroAnnotationType,
  WrittenZoteroAnnotation,
  ZoteroAnnotationWriteRefusal,
  ZoteroAnnotationWriteSession,
  ZoteroLivenessProbes,
} from '@readflex/zotero-bridge'
import { generateZoteroObjectKey } from '@readflex/zotero-bridge'

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
 * Why an edit or a deletion of a mark is kept here instead of written. The local Zotero write covers
 * the insert and nothing else (ADR-0031), so this is a fact about what is built, not a refusal by
 * Zotero: the row is stored local-only and is never counted or shown as refused.
 *
 * **This is the only definition of the current sentence.** Releases up to 0.21.0-alpha.32 stored an
 * earlier wording as the `last_error` of `failed` rows, and `reconcileKeptEdits` recognises those rows
 * by exact text. Any reword must move the previous sentence into `LEGACY_UNSUPPORTED_ZOTERO_EDIT_REASONS`.
 */
export const UNSUPPORTED_ZOTERO_EDIT_REASON =
  'Editing a highlight in Zotero itself is not something WriteFlex does yet, so this change is kept here.'

/**
 * Earlier wordings of `UNSUPPORTED_ZOTERO_EDIT_REASON` that may still sit in stored `failed` outbox
 * rows (the app was called ReadFlex then). Recognised on read; never written.
 */
export const LEGACY_UNSUPPORTED_ZOTERO_EDIT_REASONS: readonly string[] = [
  'Editing a highlight in Zotero itself is not something ReadFlex does yet, so this change is kept here.'
]

/** True when a stored `last_error` is the current or any legacy kept-edit sentence. */
export function isUnsupportedZoteroEditReason(lastError: string | null | undefined): boolean {
  return (
    lastError === UNSUPPORTED_ZOTERO_EDIT_REASON ||
    (typeof lastError === 'string' && LEGACY_UNSUPPORTED_ZOTERO_EDIT_REASONS.includes(lastError))
  )
}

/**
 * True for an operation the local Zotero write has no path for: every `delete`, and every `update`
 * except the Area quotation comment, which has its own narrow write (`setImageQuotation`).
 */
export function isUnsupportedZoteroOperation(
  operation: OutboxEntry['operation'],
  payload: Pick<ZoteroAnnotationPayload, 'readflexAreaQuotation'>,
): boolean {
  if (operation === 'delete') return true
  return operation === 'update' && !payload.readflexAreaQuotation
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
): ZoteroAnnotationPayload {
  return {
    annotationColor: annotation.color ?? DEFAULT_COLOUR,
    annotationComment: truncateUtf8WithEllipsis(
      annotation.comment ?? '',
      MAX_ANNOTATION_COMMENT_BYTES,
    ),
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
  payload: ZoteroAnnotationPayload
}) => Promise<ZoteroWriteOutcome>

export type ZoteroWriteOutcome =
  /** The server took it; `itemKey` is the key it assigned to a create. */
  | { kind: 'confirmed'; itemKey?: string }
  /** Someone else edited this annotation. Last writer wins; the loser is kept (ADR-0002). */
  | { kind: 'conflict'; reason: string; winningPayload?: string }
  /** Try again later — offline, rate-limited, a 5xx. */
  | { kind: 'retry'; reason: string }
  /** A person must look at it — malformed, forbidden, the parent is gone. */
  | { kind: 'rejected'; reason: string }
  /** Nothing is wrong and nothing was written: this kind of change has no write path yet. The entry
   *  is kept and drawn here, and is not a refusal. */
  | { kind: 'kept-local'; reason: string }

/** The subset of the sidecar the drain touches, so the drain can be tested without a real store. */
export type OutboxStore = {
  outboxDue(limit?: number): OutboxEntry[]
  markOutboxConfirmed(id: number, itemKey?: string): void
  markOutboxFailed(id: number, reason: string, retryable?: boolean): void
  markOutboxConflict(id: number, losingPayload: string, reason: string): void
  /** Keep the entry drawn here and out of both sync counts. Never deletes or rewrites the payload. */
  markOutboxLocalOnly(id: number, reason: string): void
  outboxByStatus?(status: 'confirmed'): OutboxEntry[]
}

/**
 * Why a drain did nothing. Every one of these leaves the queue untouched, which is the point: the
 * highlight is already safe, and writing it to Zotero is a later, repeatable act.
 *
 * `no-credential` predates ADR-0031 and survives as the "there is nowhere to write to" case.
 */
export type DrainSkipReason =
  | 'no-credential'
  | 'zotero-is-open'
  | 'schema-drift'
  | 'schema-unreadable'
  | 'library-missing'

export type DrainReport = {
  attempted: number
  confirmed: number
  conflicted: number
  retrying: number
  rejected: number
  /** Edits and deletions kept here because there is no write path for them yet. Not refusals. */
  keptLocal: number
  /** Set when nothing was attempted and nothing was lost. */
  skipped: DrainSkipReason | null
  /** What to tell a person when `skipped` is set — a plain instruction, never a warning. */
  skippedReason?: string
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
  for (const entry of store.outboxDue(limit)) {
    let payload: ZoteroAnnotationPayload
    try {
      payload = JSON.parse(entry.payload) as ZoteroAnnotationPayload
    } catch {
      // Unparseable payload is not retryable and must not block the queue behind it.
      store.markOutboxFailed(entry.id, 'This highlight could not be read back for sending.', false)
      report.attempted += 1
      report.rejected += 1
      continue
    }
    report.attempted += 1
    let outcome: ZoteroWriteOutcome
    try {
      outcome = await transport({
        itemKey: entry.itemKey,
        libraryId: entry.libraryId,
        operation: entry.operation,
        payload,
      })
    } catch (error) {
      // A thrown transport is a network fact, not a data fact: keep it queued.
      outcome = {
        kind: 'retry',
        reason: error instanceof Error ? error.message : 'The connection failed.',
      }
    }
    switch (outcome.kind) {
      case 'confirmed':
        store.markOutboxConfirmed(entry.id, outcome.itemKey)
        report.confirmed += 1
        break
      case 'conflict':
        store.markOutboxConflict(entry.id, entry.payload, outcome.reason)
        report.conflicted += 1
        break
      case 'retry':
        store.markOutboxFailed(entry.id, outcome.reason, true)
        report.retrying += 1
        break
      case 'rejected':
        store.markOutboxFailed(entry.id, outcome.reason, false)
        report.rejected += 1
        break
      case 'kept-local':
        store.markOutboxLocalOnly(entry.id, outcome.reason)
        report.keptLocal += 1
        break
    }
  }
  return report
}

// ---------------------------------------------------------------------------
// The local write (ADR-0031)
// ---------------------------------------------------------------------------

/** How a session is obtained. A function rather than a value so liveness is re-read every drain:
 *  Zotero can be launched between one highlight and the next, and a session held open across the
 *  app's lifetime would be holding the library while the user tried to. */
export type ZoteroWriteSessionOpener = () =>
  | ZoteroAnnotationWriteSession
  | ZoteroAnnotationWriteRefusal

/** Annotation types the local write can produce. `unknown` has no numeric type in Zotero. */
const WRITABLE_TYPES: readonly WritableZoteroAnnotationType[] = [
  'highlight', 'note', 'image', 'ink', 'underline', 'text',
]

function writableType(type: unknown): WritableZoteroAnnotationType | null {
  return WRITABLE_TYPES.includes(type as WritableZoteroAnnotationType)
    ? (type as WritableZoteroAnnotationType)
    : null
}

/**
 * The API payload, back into the shape the local insert takes. ADR-0002 verified the mapping is
 * one-to-one in both directions, so this is a field rename and not a translation — which is why the
 * outbox could keep storing the payload it already stored when the destination changed.
 */
export function localAnnotationFromPayload(
  entry: Pick<OutboxEntry, 'libraryId' | 'itemKey' | 'parentItemKey'>,
  payload: ZoteroAnnotationPayload,
): NewZoteroAnnotation | null {
  const type = writableType(payload.annotationType)
  if (!type || typeof payload.annotationSortIndex !== 'string' || !payload.annotationSortIndex) {
    return null
  }
  return {
    color: payload.annotationColor || null,
    comment: payload.annotationComment || null,
    key: entry.itemKey,
    libraryId: entry.libraryId,
    pageLabel: payload.annotationPageLabel || null,
    parentAttachmentKey: entry.parentItemKey,
    position: JSON.stringify(payload.annotationPosition ?? { pageIndex: 0, rects: [] }),
    sortIndex: payload.annotationSortIndex,
    tags: (payload.tags ?? [])
      .map((tag) => tag.tag)
      .filter((tag): tag is string => typeof tag === 'string'),
    text: payload.annotationText || null,
    type,
  }
}

/**
 * A transport that writes into `zotero.sqlite` instead of posting (ADR-0031, decision 1).
 *
 * `create` is the whole of it. **`update` and `delete` are kept here rather than written**, because
 * ADR-0031's decisions cover the insert and nothing else, and a builder guessing at an UPDATE of a
 * row Zotero's sync engine is tracking is exactly the "hand-forging sync metadata" risk the ADR only
 * partly retired. Such an entry stays in the outbox, local-only, with its reason, so ADR-0029 still
 * draws the edited mark and nothing a reader wrote is lost — it simply has not reached Zotero. It is
 * not a refusal: Zotero was never asked.
 */
export function localZoteroTransport(
  session: Pick<ZoteroAnnotationWriteSession, 'insert' | 'setImageQuotation'>,
  store?: Pick<OutboxStore, 'outboxByStatus'>,
): ZoteroWriteTransport {
  return async ({ itemKey, libraryId, operation, payload }) => {
    const areaQuotation = payload.readflexAreaQuotation
    if (operation === 'update' && areaQuotation) {
      const setImageQuotation = session.setImageQuotation
      if (
        payload.annotationType !== 'image'
        || typeof areaQuotation.sourceKey !== 'string'
        || !areaQuotation.sourceKey
        || typeof areaQuotation.comment !== 'string'
        || !areaQuotation.comment
        || !setImageQuotation
      ) {
        return { kind: 'rejected', reason: 'This Area quotation record was not valid.' }
      }
      let canonicalKey: string | null = null
      for (const entry of store?.outboxByStatus?.('confirmed') ?? []) {
        if (
          entry.operation !== 'create'
          || entry.libraryId !== libraryId
          || entry.parentItemKey !== payload.parentItem
          || !entry.itemKey
        ) continue
        try {
          const retained = JSON.parse(entry.payload) as ZoteroAnnotationPayload
          if (
            retained.annotationType === 'image'
            && (
              retained.readflexSourceKey === areaQuotation.sourceKey
              || (!retained.readflexSourceKey && entry.itemKey === areaQuotation.sourceKey)
            )
          ) {
            canonicalKey = entry.itemKey
            break
          }
        } catch {
          // An unreadable retained row cannot establish the annotation's identity.
        }
      }
      if (!canonicalKey) {
        return {
          kind: 'retry',
          reason: 'The Area annotation is still waiting to be written before its quotation can be recorded.',
        }
      }
      try {
        setImageQuotation({
          comment: areaQuotation.comment,
          key: canonicalKey,
          libraryId,
          parentAttachmentKey: payload.parentItem,
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'The Area quotation could not be recorded in Zotero.'
        const permanent = /accepted form|too long|no safe room|could not be found|personal Zotero library/.test(reason)
        return {
          kind: permanent ? 'rejected' : 'retry',
          reason,
        }
      }
      return { itemKey: canonicalKey, kind: 'confirmed' }
    }
    if (operation !== 'create') {
      return { kind: 'kept-local', reason: UNSUPPORTED_ZOTERO_EDIT_REASON }
    }
    const annotation = localAnnotationFromPayload(
      { itemKey, libraryId, parentItemKey: payload.parentItem },
      payload,
    )
    if (!annotation) {
      return { kind: 'rejected', reason: 'This highlight could not be read back for writing.' }
    }
    let written: WrittenZoteroAnnotation
    try {
      written = session.insert(annotation)
    } catch (error) {
      // Every throw from the insert is a fact about the data or the library — a missing parent, a
      // group library, an unreadable position. None of them get better by trying again, so the entry
      // stops retrying and keeps its reason where a person can see it.
      return {
        kind: 'rejected',
        reason: error instanceof Error ? error.message : 'This highlight could not be written to Zotero.',
      }
    }
    // The key actually written, which may differ from the reader's if that one was taken or
    // malformed. ADR-0029's painted union is deduplicated on it, so recording the real one matters.
    return { itemKey: written.key, kind: 'confirmed' }
  }
}

/**
 * Drain the outbox into Zotero's own database, or refuse and say why.
 *
 * The refusal is the interesting half. Nothing is attempted, nothing is lost, and the reason is a
 * sentence for a person: *"Close Zotero and this highlight will be saved to your library."* The
 * highlight is already durable in the outbox and already painted (ADR-0029), so the refusal costs
 * the reader nothing but a sync.
 */
export async function drainOutboxToZotero(
  store: OutboxStore,
  openSession: ZoteroWriteSessionOpener,
  limit = 25,
): Promise<DrainReport> {
  const session = openSession()
  if (session.kind === 'refused') {
    return {
      attempted: 0,
      confirmed: 0,
      conflicted: 0,
      keptLocal: 0,
      rejected: 0,
      retrying: 0,
      skipped: session.code,
      skippedReason: session.reason,
    }
  }
  try {
    return await drainOutbox(store, localZoteroTransport(session, store), limit)
  } finally {
    // Never hold Zotero's library open past the write: the user may be about to launch Zotero.
    session.close()
  }
}

// ---------------------------------------------------------------------------
// Fixture-scoped liveness (ADR-0031, correction)
// ---------------------------------------------------------------------------

/**
 * Liveness probes scoped to the library actually under examination, for the e2e harness.
 *
 * The default probes ask the machine — `ps -axo pid=,comm=` for executable paths and `lsof` for
 * database holders — which is necessary for the real library and wrong for a fixture library in a
 * temp directory. A test whose result depends on whether the developer has an unrelated application
 * running is not flaky; it is not isolated.
 *
 * So the process and holder probes are injected at the boundary rather than weakened. The `-wal`
 * and exclusive-lock readings are already fixture-scoped because they read the fixture's own file.
 *
 * **The seam engages only when a fixture library is in play**, so it can never speak for the live
 * library: both `WRITEFLEX_E2E=1` and `WRITEFLEX_E2E_ZOTERO_DIRECTORY` are required. Within that,
 * `WRITEFLEX_E2E_ZOTERO_LIVENESS=open` makes the fixture report Zotero as running — the refusal path
 * needs testing too, and a seam that can only ever say "closed" would replace a false red with a
 * false green.
 *
 * It lives in this module rather than beside the other e2e fences in `reading-room.ts` because that
 * module imports `electron` at the top level and so cannot be reached by a unit test.
 */
export function e2eZoteroLivenessProbes(
  environment: NodeJS.ProcessEnv = process.env,
): ZoteroLivenessProbes | undefined {
  if (environment.WRITEFLEX_E2E !== '1') return undefined
  if (!environment.WRITEFLEX_E2E_ZOTERO_DIRECTORY?.trim()) return undefined
  const open = environment.WRITEFLEX_E2E_ZOTERO_LIVENESS?.trim() === 'open'
  return {
    processesHoldingDatabase: () => (open ? ['czotero'] : []),
    runningZoteroProcesses: () => (open ? ['4711 zotero'] : []),
  }
}
