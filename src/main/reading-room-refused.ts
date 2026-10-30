/**
 * What Zotero would not take, and what was never Zotero's to refuse.
 *
 * Two different facts used to share one status-bar count:
 *
 *  - **A genuine refusal** — an insert Zotero's library rejected (the paper is gone, the position is
 *    unreadable), or an edit conflict. A person may want to look at it, so it is counted, listed with
 *    its reason, and can be retried or dismissed.
 *  - **A mark kept here on purpose** — a web or EPUB mark, or a refusal the reader dismissed. Nothing
 *    can be done about it, so it is not counted and not a warning. It is stored with the sidecar's own
 *    `local_only` flag, which keeps it drawn (ADR-0029) and out of both counts.
 *
 * Edits and deletions of PDF marks are written to Zotero since 0.27.0-alpha.2; the rows older releases
 * kept back are released once by `releaseKeptEdits` (`zotero-outbox-edits.ts`).
 *
 * Nothing in this module deletes a row or rewrites a payload. Every action is a change of
 * classification on a row that stays in the outbox.
 *
 * Shaping and store calls only — no `electron` import — so a unit test can reach all of it.
 */
import type { OutboxEntry, OutboxStatus } from '@readflex/sidecar'
import type { ZoteroAnnotationPayload } from './zotero-annotation-writes'

/** The subset of the sidecar this module touches. */
export type RefusedOutboxStore = {
  outboxByStatus(status: OutboxStatus): OutboxEntry[]
  markOutboxLocalOnly(id: number, reason: string): void
  retryOutbox(id: number): void
}

function parsedPayload(entry: Pick<OutboxEntry, 'payload'>): ZoteroAnnotationPayload | null {
  try {
    const value = JSON.parse(entry.payload) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as ZoteroAnnotationPayload
      : null
  } catch {
    return null
  }
}

/** Annotation keys in one document whose shown state is an edit kept here, not sent to Zotero. */
export function keptEditKeys(entries: OutboxEntry[]): Set<string> {
  const keys = new Set<string>()
  for (const entry of entries) {
    if (entry.itemKey && entry.localOnly === 1 && entry.operation === 'update') keys.add(entry.itemKey)
  }
  return keys
}

/** One row of the "Not sent to Zotero" list. */
export type RefusedHighlight = {
  /** The outbox row, which is what retry and dismiss act on. */
  id: number
  kind: 'refused' | 'conflict'
  /** The paper's title, or the attachment key when the library no longer names it. */
  documentTitle: string
  /** The quoted words, the reader's comment, or a name for the kind of mark. Never empty. */
  excerpt: string
  /** The stored reason (`last_error`). Never empty. */
  reason: string
  /** ISO-8601: when the row was last touched, which is when it was refused. */
  date: string
  /** A refused write (not a conflict) whose payload reads back may succeed on another try. */
  retryable: boolean
  /** Raw Zotero position JSON for a jump, when the payload carries one. */
  position: string | null
  /** The keys that open the paper through the Shelf's own handler; null when it cannot be found. */
  open: { libraryId: number; itemKey: string; attachmentKey: string } | null
}

/** Names a paper from the library and the attachment an outbox row belongs to. */
export type RefusedDocumentResolver = (
  libraryId: number,
  attachmentKey: string,
) => { title: string; itemKey: string | null } | null

const EXCERPT_LENGTH = 160

function excerptOf(payload: ZoteroAnnotationPayload | null): string {
  const collapse = (value: unknown): string =>
    typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  const words = collapse(payload?.annotationText) || collapse(payload?.annotationComment)
  if (!words) {
    return payload?.annotationType === 'image' ? 'A marked region of the page' : 'A mark with no words'
  }
  return words.length > EXCERPT_LENGTH ? `${words.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…` : words
}

/** Exactly the rows `countOutboxRejected` counts, oldest first. */
function refusedEntries(store: RefusedOutboxStore): OutboxEntry[] {
  return [...store.outboxByStatus('failed'), ...store.outboxByStatus('conflict')]
    .filter((entry) => entry.localOnly === 0)
    .sort((left, right) => left.id - right.id)
}

/** Any refused write whose payload reads back can be tried again. A conflict is a decision, not a
 *  failure, so it is dismissed rather than retried. */
function isRetryable(entry: OutboxEntry, payload: ZoteroAnnotationPayload | null): boolean {
  return entry.status !== 'conflict' && payload !== null
}

/** Every refused highlight across all documents, in the order they were made. */
export function refusedHighlights(
  store: RefusedOutboxStore,
  resolveDocument: RefusedDocumentResolver,
): RefusedHighlight[] {
  return refusedEntries(store).map((entry) => {
    const payload = parsedPayload(entry)
    const named = resolveDocument(entry.libraryId, entry.parentItemKey)
    const position = payload?.annotationPosition
    return {
      date: entry.updatedAt,
      documentTitle: named?.title.trim() || entry.parentItemKey,
      excerpt: excerptOf(payload),
      id: entry.id,
      kind: entry.status === 'conflict' ? 'conflict' : 'refused',
      open: named?.itemKey
        ? { attachmentKey: entry.parentItemKey, itemKey: named.itemKey, libraryId: entry.libraryId }
        : null,
      position: position && typeof position === 'object' ? JSON.stringify(position) : null,
      reason: entry.lastError?.trim() || 'Zotero would not take this highlight.',
      retryable: isRetryable(entry, payload),
    }
  })
}

/**
 * Put a refused row back in the queue. Returns false, and changes nothing, when the row is not a
 * refused one or is not retryable — the id comes from the renderer and is not trusted.
 */
export function retryRefused(store: RefusedOutboxStore, id: number): boolean {
  const entry = refusedEntries(store).find((candidate) => candidate.id === id)
  if (!entry || !isRetryable(entry, parsedPayload(entry))) return false
  store.retryOutbox(entry.id)
  return true
}

/**
 * Take a refused row out of the count. The highlight is NOT deleted: the row stays in the outbox with
 * its payload, its reason and any conflict payload, flagged local-only, so it is still drawn in the
 * Reading Room. Returns false, and changes nothing, when the row is not a refused one.
 */
export function dismissRefused(store: RefusedOutboxStore, id: number): boolean {
  const entry = refusedEntries(store).find((candidate) => candidate.id === id)
  if (!entry) return false
  store.markOutboxLocalOnly(entry.id, entry.lastError ?? 'Kept here; not sent to Zotero.')
  return true
}
