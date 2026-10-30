import type { TurnActivity, UndoTurnResult, Bridle } from '@bridle/core'
export type AssistantMode = 'suggest' | 'work' | 'read-only'
export type AssistantTurnUndo = UndoTurnResult | { undone: false; reason: string; paths?: string[]; message?: string }
export type AssistantTurnActivity = TurnActivity & { openPaths?: string[] }
export type AssistantTurnsState = { turns: AssistantTurnActivity[]; store: Bridle['proposalStore'] }
export const ASSISTANT_MODE_KEY = 'agent.mode'
export const ASSISTANT_MODES = [
  { id: 'suggest', label: 'Suggest', description: 'Every write is shown first' },
  { id: 'work', label: 'Work', description: 'New files, folders and moves apply at once; edits are shown first' },
  { id: 'read-only', label: 'Read only', description: 'The assistant can look but not change anything' },
] as const
export function assistantMode(value: unknown): AssistantMode {
  return value === 'suggest' || value === 'work' ? value : 'read-only'
}
export function refusalMessage(result: Exclude<AssistantTurnUndo, { undone: true }>): string {
  if ('message' in result && result.message) return result.message
  const paths = 'paths' in result ? result.paths : 'path' in result && result.path ? [result.path] : []
  const reasons: Record<string, string> = {
    'later-turns-exist': 'Later turns changed files. Undo those turns together with this one to keep the history consistent.',
    'changed-after-turn': `These files changed after this turn: ${paths?.join(', ') || 'the turn’s files'}. Your later changes have been kept.`,
    'partially-undone': `This turn was only partly undone. Some files were restored; the remaining files need attention before undo can continue.${paths?.length ? ' Remaining: ' + paths.join(', ') + '.' : ''}`,
    'journal-damaged': 'The undo history is damaged. WriteFlex cannot safely restore this turn.',
    'store-read-only': 'The assistant has lost write access. Undo is unavailable until write access is restored.',
    'adoption-in-flight': 'An approved change is still being applied. Wait for it to finish, then try undo again.',
    'turn-active': 'Wait for the assistant to finish, or stop it before undoing a turn.',
    'already-undone': 'This turn has already been undone.',
    'unknown-turn': 'This turn is no longer in the assistant’s history.',
    'undo-unavailable': 'No safe undo checkpoint is available for this turn.',
    'unrestorable-file': `This turn includes a file that cannot be safely restored${paths?.length ? ': ' + paths.join(', ') : ''}.`,
    'outside-workspace': 'This turn changed a file outside this folder. It cannot be undone here.',
    'disposed': 'This conversation has closed. Open it again before undoing a turn.',
  }
  return reasons[result.reason] ?? ('message' in result && result.message ? result.message : 'The turn could not be undone. Your files have been kept.')
}
export function storeNotice(store: AssistantTurnsState['store']): string | null {
  if (store.status !== 'read-only') return null
  return store.reason === 'store-in-use-in-process'
    ? 'Changes are read only because another assistant is using this store.'
    : 'The assistant has lost write access. Changes are read only until access is restored.'
}
export function groupStopMessage(reason: string): string {
  return ({ stale: 'Approval stopped because the files changed. Review a fresh proposal.', error: 'Approval stopped because a change could not be applied.', 'store-locked': 'Approval stopped because the assistant no longer has write access.', conflict: 'Approval stopped because another change conflicts with this group.' } as Record<string, string>)[reason] ?? ''
}
export function turnEndMessage(turn: TurnActivity): string {
  if (!turn.reason) return turn.outcome === 'pending' ? 'Working…' : turn.outcome === 'completed' ? 'Completed' : ''
  return ({ auth: 'Sign-in expired. Sign in again in assistant accounts.', aborted: 'You pressed Stop. Nothing changed after that.', network: 'The connection failed.', 'provider-error': 'The model provider could not finish this turn.', 'tool-error': 'A requested action failed. Check the files and activity below.', truncated: 'The model response was cut short.', 'no-answer': 'The model returned no answer.', 'no-text': 'The model returned no text.', 'checkpoint-failed': 'The undo checkpoint could not be saved.' })[turn.reason]
}


/** Bridle discovery calls configure the tool catalogue; they are not workspace activity. */
export function isToolDiscovery(capability: unknown): boolean {
  // Bridle's wireName is not exported; keep its manifest replacement rule here.
  return ['tools.search', 'tools.enable'].some(name => capability === name || capability === name.replace(/[^a-zA-Z0-9_-]/g, '_'))
}
export function visibleAssistantTurn(turn: TurnActivity): TurnActivity {
  const hidden = turn.items.filter(item => isToolDiscovery(item.capability))
  if (!hidden.length) return turn
  const counts = { ...turn.counts }
  for (const kind of Object.keys(counts) as (keyof TurnActivity['counts'])[]) {
    counts[kind] = Math.max(0, counts[kind] - hidden.filter(item => item.kind === kind).length)
  }
  return { ...turn, counts, items: turn.items.filter(item => !isToolDiscovery(item.capability)) }
}

/** Latest non-undone turn that changed files; questions do not consume Undo. */
export function latestChangedTurn(turns: TurnActivity[]): TurnActivity | undefined {
  return turns.filter(turn => !turn.undo.undoneAt && Object.entries(turn.counts).some(([kind, count]) => kind !== 'read' && count > 0))
    .reduce<TurnActivity | undefined>((latest, turn) => !latest || (turn.endedAt ?? turn.startedAt) > (latest.endedAt ?? latest.startedAt) ? turn : latest, undefined)
}
