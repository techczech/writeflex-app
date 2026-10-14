// Actions here (ADR-0043, ticket 03; the drawn menu, 2026-10-12): the rows of the ⌘K panel. This
// module is the seam between the place list (`actionsAt`, place.ts), the drawn layout (actions-layout.ts)
// and the panel that draws it.
//
// THE RULES
//   1. THE LAYOUT IS DRAWN, THE AVAILABILITY IS `actionsAt`. A place's rows are its LAYOUTS entry, in
//      the drawn order; a row, a split row's two commands, a strip cell or an opener child is kept only
//      while `actionsAt(place, state)` offers its command there. An opener with no child left goes.
//   2. THE COUNT IS THE ROWS: the rows of the groups (a split row and an opener are one row each; an
//      opener's children are not rows) plus the strip's cells. `hereCount` is the chip's number.
//   3. FILTERING reaches a row's label and its keywords (the registry's own label among them), every
//      typed word having to match, and it reaches INTO openers: while a filter is typed a child
//      command is a row of its own, the strip's cells are rows, and the Insert row is followed by
//      the objects "Insert object…" would list.
//   4. THE CHORDS are the effective ones (chords.ts): a rebinding replaces the default, an empty
//      override means no key and the row shows none.
import type { EditorState } from '@codemirror/state'
import { effectiveChords, resolveChord, type OverrideMap } from './chords'
import { INSERT_GROUP, INSERT_OBJECT_ROW } from './command-places'
import { COMPOSED_PREFIX, LAYOUTS } from './actions-layout'
import { actionsAt, type Place } from './place'
import { registryCommand, type Command } from './registry'
import { launchesAgent } from '../components/agent-icon'
import { AppWindow, Braces, Code, Image, Minus, Network, Quote, Shapes, Superscript, Table, Workflow, type LucideIcon } from 'lucide-react'

/** The fixed strings of the panel (TEXT.actionsHere and TEXT.insert in the drawing's builder). */
export const ACTIONS_HERE_TEXT = {
  title: 'Actions here',
  filter: 'Filter actions',
  all: 'All commands…',
  none: (query: string): string => `No “${query}” action here`,
  insertRow: 'Insert object…',
  insertTitle: 'Insert object',
  insertFilter: 'Filter objects',
} as const

export type PanelView = 'here' | 'insert' | 'diagram' | 'menu'

/** One key cap of a split row: it runs its own command when clicked. */
export type SplitCap = { id: string; label: string; chords: string[] }

export type ActionRow = {
  id: string
  label: string
  /** The effective chords, display glyphs; empty when the command has no key. */
  chords: string[]
  /** Searchable words that are not drawn. */
  keywords: string
  /** Opens a list beside the panel (an opener's children, the object list, the diagram kinds) instead of running anything. */
  opens?: PanelView
  /** The row hands work to the agent: it wears the agent icon (ticket 12). */
  agent?: boolean
  /** The glyph before the label. */
  icon?: LucideIcon
  /** An opener's child list (it opens beside the panel); the children are not rows of the place. */
  children?: ActionGroup[]
  /** A split row: one row, two commands, two key caps. Return runs `second`, ⇧Return `first`. */
  split?: { first: SplitCap; second: SplitCap }
  /** A quiet tag after the label (the "now" of the block's own type); a tagged row is not selectable. */
  tag?: string
  /** Drawn but never run, never counted. */
  inert?: boolean
}
export type ActionGroup = { name: string; rows: ActionRow[] }

/** The objects behind "Insert object…", in the drawn order (the drawing's INSERT_OBJECTS). */
export const INSERT_OBJECT_IDS = ['insert.table', 'insert.image', 'insert.widget', 'insert.code', 'insert.mermaid', 'insert.markmap', 'insert.svg', 'insert.divider', 'insert.footnote', 'insert.metadata', 'insert.reference'] as const

/** The glyph of each object in Insert object… (lucide, drawn at the size the right-pane tabs use). */
export const INSERT_OBJECT_ICONS: Record<(typeof INSERT_OBJECT_IDS)[number], LucideIcon> = {
  'insert.table': Table,
  'insert.image': Image,
  'insert.widget': AppWindow,
  'insert.code': Code,
  'insert.mermaid': Workflow,
  'insert.markmap': Network,
  'insert.svg': Shapes,
  'insert.divider': Minus,
  'insert.footnote': Superscript,
  'insert.metadata': Braces,
  'insert.reference': Quote,
}

/** In the object list the widget reads "Widget…", like "Image…"; the palette command is "Insert widget…". */
const INSERT_OBJECT_LABELS: Partial<Record<(typeof INSERT_OBJECT_IDS)[number], string>> = { 'insert.widget': 'Widget…' }

/** The five diagrams "Flow diagram" offers, as it has always offered them. */
export const DIAGRAM_ROWS: readonly ActionRow[] = [
  { id: 'mermaid:flowchart-right', label: 'Flowchart →', chords: [], keywords: 'mermaid' },
  { id: 'mermaid:flowchart-down', label: 'Flowchart ↓', chords: [], keywords: 'mermaid' },
  { id: 'mermaid:sequence', label: 'Sequence', chords: [], keywords: 'mermaid' },
  { id: 'mermaid:state', label: 'State', chords: [], keywords: 'mermaid' },
  { id: 'mermaid:pie', label: 'Pie', chords: [], keywords: 'mermaid' },
]

/** The Insert object… row: it opens the object list beside the panel. */
export const INSERT_OPENER: ActionRow = { id: INSERT_OBJECT_ROW, label: ACTIONS_HERE_TEXT.insertRow, chords: [], keywords: 'insert object', opens: 'insert' }

const rowOf = (command: Pick<Command, 'id' | 'label' | 'keywords' | 'keys'> & Partial<Command>, overrides: OverrideMap): ActionRow => {
  if (command.id === INSERT_OBJECT_ROW) return INSERT_OPENER
  const row: ActionRow = { id: command.id, label: command.label, chords: effectiveChords(command as Command, overrides), keywords: (command.keywords ?? []).join(' ') }
  if (launchesAgent(command.id)) row.agent = true
  if (command.id === 'insert.mermaid') row.opens = 'diagram'
  return row
}

/** A layout row: the command's row with the drawn icon and label; the registry's own label stays searchable. */
const drawnRow = (id: string, icon: LucideIcon, label: string, overrides: OverrideMap): ActionRow => {
  const command = registryCommand(id)
  const base = rowOf(command, overrides)
  // Two alternative chords for one command (Fold's ⌘8 and ⌃⇧[): the row shows the primary only.
  return { ...base, label, icon, chords: base.chords.slice(0, 1), keywords: `${base.keywords} ${command.label}`.trim() }
}

const cap = (id: string, overrides: OverrideMap): SplitCap => ({ id, label: registryCommand(id).label, chords: effectiveChords(registryCommand(id), overrides) })

/** Rows and separators in a run become groups: split at each separator, none left empty. */
function intoGroups(items: ReadonlyArray<ActionRow | 'sep'>): ActionGroup[] {
  const groups: ActionGroup[] = []
  let current: ActionRow[] = []
  for (const item of items) {
    if (item === 'sep') { if (current.length > 0) groups.push({ name: '', rows: current }); current = [] } else current.push(item)
  }
  if (current.length > 0) groups.push({ name: '', rows: current })
  return groups
}

export type PlaceLayout = {
  /** The Format strip above the filter (the selection place); empty elsewhere. */
  strip: ActionRow[]
  stripCaption: string
  groups: ActionGroup[]
}

/** The drawn rows at a place: the layout, cut down to what `actionsAt` offers there. */
export function actionLayoutAt(place: Place, state: EditorState | null, overrides: OverrideMap): PlaceLayout {
  const offered = new Set(actionsAt(place, state).map((command) => command.id))
  const has = (id: string): boolean => offered.has(id)
  const items: Array<ActionRow | 'sep'> = []
  let strip: ActionRow[] = []
  let stripCaption = ''
  for (const item of LAYOUTS[place]) {
    if (item.kind === 'sep') items.push('sep')
    else if (item.kind === 'row') { if (has(item.id)) items.push(drawnRow(item.id, item.icon, item.label, overrides)) }
    else if (item.kind === 'strip') {
      strip = item.cells.filter((cell) => has(cell.id)).map((cell) => drawnRow(cell.id, cell.icon, cell.label, overrides))
      stripCaption = item.caption
    } else if (item.kind === 'split') {
      if (has(item.first) && has(item.second)) {
        const first = cap(item.first, overrides)
        const second = cap(item.second, overrides)
        items.push({ id: item.id, label: item.label, icon: item.icon, chords: [], keywords: `${registryCommand(item.first).label} ${registryCommand(item.second).label}`, split: { first, second } })
      }
    } else {
      const kids: Array<ActionRow | 'sep'> = []
      for (const kid of item.children) {
        if (kid.kind === 'sep') kids.push('sep')
        else if (kid.kind === 'now') kids.push({ id: `now:${kid.label}`, label: kid.label, icon: kid.icon, chords: [], keywords: '', tag: kid.tag, inert: true })
        else if (kid.kind === 'composed') {
          // A quotation's target: offered while the quotation can be made a plain paragraph first. It runs both as one undo step.
          if (has('outline.makeParagraph')) kids.push({ ...drawnRow(kid.id, kid.icon, kid.label, overrides), id: COMPOSED_PREFIX + kid.id, chords: [] })
        } else if (has(kid.id)) kids.push(drawnRow(kid.id, kid.icon, kid.label, overrides))
      }
      const children = intoGroups(kids)
      if (children.some((group) => group.rows.some((kid) => !kid.inert))) {
        items.push({ id: item.id, label: item.label, icon: item.icon, chords: [], keywords: '', opens: 'menu', children })
      }
    }
  }
  return { strip, stripCaption, groups: intoGroups(items) }
}

/** The groups of the drawn rows at a place (the strip is `actionLayoutAt(...).strip`). */
export const actionGroupsAt = (place: Place, state: EditorState | null, overrides: OverrideMap): ActionGroup[] => actionLayoutAt(place, state, overrides).groups

/** The Insert object list, in the drawn order, with the effective chords. */
export const insertObjectRows = (overrides: OverrideMap): ActionRow[] => INSERT_OBJECT_IDS.map((id) => {
  const row = { ...rowOf(registryCommand(id), overrides), icon: INSERT_OBJECT_ICONS[id], ...(INSERT_OBJECT_LABELS[id] ? { label: INSERT_OBJECT_LABELS[id] } : {}) }
  return id === 'insert.mermaid' ? { ...row, opens: 'diagram' } : row
})

const words = (text: string): string[] => text.toLowerCase().split(/\s+/).filter(Boolean)
const matches = (row: ActionRow, query: string[]): boolean => {
  const haystack = `${row.label} ${row.keywords}`.toLowerCase()
  return query.every((word) => haystack.includes(word))
}

/** Every row a filter can reach: the rows, and the children inside openers, each listed once. */
function reachable(groups: readonly ActionGroup[]): ActionRow[] {
  const seen = new Set<string>()
  const out: ActionRow[] = []
  const visit = (row: ActionRow): void => {
    if (row.inert || seen.has(row.id)) return
    seen.add(row.id)
    out.push(row)
    for (const group of row.children ?? []) for (const kid of group.rows) visit(kid)
  }
  for (const group of groups) for (const row of group.rows) visit(row)
  return out
}

/**
 * The groups that remain for a typed filter; none are dropped when nothing is typed. With a filter
 * typed the result is one list: the matching rows, openers' children among them, with the objects
 * that match following the Insert row (`objects`, which "Insert object…" would list).
 */
export function filterActionGroups(groups: readonly ActionGroup[], query: string, objects: readonly ActionRow[] = []): ActionGroup[] {
  const typed = words(query)
  if (typed.length === 0) return groups.map((group) => ({ ...group, rows: [...group.rows] }))
  const all = reachable(groups)
  const hits = all.filter((row) => matches(row, typed))
  // The objects are reachable only where the place has an Insert row (a file has none).
  const reached = all.some((row) => row.id === INSERT_OBJECT_ROW) ? objects.filter((row) => matches(row, typed) && !hits.some((hit) => hit.id === row.id)) : []
  const rows = hits.flatMap((row) => row.id === INSERT_OBJECT_ROW ? [row, ...reached] : [row])
  if (reached.length > 0 && !hits.some((row) => row.id === INSERT_OBJECT_ROW)) rows.push(...reached)
  return rows.length > 0 ? [{ name: '', rows }] : []
}

/** The rows a list counts: split rows and openers are one each; an inert marker is none. */
export const rowCount = (groups: readonly ActionGroup[]): number => groups.reduce((total, group) => total + group.rows.filter((row) => !row.inert).length, 0)

/** The chip's number: the drawn rows at a place plus the strip's cells. */
export const hereCount = (place: Place, state: EditorState | null): number => {
  const layout = actionLayoutAt(place, state, {})
  return rowCount(layout.groups) + layout.strip.length
}

/** The chord the "All commands…" row shows: the command palette's effective chord. */
export const allCommandsChord = (overrides: OverrideMap): string | null => resolveChord('app.commandPalette', overrides)
