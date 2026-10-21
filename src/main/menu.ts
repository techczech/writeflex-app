import { COLLECTION_PAGE_COMMANDS } from '../shared/collection-page-commands'
import { BrowserWindow, Menu, dialog, type MenuItemConstructorOptions } from 'electron'
import { statSync } from 'node:fs'
import { allStates, type WindowState } from './state'
import type { WindowManager } from './windows'
import type { SettingsStore } from './settings'
import { startScreenLists } from './start-screen-model'
import type { MenuAction } from '../preload'

function focusedState(): WindowState | null {
  const window = BrowserWindow.getFocusedWindow()
  if (!window) return null
  return allStates().find((state) => state.window === window) ?? null
}

/** Menu commands the renderer owns (they touch the editor buffer) go to the focused window. */
function sendMenuAction(action: MenuAction): void {
  BrowserWindow.getFocusedWindow()?.webContents.send('menu:action', action)
}

export function updateCollectionMenu(): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('collection-page')
  const enabled = focusedState()?.collectionPageActive === true
  for (const child of item?.submenu?.items ?? []) {
    child.enabled = enabled
    child.visible = child.id !== 'collection-page:bulk-folio' || focusedState()?.collectionPageFolio === true
  }
}

/** Same dialog as the renderer's workspace:open-dialog, but routed straight through the manager. */
async function promptOpen(manager: WindowManager): Promise<void> {
  const from = focusedState()
  const options: Electron.OpenDialogOptions = {
    title: 'Open Folder or Markdown File',
    properties: ['openFile', 'openDirectory'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] }]
  }
  const result = from ? await dialog.showOpenDialog(from.window, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return
  const picked = result.filePaths[0]
  if (statSync(picked).isDirectory()) await manager.openFolder(from, picked)
  else await manager.openFile(from, picked)
}

/** Display-chord glyphs → Electron accelerator tokens (Round A T6 effective-chord labels). */
const ACCELERATOR_GLYPHS: Record<string, string> = { '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift', '⌘': 'CmdOrCtrl' }

/** '⌥⌘D' → 'Alt+CmdOrCtrl+D'; null when the chord has no accelerator-expressible key. */
function chordToAccelerator(chord: string): string | null {
  const parts: string[] = []
  let rest = chord
  while (rest.length > 1 && ACCELERATOR_GLYPHS[rest[0]]) {
    parts.push(ACCELERATOR_GLYPHS[rest[0]])
    rest = rest.slice(1)
  }
  if (!rest) return null
  parts.push(rest.length === 1 ? rest.toUpperCase() : rest)
  return parts.join('+')
}

/**
 * The accelerator a menu item should DISPLAY for a bindable command (Round A T6): the writer's
 * override when one exists ('' = unassigned → no accelerator shown), else the shipped fallback.
 * All mapped items are registerAccelerator:false, so this is honest labelling, never key claiming.
 */
function effectiveAccelerator(settings: SettingsStore, commandId: string, fallback: string): { accelerator: string } | Record<string, never> {
  let overrides: Record<string, unknown> = {}
  try {
    const raw = settings.get('shortcuts.overrides')
    if (typeof raw === 'string' && raw !== '') {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) overrides = parsed as Record<string, unknown>
    }
  } catch {
    /* malformed overrides read as none */
  }
  const override = overrides[commandId]
  if (typeof override !== 'string') return { accelerator: fallback }
  if (override === '') return {}
  const accelerator = chordToAccelerator(override)
  return accelerator ? { accelerator } : {}
}

/**
 * Build the application menu (ADR-0007). File owns ⌘N/⌃⌘N/⌘O/⌘S/⌘W now that the renderer keydown
 * handler no longer does; Reload is deliberately omitted so ⌘R stays the renderer's Rename shortcut.
 */
export function buildAppMenu(manager: WindowManager, settings: SettingsStore): Menu {
  const isMac = process.platform === 'darwin'
  const accel = (commandId: string, fallback: string) => effectiveAccelerator(settings, commandId, fallback)
  // Pinned folders first (in the user's order), then recents that are not pinned.
  // The same lists the start screen shows (the Example collection, while shown, is in neither).
  const { pinned, recents } = startScreenLists(settings)
  const open = (root: string): MenuItemConstructorOptions => ({ label: root, click: () => void manager.openFolder(focusedState(), root) })
  const recentRoots = recents.map((recent) => recent.root)
  const recentItems: MenuItemConstructorOptions[] = pinned.length || recentRoots.length
    ? [
        ...pinned.map(open),
        ...(pinned.length && recentRoots.length ? [{ type: 'separator' as const }] : []),
        ...recentRoots.map(open),
      ]
    : [{ label: 'No Recent Workspaces', enabled: false }]

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New File', accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new-file') },
        { label: 'New Folder', accelerator: 'Ctrl+CmdOrCtrl+N', click: () => sendMenuAction('new-folder') },
        { label: 'New Window', accelerator: 'Alt+CmdOrCtrl+N', click: () => { manager.createWindow() } },
        { label: 'Capture an Idea…', ...accel('idea.capture', 'Shift+CmdOrCtrl+N'), registerAccelerator: false, click: () => sendMenuAction('capture-idea') },
        // ⌘O routes to the focused renderer's own open flow (onMenuAction → workspace:open-dialog),
        // so binding into a start-screen window refreshes that window's view — a main-driven dialog
        // would bind the Workspace but leave the renderer showing the start screen (T3 precedent).
        // With no window focused (macOS app menu, all windows closed) fall back to the main-driven
        // dialog, which creates the first window itself.
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => (BrowserWindow.getFocusedWindow() ? sendMenuAction('open-dialog') : void promptOpen(manager)) },
        { label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        // registerAccelerator: false — same discoverable-but-not-native-owner pattern as the View
        // menu's Toggle Outline/Typewriter (Task 13/14): the renderer's own keydown handler is the
        // sole owner of ⇧⌘K, so a native registration here would double-fire the toggle.
        { label: 'Quick Open…', ...accel('app.quickOpen', 'Shift+CmdOrCtrl+K'), registerAccelerator: false, click: () => sendMenuAction('quick-open') },
        // Same registerAccelerator: false pattern as Quick Open above — the renderer's own keydown
        // handler is the sole owner of ⌘K (Task 13), so a native registration here would double-fire.
        { label: 'Command Palette…', accelerator: 'Shift+CmdOrCtrl+P', registerAccelerator: false, click: () => sendMenuAction('command-palette') },
        // Same registerAccelerator: false pattern as Quick Open above (Task 17) — the renderer's
        // own keydown handler is the sole owner of ⇧⌘F (Task 18), so a native registration here
        // would double-fire the panel toggle.
        { label: 'Open Files', ...accel('view.files', 'Shift+CmdOrCtrl+E'), registerAccelerator: false, click: () => sendMenuAction('open-files') },
        { label: 'Search Files…', ...accel('app.search', 'Shift+CmdOrCtrl+F'), registerAccelerator: false, click: () => sendMenuAction('search') },
        // The archive search dock (WF-4B); the renderer owns ⌃⌘F, so the menu only shows it.
        { label: 'Search the Archive…', ...accel('archive.search', 'Ctrl+CmdOrCtrl+F'), registerAccelerator: false, click: () => sendMenuAction('archive-search') },
        // Saving is automatic (ADR-0013); ⌘S makes a tier-2 CHECKPOINT — a returnable point in history.
        { label: 'Checkpoint', accelerator: 'CmdOrCtrl+S', click: () => sendMenuAction('save') },
        { label: 'Save Version…', ...accel('file.nameVersion', 'Shift+CmdOrCtrl+S'), registerAccelerator: false, click: () => sendMenuAction('name-version') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendMenuAction('close-tab') },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }])
      ]
    },
    {
    // Explicit Edit submenu instead of role:'editMenu' for ONE reason: the role registers Redo's
    // ⇧⌘Z natively, which would swallow the key before the renderer ever sees it — and ⇧⌘Z is
    // context-sensitive by design (ADR-0009 cheat-sheet: Undo agent turn). registerAccelerator:
    // false keeps the item discoverable while the renderer owns the keydown (the Toggle Outline
    // pattern): agent-panel focus undoes the agent's last turn; the editor redoes via CM6's own
    // historyKeymap; the menu CLICK routes as a 'redo' action for the mouse path.
    label: 'Edit',
    submenu: [
      // Undo follows the Redo pattern: a native role would claim ⌘Z before the Folio outline's Details card (which
      // undoes its own change by token) could see it. The renderer owns the key; the click routes as 'undo'.
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: () => sendMenuAction('undo') },
      { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', registerAccelerator: false, click: () => sendMenuAction('redo') },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? [{ role: 'pasteAndMatchStyle' as const }, { role: 'delete' as const }, { role: 'selectAll' as const }]
        : [{ role: 'delete' as const }, { type: 'separator' as const }, { role: 'selectAll' as const }]),
      { type: 'separator' },
      { label: 'Follow Wikilink', accelerator: 'Alt+Enter', registerAccelerator: false, click: () => sendMenuAction('follow-wikilink') },
      { label: 'Materialise Dead Wikilink', accelerator: 'CmdOrCtrl+Enter', registerAccelerator: false, click: () => sendMenuAction('materialise-stub') }
    ]
  },
    {
      label: 'View',
      submenu: [
        // registerAccelerator: false shows the shortcut for discoverability without Electron
        // claiming it natively — the renderer's own keydown handler is the sole owner of ⇧⌘O
        // (Task 13), so a native registration here would double-fire the toggle.
        { label: 'Open Outline', ...accel('view.outline', 'Shift+CmdOrCtrl+O'), registerAccelerator: false, click: () => sendMenuAction('toggle-outline') },
        { label: 'Open Board', ...accel('collection.openBoard', 'Shift+CmdOrCtrl+B'), registerAccelerator: false, click: () => sendMenuAction('open-board') },
        { label: 'Open Tabs', ...accel('view.openTabs', 'CmdOrCtrl+2'), registerAccelerator: false, click: () => sendMenuAction('open-tabs') },
        { label: 'Next Tab', ...accel('navigation.nextTab', 'Shift+CmdOrCtrl+]'), registerAccelerator: false, click: () => sendMenuAction('next-tab') },
        { label: 'Previous Tab', ...accel('navigation.previousTab', 'Shift+CmdOrCtrl+['), registerAccelerator: false, click: () => sendMenuAction('previous-tab') },
        { label: 'Next File in Folder', ...accel('navigation.nextFolderFile', 'Alt+CmdOrCtrl+]'), registerAccelerator: false, click: () => sendMenuAction('next-folder-file') },
        { label: 'Previous File in Folder', ...accel('navigation.previousFolderFile', 'Alt+CmdOrCtrl+['), registerAccelerator: false, click: () => sendMenuAction('previous-folder-file') },
        { label: 'Focus Review Margin', ...accel('review.focusMargin', 'Shift+CmdOrCtrl+C'), registerAccelerator: false, click: () => sendMenuAction('focus-review-margin') },
        { label: 'Switch Margin / Inline', ...accel('review.switchMarginView', 'Shift+Alt+CmdOrCtrl+V'), registerAccelerator: false, click: () => sendMenuAction('switch-margin-view') },
        { label: 'Show or Hide Margin', ...accel('review.toggleMargin', 'Shift+Alt+CmdOrCtrl+M'), registerAccelerator: false, click: () => sendMenuAction('toggle-margin') },
        { label: 'Open Versions', ...accel('app.versions', 'CmdOrCtrl+3'), registerAccelerator: false, click: () => sendMenuAction('open-versions') },
        // Same registerAccelerator: false pattern as Toggle Outline above — the renderer's keydown
        // handler is the sole owner of ⌘T (Task 14), so a native registration here would double-fire.
        { label: 'Toggle Typewriter', ...accel('view.typewriter', 'CmdOrCtrl+T'), registerAccelerator: false, click: () => sendMenuAction('toggle-typewriter') },
        { type: 'separator' },
        // The native zoom ROLES stay absent (Task 17): the locked design gives ⌘+/⌘− to prose size,
        // ⌥⌘+/⌥⌘− to column width, ⌥⌘0 to reset, and the freed ⌘0 to Toggle Sidebar (mockup
        // cheat-sheet, View + Navigation groups) — a role would swallow those keydowns before the
        // renderer's handlers saw them. But the actions are discoverable here the same way Toggle
        // Outline/Typewriter are: registerAccelerator:false shows the shortcut without Electron
        // claiming it, and the CLICK routes as a menu action to the renderer's own handlers.
        { label: 'Increase Prose Size', accelerator: 'CmdOrCtrl+Plus', registerAccelerator: false, click: () => sendMenuAction('prose-zoom-in') },
        { label: 'Decrease Prose Size', accelerator: 'CmdOrCtrl+-', registerAccelerator: false, click: () => sendMenuAction('prose-zoom-out') },
        { label: 'Reset Prose Size', accelerator: 'Alt+CmdOrCtrl+0', registerAccelerator: false, click: () => sendMenuAction('prose-zoom-reset') },
        // Column width has renderer-owned keys too (⌥⌘+/⌥⌘−), so mirror them — same discoverable,
        // non-native pattern. Width has no dedicated reset item: ⌥⌘0 / Reset Prose Size resets both.
        { label: 'Increase Column Width', accelerator: 'Alt+CmdOrCtrl+Plus', registerAccelerator: false, click: () => sendMenuAction('column-width-in') },
        { label: 'Decrease Column Width', accelerator: 'Alt+CmdOrCtrl+-', registerAccelerator: false, click: () => sendMenuAction('column-width-out') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        // Full Screen keeps its menu item but not the ⌃⌘F accelerator the role would register: that
        // chord opens the archive search (WF-4B). fn-F and the green window button still toggle it.
        { label: 'Toggle Full Screen', click: (_item, window) => { if (window instanceof BrowserWindow) window.setFullScreen(!window.isFullScreen()) } }
      ]
    },
    {
      id: 'collection-page',
      label: 'Collection',
      submenu: COLLECTION_PAGE_COMMANDS.map(([name, label]) => ({ id: `collection-page:${name}`, label, enabled: focusedState()?.collectionPageActive === true, visible: name !== 'bulk-folio' || focusedState()?.collectionPageFolio === true, click: () => sendMenuAction(`collection-page:${name}`) }))
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])
      ]
    }
  ]
  return Menu.buildFromTemplate(template)
}
