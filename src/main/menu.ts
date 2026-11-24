import { BrowserWindow, Menu, dialog, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { recentMenuLabels } from './recent-menu-labels'
import { statSync } from 'node:fs'
import { allStates, type WindowState } from './state'
import type { WindowManager } from './windows'
import type { SettingsStore } from './settings'
import { startScreenLists } from './start-screen-model'
import { buildCommandMenu, toAccelerator, type MenuCommand, type MenuFocus } from '../shared/command-menu'
import { MAIN_MENU_KEY_IDS, MENU_FALLBACK_ENABLED, NATIVE_MENU_COMMANDS, SEED_MENU_COMMANDS } from '../shared/native-menu-commands'
import { commandPlaces } from '../renderer/src/commands/command-places'
import { buildMenuTemplate } from './menu-template'
import { canonicalChord, menuInputChord, nativeEditRoleChord } from '../renderer/src/app/shortcuts'

const models = new WeakMap<WebContents, MenuCommand[]>()
const editorFocus = new WeakMap<WebContents, MenuFocus>()
const pendingWindowCommands = new WeakMap<WebContents, string>()
const observedSenders = new WeakSet<WebContents>()
let lastModel: MenuCommand[] = []
let lastModelSender: WebContents | undefined
/** A withdrawn model must not outlive its window as the cached menu; the fixed seed shows instead. */
function withdraw(sender: WebContents): void {
  models.delete(sender)
  editorFocus.delete(sender)
  if (lastModelSender === sender) { lastModel = []; lastModelSender = undefined }
}
let refresh: (() => void) | undefined
/** Hidden e2e windows cannot take native focus. Normal runs require an actual focused window. */
let lastFocusedWindow: BrowserWindow | undefined
let settingsMenuWindow: BrowserWindow | undefined
let lastMenuWindow: BrowserWindow | undefined
export function noteSettingsWindow(window: BrowserWindow): void {
  settingsMenuWindow = window
  editorFocus.set(window.webContents, 'other')
  noteFocusedWindow(window)
}
const SETTINGS_EDITOR_ONLY = new Set(['file.new', 'folder.new', 'file.checkpoint'])
/** The shared Settings window publishes only its focus kind, never an editor command model. */
export function noteSettingsMenuFocus(window: BrowserWindow, focus: MenuFocus): void {
  settingsMenuWindow = window
  editorFocus.set(window.webContents, focus)
  refresh?.()
}
export function noteFocusedWindow(window: BrowserWindow): void {
  lastMenuWindow = window
  if (allStates().some(state => state.window === window)) lastFocusedWindow = window
  refresh?.()
}
function menuWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed() && !focused.isMinimized()) return focused
  if (process.env.WRITEFLEX_E2E !== '1') return null
  if (lastMenuWindow && !lastMenuWindow.isDestroyed()) return lastMenuWindow
  if (lastFocusedWindow && !lastFocusedWindow.isDestroyed() && !lastFocusedWindow.isMinimized()) return lastFocusedWindow
  return allStates().find(state => !state.window.isDestroyed() && !state.window.isMinimized())?.window ?? null
}
function focusedState(): WindowState | null {
  const window = BrowserWindow.getFocusedWindow()
  return allStates().find(state => state.window === window) ?? null
}

/** The menu bar shows the focused window's model; a change elsewhere is stored but never rebuilds it. */
function showsFor(sender: WebContents): boolean {
  const focused = BrowserWindow.getFocusedWindow()
  return !focused || focused.isDestroyed() || focused.webContents === sender
}
const LABEL_LIMIT = 200

/** Models contain data only; per-window storage prevents background editors replacing the active menu. */
export function receiveCommandMenu(sender: WebContents, commands: MenuCommand[], focus: MenuFocus = 'other'): void {
  if (!['editor', 'plain-text-field', 'other'].includes(focus)) throw new Error('Invalid menu focus')
  if (!Array.isArray(commands) || commands.length > 2000) throw new Error('Invalid command menu')
  if (commands.length === 0) { withdraw(sender); if (showsFor(sender)) refresh?.(); return }
  const ids = new Set<string>()
  const known: MenuCommand[] = []
  for (const c of commands) {
    if (!c || typeof c.id !== 'string' || ids.has(c.id) || typeof c.label !== 'string' || c.label.length > LABEL_LIMIT || typeof c.task !== 'string' || typeof c.subgroup !== 'string' || typeof c.enabled !== 'boolean'
      || (c.chord !== undefined && typeof c.chord !== 'string') || (c.checked !== undefined && typeof c.checked !== 'boolean')
      || (c.nativeAccelerator !== undefined && typeof c.nativeAccelerator !== 'boolean') || (c.nativeAccelerator === true && !MAIN_MENU_KEY_IDS.has(c.id))
      || (c.noMenu !== undefined && (typeof c.noMenu !== 'string' || !c.noMenu.trim()))) throw new Error('Invalid command menu entry')
    ids.add(c.id)
    // commandPlaces holds every registry id and is pure data, so main can tell a real command from an invented one.
    if (Object.hasOwn(commandPlaces, c.id)) known.push(c)
  }
  if (!observedSenders.has(sender)) {
    observedSenders.add(sender)
    // registerAccelerator:false is Linux/Windows-only in Electron. On macOS, let
    // registry chords reach the renderer and leave native roles (including Quit) alone.
    sender.on('before-input-event', (_event, input) => {
      const event = { key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift }
      const chord = menuInputChord(event)
      const physical = (key: string) => canonicalChord(key.replace(/\+$/, '=').replace(/^(.*)⇧(.*=)$/, '$1$2'))
      const registryOwns = (editorFocus.get(sender) === 'editor' || !nativeEditRoleChord(chord))
        && (models.get(sender) ?? []).some(command => toAccelerator(command.chord) && command.chord && physical(command.chord) === physical(chord))
      sender.setIgnoreMenuShortcuts(registryOwns)
    })
    const retire = () => { withdraw(sender); refresh?.() }
    sender.on('did-start-loading', retire)
    sender.on('render-process-gone', retire)
    sender.once('destroyed', retire)
  }
  editorFocus.set(sender, focus)
  models.set(sender, known)
  lastModel = known
  lastModelSender = sender
  if (showsFor(sender)) refresh?.()
  const pending = pendingWindowCommands.get(sender)
  if (pending) { pendingWindowCommands.delete(sender); sender.send('menu:command', pending) }
}

export function updateCollectionMenu(): void { refresh?.() }

async function promptOpen(manager: WindowManager): Promise<void> {
  const from = focusedState()
  const options: Electron.OpenDialogOptions = {
    title: 'Open Folder or Markdown File', properties: ['openFile', 'openDirectory'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] }],
  }
  const result = from ? await dialog.showOpenDialog(from.window, options) : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths.length) return
  const picked = result.filePaths[0]
  if (statSync(picked).isDirectory()) await manager.openFolder(from, picked)
  else await manager.openFile(from, picked)
}

/** The newly registered commands reuse the existing main/renderer operations. */
function runNativeMenuCommand(id: string, target: BrowserWindow, manager?: WindowManager): void {
  const command = NATIVE_MENU_COMMANDS.find(c => c.id === id)
  if (!command) throw new Error(`Not a native menu command: ${id}`)
  if (id === 'window.new') { manager?.createWindow(); return }
  if (id === 'view.developerTools') { target.webContents.toggleDevTools(); return }
  if (id === 'view.fullScreen') { target.setFullScreen(!target.isFullScreen()); return }
  if ('action' in command) target.webContents.send('menu:action', command.action)
}
let windowManager: WindowManager | undefined
export function invokeNativeMenuCommand(id: string, target: BrowserWindow): void { runNativeMenuCommand(id, target, windowManager) }

function updateWindow(): BrowserWindow | undefined {
  return allStates().find(state => !state.window.isDestroyed() && models.has(state.window.webContents))?.window
}

/** A menu click: to the focused window's model when it has one, otherwise the few things main can do alone. */
export function runMenuClick(id: string, manager: WindowManager): void {
  if (id === 'app.settings' && manager.openSettings) { manager.openSettings(); return }
  const target = menuWindow()
  if (target === settingsMenuWindow && SETTINGS_EDITOR_ONLY.has(id)) return
  if (target === settingsMenuWindow && target && id === 'tab.close') { target.close(); return }
  if (target === settingsMenuWindow && target && editorFocus.get(target.webContents) === 'plain-text-field' && (id === 'edit.undo' || id === 'edit.redo')) {
    if (id === 'edit.undo') target.webContents.undo(); else target.webContents.redo()
    return
  }
  const focused = menuWindow()
  if (focused && models.has(focused.webContents)) focused.webContents.send('menu:command', id)
  else if (id === 'window.new') manager.createWindow()
  else if (id === 'app.open') void promptOpen(manager)
  else if (focused && (MENU_FALLBACK_ENABLED.withWindow as readonly string[]).includes(id)) invokeNativeMenuCommand(id, focused)
  // The renderer's own handler is mounted before its first model reaches main, and rechecks the command itself.
  else if (focused && focused !== settingsMenuWindow && (MENU_FALLBACK_ENABLED.update as readonly string[]).includes(id)) focused.webContents.send('menu:command', id)
  // Preserve the previous update-menu fallback, including hidden editor windows.
  else if ((!focused || focused === settingsMenuWindow) && noFocusIds.has(id)) {
    const window = updateWindow() ?? manager.createWindow().window
    if (process.env.WRITEFLEX_E2E !== '1') {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
    if (models.has(window.webContents)) window.webContents.send('menu:command', id)
    else pendingWindowCommands.set(window.webContents, id)
  }
}

const noFocusIds = new Set<string>(['app.settings', ...MENU_FALLBACK_ENABLED.update, 'guide.open', 'app.shortcuts', 'app.commandPalette', 'app.actionsHere', 'example.restore'])
let cachedMenu: Menu | undefined
let serialisedMenu: string | undefined

export function buildAppMenu(manager: WindowManager, settings: SettingsStore): Menu {
  windowManager = manager
  refresh = () => {
    const previous = cachedMenu
    const next = buildAppMenu(manager, settings)
    if (next !== previous) Menu.setApplicationMenu(next)
  }
  const target = menuWindow()
  const focus = target ? editorFocus.get(target.webContents) ?? 'other' : 'other'
  const live = target ? models.get(target.webContents) : undefined
  const commands = (live ?? (lastModel.length ? lastModel : SEED_MENU_COMMANDS)).map(c => ({ ...c,
    chord: focus !== 'editor' && nativeEditRoleChord(c.chord) ? undefined : c.chord,
    nativeAccelerator: live ? c.nativeAccelerator : MAIN_MENU_KEY_IDS.has(c.id),
    enabled: target === settingsMenuWindow && SETTINGS_EDITOR_ONLY.has(c.id) ? false : live ? c.enabled : (MENU_FALLBACK_ENABLED.always as readonly string[]).includes(c.id)
      || Boolean(target && (MENU_FALLBACK_ENABLED.withWindow as readonly string[]).includes(c.id))
      || noFocusIds.has(c.id) || (target === settingsMenuWindow && focus === 'plain-text-field' && (c.id === 'edit.undo' || c.id === 'edit.redo')),
    ...(c.id === 'view.fullScreen' ? { checked: target?.isFullScreen() ?? false } : {}),
  }))
  const { pinned, recents } = startScreenLists(settings)
  const recentRoots = [...pinned, ...recents.map(recent => recent.root)]
  const labels = recentMenuLabels(recentRoots)
  const open = (root: string): MenuItemConstructorOptions => ({ label: labels.get(root), click: () => void manager.openFolder(focusedState(), root) })
  const recentItems: MenuItemConstructorOptions[] = [
    ...pinned.map(open),
    ...(pinned.length && recents.length ? [{ type: 'separator' as const }] : []),
    ...recents.map(recent => open(recent.root)),
  ]
  const run = (id: string): void => runMenuClick(id, manager)
  const model = buildCommandMenu(commands)
  const next = JSON.stringify({ model, recents: { pinned, roots: recents.map(recent => recent.root) }, focus })
  if (cachedMenu && serialisedMenu === next) return cachedMenu
  serialisedMenu = next
  cachedMenu = Menu.buildFromTemplate(buildMenuTemplate(model, run, recentItems, focus))
  return cachedMenu
}
