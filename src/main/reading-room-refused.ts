/**
 * What Zotero would not take, and what was never Zotero's to refuse.
 *
 * Two different facts used to share one status-bar count:
 *
 *  - **A genuine refusal** — an insert Zotero's library rejected (the paper is gone, the position is
 *    unreadable), or an edit conflict. A person may want to look at it, so it is counted, listed with
 *    its reason, and can be retried or dismissed.
 *  - **An edit or deletion there is no write path for yet** (ADR-0031 covers the insert only). Nothing
 *    went wrong and nothing can be done about it, so it is not counted and not a warning. It is stored
 *    with the sidecar's own `local_only` flag, which keeps it drawn (ADR-0029) and out of both counts.
 *
 * Nothing in this module deletes a row or rewrites a payload. Every action is a change of
 * classification on a row that stays in the outbox.
 *
 * Shaping and store calls only — no `electron` import — so a unit test can reach all of it.
 */
import type { OutboxEntry, OutboxStatus } from '@readflex/sidecar'
import {
  isUnsupportedZoteroOperation,
  UNSUPPORTED_ZOTERO_EDIT_REASON,
  isUnsupportedZoteroEditReason,
  type ZoteroAnnotationPayload,
} from './zotero-annotation-writes'

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

/**
 * True when this row is an edit or deletion the local write has no path for, and is still classified
 * as Zotero work.
 *
 * A row still waiting (`pending`, `retrying`) is recognised by its operation alone: the transport
 * would give it exactly this answer the moment Zotero is closed. A `failed` row has no structured
 * record of WHY it failed, so it must also carry the exact sentence older releases stored — a failed
 * edit with any other reason is left alone and stays a visible refusal.
 */
export function isLegacyKeptEdit(entry: OutboxEntry): boolean {
  if (entry.localOnly !== 0) return false
  if (entry.operation !== 'update' && entry.operation !== 'delete') return false
  const payload = parsedPayload(entry)
  // An unreadable payload is a different fault with its own reason; it is not reclassified here.
  if (!payload || !isUnsupportedZoteroOperation(entry.operation, payload)) return false
  if (entry.status === 'pending' || entry.status === 'retrying') return true
  return entry.status === 'failed' && isUnsupportedZoteroEditReason(entry.lastError)
}

/**
 * Reclassify edits and deletions that older releases left counted as refused. Run once per launch;
 * a second run finds nothing, because a reclassified row is `local_only` and no longer matches.
 * Returns how many rows changed.
 */
export function reconcileKeptEdits(store: RefusedOutboxStore): number {
  let changed = 0
  for (const status of ['pending', 'retrying', 'failed'] as const) {
    for (const entry of store.outboxByStatus(status)) {
      if (!isLegacyKeptEdit(entry)) continue
      store.markOutboxLocalOnly(entry.id, UNSUPPORTED_ZOTERO_EDIT_REASON)
      changed += 1
    }
  }
  return changed
}

/** Annotation keys in one document whose latest edit is kept here and has not reached Zotero. */
export function keptEditKeys(entries: OutboxEntry[]): Set<string> {
  const keys = new Set<string>()
  for (const entry of entries) {
    if (
      entry.itemKey
      && entry.localOnly === 1
      && entry.operation === 'update'
      && isUnsupportedZoteroEditReason(entry.lastError)
    ) keys.add(entry.itemKey)
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
  /** An insert may succeed on another try; an edit has no write path to retry. */
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

function isRetryable(entry: OutboxEntry, payload: ZoteroAnnotationPayload | null): boolean {
  return entry.operation === 'create' && payload !== null
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
 * Put a refused insert back in the queue. Returns false, and changes nothing, when the row is not a
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
