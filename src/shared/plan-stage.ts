export const PLAN_STAGES = ['idea', 'jottings', 'partial draft', 'rough draft', 'final draft', 'published'] as const
export type PlanStage = (typeof PLAN_STAGES)[number]

/** Existing Collection statuses projected onto the approved Plan vocabulary. This never writes. */
export const PLAN_STAGE_ALIASES: Readonly<Record<string, PlanStage>> = {
  idea: 'idea',
  jottings: 'jottings',
  'note gathering': 'jottings',
  drafting: 'jottings',
  'in progress': 'partial draft',
  'partial draft': 'partial draft',
  'rough draft': 'rough draft',
  editing: 'final draft',
  ready: 'final draft',
  'final draft': 'final draft',
  published: 'published',
}

export function planStageForStatus(status: string | null | undefined): PlanStage | null {
  if (!status) return null
  return PLAN_STAGE_ALIASES[status.trim().toLocaleLowerCase()] ?? null
}
