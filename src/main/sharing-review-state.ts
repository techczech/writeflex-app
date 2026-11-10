// Converging reader cards is structural: service item identity, decision receipt, reply ids.
// This module never interprets the prose and never writes a document.
import type { Change } from '../engine'
import type { OutsideChangeFields, ReaderHeard, ReaderReply } from '../shared/outside-source'
import { readerNoteOf } from './outside-change-fields'

export type ReaderItemState = { key: string; outcome: ReaderHeard['outcome']; at: number | null; replies: Array<{ id: string; text: string; at: number; visibility?: 'private' | 'open' }> }

export function applyReaderItemState(change: Change, state: ReaderItemState, now: number): Change {
  const fields = change as Change & OutsideChangeFields
  const before = fields.readerHeard
  const localOutcome = change.status === 'accepted' ? readerNoteOf(change)?.kind === 'note' ? 'done' : 'accepted' : change.status === 'rejected' ? (change as Change & { closedReason?: string }).closedReason ? 'failed' : 'declined' : null
  // A local decision based on the service state we are reading still needs sending. A changed
  // remote receipt wins; an accept receipt always wins, since it must never place text here.
  const unsent = localOutcome !== (before?.outcome ?? null) || (fields.readerDecidedAt ?? null) !== (before?.at ?? null)
  const preserve = unsent && state.at === (before?.at ?? null) && state.outcome !== 'accepted'
  const replies = new Map((fields.readerReplies ?? []).map((r) => [r.id, r]))
  for (const r of state.replies) {
    const previous = replies.get(r.id)
    replies.set(r.id, { ...(previous ?? { by: 'You' }), ...r, sent: previous?.sent ?? now, notSent: undefined })
  }
  let next: Change & OutsideChangeFields = { ...fields, readerHeard: { outcome: state.outcome, at: state.at }, ...(replies.size ? { readerReplies: [...replies.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)) } : {}) }
  if (!preserve && (state.at !== (before?.at ?? null) || state.outcome !== localOutcome)) {
    const { closedAt: _a, closedReason: _r, closedCode: _c, ...open } = next as typeof next & { closedAt?: number; closedReason?: string; closedCode?: string }
    next = { ...open, status: state.outcome === 'accepted' || state.outcome === 'done' ? 'accepted' : state.outcome === null ? 'pending' : 'rejected', ...(state.at !== null ? { readerDecidedAt: state.at } : { readerDecidedAt: undefined }), ...(state.outcome === 'failed' ? { closedReason: 'This proposed edit could not be applied on another Mac.', closedAt: state.at ?? now, closedCode: 'other' } : {}) } as Change & OutsideChangeFields
  }
  return next
}

/** One card per service item, even when two local journals assigned it different Change ids. */
export function uniqueReaderItems(changes: readonly Change[]): Change[] {
  const out: Change[] = [], at = new Map<string, number>()
  for (const change of changes) {
    const f = readerNoteOf(change)
    if (!f) { out.push(change); continue }
    const key = `${f.shareId}/${f.key}`, index = at.get(key)
    if (index === undefined) { at.set(key, out.length); out.push(change); continue }
    const previous = out[index]
    const stamp = (c: Change) => (c as Change & OutsideChangeFields).readerDecidedAt ?? (c.status === 'accepted' || c.status === 'rejected' ? c.ts : 0)
    const chosen = stamp(change) > stamp(previous) ? change : previous
    const replies = new Map<string, ReaderReply>()
    for (const c of [previous, change]) for (const r of (c as Change & OutsideChangeFields).readerReplies ?? []) {
      const old = replies.get(r.id)
      replies.set(r.id, old?.sent ? old : r)
    }
    out[index] = { ...chosen, id: previous.id, ...(replies.size ? { readerReplies: [...replies.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)) } : {}) } as Change
  }
  return out
}
