import { ipcMain, type BrowserWindow } from 'electron'
import type { ConfirmSpec } from '../shared/confirm-card'

/**
 * Ask the writer for a decision through the renderer's confirm card (R11) instead of a native message box.
 * The window draws the card and answers on `confirm:answer`; a closed window answers no.
 */
const waiting = new Map<number, (ok: boolean) => void>()
let nextId = 1

export function askConfirm(window: BrowserWindow, spec: ConfirmSpec): Promise<boolean> {
  const id = nextId++
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean): void => { waiting.delete(id); resolve(ok) }
    waiting.set(id, done)
    if (window.isDestroyed()) { done(false); return }
    if (typeof window.once === 'function') window.once('closed', () => done(false))
    window.webContents.send('confirm:ask', { id, spec })
  })
}

export function registerConfirmIpc(): () => void {
  ipcMain.handle('confirm:answer', (_event, id: number, ok: boolean) => { waiting.get(id)?.(ok === true) })
  return () => { ipcMain.removeHandler('confirm:answer') }
}
