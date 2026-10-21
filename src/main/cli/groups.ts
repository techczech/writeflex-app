/** The ten approved WriteFlex task groups, verbatim and in order
 *  (docs/design/2026-10-06-onboarding-and-command-discovery/command-map-writeflex.json). */
export const TASK_GROUPS = [
  'Write',
  'Shape the document',
  'Stay focused',
  'Listen',
  'Review and versions',
  'Find and manage files',
  'Collect and plan',
  'Work with the agent',
  'Share and export',
  'Set up WriteFlex',
] as const

export type TaskGroup = (typeof TASK_GROUPS)[number]
