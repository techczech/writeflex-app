/**
 * How edits and deletions enter the outbox, and the one-time release of the edits older releases
 * kept back.
 *
 * ```
 * reader edit   ──▶ a create for it has not reached Zotero?  ──▶ fold into that create
 *                    an earlier edit is still waiting?        ──▶ fold into that edit
 *                    otherwise                                ──▶ queue an update
 * reader delete ──▶ a create for it has not reached Zotero?  ──▶ cancel the create and everything after it
 *                    otherwise                                ──▶ drop waiting edits, queue one delete
 * ```
 *
 * Folding keeps the earlier row's place in the queue, so Zotero always receives a create before
 * anything about the same mark.
 *
 * **Rows in flight.** A row a drain has claimed (`sendingRevision` set) is never folded into or
 * cancelled: its write may already be in Zotero. A change to it is queued as a new row after it — an
 * edit as a follow-up update, a deletion of a create in flight as a deletion that runs once the create
 * is confirmed and resolves its key then. The drain keeps a mark's rows in order. Each change is ONE sidecar transaction: a delete that drops waiting
 * edits and queues itself either happens whole or not at all.
 *
 * **Baselines.** An edit or deletion carries the annotation as the reader showed it before the change
 * (`readflexBaseline`); the plugin writes it compare-and-set against it (ADR-0047). Folding keeps the EARLIEST baseline,
 * because Zotero has not seen any of the waiting edits: a later edit folded into an earlier one, or a
 * delete replacing waiting edits, is still compared against what Zotero held before the first. Cancelling is the one place outbox rows are removed, and only rows
 * that never reached Zotero: a mark made and deleted while Zotero was open owes Zotero nothing.
 *
 * Store calls and payload shaping only — no `electron` import — so unit tests reach all of it.
 */
import type { NewOutboxEntry, OutboxEntry, OutboxStatus } from '@readflex/sidecar'
import {
  isPdfCitationPosition,
  isUnsupportedZoteroEditReason,
  readerSessionOf,
  UNVERIFIABLE_CHANGE_REASON,
  type ZoteroAnnotationFields,
  type ZoteroAnnotationPayload,
} from './zotero-annotation-writes'

export type OutboxEditStore = {
  enqueueOutbox(entry: NewOutboxEntry): OutboxEntry
  outboxRowsForKey(libraryId: number, parentItemKey: string, itemKey: string): OutboxEntry[]
  replaceOutboxPayload(id: number, payload: string): boolean | void
  cancelOutboxEntries(ids: readonly number[]): void
  runInTransaction<T>(work: () => T): T
  /** The re-key of a create, scoped to the reader session that made it (see `resolveTarget`). */
  outboxKeyReplacement?(libraryId: number, parentItemKey: string, readerKey: string, readerSession?: string | null): string | null
}

/** True while a drain is writing this row. */
/**
 * True while a row is being sent, and also when its last send was cut off (`sendInterrupted`): Zotero
 * may already hold what it said, so it is never folded into or cancelled, exactly as if in flight. A
 * deletion of such a create is queued behind the create's resend.
 */
function inFlight(entry: OutboxEntry): boolean {
  return (entry.sendingRevision !== undefined && entry.sendingRevision !== null) || entry.sendInterrupted === 1
}

export type QueuedChange =
  /** A new outbox row. */
  | { kind: 'queued'; entry: OutboxEntry }
  /** The change replaced the payload of an earlier unconfirmed row for the same mark. */
  | { kind: 'folded'; entry: OutboxEntry }
  /** A delete of a mark that never reached Zotero: its rows were removed and nothing is owed. */
  | { kind: 'cancelled'; removed: number }

function parsed(payload: string): ZoteroAnnotationPayload | null {
  try {
    const value = JSON.parse(payload) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as ZoteroAnnotationPayload
      : null
  } catch {
    return null
  }
}

/** The private Area quotation update rides the outbox but is not a reader edit; it never folds. */
function isAreaQuotation(entry: OutboxEntry): boolean {
  return !!parsed(entry.payload)?.readflexAreaQuotation
}

function withBaseline(payload: string, baseline: ZoteroAnnotationFields | null | undefined): string {
  const value = parsed(payload)
  if (!value) return payload
  const next: ZoteroAnnotationPayload = { ...value }
  if (baseline) next.readflexBaseline = baseline
  else delete next.readflexBaseline
  return JSON.stringify(next)
}

/** The payload with the reader session of the row it is folded into: the row keeps its identity. */
function withSessionOf(payload: string, owner: string): string {
  const value = parsed(payload)
  if (!value) return payload
  const session = readerSessionOf(parsed(owner))
  const next: ZoteroAnnotationPayload = { ...value }
  if (session) next.readflexReaderSession = session
  else delete next.readflexReaderSession
  return JSON.stringify(next)
}

function baselineOf(entry: OutboxEntry): ZoteroAnnotationFields | null {
  return parsed(entry.payload)?.readflexBaseline ?? null
}

/** The fields of a stored payload, in the shape a baseline takes. */
export function fieldsFromPayload(payload: ZoteroAnnotationPayload): ZoteroAnnotationFields | null {
  if (typeof payload.annotationSortIndex !== 'string') return null
  return {
    color: payload.annotationColor || null,
    comment: payload.annotationComment || null,
    pageLabel: payload.annotationPageLabel || null,
    position: JSON.stringify(payload.annotationPosition ?? { pageIndex: 0, rects: [] }),
    sortIndex: payload.annotationSortIndex,
    text: payload.annotationText || null,
    // The mark's kind is part of the compare (WriteFlex never changes it).
    ...(payload.annotationType ? { type: payload.annotationType } : {}),
  }
}

/**
 * Queue a reader change for one mark, collapsing it against what is already waiting. A `create` is
 * always queued as given. `baseline` is the mark as the reader showed it before an edit or deletion;
 * without one the change is queued, and the write lists it as a conflict rather than guess.
 */
export function queueAnnotationChange(
  store: OutboxEditStore,
  change: NewOutboxEntry,
  baseline: ZoteroAnnotationFields | null = null,
): QueuedChange {
  return store.runInTransaction(() => collapse(store, change, baseline))
}

function collapse(
  store: OutboxEditStore,
  change: NewOutboxEntry,
  baseline: ZoteroAnnotationFields | null,
): QueuedChange {
  if (change.operation === 'create' || !change.itemKey) {
    return { entry: store.enqueueOutbox(change), kind: 'queued' }
  }
  // Once a create was re-keyed because Zotero held its reader key, that key means two marks: ours, to
  // the reader instance that made the create, and Zotero's own, to every other reader. Rows of the two
  // never fold into or cancel each other.
  const { libraryId, parentItemKey, itemKey } = change
  const rekeyed = (store.outboxKeyReplacement?.(libraryId, parentItemKey, itemKey) ?? null) !== null
  const meansOurs = (payload: string): boolean => {
    const session = readerSessionOf(parsed(payload))
    return !!session && (store.outboxKeyReplacement?.(libraryId, parentItemKey, itemKey, session) ?? null) !== null
  }
  const changeMeansOurs = rekeyed && meansOurs(change.payload)
  const rows = store
    .outboxRowsForKey(libraryId, parentItemKey, itemKey)
    .filter((entry) => entry.status !== 'confirmed')
    .filter((entry) => !rekeyed || meansOurs(entry.payload) === changeMeansOurs)
  const unsentCreate = rows.find((entry) => entry.operation === 'create')

  if (change.operation === 'delete') {
    // A mark Zotero never got, with nothing of it being written now, owes Zotero nothing.
    if (unsentCreate && !rows.some(inFlight)) {
      const ids = rows.map((entry) => entry.id)
      store.cancelOutboxEntries(ids)
      return { kind: 'cancelled', removed: ids.length }
    }
    const waitingDelete = rows.find((entry) => entry.operation === 'delete' && entry.localOnly === 0)
    // Edits still owed to a mark being deleted are moot; so is any earlier kept or refused edit. An
    // edit being written is not: it may already be in Zotero, and the deletion is compared after it.
    const moot = rows.filter((entry) => entry.operation === 'update' && !inFlight(entry))
    // Zotero never saw a waiting edit, so the deletion is compared against what it held before the first.
    const earliestWaiting = moot.find((entry) =>
      entry.localOnly === 0
      && (entry.status === 'pending' || entry.status === 'retrying')
      && !isAreaQuotation(entry)
      && baselineOf(entry))
    if (moot.length > 0) store.cancelOutboxEntries(moot.map((entry) => entry.id))
    if (waitingDelete) return { entry: waitingDelete, kind: 'folded' }
    const payload = withBaseline(change.payload, earliestWaiting ? baselineOf(earliestWaiting) : baseline)
    return { entry: store.enqueueOutbox({ ...change, payload }), kind: 'queued' }
  }

  // An update.
  if (unsentCreate && !inFlight(unsentCreate)) {
    const createPayload = parsed(unsentCreate.payload)
    const editPayload = parsed(change.payload)
    // An Area create keeps the identity its quotation records resolve by. A create has no baseline.
    const merged = editPayload
      ? withSessionOf(withBaseline(JSON.stringify({
          ...editPayload,
          ...(createPayload?.readflexSourceKey ? { readflexSourceKey: createPayload.readflexSourceKey } : {}),
        }), null), unsentCreate.payload)
      : change.payload
    store.replaceOutboxPayload(unsentCreate.id, merged)
    return { entry: { ...unsentCreate, payload: merged }, kind: 'folded' }
  }
  const waitingEdit = [...rows]
    .reverse()
    .find((entry) =>
      entry.operation === 'update'
      && entry.localOnly === 0
      && (entry.status === 'pending' || entry.status === 'retrying')
      && !isAreaQuotation(entry))
  // The latest waiting edit is being written: this edit follows it, compared against what the reader
  // showed after it (the reader's own before-state).
  if (waitingEdit && !inFlight(waitingEdit)) {
    // The earlier edit's baseline stays: Zotero has seen neither edit.
    const payload = withSessionOf(withBaseline(change.payload, baselineOf(waitingEdit)), waitingEdit.payload)
    store.replaceOutboxPayload(waitingEdit.id, payload)
    return { entry: { ...waitingEdit, payload }, kind: 'folded' }
  }
  const payload = withBaseline(change.payload, baseline)
  return { entry: store.enqueueOutbox({ ...change, payload }), kind: 'queued' }
}

export type KeptEditReleaseStore = {
  outboxByStatus(status: OutboxStatus): OutboxEntry[]
  outboxRowsForKey(libraryId: number, parentItemKey: string, itemKey: string): OutboxEntry[]
  replaceOutboxPayload(id: number, payload: string): void
  releaseOutboxLocalOnly(id: number): void
  markOutboxConflict(id: number, losingPayload: string, reason: string): void
  runInTransaction<T>(work: () => T): T
}

/**
 * True for a row an older release kept back only because edits and deletions had no write path:
 * it carries the exact kept-edit sentence (current or legacy), it is an edit or deletion of a PDF
 * mark (page index plus rectangles — web and EPUB positions have neither), and it is not the private
 * Area quotation record.
 */
export function isReleasableKeptEdit(entry: OutboxEntry): boolean {
  if (entry.operation !== 'update' && entry.operation !== 'delete') return false
  if (entry.status !== 'failed' || !isUnsupportedZoteroEditReason(entry.lastError)) return false
  const payload = parsed(entry.payload)
  if (!payload || payload.readflexAreaQuotation) return false
  return isPdfCitationPosition(JSON.stringify(payload.annotationPosition ?? null))
}

/**
 * What the reader showed before a kept edit, where this app still holds it: the payload of the
 * edit kept just before it for the same mark, or else the create this app wrote for the mark.
 * A mark made in Zotero with no earlier row here has nothing to recover.
 */
function recoveredBaseline(store: KeptEditReleaseStore, entry: OutboxEntry): ZoteroAnnotationFields | null {
  if (!entry.itemKey) return null
  const rows = store.outboxRowsForKey(entry.libraryId, entry.parentItemKey, entry.itemKey)
  const position = rows.findIndex((row) => row.id === entry.id)
  for (const row of rows.slice(0, Math.max(position, 0)).reverse()) {
    if (isAreaQuotation(row)) continue
    if (row.operation === 'update' || (row.operation === 'create' && row.status === 'confirmed')) {
      const payload = parsed(row.payload)
      return payload ? fieldsFromPayload(payload) : null
    }
  }
  return null
}

/**
 * Put kept PDF edits back in the queue, in their original order, now that they can be written — each
 * with the baseline recovered for it. One without a recoverable baseline is listed as a conflict and
 * never sent. Run on every open; a released row no longer carries the sentence, so a second run finds
 * nothing. Returns how many rows were released.
 */
export function releaseKeptEdits(store: KeptEditReleaseStore): number {
  let released = 0
  for (const entry of store.outboxByStatus('failed')) {
    if (!isReleasableKeptEdit(entry)) continue
    const baseline = recoveredBaseline(store, entry)
    store.runInTransaction(() => {
      if (!baseline) {
        store.markOutboxConflict(entry.id, entry.payload, UNVERIFIABLE_CHANGE_REASON)
        return
      }
      store.replaceOutboxPayload(entry.id, withBaseline(entry.payload, baseline))
      store.releaseOutboxLocalOnly(entry.id)
      released += 1
    })
  }
  return released
}
