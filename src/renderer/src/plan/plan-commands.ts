export const PLAN_COMMAND_EVENT = 'writeflex:plan-command'

export type PlanCommandName = 'add' | 'adopt' | 'adopt-front-matter' | 'move-up' | 'move-down' | 'open-part' | 'remove' | 'add-all' | 'sort'
  // The Folio outline's Details card (0.26 ticket 4): D moves focus to its first field.
  | 'details'
  // R: focus to the selected part's role menu.
  | 'role'
  // Title-conflict buttons: the selected part, or every part whose title and heading disagree.
  // The 2026-10-19 Folio page: write the agent instructions (both, AGENTS.md only, CLAUDE.md only), choose front matter, close or open Not in the outline.
  | 'agents-both' | 'agents-agents' | 'agents-claude' | 'front-matter-choose' | 'not-in-outline-toggle'
  | 'title-heading-to-title' | 'title-title-to-heading' | 'titles-heading-to-title' | 'titles-title-to-heading'

let invocation: 'explicit' | 'shortcut' = 'explicit'

/** Stamp synchronous shortcut dispatches so a palette action remains explicit after focus is restored. */
export function runAsPlanShortcut(run: () => void): void {
  const previous = invocation
  invocation = 'shortcut'
  try { run() } finally { invocation = previous }
}
export function planCommandIsShortcut(event: Event): boolean { return (event as Event & { commandSource?: string }).commandSource === 'shortcut' }
export function dispatchPlanCommand(command: PlanCommandName): void {
  const event = Object.assign(new CustomEvent<PlanCommandName>(PLAN_COMMAND_EVENT, { detail: command }), { commandSource: invocation })
  window.dispatchEvent(event)
}

/** A Folio command handed from the room to the Folio page: the command, the part the room had selected (its Plan key) and a number that tells one hand-over from the next. */
export type PendingPlanCommand = { command: PlanCommandName; key: { title: string; path: string | null } | null; seq: number }

export const HANDOVER_PART_GONE = 'That part is no longer in the Folio outline, so the command was not run.'

/**
 * What the Folio page does with a command handed over from the room, given its Plan read so far:
 * `wait` (not read yet, or the read failed: the command stays pending), `select` (make that part the selected one, then ask again),
 * `refuse` (the room's part is not in the outline any more: the command is dropped, never run on another part) or `run`.
 */
export function handoverStep(
  plan: { parts: ReadonlyArray<{ title: string; path: string | null }> } | null | undefined,
  pending: Pick<PendingPlanCommand, 'key'>,
  selected: number | null,
): { kind: 'wait' } | { kind: 'select'; at: number } | { kind: 'refuse' } | { kind: 'run' } {
  if (!plan) return { kind: 'wait' }
  const { key } = pending
  if (!key) return { kind: 'run' }
  const at = plan.parts.findIndex((part) => part.title === key.title && part.path === key.path)
  if (at < 0) return { kind: 'refuse' }
  return selected === at ? { kind: 'run' } : { kind: 'select', at }
}
