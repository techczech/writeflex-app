import { noteSettingsWindow } from './menu'
import { e2eHidden, openMain } from './window-presentation'
// The app's side of the shared settings: the store (userData/settings-v2.json), the first-launch
// migration from the old settings.json, the Settings window, the menu bar generated from the command
// registry, export and import, and Accounts and keys. Behaviour lives in the @app-patterns packages; this
// file wires them to WriteFlex's schema, registry, windows and its old settings file.
//
// Two steps, because the key slots need the agent's credential store, which registerIpc opens:
//   openSharedSettings()   migration, then the store; preferences are read from it from here on
//   installSettingsHost()  the window, the menu bar, the IPC (bridle-settings:), the slots
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { registerRenderer } from './renderer-boundary'
import { decideNavigation } from './navigation'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installSettingsWith, type ElectronDeps, type SecretSlots, type SettingsHost } from '@app-patterns/settings-electron/main'
import { FRAME_MAIN_COMMANDS, MENUS, registry, writeflexIdOf } from '../shared/bridle-commands'
import { THEME_SETTING } from '../shared/appearance'
import { windowBackgrounds } from './window-appearance'
import { TRAFFIC_LIGHT_POSITION } from '../shared/window-chrome'
import { APP_NAME, schema } from '../shared/settings-schema'
import type { SettingsStore as LegacySettingsStore } from './settings'

/** Custom pages of the Settings window (renderer/src/settings-pages.tsx); the window may be opened at them. */
export const CUSTOM_PAGES = ['git-sync', 'sign-in', 'model', 'voice', 'counted', 'command-line', 'get-started', 'backup', 'sharing', 'scratchpad', 'updates'] as const

/** The channel a menu click on a renderer command travels on (never `settings:` or `bridle-settings:`). */
export const MENU_COMMAND_CHANNEL = 'menu:command'
/** A main window asks to open the Settings window (at a section). */
export const OPEN_SETTINGS_CHANNEL = 'wf-open-settings'
/** App commands the Settings window's own pages may run in the main window. */
export const SETTINGS_PAGE_COMMANDS: ReadonlySet<string> = new Set(['view.configureActionBar', 'guide.open', 'example.restore'])

export { type SharedSettings } from './shared-preferences'
import { openPreferences, followSharedSettingsMenu, type SharedSettings } from './shared-preferences'

export async function openSharedSettings(legacy: LegacySettingsStore, log: (line: string) => void): Promise<SharedSettings> {
  return openPreferences(legacy, app.getPath('userData'), app.getVersion(), log)
}

export type HostWiring = {
  shared: SharedSettings
  slots: SecretSlots
  /** The main window a command goes to: the focused one, else the last focused, else a new one. */
  mainWindow(): BrowserWindow
  log(line: string): void
}

export type SettingsApp = {
  host: SettingsHost
  openSettings(section?: string): void
  rebuildMenu(): void
  slotsChanged(): void
  /** Whether an IPC event comes from the Settings window's own page (pass the whole event). */
  isSettingsSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean
  settingsWindow(): BrowserWindow | null
  settingsWebContents(): Electron.WebContents | null
  dispose(): Promise<void>
}

function settingsPageUrl(): string {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && dev) return `${dev}/settings.html`
  return pathToFileURL(join(__dirname, '../renderer/settings.html')).href
}

type Item = Electron.MenuItemConstructorOptions

/** Installs the Settings window, its IPC, the generated menu bar, export and import, and the slots. */
export function installSettingsHost(w: HostWiring): SettingsApp {
  const target = (): BrowserWindow => w.mainWindow()
  // Keep the app's current context-sensitive menu; the host owns only the Settings window.
  const decoratedMenu: ElectronDeps['Menu'] = {
    buildFromTemplate: (template) => Menu.buildFromTemplate(template as Item[]),
    setApplicationMenu: () => {},
  }
  const url = settingsPageUrl()
  const showOnReady = !e2eHidden() // hidden in end-to-end runs: nothing appears on screen
  // Electron's BrowserWindow lookup excludes subclasses. Return an ordinary instance so menus,
  // notifications and updater restart can find Settings through the same native APIs as the editor.
  function SettingsBrowserWindow(options: Electron.BrowserWindowConstructorOptions): BrowserWindow {
    const window = new BrowserWindow({
      ...options,
      backgroundColor: windowBackgrounds(w.shared.store.view().settings[THEME_SETTING]).settings,
      ...(process.platform === 'darwin' ? { trafficLightPosition: TRAFFIC_LIGHT_POSITION } : {}),
      webPreferences: { ...options.webPreferences, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false },
    })
    registerRenderer(window.webContents, url, 'settings')
    return window
  }
  // A hidden run must never open a native picker or confirmation on the working desktop.
  const settingsDialog = e2eHidden() ? {
    showOpenDialog: async () => {
      const fixture = !app.isPackaged ? process.env.WRITEFLEX_E2E_DIARY_FOLDER : undefined
      return { canceled: !fixture, filePaths: fixture ? [fixture] : [] }
    },
    showSaveDialog: async () => ({ canceled: true }),
    showMessageBox: async () => ({ response: 1 }),
  } : dialog
  const host = installSettingsWith({ ipcMain, BrowserWindow: SettingsBrowserWindow as unknown as ElectronDeps['BrowserWindow'], dialog: settingsDialog as unknown as ElectronDeps['dialog'], Menu: decoratedMenu }, {
    app,
    appName: APP_NAME,
    store: w.shared.store,
    schema,
    registry,
    menus: MENUS,
    slots: w.slots,
    openMain: () => openMain(target()),
    sendCommand: (id) => {
      if (FRAME_MAIN_COMMANDS.has(id)) return
      const win = target()
      const writeflexId = writeflexIdOf(id)
      if (writeflexId && !win.isDestroyed()) win.webContents.send(MENU_COMMAND_CHANNEL, writeflexId)
    },
    extraSections: [...CUSTOM_PAGES],
    pathKind: () => 'folder',
    window: { preload: join(__dirname, '../preload/settings.js'), url, title: 'WriteFlex Settings', showOnReady },
    appInfo: { icon: 'feather', cli: 'writeflex' },
  })
  followSharedSettingsMenu(w.shared, host)

  const observed = new WeakSet<BrowserWindow>()
  return {
    host,
    openSettings: (section) => {
      const window = host.openSettingsWindow(section) as unknown as BrowserWindow
      noteSettingsWindow(window)
      if (!observed.has(window)) {
        observed.add(window)
        const openExternal = (target: string) => {
          if (!e2eHidden() && decideNavigation(url, target) === 'external') void shell.openExternal(target)
        }
        window.webContents.on('will-navigate', (event, target) => {
          if (decideNavigation(url, target) === 'allow') return
          event.preventDefault()
          if (event.initiator === window.webContents.mainFrame) openExternal(target)
        })
        window.webContents.setWindowOpenHandler(({ url: target }) => {
          openExternal(target)
          return { action: 'deny' }
        })
        window.webContents.on('before-input-event', () => window.webContents.setIgnoreMenuShortcuts(false))
      }
    },
    rebuildMenu: () => host.rebuildMenu(),
    slotsChanged: () => host.slotsChanged(),
    isSettingsSender: (event) => Boolean(host.isSettingsWindowSender(event as unknown as Parameters<SettingsHost['isSettingsWindowSender']>[0])),
    settingsWindow() {
      const win = host.settingsWindow() as unknown as BrowserWindow | null
      return win && !win.isDestroyed() ? win : null
    },
    settingsWebContents() {
      const win = host.settingsWindow() as unknown as BrowserWindow | null
      return win && !win.isDestroyed() && win.webContents.getURL() === settingsPageUrl() ? win.webContents : null
    },
    dispose() {
      host.dispose()
      return w.shared.close()
    },
  }
}
