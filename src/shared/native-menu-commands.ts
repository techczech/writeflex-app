export const NATIVE_EDIT_LABELS = { cut: 'Cut', copy: 'Copy', paste: 'Paste', pasteAndMatchStyle: 'Paste and Match Style', delete: 'Delete', selectAll: 'Select All' } as const

import type { MenuCommand } from './command-menu'

/** The native Edit frame owns these keys outside CodeMirror. Shared with input ownership and duplicate suppression. */
export const NATIVE_EDIT_ROLE_CHORDS: Readonly<Record<string, string>> = {
  undo: '⌘Z', redo: '⇧⌘Z', cut: '⌘X', copy: '⌘C', paste: '⌘V', pasteAndMatchStyle: '⌥⇧⌘V', selectAll: '⌘A',
}

/** Existing menu operations, registered without changing their shipped chords. */
export const NATIVE_MENU_COMMANDS = [
  { id: 'file.new', nativeKey: true, label: 'New File', keys: '⌘N', action: 'new-file', task: 'Find and manage files', subgroup: 'Files and quick open' },
  { id: 'folder.new', nativeKey: true, label: 'New Folder', keys: '⌃⌘N', action: 'new-folder', task: 'Find and manage files', subgroup: 'Files and quick open' },
  { id: 'window.new', nativeKey: true, label: 'New Window', keys: '⌥⌘N', task: 'Find and manage files', subgroup: 'Files and quick open' },
  { id: 'app.open', nativeKey: true, label: 'Open…', keys: '⌘O', action: 'open-dialog', task: 'Find and manage files', subgroup: 'Files and quick open' },
  { id: 'app.openRecent', label: 'Open Recent', task: 'Find and manage files', subgroup: 'Files and quick open' },
  { id: 'file.checkpoint', nativeKey: true, label: 'Checkpoint', keys: '⌘S', action: 'save', task: 'Find and manage files', subgroup: 'Files and quick open' },
  { id: 'tab.close', nativeKey: true, label: 'Close Tab', keys: '⌘W', action: 'close-tab', task: 'Find and manage files', subgroup: 'Tabs' },
  { id: 'view.proseIncrease', label: 'Increase Prose Size', keys: '⌘+', keyAliases: ['⌘=', '⇧⌘='], action: 'prose-zoom-in', task: 'Set up WriteFlex', subgroup: 'View and text size' },
  { id: 'view.proseDecrease', label: 'Decrease Prose Size', keys: '⌘-', keyAliases: ['⇧⌘-'], action: 'prose-zoom-out', task: 'Set up WriteFlex', subgroup: 'View and text size' },
  { id: 'view.proseReset', label: 'Reset Prose Size', keys: '⌥⌘0', action: 'prose-zoom-reset', task: 'Set up WriteFlex', subgroup: 'View and text size' },
  { id: 'view.columnIncrease', label: 'Increase Column Width', keys: '⌥⌘+', keyAliases: ['⌥⌘=', '⌥⇧⌘='], action: 'column-width-in', task: 'Set up WriteFlex', subgroup: 'View and text size' },
  { id: 'view.columnDecrease', label: 'Decrease Column Width', keys: '⌥⌘-', keyAliases: ['⌥⇧⌘-'], action: 'column-width-out', task: 'Set up WriteFlex', subgroup: 'View and text size' },
  { id: 'view.developerTools', nativeKey: true, label: 'Toggle Developer Tools', keys: '⌥⇧⌘I', task: 'Set up WriteFlex', subgroup: 'View and text size' },
  { id: 'view.fullScreen', label: 'Toggle Full Screen', task: 'Set up WriteFlex', subgroup: 'View and text size' },
] as const

/** Native ownership predates this parcel (`nativeKey`); the other keys stay renderer-owned. */
export const MAIN_MENU_KEY_IDS: ReadonlySet<string> = new Set(NATIVE_MENU_COMMANDS.filter(c => 'nativeKey' in c).map(c => c.id))
export const NATIVE_MENU_ACTIONS: ReadonlySet<string> = new Set(NATIVE_MENU_COMMANDS.flatMap(c => 'action' in c ? [c.action] : []))

/** The one line under Open Recent when nothing has been opened yet. */
export const NO_RECENTS_LABEL = 'No Recent Vaults'

/** What the menu may do from main alone, when no editor window has published a model or none is focused. */
export const MENU_FALLBACK_ENABLED = {
  always: ['window.new', 'app.open', 'app.openRecent', 'app.about'],
  /** Window operations main can send or run itself, with no renderer model: the native-keyed commands and the two View items. */
  withWindow: ['file.new', 'folder.new', 'file.checkpoint', 'tab.close', 'view.developerTools', 'view.fullScreen'],
  /** The update items also work with no window focused, through a hidden editor window. */
  update: ['app.checkForUpdates', 'app.whatsNew'],
} as const

/**
 * The menu before any renderer has published: the native commands and the app items main can run alone.
 * Labels repeat the registry's (tests/main/menu-registry.test.ts compares them), so the bar is complete from launch.
 */
export const SEED_MENU_COMMANDS: readonly MenuCommand[] = [
  { id: 'app.settings', label: 'Open Settings…', task: 'Set up WriteFlex', subgroup: 'Settings and shortcuts', chord: '⌘,', enabled: false },
  { id: 'app.about', label: 'About WriteFlex', task: 'Set up WriteFlex', subgroup: 'Settings and shortcuts', enabled: true },
  { id: 'app.checkForUpdates', label: 'Check for Updates…', task: 'Set up WriteFlex', subgroup: 'Settings and shortcuts', enabled: false },
  { id: 'app.whatsNew', label: 'What’s new in WriteFlex', task: 'Set up WriteFlex', subgroup: 'Settings and shortcuts', enabled: false },
  ...NATIVE_MENU_COMMANDS.map(c => ({ id: c.id, label: c.label, task: c.task, subgroup: c.subgroup, enabled: false, ...('keys' in c ? { chord: c.keys } : {}) })),
]
