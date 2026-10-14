// The Guide's chapters, derived from the registry (ADR-0043, ticket 07). Nothing here is typed per
// chapter: a chapter's rows are the registry's commands in that task group, minus
//   - sheet mirror rows (`sheet.*` ids that repeat a source command),
//   - key-only sheet rows (`sheetSource.kind === 'literal'`: a key with no command behind it, so
//     nothing can report that it ran),
//   - commands marked not built (`future`),
// and with the sets in MERGED_ROWS folded into one row each. A merged row is ticked when ANY of its
// commands has run. A command listed in MERGED_ROWS that is not in the registry is skipped, so a
// row never counts a command this build does not have.
import { effectiveChords, type OverrideMap } from './chords'
import { SUBGROUP_ORDER, TASK_GROUPS, type TaskGroup } from './command-task-groups'
import { commandRegistry, type Command } from './registry'

/** The shape of a command this module reads. The registry's `Command` satisfies it. */
export type ChapterCommand = Pick<Command, 'id' | 'label' | 'task' | 'subgroup' | 'sheetSource' | 'future' | 'keys'>

/**
 * Rows that are one idea in several commands. `pair`: two keys for one idea (up/down, previous/next,
 * raise/lower), drawn with two key caps. `variants`: the choices of one setting (the six
 * read-aloud highlight colours, the ruler and Line focus sizes, the outline's show-level 1 to 6),
 * drawn as one row naming the variants. The label is what the row says.
 */
export type MergedRow = { label: string; kind: 'pair' | 'variants'; ids: readonly string[] }

export const MERGED_ROWS: readonly MergedRow[] = [
  // Write
  { label: 'Select to the start / end of the line', kind: 'pair', ids: ['selection.lineStart', 'selection.lineEnd'] },
  { label: 'Select to the start / end of the document', kind: 'pair', ids: ['selection.documentStart', 'selection.documentEnd'] },
  { label: 'Indent / outdent list item with children', kind: 'pair', ids: ['outline.indentListItem', 'outline.outdentListItem'] },
  { label: 'List type: a. b. c. · i. ii. iii. · 1. 2. 3. · bullet · checkboxes', kind: 'variants', ids: ['list.type.lettered', 'list.type.roman', 'list.type.numbered', 'list.type.bullet', 'list.type.checkboxes'] },
  { label: 'Align a column: left · centre · right', kind: 'variants', ids: ['table.alignLeft', 'table.alignCentre', 'table.alignRight'] },
  { label: 'Insert a column left / right', kind: 'pair', ids: ['table.insertLeft', 'table.insertRight'] },
  // Shape the document
  { label: 'Move this block up / down', kind: 'pair', ids: ['outline.moveBlockUp', 'outline.moveBlockDown'] },
  { label: 'Move this with everything under it up / down', kind: 'pair', ids: ['outline.moveSubtreeUp', 'outline.moveSubtreeDown'] },
  { label: 'Raise / lower the level of this line', kind: 'pair', ids: ['heading.decrease', 'heading.increase'] },
  { label: 'Raise / lower the level with everything under it', kind: 'pair', ids: ['outline.raiseSubtreeLevel', 'outline.lowerSubtreeLevel'] },
  { label: 'Previous / next heading', kind: 'pair', ids: ['outline.previousHeading', 'outline.nextHeading'] },
  { label: 'Next / previous block', kind: 'pair', ids: ['navigation.nextBlock', 'navigation.previousBlock'] },
  { label: 'Outline: show levels 1 to 1 … 1 to 6', kind: 'variants', ids: ['outline.showLevel1', 'outline.showLevel2', 'outline.showLevel3', 'outline.showLevel4', 'outline.showLevel5', 'outline.showLevel6'] },
  // Stay focused
  { label: 'Line focus size: 1 · 3 · 5 lines', kind: 'variants', ids: ['lineFocus.size1', 'lineFocus.size3', 'lineFocus.size5'] },
  { label: 'Ruler covers: thin rule · 1 · 3 · 5 lines · all below', kind: 'variants', ids: ['ruler.covers.thin', 'ruler.covers.1', 'ruler.covers.3', 'ruler.covers.5', 'ruler.covers.below'] },
  { label: 'Ruler opacity: lighter / darker', kind: 'pair', ids: ['ruler.opacity.lighter', 'ruler.opacity.darker'] },
  { label: 'Fixed line: top third · middle · lower third', kind: 'variants', ids: ['fixedLine.topThird', 'fixedLine.middle', 'fixedLine.lowerThird'] },
  // Listen
  { label: 'Read faster / slower', kind: 'pair', ids: ['readAloud.faster', 'readAloud.slower'] },
  { label: 'Next / previous sentence', kind: 'pair', ids: ['readAloud.nextSentence', 'readAloud.previousSentence'] },
  { label: 'Next / previous paragraph', kind: 'pair', ids: ['readAloud.nextParagraph', 'readAloud.previousParagraph'] },
  { label: 'Read-aloud highlight: terracotta · amber · green · blue · lilac · grey', kind: 'variants', ids: ['readAloudHighlight.terracotta', 'readAloudHighlight.amber', 'readAloudHighlight.green', 'readAloudHighlight.blue', 'readAloudHighlight.lilac', 'readAloudHighlight.grey'] },
  // Review and versions
  { label: 'Next / previous change', kind: 'pair', ids: ['review.nextChange', 'review.previousChange'] },
  // Find and manage files
  { label: 'Next / previous open tab', kind: 'pair', ids: ['navigation.nextTab', 'navigation.previousTab'] },
  { label: 'Next / previous panel tab', kind: 'pair', ids: ['navigation.nextPanelTab', 'navigation.previousPanelTab'] },
  { label: 'Next / previous file in folder', kind: 'pair', ids: ['navigation.nextFolderFile', 'navigation.previousFolderFile'] },
  { label: 'Back / forward along the link trail', kind: 'pair', ids: ['navigation.linkTrailBack', 'navigation.linkTrailForward'] },
  { label: 'Pin / unpin this workspace', kind: 'variants', ids: ['workspace.pin', 'workspace.unpin'] },
  // Collect and plan
  { label: 'Move Plan part up / down', kind: 'pair', ids: ['plan.moveUp', 'plan.moveDown'] },
  // Share and export
  { label: 'Move export preset up / down', kind: 'pair', ids: ['exportPresets.moveUp', 'exportPresets.moveDown'] },
  // Set up WriteFlex
  { label: 'Use dark / light theme', kind: 'variants', ids: ['appearance.darkTheme', 'appearance.lightTheme'] },
]

/** One row of a chapter's This chapter list. `ids` are the commands it stands for (one, unless merged). */
export type ChapterRow = {
  id: string
  label: string
  ids: readonly string[]
  merged: MergedRow['kind'] | null
  subgroup: string
}
export type ChapterSubgroup = { name: string; rows: ChapterRow[] }
export type Chapter = { task: TaskGroup; subgroups: ChapterSubgroup[]; rows: ChapterRow[] }

const isMirror = (command: Pick<ChapterCommand, 'sheetSource'>): boolean => command.sheetSource?.kind === 'command'
const isKeyOnly = (command: Pick<ChapterCommand, 'sheetSource'>): boolean => command.sheetSource?.kind === 'literal'

/** Does a registry command count in a chapter at all? */
export const countsInChapter = (command: ChapterCommand): boolean => !isMirror(command) && !isKeyOnly(command) && !command.future

/** Derive every chapter, in the ten-group order, from a command list (the registry by default). */
export function deriveChapters(commands: readonly ChapterCommand[] = commandRegistry, merged: readonly MergedRow[] = MERGED_ROWS): Chapter[] {
  const counted = commands.filter(countsInChapter)
  const byId = new Map(counted.map((command) => [command.id, command]))
  return TASK_GROUPS.map((task) => {
    const rows: ChapterRow[] = []
    const seen = new Set<string>()
    for (const command of counted.filter((entry) => entry.task === task)) {
      if (seen.has(command.id)) continue
      const set = merged.find((entry) => entry.ids.includes(command.id))
      // Members of a set that this build has, in the set's own order, and only those in this task.
      const members = set ? set.ids.filter((id) => byId.get(id)?.task === task) : [command.id]
      members.forEach((id) => seen.add(id))
      rows.push({ id: members[0], label: set && members.length > 1 ? set.label : command.label, ids: members, merged: set && members.length > 1 ? set.kind : null, subgroup: command.subgroup })
    }
    const names = [...(SUBGROUP_ORDER[task] ?? [])]
    for (const row of rows) if (!names.includes(row.subgroup)) names.push(row.subgroup)
    const subgroups = names.map((name) => ({ name, rows: rows.filter((row) => row.subgroup === name) })).filter((group) => group.rows.length > 0)
    return { task, subgroups, rows: subgroups.flatMap((group) => group.rows) }
  })
}

export const chapterFor = (chapters: readonly Chapter[], task: string): Chapter | undefined => chapters.find((chapter) => chapter.task === task)

/** Has any command of the row run? A merged row is ticked when any of its commands has. */
export const rowTried = (row: ChapterRow, ran: ReadonlySet<string>): boolean => row.ids.some((id) => ran.has(id))

export function triedCount(chapter: Chapter, ran: ReadonlySet<string>): number {
  return chapter.rows.filter((row) => rowTried(row, ran)).length
}

/** The chords a row shows: every member's effective chords, once each. Variants show none. */
export function rowChords(row: ChapterRow, overrides: OverrideMap, commands: readonly ChapterCommand[] = commandRegistry): string[] {
  if (row.merged === 'variants') return []
  const out: string[] = []
  for (const id of row.ids) {
    const command = commands.find((entry) => entry.id === id)
    if (!command) continue
    for (const chord of effectiveChords(command as Command, overrides)) if (!out.includes(chord)) out.push(chord)
  }
  return out
}

/** The first row not yet tried, in list order: the one the drawing marks as next. */
export function nextUntried(chapter: Chapter, ran: ReadonlySet<string>): ChapterRow | null {
  return chapter.rows.find((row) => !rowTried(row, ran)) ?? null
}

/** The lesson file of a chapter: `01 Write.md` … `10 Set up WriteFlex.md` (00 is the welcome). */
export const lessonFileFor = (task: TaskGroup): string => `${String(TASK_GROUPS.indexOf(task) + 1).padStart(2, '0')} ${task}.md`

/** Which chapter a file name in the Example collection belongs to, or null (also for `00 Start here.md`). */
export function chapterOfLessonFile(fileName: string): TaskGroup | null {
  return TASK_GROUPS.find((task) => lessonFileFor(task) === fileName) ?? null
}
