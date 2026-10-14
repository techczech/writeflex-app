import {
  proposalEntries,
  setEntriesEnabled,
  withWriterMove,
  type AcceptedSummary,
  type PlanAcceptResult,
  type PlanProposalView,
  type ProposalEntry,
} from '../../../shared/plan-proposal'

/**
 * The proposal card's states (ticket 09, locked frames 2–6), kept renderer-free like agent-chat.ts
 * so the transitions test headlessly. The pending proposal itself lives in the agent conversation
 * (a Bridle Proposal); this is only how its card stands in this window.
 */
export type PlanCardPhase =
  | 'loading'
  | 'pending'       // frame 2
  | 'editing'       // frame 3
  | 'accepted'      // frame 4
  | 'undo-refused'  // frame 5
  | 'stale'         // frame 6
  | 'undone'
  | 'discarded'
  | 'gone'

export type PlanCard = {
  id: string
  phase: PlanCardPhase
  view: PlanProposalView | null
  /** The agent's changes plus the writer's Edit-first choices. */
  entries: ProposalEntry[]
  accepted?: AcceptedSummary
  /** The refusal or failure sentence the card shows. */
  message?: string
  busy: boolean
  acceptedAt?: number
}

export type PlanCardEvent =
  | { type: 'loaded'; view: PlanProposalView | null }
  | { type: 'edit' }
  | { type: 'cancel-edit' }
  | { type: 'drop'; ids: string[] }
  | { type: 'restore'; ids: string[] }
  | { type: 'drag'; title: string; to: number }
  | { type: 'busy' }
  | { type: 'accept-result'; result: PlanAcceptResult; at: number }
  | { type: 'undo-result'; ok: boolean; message?: string }
  | { type: 'discarded' }

export function emptyPlanCard(id: string): PlanCard {
  return { id, phase: 'loading', view: null, entries: [], busy: false }
}

function phaseFor(view: PlanProposalView): PlanCardPhase {
  switch (view.status) {
    case 'pending': return 'pending'
    case 'stale': return 'stale'
    case 'accepted': return 'accepted'
    case 'discarded': return 'discarded'
    default: return 'gone'
  }
}

export function reducePlanCard(card: PlanCard, event: PlanCardEvent): PlanCard {
  switch (event.type) {
    case 'loaded': {
      if (!event.view) return { ...card, phase: 'gone', busy: false }
      // A view refresh never throws away the writer's edits or a refusal already on screen.
      const keep = card.phase === 'editing' || card.phase === 'undo-refused' || card.phase === 'undone'
      const next = phaseFor(event.view)
      const phase = keep && (next === 'pending' || next === 'accepted') ? card.phase : next
      return {
        ...card,
        phase,
        view: event.view,
        entries: card.entries.length ? card.entries : proposalEntries(event.view.changes),
        ...(event.view.accepted ? { accepted: event.view.accepted } : {}),
        busy: false,
      }
    }
    case 'edit':
      return card.phase === 'pending' ? { ...card, phase: 'editing' } : card
    case 'cancel-edit':
      return card.phase === 'editing' && card.view
        ? { ...card, phase: 'pending', entries: proposalEntries(card.view.changes) }
        : card
    case 'drop':
      return card.phase === 'editing' ? { ...card, entries: setEntriesEnabled(card.entries, event.ids, false) } : card
    case 'restore':
      return card.phase === 'editing' ? { ...card, entries: setEntriesEnabled(card.entries, event.ids, true) } : card
    case 'drag':
      return card.phase === 'editing' ? { ...card, entries: withWriterMove(card.entries, event.title, event.to) } : card
    case 'busy':
      return { ...card, busy: true, message: undefined }
    case 'accept-result': {
      const result = event.result
      if (result.ok) return { ...card, phase: 'accepted', accepted: result.accepted, acceptedAt: event.at, busy: false, message: undefined }
      if (result.stale?.length && card.view) {
        return { ...card, phase: 'stale', view: { ...card.view, status: 'stale', stale: result.stale }, busy: false }
      }
      return { ...card, busy: false, message: result.message }
    }
    case 'undo-result':
      return event.ok
        ? { ...card, phase: 'undone', busy: false, message: undefined }
        : { ...card, phase: 'undo-refused', busy: false, message: event.message }
    case 'discarded':
      return { ...card, phase: 'discarded', busy: false }
  }
}

/** The card whose Undo ⌘⇧Z reaches: the most recently accepted one still holding its undo. */
export function latestUndoableCard(cards: Record<string, PlanCard>): PlanCard | null {
  let latest: PlanCard | null = null
  for (const card of Object.values(cards)) {
    if (card.phase !== 'accepted' || card.acceptedAt === undefined) continue
    if (!latest || (latest.acceptedAt ?? 0) < card.acceptedAt) latest = card
  }
  return latest
}

export type PlanCards = Record<string, PlanCard>

/** Every card in the window, keyed by proposal id. */
export function reducePlanCards(cards: PlanCards, action: { id: string; event: PlanCardEvent }): PlanCards {
  const current = cards[action.id] ?? emptyPlanCard(action.id)
  const next = reducePlanCard(current, action.event)
  return next === current && cards[action.id] ? cards : { ...cards, [action.id]: next }
}

/** Cards whose staleness can still change, so a folder change should re-check them. */
export function liveCardIds(cards: PlanCards): string[] {
  return Object.values(cards).filter((card) => card.phase === 'pending' || card.phase === 'editing' || card.phase === 'loading').map((card) => card.id)
}
