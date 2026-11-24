// The palette's "groups first, open one to browse" model: pure, so it is tested without React.
// Group names, their order and sub-group order all come from commands/command-task-groups.ts
// (ADR-0043): no second list lives here.
import { SUBGROUP_ORDER, TASK_GROUPS, type TaskGroup } from '../commands/command-task-groups'
import { fuzzyScore } from '../fuzzy'

/** The fields of a palette command the grouping reads. */
export type Groupable = {
  label: string
  group: TaskGroup
  subgroup?: string
  keywords?: string[]
  leadsFor?: string[]
}

/** Top level (Recent, the task groups, Skills; typing searches everything) or one opened group. */
export type PaletteView = { kind: 'top' } | { kind: 'group'; group: TaskGroup }
export const TOP_VIEW: PaletteView = { kind: 'top' }

/** One row per task group, in ADR-0043 order, counting the commands the palette was handed for it. */
export function taskGroupCounts(commands: readonly Groupable[]): Array<{ group: TaskGroup; count: number }> {
  return TASK_GROUPS.map((group) => ({ group, count: commands.filter((command) => command.group === group).length }))
}

export const commandCountText = (count: number): string => `${count} ${count === 1 ? 'command' : 'commands'}`

/** Whether a typed query finds this command: the same fields the top-level ranking matches through. */
export function commandMatches(query: string, command: Groupable): boolean {
  const q = query.trim()
  if (!q) return true
  if (command.leadsFor?.includes(q.toLowerCase())) return true
  if (fuzzyScore(q, command.label) !== null) return true
  if (fuzzyScore(q, [command.label, command.group, ...(command.keywords ?? [])].join(' ')) !== null) return true
  return command.subgroup ? fuzzyScore(q, command.subgroup) !== null : false
}

/**
 * An opened group's commands under their sub-group headings: the drawn order where SUBGROUP_ORDER
 * fixes one, else the order the commands first name them; rows keep the order they were handed in.
 * A query keeps only matching rows and drops headings left empty.
 */
export function groupSubsections<T extends Groupable>(commands: readonly T[], group: TaskGroup, query = ''): Array<{ label: string; commands: T[] }> {
  const own = commands.filter((command) => command.group === group)
  const nameOf = (command: T): string => command.subgroup ?? group
  const names = [...(SUBGROUP_ORDER[group] ?? [])]
  for (const command of own) if (!names.includes(nameOf(command))) names.push(nameOf(command))
  return names
    .map((label) => ({ label, commands: own.filter((command) => nameOf(command) === label && commandMatches(query, command)) }))
    .filter((section) => section.commands.length > 0)
}

export type PaletteKeyAction = 'open-group' | 'back' | 'close' | null

/** What a key does to the palette's view, before ordinary row navigation gets it. */
export function paletteKeyAction({ view, query, key, selectedIsGroup }: {
  view: PaletteView
  query: string
  key: string
  selectedIsGroup: boolean
}): PaletteKeyAction {
  if (key === 'Escape') return view.kind === 'group' ? 'back' : 'close'
  if (view.kind === 'top') return selectedIsGroup && (key === 'Enter' || key === 'ArrowRight') ? 'open-group' : null
  return query === '' && (key === 'ArrowLeft' || key === 'Backspace') ? 'back' : null
}

/** The footer line in commands mode. */
export function paletteFooterHint(view: PaletteView, query: string): string {
  if (view.kind === 'group') return '← back · ↵ run'
  return query.trim() ? '↑↓ move · ↵ run' : '↑↓ move · → open group · ↵ run'
}

export const groupCrumb = (group: TaskGroup): string => `${group} ›`
export const groupRowKey = (group: TaskGroup): string => `group:${group}`
