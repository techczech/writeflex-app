// WriteFlex's command registry in the shared @app-patterns/commands form: the one list the macOS menu bar, the
// Settings window's Shortcuts page, the settings file's shortcut overrides and `writeflex settings` read.
//
// The commands themselves are defined once, in the renderer's registry (src/renderer/src/commands/
// registry.ts); command-catalogue.ts is that list as generated plain data, so main does not bundle the
// editor. This file adds what the shared registry needs and the renderer's does not say:
//   - an id the package accepts (lower case, '.', '-': `edit.selectBodyExceptMetadata` becomes
//     `edit.select-body-except-metadata`), with the way back;
//   - the chord in the package's spelling (⌘ ⌃ ⌥ ⇧ order: `⇧⌘D` becomes `⌘⇧D`);
//   - which commands are fixed (the estate's shared chords, and the context keys the old Keycap
//     Ledger would not rebind), which keys belong to a scope (the Plan's bare keys, a list's Tab keys),
//     and which commands stay out of the menu bar, each with its reason;
//   - the commands the main process owns (New File, Open…, Checkpoint, Close Tab …), which were
//     hand-written in the old menu.ts and had no registry entry.
//
// Pure: no Electron, no React, no CodeMirror.
import { canonChord, defineRegistry, isValidChord, type CommandDef, type MenuDecl } from '@app-patterns/commands'
import { MENU_PLACEMENT } from './command-menu'
import { COMMAND_CATALOGUE, type CatalogueRow } from './command-catalogue'

export type Group =
  | 'File'
  | 'Write'
  | 'Shape the document'
  | 'View'
  | 'Stay focused'
  | 'Listen'
  | 'Review and versions'
  | 'Find and manage files'
  | 'Collect and plan'
  | 'Work with the agent'
  | 'Share and export'
  | 'Set up WriteFlex'

/** Renderer ids that are the package's own frame commands: Settings… (⌘,) and the cheat sheet (⌘/). */
export const FRAME_OF_WRITEFLEX: Readonly<Record<string, string>> = { 'app.settings': 'settings', 'app.shortcuts': 'cheat' }

/**
 * Fixed: never rebound in Settings, and nothing else may take the chord. The estate's shared chords
 * (⇧⌘P, ⇧⌘K, ⇧⌘F) and the system's (⌘Z, ⇧⌘Z, ⌘A), and the context keys the old Keycap Ledger kept
 * out of rebinding (⌘↵ and ⌥↵ inside a wikilink, ⌘↵ on a checkbox line).
 */
const FIXED = new Set([
  'tab.close', 'app.commandPalette', 'app.quickOpen', 'app.search', 'edit.undo', 'edit.redo', 'edit.selectBodyExceptMetadata',
  'idea.materialise', 'navigation.followWikilink', 'edit.toggleCheckbox', 'folio.open',
])

/** Keys that belong to one context: only there may they be bare keys, and there they shadow a global chord. */
const SCOPES: Readonly<Record<string, string>> = {
  'plan.addPart': 'plan', 'plan.adoptPart': 'plan', 'plan.moveUp': 'plan', 'plan.moveDown': 'plan', 'plan.materialise': 'plan', 'plan.removePart': 'plan',
  'outline.indentListItem': 'list', 'outline.outdentListItem': 'list',
  'idea.materialise': 'wikilink', 'navigation.followWikilink': 'wikilink',
  'edit.toggleCheckbox': 'checkbox', 'folio.open': 'folio',
}

/** Commands left out of the menu bar, with the reason the Shortcuts page shows. */
const NO_MENU: Readonly<Record<string, string>> = {
  'edit.undo': 'The Edit menu’s own Undo runs it',
  'edit.redo': 'The Edit menu’s own Redo runs it',
  'selection.lineStart': 'A selection movement key, used while typing',
  'selection.lineEnd': 'A selection movement key, used while typing',
  'selection.documentStart': 'A selection movement key, used while typing',
  'selection.documentEnd': 'A selection movement key, used while typing',
  'outline.indentListItem': 'The Tab key of a list item, used while typing',
  'outline.outdentListItem': 'The Tab key of a list item, used while typing',
  'plan.addPart': 'A key of the Plan list: it acts on the Plan row that has focus',
  'plan.adoptPart': 'A key of the Plan list: it acts on the Plan row that has focus',
  'plan.moveUp': 'A key of the Plan list: it acts on the Plan row that has focus',
  'plan.moveDown': 'A key of the Plan list: it acts on the Plan row that has focus',
  'plan.materialise': 'A key of the Plan list: it acts on the Plan row that has focus',
  'plan.removePart': 'A key of the Plan list: it acts on the Plan row that has focus',
}

const ICON_OF_GROUP: Readonly<Record<string, string>> = {
  File: 'file', Write: 'pen-line', 'Shape the document': 'list-tree', View: 'eye', 'Stay focused': 'focus', Listen: 'volume-2',
  'Review and versions': 'git-compare', 'Find and manage files': 'folder-open', 'Collect and plan': 'layout-grid',
  'Work with the agent': 'bot', 'Share and export': 'share', 'Set up WriteFlex': 'settings',
}

// ---------------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------------

const OPEN_RENDERER_ID = 'app.open'
const OPEN_BRIDLE_ID = 'file.open'

/** `edit.selectBodyExceptMetadata` → `edit.select-body-except-metadata`; frame commands map to the frame's ids. */
export function bridleIdOf(writeflexId: string): string {
  if (writeflexId === OPEN_RENDERER_ID) return OPEN_BRIDLE_ID
  const frame = FRAME_OF_WRITEFLEX[writeflexId]
  if (frame) return frame
  return writeflexId.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

const WRITEFLEX_OF_BRIDLE = new Map<string, string>([...COMMAND_CATALOGUE.map((row) => [bridleIdOf(row.id), row.id] as [string, string])])
const CATALOGUE_BY_ID = new Map<string, CatalogueRow>(COMMAND_CATALOGUE.map((row) => [row.id, row]))

/** Renderer id for a registry command, including the main-dispatched palette rows; null if unknown. */
export const writeflexIdOf = (bridleId: string): string | null => WRITEFLEX_OF_BRIDLE.get(bridleId) ?? null

// ---------------------------------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------------------------------

/** '⇧⌘D' → '⌘⇧D'; '?' → '⌘'-less '⇧/'; '' when the renderer's chord has no spelling in the package. */
export function bridleChordOf(writeflexChord: string): string {
  const t = writeflexChord.trim()
  if (!t) return ''
  const spelled = t.endsWith('?') ? `${t.slice(0, -1)}⇧/` : t.replace(/\+$/, '=')
  const chord = canonChord(spelled)
  return isValidChord(chord) ? chord : ''
}

/** '⌘⇧D' → '⇧⌘D' (the renderer's ⌃⌥⇧⌘ order, as its key handlers compare chords); '' stays ''. */
export function writeflexChordOf(bridleChord: string): string {
  const t = bridleChord.trim()
  if (!t) return ''
  const glyphs = '⌃⌥⇧⌘'
  const chars = [...t]
  let i = 0
  const mods = new Set<string>()
  while (i < chars.length - 1 && glyphs.includes(chars[i])) { mods.add(chars[i]); i += 1 }
  const key = chars.slice(i).join('')
  return `${[...glyphs].filter((g) => mods.has(g)).join('')}${key}`
}

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------

function defOf(row: CatalogueRow): CommandDef<Group, void> | null {
  if (FRAME_OF_WRITEFLEX[row.id]) return null // the package supplies Settings… and the cheat sheet
  const group = row.task as Group
  const def: CommandDef<Group, void> = {
    id: bridleIdOf(row.id),
    group,
    label: row.label,
    key: bridleChordOf(row.keys[0] ?? ''),
    icon: ICON_OF_GROUP[group] ?? 'command',
  }
  if (FIXED.has(row.id) || (!row.bindable && !SCOPES[row.id])) def.fixed = true
  const scope = SCOPES[row.id]
  if (scope) def.scope = scope
  const noMenu = NO_MENU[row.id]
  if (noMenu) { def.noMenu = true; def.noMenuReason = noMenu }
  return def
}

export const DEFS: CommandDef<Group, void>[] = [
  ...COMMAND_CATALOGUE.flatMap((row) => { const def = defOf(row); return def ? [def] : [] }),
]

export const registry = defineRegistry<Group, void>(DEFS)

/** The app's menus; the frame supplies App, Edit, View, Window and Help (Edit, View and Help gain these groups). */
export const MENUS: MenuDecl<Group>[] = MENU_PLACEMENT
  .filter(menu => menu.tasks.length > 0)
  .map(menu => ({ label: menu.label, groups: [...menu.tasks] as Group[] }))

/** Whether a renderer command may hold a shortcut in the registry's `keys` (not fixed, no scope, known). */
export function registryHoldsKeyOf(writeflexId: string): boolean {
  const row = CATALOGUE_BY_ID.get(writeflexId)
  if (!row || FRAME_OF_WRITEFLEX[writeflexId]) return false
  const def = registry.byId(bridleIdOf(writeflexId))
  return Boolean(def && !def.fixed && !def.scope)
}

/** Commands the main process runs itself: the package's Settings, Export and Import. */
export const FRAME_MAIN_COMMANDS: ReadonlySet<string> = new Set(['settings', 'export-settings', 'import-settings'])
