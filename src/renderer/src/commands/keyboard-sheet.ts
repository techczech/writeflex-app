// The keyboard sheet's data (ADR-0043, ticket 04): place, registry and overrides in; sections out.
// <CheatSheet> only draws what this returns and holds the cursor; it decides nothing about rows.
//
// THE RULES
//   1. HERE IS `actionsAt`. The first section (only when there is a place) is exactly the commands
//      `actionsAt(place, state)` lists, in its order, grouped by `actionGroupOf` (Insert first):
//      the same rows, order and count as the status-bar chip and the ⌘K panel. Nothing is derived
//      a second time here. The Insert row's key reads "⌘K then ↵" (the drawing, note on state 18).
//   2. THE TASK SECTIONS LIST EVERY REGISTRY ROW EXCEPT A MIRROR. A mirror is a `sheet.*` row that
//      repeats a source command (`sheetSource.kind === 'command'`); it is never listed beside its
//      source, and every source is itself a row. What stays: commands on any surface (palette,
//      sheet or menu: Here lists menu-only commands, so the task view must), and the literal rows
//      (`sheetSource.kind === 'literal'`: keys with no command, kept as the sheet has had them),
//      except a key-only row that a registered command in the same sub-group already shows with the
//      same default key: it goes, its command stays (the drawing's own rule, state 18 notes).
//      A row marked not built yet (`future`) is shown greyed and is not counted.
//   3. SUB-GROUPS follow SUBGROUP_ORDER where the drawing fixes one, else the order the registry
//      first names them.
//   4. THE FILTER reaches all ten tasks and Here at once: every typed word must be in a row's label
//      or keywords. Counts then become the matches; a group with none is dropped.
//   5. CHORDS are the effective ones (chords.ts). A chord that differs from the default is
//      `rebound`, and `was` holds the defaults; an empty override is "no key" (not rebound).
import type { EditorState } from '@codemirror/state'
import { ACTIONS_HERE_TEXT } from './actions-here'
import { effectiveSheetChords, defaultChords, type OverrideMap } from './chords'
import { INSERT_OBJECT_ROW } from './command-places'
import { SUBGROUP_ORDER, TASK_GROUPS, type TaskGroup } from './command-task-groups'
import { actionGroupOf, actionsAt, placeLabel, type Place } from './place'
import { commandRegistry, type Command } from './registry'

/** The fixed strings of the sheet (TEXT.sheet in the drawing's builder). */
export const KEYBOARD_SHEET_TEXT = {
  title: 'Keyboard shortcuts',
  filter: 'Filter all commands',
  noKey: 'no key',
  run: 'Run',
  rebound: 'rebound',
  was: 'was',
  insertThen: '↵',
  none: (query: string): string => `No “${query}” command here`,
  /** "Here: on a heading": the chip's label with its first letter lower-cased. */
  here: (place: Place): string => {
    const label = placeLabel(place)
    return `Here: ${label.charAt(0).toLowerCase()}${label.slice(1)}`
  },
} as const

export type SheetSectionId = 'here' | TaskGroup

export type SheetRow = {
  id: string
  label: string
  /** Searchable words that are not drawn. */
  keywords: string
  /** The effective chords; empty means "no key". */
  chords: string[]
  /** The chord differs from the default (a rebinding made it). */
  rebound: boolean
  /** The default chords a rebound row was bound to; empty when it had none. */
  was: string[]
  /** The row's key is "⌘K then ↵" (the Insert row in the Here section). */
  then?: string
  /** Not built yet: drawn greyed, never counted. */
  future?: 'ship2' | 'build'
}
export type SheetGroup = { name: string; count: number; rows: SheetRow[] }
export type SheetSection = { id: SheetSectionId; label: string; count: number; groups: SheetGroup[] }

const words = (text: string): string[] => text.toLowerCase().split(/\s+/).filter(Boolean)
const matches = (row: SheetRow, query: readonly string[]): boolean => {
  const haystack = `${row.label} ${row.keywords}`.toLowerCase()
  return query.every((word) => haystack.includes(word))
}

/** Is this registry row a mirror of another command (rule 2)? */
export const isMirrorRow = (command: Pick<Command, 'sheetSource'>): boolean => command.sheetSource?.kind === 'command'

const isLiteralRow = (command: Pick<Command, 'sheetSource'>): boolean => command.sheetSource?.kind === 'literal'
const chordKey = (command: Command): string => defaultChords(command).join(' ')

/** A key-only row that a registered command in the same sub-group already shows with the same key
 *  (the drawing: New file, Rename file or folder, Move to folder, Duplicate file and Move to Bin go). */
const repeatsACommand = (row: Command, rows: readonly Command[]): boolean =>
  isLiteralRow(row) && chordKey(row) !== '' && rows.some((other) => !isLiteralRow(other) && other.task === row.task && other.subgroup === row.subgroup && chordKey(other) === chordKey(row))

/** The registry rows the task sections list (rule 2), in registry order. */
export const sheetRows = (): Command[] => {
  const own = commandRegistry.filter((command) => !isMirrorRow(command))
  return own.filter((command) => !repeatsACommand(command, own))
}

function rowOf(command: Command, overrides: OverrideMap, here: boolean): SheetRow {
  const chords = effectiveSheetChords(command, overrides)
  const override = overrides[command.id]
  const defaults = command.sheetSource?.kind === 'literal' ? [] : defaultChords(command)
  const rebound = override !== undefined && override !== '' && !(defaults.length === 1 && defaults[0] === override)
  const row: SheetRow = {
    id: command.id,
    label: command.label,
    keywords: (command.keywords ?? []).join(' '),
    chords,
    rebound,
    was: rebound ? defaults : [],
  }
  if (here && command.id === INSERT_OBJECT_ROW) { row.then = KEYBOARD_SHEET_TEXT.insertThen; row.label = ACTIONS_HERE_TEXT.insertRow }
  if (command.future) row.future = command.future
  return row
}

function groupRows(entries: Array<{ name: string; row: SheetRow }>, order: readonly string[], typed: readonly string[]): SheetGroup[] {
  const names = [...order]
  for (const { name } of entries) if (!names.includes(name)) names.push(name)
  return names
    .map((name) => {
      const rows = entries.filter((entry) => entry.name === name && matches(entry.row, typed)).map((entry) => entry.row)
      return { name, count: rows.filter((row) => !row.future).length, rows }
    })
    .filter((group) => group.rows.length > 0)
}

const countOf = (groups: readonly SheetGroup[]): number => groups.reduce((total, group) => total + group.count, 0)

export type KeyboardSheetInput = {
  /** The place the writer is at; null with no document open and no pane row, which drops the Here section. */
  place: Place | null
  /** The editor state commands' `when` is asked about; null with no document. */
  state: EditorState | null
  overrides: OverrideMap
  query?: string
}

/** The sections of the sheet: Here (when there is a place), then the ten task groups in order. */
export function keyboardSheet({ place, state, overrides, query = '' }: KeyboardSheetInput): SheetSection[] {
  const typed = words(query)
  const sections: SheetSection[] = []

  if (place) {
    const entries = actionsAt(place, state).map((command) => ({ name: actionGroupOf(command), row: rowOf(command, overrides, true) }))
    // Here's groups keep the order actionsAt gave them (Insert first, then the task groups by size).
    const order: string[] = []
    for (const { name } of entries) if (!order.includes(name)) order.push(name)
    const groups = groupRows(entries, order, typed)
    sections.push({ id: 'here', label: KEYBOARD_SHEET_TEXT.here(place), count: countOf(groups), groups })
  }

  const rows = sheetRows()
  for (const task of TASK_GROUPS) {
    const own = rows.filter((command) => command.task === task)
    // Sub-groups: the drawn order where there is one, else the order the registry first names them.
    const entries = own.map((command) => ({ name: command.subgroup, row: rowOf(command, overrides, false) }))
    const groups = groupRows(entries, SUBGROUP_ORDER[task] ?? [], typed)
    sections.push({ id: task, label: task, count: countOf(groups), groups })
  }
  return sections
}

/** The drawing's two columns: groups in order, cut where the row count is closest to half. */
export function splitColumns<T extends { rows: readonly unknown[] }>(groups: readonly T[]): [T[], T[]] {
  const weight = (group: T): number => group.rows.length + 1.5
  const total = groups.reduce((sum, group) => sum + weight(group), 0)
  const columns: [T[], T[]] = [[], []]
  let used = 0
  for (const group of groups) {
    const first = used + weight(group) / 2 <= total / 2 || columns[0].length === 0
    columns[first ? 0 : 1].push(group)
    used += weight(group)
  }
  return columns
}

