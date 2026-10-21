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

export function dispatchPlanCommand(command: PlanCommandName): void {
  window.dispatchEvent(new CustomEvent<PlanCommandName>(PLAN_COMMAND_EVENT, { detail: command }))
}
