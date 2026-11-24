// Main-process controls for the unpublished update-test flavour. Production statically removes
// the call. A Squirrel relaunch writes a boot receipt even without the proof driver.
import { join } from 'node:path'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { app, BrowserWindow } from 'electron'

function writeReceipt(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}

export function startUpdateTestControl(): void {
  const profile = app.getPath('userData')
  const version = app.getVersion()
  writeReceipt(join(profile, 'update-test-boot.json'), { pid: process.pid, version })
  if (process.env.WRITEFLEX_UPDATE_TEST_DRIVER !== '1') return

  const control = join(profile, `update-test-control.${process.pid}`)
  mkdirSync(control, { mode: 0o700 })
  let last = 0
  const timer = setInterval(() => {
    let action: string
    const id = last + 1
    try { action = readFileSync(join(control, `request-${id}`), 'utf8') }
    catch { return }
    last = id
    const windows = BrowserWindow.getAllWindows()
    if (action === 'close-windows') for (const window of windows) window.close()
    const state = {
      version,
      windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), destroyed: window.isDestroyed() })),
    }
    writeReceipt(join(control, `response-${id}`), state)
    if (action === 'quit') app.quit()
  }, 50)
  timer.unref()
  app.once('will-quit', () => clearInterval(timer))
}
