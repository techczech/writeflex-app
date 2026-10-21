import type { Change } from '../../../preload'
import type { HeadFilterState } from './margin-head-state'

/**
 * The margin's modes (ticket 08, frames `settled` and `my-edits`). Pure.
 *
 * - `review`: what waits, as drawn everywhere else.
 * - `settled` (Settled today): today's accepted and declined items beside their words with their outcome; an item
 *   reopened while the mode is on stays as an Open card, "waiting again". Everything else waiting is out of sight.
 * - `mine` (My edits): the writer's own recorded edits as cards, "Accept all N" (the old Accept session). Everything
 *   else waiting is out of sight and counted ("5 others waiting").
 *
 * The mode lives in the margin's filter state (`settled`, `showOwnEdits`), so the app's review line and the margin read
 * one value. Esc, the count menu or the palette leave it; leaving restores review with no who filter.
 */
export type ReviewMode = 'review' | 'settled' | 'mine'

export function reviewModeOf(state: Pick<HeadFilterState, 'settled' | 'showOwnEdits'>): ReviewMode {
  return state.settled ? 'settled' : state.showOwnEdits ? 'mine' : 'review'
}

/** The state with `mode` on (or review). My edits narrows to your edits; leaving it clears the who filter as today. */
export function withMode(state: HeadFilterState, mode: ReviewMode): HeadFilterState {
  const current = reviewModeOf(state)
  const noWho = { ...state.filter, sources: undefined, requests: undefined, links: undefined }
  if (mode === 'settled') return { ...state, settled: true, showOwnEdits: false, filter: current === 'mine' ? noWho : state.filter }
  if (mode === 'mine') return { ...state, settled: false, showOwnEdits: true, filter: { ...noWho, sources: new Set(['you']) } }
  return { ...state, settled: false, showOwnEdits: false, filter: current === 'mine' ? noWho : state.filter }
}

/** The count menu and palette rows are switches: the mode on, or back to review when it already is. */
export const toggleMode = (state: HeadFilterState, mode: Exclude<ReviewMode, 'review'>): HeadFilterState =>
  withMode(state, reviewModeOf(state) === mode ? 'review' : mode)

/**
 * Items waiting again in Settled today: settled today when seen in the mode, waiting now (reopened from it). Pure:
 * `seen` grows with every settled id seen while the mode is on; leaving the mode or opening another piece starts afresh.
 */
export function trackWaitingAgain(state: { seen: ReadonlySet<string>; again: ReadonlySet<string> }, settledIds: readonly string[], changes: readonly Change[]): { seen: ReadonlySet<string>; again: ReadonlySet<string> } {
  const seen = new Set(state.seen)
  for (const id of settledIds) seen.add(id)
  const again = new Set<string>()
  for (const change of changes) {
    if (seen.has(change.id) && !change.snapshotId && (change.status === 'pending' || change.status === 'held')) again.add(change.id)
  }
  const same = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((id) => b.has(id))
  return { seen: same(seen, state.seen) ? state.seen : seen, again: same(again, state.again) ? state.again : again }
}

/** The ids My edits' "Accept all N" settles: exactly today's Accept session (`acceptWriterSessionChanges`). */
export const myEditsSessionIds = (changes: readonly Change[]): string[] =>
  changes.filter((change) => change.provenance === 'writer' && change.editClass !== 'copy' && change.status === 'pending' && !change.snapshotId).map((change) => change.id)

export type ModeLine =
  | { mode: 'settled'; label: 'Settled today'; text: string; items: number; quiet: number; includeQuiet: boolean }
  | { mode: 'mine'; label: 'My edits'; text: string; recorded: number; others: number }

/** What the top of the margin says in a mode (frames `settled`, `my-edits`). */
export function modeLineOf(model: { mode: ReviewMode; settled: readonly unknown[]; cards: readonly unknown[]; unplaced: readonly unknown[]; settledQuiet: number; othersWaiting: number }, includeQuiet: boolean): ModeLine | null {
  const n = (value: number): string => value.toLocaleString()
  if (model.mode === 'settled') {
    const items = model.settled.length + model.cards.length + model.unplaced.length
    return { mode: 'settled', label: 'Settled today', text: items === 1 ? '1 item' : `${n(items)} items`, items, quiet: model.settledQuiet, includeQuiet }
  }
  if (model.mode === 'mine') {
    const recorded = model.cards.length + model.unplaced.length
    const waiting = model.othersWaiting
    const rest = waiting === 0 ? 'Nothing else is waiting.' : `The ${n(waiting)} waiting ${waiting === 1 ? 'item is' : 'items are'} out of sight until you go back.`
    return { mode: 'mine', label: 'My edits', text: `${n(recorded)} recorded in this piece. ${rest}`, recorded, others: waiting }
  }
  return null
}
