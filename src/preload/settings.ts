import './settings-custom'
// Preload of the shared Settings window. Sandboxed, so it is bundled into one file with everything it
// imports (electron.vite.config.ts, settingsPreload). It carries the shared settings bridge
// (window.bridleSettings) and WriteFlex's own small bridge for its custom pages (window.writeflexSettings).
// Main answers every channel below only for the Settings window's own page (isSettingsWindowSender).
import { contextBridge, ipcRenderer } from 'electron'
import { exposeSettingsBridge } from '@app-patterns/settings-electron/preload'
import { createAuthTransport } from '@bridle/electron/preload'
import type { WriteFlexSettingsApi } from './settings-api'

exposeSettingsBridge()

const api: WriteFlexSettingsApi = {
  auth: createAuthTransport(),
  onContextChanged: (listener) => {
    const changed = () => listener()
    ipcRenderer.on('wf-settings-window:context-changed', changed)
    return () => ipcRenderer.removeListener('wf-settings-window:context-changed', changed)
  },
  menuFocus: (plain) => ipcRenderer.invoke('wf-settings-window:menu-focus', plain),
  getStarted: () => ipcRenderer.invoke('wf-settings-window:get-started'),
  restoreExample: () => ipcRenderer.invoke('wf-settings-window:restore-example'),
  context: () => ipcRenderer.invoke('wf-settings-window:context'),
  models: () => ipcRenderer.invoke('wf-settings-window:models') as ReturnType<WriteFlexSettingsApi['models']>,
  countedChanges: () => ipcRenderer.invoke('wf-settings-window:counted-changes'),
  resetCounted: (change) => ipcRenderer.invoke('wf-settings-window:counted-reset', change),
  countedCollections: () => ipcRenderer.invoke('wf-settings-window:counted') as ReturnType<WriteFlexSettingsApi['countedCollections']>,
  uncount: (root, dir) => ipcRenderer.invoke('wf-settings-window:uncount', { root, dir }) as ReturnType<WriteFlexSettingsApi['uncount']>,
  installCommandLineTool: () => ipcRenderer.invoke('cli:install') as ReturnType<WriteFlexSettingsApi['installCommandLineTool']>,
  runInMainWindow: (id) => ipcRenderer.invoke('wf-settings-window:run-command', id) as Promise<void>,
}

contextBridge.exposeInMainWorld('writeflexSettings', api)
