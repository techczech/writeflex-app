export const PLAN_COMMAND_EVENT = 'writeflex:plan-command'

export type PlanCommandName = 'add' | 'adopt' | 'move-up' | 'move-down' | 'open-part' | 'remove'

export function dispatchPlanCommand(command: PlanCommandName): void {
  window.dispatchEvent(new CustomEvent<PlanCommandName>(PLAN_COMMAND_EVENT, { detail: command }))
}
