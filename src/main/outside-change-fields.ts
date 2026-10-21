/**
 * The fields an outside Change carries in the review ledger, and the only readers of them. Kept apart
 * from the validator (outside-change.ts) so the Change store can read them without loading it.
 */
import type { Change } from '../engine'
import { OUTSIDE_SOURCES, OUTSIDE_SOURCE_LABELS, type OutsideChangeFields, type OutsideLook, type OutsideRequestRef, type OutsideSource, type OutsideSummary, type ReaderNoteFields } from '../shared/outside-source'

export type { OutsideChangeFields, OutsideRequestRef } from '../shared/outside-source'
export type OutsideChange = Change & OutsideChangeFields

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The stored source of a Change from outside, or null for any other Change. Tolerates any record. */
export function outsideSourceOf(change: Change): OutsideSource | null {
  const source = (change as OutsideChange).outsideSource
  return typeof source === 'string' && (OUTSIDE_SOURCES as readonly string[]).includes(source) ? source : null
}

/** A reader's note or proposed edit (0.24 ticket 07): its reader fields, only on a Change whose source is `reader`. */
export function readerNoteOf(change: Change): ReaderNoteFields | null {
  const fields = (change as OutsideChange).readerNote
  if (outsideSourceOf(change) !== 'reader' || !isRecord(fields)) return null
  return (fields.kind === 'note' || fields.kind === 'edit') && typeof fields.shareId === 'string' ? fields as ReaderNoteFields : null
}

export function outsideRequestOf(change: Change): OutsideRequestRef | null {
  const ref = (change as OutsideChange).outsideRequest
  if (!isRecord(ref) || typeof ref.id !== 'string') return null
  const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
  return whole(ref.index) && whole(ref.count) && whole(ref.at) ? { id: ref.id, index: ref.index, count: ref.count, at: ref.at } : null
}

export function outsideMoveAfterOf(change: Change): string | null {
  const after = (change as OutsideChange).outsideMoveAfter
  return change.editClass === 'move' && outsideSourceOf(change) !== null && typeof after === 'string' && after !== '' ? after : null
}

/**
 * How full the ledger is with undecided Changes from outside: in all, per source, and per request
 * (newest first). Pure; the dock asks for it over `changes:outside-summary`, and the command line
 * reads the same numbers before it files.
 */
export function outsideSummary(changes: Change[], limits: { limit: number; limitPerSource: number }, lastLook: OutsideLook | null = null): OutsideSummary {
  const bySource = new Map<OutsideSource, number>(OUTSIDE_SOURCES.map((source) => [source, 0]))
  const byRequest = new Map<string, OutsideSummary['byRequest'][number]>()
  let undecided = 0
  for (const change of changes) {
    const source = outsideSourceOf(change)
    if (source === null || (change.status !== 'pending' && change.status !== 'held')) continue
    undecided += 1
    bySource.set(source, (bySource.get(source) ?? 0) + 1)
    const request = outsideRequestOf(change)
    if (!request) continue
    const row = byRequest.get(request.id) ?? { id: request.id, source, at: request.at, undecided: 0, count: request.count, paths: [] }
    row.undecided += 1
    if (!row.paths.includes(change.path)) row.paths.push(change.path)
    byRequest.set(request.id, row)
  }
  return {
    undecided, limit: limits.limit, limitPerSource: limits.limitPerSource,
    bySource: OUTSIDE_SOURCES.map((source) => ({ source, label: OUTSIDE_SOURCE_LABELS[source], undecided: bySource.get(source) ?? 0 })),
    byRequest: [...byRequest.values()].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1)),
    lastLook,
  }
}

/** True for the closed record of a request that failed validation: it never becomes acceptable. */
export const isRefusedOutsideChange = (change: Change): boolean => (change as OutsideChange).outsideRefused === true

/** What a closed outside Change was meant to do: the refused request's text when there is one, else the Change's own. */
export function intendedTextOf(change: Change): { oldText: string; newText: string; cut: boolean } {
  const kept = (change as OutsideChange).outsideIntended
  if (isRecord(kept) && typeof kept.oldText === 'string' && typeof kept.newText === 'string') return { oldText: kept.oldText, newText: kept.newText, cut: kept.cut === true }
  return { oldText: change.oldText, newText: change.newText, cut: false }
}

/** The path a closed outside Change's request named: as typed when it was not a document path (the
 *  record's own `path` is then a fixed label, changes.ts `safeOutsidePath`), otherwise the record's. */
export function intendedPathOf(change: Change): string {
  const typed = (change as OutsideChange).outsideIntended?.path
  return typeof typed === 'string' && typed !== '' ? typed : change.path
}
