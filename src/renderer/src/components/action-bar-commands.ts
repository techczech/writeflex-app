import {
  Bold,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListOrdered,
  MessageSquare,
  Pilcrow,
  Quote,
  Redo2,
  Strikethrough,
  Table,
  Undo2,
  Volume2,
  type LucideIcon,
} from 'lucide-react'
import { ACTION_BAR_SEPARATOR, isActionBarSeparator } from '../../../shared/action-bar-settings'

/**
 * The action bar's command set (ADR-0040), as DATA — one list, in one place. The drawn set is "a
 * starting point, not a decision": striking a command through, or reordering the groups, is an edit
 * to this array and never a refactor. Ticket A2 replaces this seed with the writer's stored order
 * and feeds `resolveActionBarGroups` the same way.
 *
 * Deliberately NOT here: a review-navigation group. The Reviewing belt already owns ‹ › and the
 * change count, and ADR-0026 forbids two surfaces restating each other. Anyone who wants review
 * verbs on the bar drags them in — that is what configurable means.
 */

/** One button on the bar: which command it runs, the icon it wears, and how it behaves in Reviewing. */
export type ActionBarEntrySpec = {
  /** A registry command id. An entry whose command is not runnable today simply does not render. */
  commandId: string
  icon: LucideIcon
  /**
   * True for the writing verbs the drawing DIMS in Reviewing. They keep their place rather than
   * vanishing, so the bar holds its shape and muscle memory survives the mode.
   */
  dimsInReviewing?: boolean
  /**
   * Related commands offered from a small ▾ beside the button — the list button's List type choices
   * (docs/design/2026-09-27-checkbox-lists, frame 6). The button itself keeps its own verb.
   */
  menu?: { label: string; commandIds: readonly string[] }
}

/** The List type family the list button's ▾ offers, in the palette's drawn order (frame 6). */
export const LIST_TYPE_MENU = {
  label: 'List type',
  commandIds: ['list.type.lettered', 'list.type.roman', 'list.type.numbered', 'list.type.bullet', 'list.type.checkboxes'],
} as const

/** A group of buttons, separated from its neighbours by a hairline and never broken across the fold. */
export type ActionBarGroupSpec = { id: string; entries: ActionBarEntrySpec[] }

/**
 * The default set, in the drawn order: history · inline marks · headings · blocks · aside.
 *
 * Seven of the drawn verbs had NO command in the app when the bar was built; ticket A1b made six of
 * them real — strikethrough, plain paragraph, the two list toggles, blockquote, and the table insert
 * (which was menu-surfaced only and is now the same code registered). The seventh, the aside
 * group's message square, is the note WriteFlex already has: `edit.toggleComment`, the `// ` line
 * note that is left out of the word count and stripped on export. All sixteen drawn buttons now
 * run, and the bar draws sixteen.
 *
 * That button is NOT an anchored annotation on a span of words. That is a real feature wanted for
 * both the writer and the agent, and it is its own design round — when it lands it gets its own id
 * and its own place, and pointing this square at a half-built one meanwhile would have been worse
 * than leaving the square dark.
 *
 * The resolver still drops an id it cannot run, because the writer's STORED list outlives any verb
 * this build retires (see `resolveActionBarItems`); it is simply no longer the default's own case.
 */
export const DEFAULT_ACTION_BAR_GROUPS: ActionBarGroupSpec[] = [
  {
    id: 'history',
    entries: [
      { commandId: 'edit.undo', icon: Undo2 },
      { commandId: 'edit.redo', icon: Redo2 },
    ],
  },
  {
    id: 'marks',
    entries: [
      { commandId: 'edit.bold', icon: Bold, dimsInReviewing: true },
      { commandId: 'edit.italic', icon: Italic, dimsInReviewing: true },
      { commandId: 'edit.strikethrough', icon: Strikethrough, dimsInReviewing: true },
      { commandId: 'edit.link', icon: Link, dimsInReviewing: true },
    ],
  },
  {
    id: 'headings',
    entries: [
      { commandId: 'outline.makeHeadingLevel1', icon: Heading1, dimsInReviewing: true },
      { commandId: 'outline.makeHeadingLevel2', icon: Heading2, dimsInReviewing: true },
      { commandId: 'outline.makeHeadingLevel3', icon: Heading3, dimsInReviewing: true },
      { commandId: 'outline.makeParagraph', icon: Pilcrow, dimsInReviewing: true },
    ],
  },
  {
    id: 'blocks',
    entries: [
      { commandId: 'list.bullet', icon: List, dimsInReviewing: true },
      { commandId: 'list.ordered', icon: ListOrdered, dimsInReviewing: true, menu: LIST_TYPE_MENU },
      { commandId: 'block.quote', icon: Quote, dimsInReviewing: true },
      { commandId: 'insert.table', icon: Table, dimsInReviewing: true },
    ],
  },
  {
    id: 'aside',
    entries: [
      { commandId: 'edit.toggleComment', icon: MessageSquare },
      { commandId: 'readAloud.start', icon: Volume2 },
    ],
  },
]

/** What the bar needs to know about a command it can run — the palette's own row, narrowed. */
export type RunnableCommand = {
  label: string
  /**
   * The icon the palette draws this command with. The drawn default set carries its own icons (see
   * `ActionBarEntrySpec`); this is what a command the writer DRAGGED onto the bar wears, so adding a
   * verb never needs a second icon table beside the palette's.
   *
   * REQUIRED, and that is the whole protection: every row the palette lists carries an icon (its
   * own, or the palette's generic glyph), so "a button on the bar can be seen" is settled where the
   * rows are built rather than by a runtime drop that could never fire.
   */
  icon: LucideIcon
  /** The command's EFFECTIVE chord (overrides applied), or undefined when it has none. */
  keys?: string
  disabled?: boolean
  disabledReason?: string
  run: () => void
}

/** One resolved button. `dimmed` means visible, in place, and not pressable. */
export type ActionBarItem = {
  commandId: string
  label: string
  keys: string | null
  icon: LucideIcon
  dimmed: boolean
  run: () => void
  /** The button's ▾ menu, resolved like the bar itself; absent when nothing in it can run. */
  menu?: { label: string; items: ActionBarItem[] }
}

export type ActionBarGroup = { id: string; items: ActionBarItem[] }

/**
 * The default set as ONE FLAT LIST of stored items: command ids with a separator between groups.
 *
 * This is the same array as `DEFAULT_ACTION_BAR_GROUPS`, read a different way — not a copy of it.
 * The stored list the writer edits and the drawn default are therefore the same shape, so resetting
 * the bar is "forget the stored list", never "rebuild it from a second source of truth".
 */
export function flattenActionBarGroups(spec: readonly ActionBarGroupSpec[]): string[] {
  const items: string[] = []
  for (const group of spec) {
    if (items.length > 0) items.push(ACTION_BAR_SEPARATOR)
    for (const entry of group.entries) items.push(entry.commandId)
  }
  return items
}

/** The drawn default, as the writer's list would store it. */
export const DEFAULT_ACTION_BAR_ITEMS: readonly string[] = flattenActionBarGroups(DEFAULT_ACTION_BAR_GROUPS)

/**
 * The drawn presentation of each default command — its icon and whether it dims in Reviewing —
 * keyed by command id and DERIVED from the one default list rather than restated beside it.
 */
export const ACTION_BAR_ENTRY_DEFAULTS: ReadonlyMap<string, ActionBarEntrySpec> = new Map(
  DEFAULT_ACTION_BAR_GROUPS.flatMap((group) => group.entries.map((entry) => [entry.commandId, entry] as const)),
)

/**
 * THE ONE PLACE an action-bar command's icon is decided: a drawn default wears the icon the drawing
 * gave it, and anything else wears the icon the palette lists it with.
 *
 * Both surfaces that draw these commands — the bar itself and the configure sheet's two lists — go
 * through this function, so the sheet cannot show one glyph while the bar shows another (the live
 * pass of 2026-09-12 found exactly that: eleven of the sheet's rows drew the palette's generic ⌘
 * placeholder beside a bar drawing Undo, Redo, H1, H2, H3, ¶, lists, quote and table).
 */
export function actionBarIcon(
  commandId: string,
  paletteIcon: LucideIcon,
  drawn: ReadonlyMap<string, ActionBarEntrySpec> = ACTION_BAR_ENTRY_DEFAULTS,
): LucideIcon {
  return drawn.get(commandId)?.icon ?? paletteIcon
}

/**
 * Resolve the writer's stored list against the commands this window can actually run (App passes
 * the SAME rows the command palette lists and the chord dispatcher fires, so the bar can never
 * disagree with either about what a button does or which key does it).
 *
 * THE STORED LIST IS NEVER ALLOWED TO BREAK THE BAR:
 *  - an id naming a command this build no longer has is dropped SILENTLY — no gap, no dead button,
 *    no error (it stays in storage, so a command that returns returns to its place);
 *  - a repeated id keeps its first place only, so one command is one button;
 *  - separators only ever BOUND groups: leading, trailing and doubled ones collapse, so no empty
 *    group and no orphan hairline can be drawn.
 *
 * A command outside the drawn default cannot claim the drawn "dims in Reviewing" treatment, because
 * nothing drew it: it is dimmed only when the app itself reports it unavailable, which is the honest
 * signal and the same one the palette shows.
 */
export function resolveActionBarItems(
  items: readonly string[],
  commands: ReadonlyMap<string, RunnableCommand>,
  options: { reviewing: boolean; drawn?: ReadonlyMap<string, ActionBarEntrySpec> },
): ActionBarGroup[] {
  const drawnEntries = options.drawn ?? ACTION_BAR_ENTRY_DEFAULTS
  const groups: ActionBarGroup[] = []
  const seen = new Set<string>()
  let current: ActionBarItem[] = []
  const flush = (): void => {
    if (current.length === 0) return
    groups.push({ id: `g${groups.length + 1}`, items: current })
    current = []
  }
  for (const item of items) {
    if (isActionBarSeparator(item)) {
      flush()
      continue
    }
    if (seen.has(item)) continue
    const command = commands.get(item)
    if (!command) continue
    const drawn = drawnEntries.get(item)
    seen.add(item)
    const dimsHere = options.reviewing && drawn?.dimsInReviewing === true
    const resolved: ActionBarItem = {
      commandId: item,
      label: command.label,
      keys: command.keys ?? null,
      icon: actionBarIcon(item, command.icon, drawnEntries),
      dimmed: command.disabled === true || dimsHere,
      run: command.run,
    }
    // The ▾ menu's rows are the app's own commands too; one it cannot run is left out, and the
    // menu dims with its button in Reviewing, since it rewrites the same markers.
    const menuItems = (drawn?.menu?.commandIds ?? []).flatMap((id): ActionBarItem[] => {
      const entry = commands.get(id)
      return entry
        ? [{ commandId: id, label: entry.label, keys: entry.keys ?? null, icon: entry.icon, dimmed: entry.disabled === true || dimsHere, run: entry.run }]
        : []
    })
    if (drawn?.menu && menuItems.length > 0) resolved.menu = { label: drawn.menu.label, items: menuItems }
    current.push(resolved)
  }
  flush()
  return groups
}

/**
 * The same resolution, from the grouped spec — one code path, so the drawn default and a stored
 * list can never resolve by different rules. Group ids are positional (`g1`, `g2`…) because after
 * A2 a group is simply "what lies between two separators" and has no name of its own.
 */
export function resolveActionBarGroups(
  spec: readonly ActionBarGroupSpec[],
  commands: ReadonlyMap<string, RunnableCommand>,
  options: { reviewing: boolean },
): ActionBarGroup[] {
  // The spec's OWN entries are the drawn presentation here: a caller passing a set other than the
  // default must not have its icons resolved against the default's.
  const drawn = new Map(spec.flatMap((group) => group.entries.map((entry) => [entry.commandId, entry] as const)))
  return resolveActionBarItems(flattenActionBarGroups(spec), commands, { ...options, drawn })
}
