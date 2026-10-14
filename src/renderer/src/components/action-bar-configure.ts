import type { LucideIcon } from 'lucide-react'
import { ACTION_BAR_SEPARATOR, isActionBarSeparator } from '../../../shared/action-bar-settings'
import { actionBarIcon, type ActionBarEntrySpec } from './action-bar-commands'

/**
 * The configure sheet's MODEL (ADR-0040, ticket A2): every edit the two-list sheet can make to the
 * bar's stored list, as pure functions over that list.
 *
 * It is separate from the sheet's chrome on purpose. Drag is one way to reach these operations and
 * the keyboard is another; both call exactly the same functions, so "reorder from the keyboard" and
 * "reorder by dragging" cannot drift into two behaviours. It also means the rules that protect the
 * bar — one command is one button, the bar never empties, separators only ever bound groups — are
 * checkable without a browser.
 */

/** A command the sheet can put on the bar: the palette's own row, narrowed to what a row draws. */
export type ConfigureCommand = {
  id: string
  label: string
  /** The command's EFFECTIVE chord (overrides applied), or undefined when it has none. */
  keys?: string
  /** RESOLVED the way the bar resolves it (`actionBarIcon`) — never the palette row's icon raw. */
  icon: LucideIcon
  /** Extra searchable terms the palette already carries; searched, never drawn. */
  keywords?: string[]
}

/** A palette row, as App lists it: what the sheet's left-hand list is built from. */
export type PaletteRow = { id: string; label: string; icon: LucideIcon; keys?: string; keywords?: string[] }

/**
 * The sheet's command list, built from the palette's rows through THE BAR'S OWN icon resolution.
 *
 * The sheet draws the same commands the bar draws, so it must not decide their icons a second time:
 * a row here and a button there are the same verb, and the writer configures the bar by recognising
 * its buttons. One resolution (`actionBarIcon`), two surfaces — they cannot disagree.
 */
export function configureCommands(
  rows: readonly PaletteRow[],
  drawn?: ReadonlyMap<string, ActionBarEntrySpec>,
): ConfigureCommand[] {
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    icon: actionBarIcon(row.id, row.icon, drawn),
    ...(row.keys ? { keys: row.keys } : {}),
    ...(row.keywords ? { keywords: row.keywords } : {}),
  }))
}

/** One drawn row of either list. Separators are items in their own right, exactly as the lock says. */
export type ConfigureRow =
  | { kind: 'separator'; key: string; index: number }
  | { kind: 'command'; key: string; index: number; commandId: string; label: string; keys: string | null; icon: LucideIcon; onBar: boolean }

/** The sheet's two lists. `bar` is the stored order; `available` is every command the app can do. */
export type ConfigureLists = { bar: ConfigureRow[]; available: ConfigureRow[] }

/**
 * The right-hand list: the writer's stored order, resolved for display.
 *
 * An id with no command in this build is dropped from the DRAWING the same way it is dropped from
 * the bar — a row the writer could neither read nor act on is not an editing surface — but it stays
 * in the stored list, so it returns to its place the day the command does. Every edit below
 * therefore works on the stored list, never on these rows' positions.
 */
export function barRows(items: readonly string[], commands: ReadonlyMap<string, ConfigureCommand>): ConfigureRow[] {
  const rows: ConfigureRow[] = []
  const seen = new Set<string>()
  items.forEach((item, index) => {
    if (isActionBarSeparator(item)) {
      rows.push({ kind: 'separator', key: `sep:${index}`, index })
      return
    }
    if (seen.has(item)) return
    const command = commands.get(item)
    if (!command) return
    seen.add(item)
    rows.push({ kind: 'command', key: item, index, commandId: item, label: command.label, keys: command.keys ?? null, icon: command.icon, onBar: true })
  })
  return rows
}

/**
 * What the writer can type to reach the separator row. It has no label of its own to search, so
 * without these terms a search would put it out of reach — and "the separator is placeable" is a
 * requirement of the lock, not a nicety.
 */
const SEPARATOR_SEARCH_TERMS = ['separator', 'group', 'divider', 'boundary']

/**
 * Does this search NAME the separator?
 *
 * An empty search matches it because an unfiltered list pins it at the top. Anything else must be
 * the START of one of its terms — a bare substring would drag it into far too much ("o" is inside
 * both "group" and "boundary"), and a row nobody asked for at the top of a list of answers is the
 * shape of the defect this whole rule exists to close.
 */
export function separatorMatchesQuery(query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return SEPARATOR_SEARCH_TERMS.some((term) => term.startsWith(needle))
}

/**
 * The left-hand list: EVERY command the app can do, in the palette's own order, each row saying
 * whether it is already on the bar. The drawing shows commands that are on the bar listed here too
 * (Add a comment, Read aloud are both in the default set), so the list is complete rather than
 * shrinking as the writer works — adding one that is already there simply moves the focus to it.
 *
 * The separator is the UNFILTERED list's first row, pinned above the commands: the lock makes
 * separators draggable items, and a draggable item needs somewhere to be dragged from. Under a
 * SEARCH it is a match like any other — present when the writer typed one of its terms and absent
 * otherwise. It was unconditional until the live pass of 2026-09-12: searching "typewriter" still
 * listed the separator first, so the very next Enter put a separator on the bar.
 */
export function availableRows(commands: readonly ConfigureCommand[], items: readonly string[], query = ''): ConfigureRow[] {
  const onBar = new Set(items.filter((item) => !isActionBarSeparator(item)))
  const rows = commands.map((command, position): ConfigureRow => ({
    kind: 'command',
    key: command.id,
    index: position,
    commandId: command.id,
    label: command.label,
    keys: command.keys ?? null,
    icon: command.icon,
    onBar: onBar.has(command.id),
  }))
  if (!separatorMatchesQuery(query)) return rows
  return [{ kind: 'separator', key: 'new-separator', index: -1 }, ...rows]
}

/**
 * WHERE THE LEFT LIST'S ACTIVE ROW SITS — the row Enter adds, and the row ↓ from the search field
 * lands on.
 *
 * THE ACTIVE ROW IS THE LIST'S FIRST COMMAND. Unfiltered that is the row just below the pinned
 * separator, which stays one ↑ away. Searched, it is the top match, because a filtered list is
 * nothing but matches. The separator is Enter's target in exactly one case — when the list holds
 * no command at all, which is what a search for the separator itself produces — so the writer can
 * still place one by naming it, and can never be handed one for asking about something else.
 *
 * Stating it as "the first command" rather than "row 0 when searching" is deliberate: it holds
 * however loosely the separator row matches a query, so a later change to what reaches it cannot
 * quietly reopen this.
 *
 * The live pass of 2026-09-12 found the old rule (always row 0, separator always pinned there)
 * putting a separator on the bar for a writer who typed "typewriter" and pressed Enter — the
 * sheet's single most likely first action.
 */
export function availableActiveIndex(rows: readonly ConfigureRow[]): number {
  const firstCommand = rows.findIndex((row) => row.kind === 'command')
  return firstCommand < 0 ? 0 : firstCommand
}

/** Case-insensitive search over what a row shows plus what the palette already searches. */
export function filterCommands(commands: readonly ConfigureCommand[], query: string): ConfigureCommand[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...commands]
  return commands.filter((command) =>
    `${command.label} ${command.id} ${(command.keywords ?? []).join(' ')}`.toLowerCase().includes(needle),
  )
}

/**
 * How many commands the STORED LIST carries (separators are grouping, not buttons).
 *
 * This is the list, not the bar: a stored id with no command in this build counts here and draws
 * nothing. The sheet's header must report what the writer can SEE, so it counts the rows `barRows`
 * actually produced (`drawnCommandCount`) — the live pass of 2026-09-12 found the header claiming
 * "16 on the bar" over a bar of 15, because the default then stored one id with no command behind
 * it. Every default id runs today, but a stored list outlives a retired verb and the header must go
 * on counting buttons. The one caller that must still read the stored list is the
 * bar-cannot-be-emptied rule below.
 */
export function commandCount(items: readonly string[]): number {
  return new Set(items.filter((item) => !isActionBarSeparator(item))).size
}

/** How many buttons the bar DRAWS: the command rows of the list the sheet just rendered. */
export function drawnCommandCount(rows: readonly ConfigureRow[]): number {
  return rows.filter((row) => row.kind === 'command').length
}

/**
 * How many groups the STORED LIST describes: runs of commands between separators, empty runs not
 * counted. Like `commandCount`, this is the list and not the bar — a run whose every id is a
 * command this build cannot draw is a group here and draws nothing there. The sheet's header uses
 * `drawnGroupCount`; this one is for reasoning about the stored shape itself.
 */
export function groupCount(items: readonly string[]): number {
  let groups = 0
  let run = 0
  for (const item of items) {
    if (isActionBarSeparator(item)) {
      if (run > 0) groups += 1
      run = 0
    } else run += 1
  }
  return run > 0 ? groups + 1 : groups
}

/** How many groups the bar DRAWS: the same rule, read off the rows the sheet just rendered. */
export function drawnGroupCount(rows: readonly ConfigureRow[]): number {
  let groups = 0
  let run = 0
  for (const row of rows) {
    if (row.kind === 'separator') {
      if (run > 0) groups += 1
      run = 0
    } else run += 1
  }
  return run > 0 ? groups + 1 : groups
}

/**
 * How many commands the bar would DRAW for this stored list — the one question every "is the bar
 * still usable?" rule has to ask. With the commands this window can run it counts what the writer
 * would see; without them it can only count the list, which is what a caller that has no command
 * map is asking for anyway.
 */
function drawableCount(items: readonly string[], commands?: ReadonlyMap<string, ConfigureCommand>): number {
  return commands ? drawnCommandCount(barRows(items, commands)) : commandCount(items)
}

/** Clamp an insertion point into `0…items.length`. */
function clampAt(items: readonly string[], at: number): number {
  return Math.max(0, Math.min(items.length, Math.trunc(at)))
}

/**
 * Put `commandId` on the bar at `at`. A command already on the bar is not duplicated — one command
 * is one button — so this MOVES it to the new place instead, which is what dropping it there means.
 */
export function addToBar(items: readonly string[], commandId: string, at: number): string[] {
  if (isActionBarSeparator(commandId)) return insertSeparator(items, at)
  const existing = items.indexOf(commandId)
  if (existing >= 0) return moveTo(items, existing, at)
  const next = [...items]
  next.splice(clampAt(items, at), 0, commandId)
  return next
}

/**
 * Put a new separator at `at`.
 *
 * Two in a row is refused and so is a leading one: a boundary needs something on both sides to be a
 * boundary. A TRAILING one is kept — it is the writer saying "the next verb starts a new group", and
 * the bar simply draws nothing for it until one arrives (`resolveActionBarItems` closes the empty
 * run without a hairline). That is what lets a group be built from the keyboard in the obvious
 * order: separator, then the commands that belong after it.
 */
export function insertSeparator(items: readonly string[], at: number): string[] {
  const index = clampAt(items, at)
  if (index === 0) return [...items]
  if (isActionBarSeparator(items[index - 1] ?? '') || isActionBarSeparator(items[index] ?? '')) return [...items]
  const next = [...items]
  next.splice(index, 0, ACTION_BAR_SEPARATOR)
  return next
}

/**
 * Take the item at `index` off the bar.
 *
 * THE BAR NEVER EMPTIES. An empty stored list reads as "never set" and falls back to the drawn
 * default (`parseActionBarItems`), so allowing the sheet to empty the bar would make the default
 * reappear behind the writer's back — and an edit that leaves a blank strip cannot tell the writer
 * whether the user broke the app or it broke itself. A writer who wants no bar hides the bar.
 *
 * "Empty" means WHAT THE WRITER SEES, so pass the commands this window can run: counting stored
 * entries let the last drawn buttons be removed one by one while the rule counted an id that drew
 * nothing and said the bar was still populated (the 2026-09-12 default stored exactly one such id).
 * Any stored list can name a verb this build retired, so the reading stands. The count is the same
 * `barRows`/`drawnCommandCount` pair the sheet's header reports, so the rule and the header can
 * never disagree about whether the bar is empty.
 */
export function removeFromBar(
  items: readonly string[],
  index: number,
  commands?: ReadonlyMap<string, ConfigureCommand>,
): string[] {
  if (index < 0 || index >= items.length) return [...items]
  const next = [...items]
  const [removed] = next.splice(index, 1)
  if (!isActionBarSeparator(removed) && drawableCount(next, commands) === 0) return [...items]
  return tidySeparators(next)
}

/** Move the item at `index` so that it lands BEFORE the item currently at `at` (a drop target). */
export function moveTo(items: readonly string[], index: number, at: number): string[] {
  if (index < 0 || index >= items.length) return [...items]
  const target = clampAt(items, at)
  const next = [...items]
  const [item] = next.splice(index, 1)
  next.splice(target > index ? target - 1 : target, 0, item)
  return tidySeparators(next)
}

/**
 * Collapse what a move or a removal can leave behind: a leading separator, or two in a row. Each of
 * those would be a group boundary with nothing on one side of it. A trailing separator survives (see
 * `insertSeparator`): it bounds the group the writer is about to build, and draws nothing meanwhile.
 */
export function tidySeparators(items: readonly string[]): string[] {
  const out: string[] = []
  for (const item of items) {
    if (!isActionBarSeparator(item)) {
      out.push(item)
      continue
    }
    if (out.length === 0 || isActionBarSeparator(out[out.length - 1])) continue
    out.push(item)
  }
  return out
}

/** Where a drop at pointer `y` lands in a list whose rows occupy `rects`, in list order. */
export function dropIndexFor(rects: ReadonlyArray<{ top: number; height: number }>, y: number): number {
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index]
    if (y < rect.top + rect.height / 2) return index
  }
  return rects.length
}
