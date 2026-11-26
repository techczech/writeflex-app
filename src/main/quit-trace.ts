import { app } from 'electron'
import { createHook } from 'node:async_hooks'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const trackedTypes = new Set(['FSEVENTWRAP', 'STATWATCHER', 'PROCESSWRAP', 'TCPWRAP', 'TCPSERVERWRAP', 'PIPEWRAP'])

/** Capture handle types and process timing from synthetic, unpackaged E2E launches. */
export function installQuitTrace(): void {
  const log = process.env.WRITEFLEX_E2E_QUIT_LOG
  if (app.isPackaged || process.env.WRITEFLEX_E2E !== '1' || process.env.WRITEFLEX_E2E_QUIT_HANDLES !== '1' || !log) return
  type Handle = { constructor?: { name?: string }; fd?: number; pid?: number; hasRef?(): boolean }
  const node = process as typeof process & { _getActiveHandles(): Handle[]; _getActiveRequests(): Handle[] }
  // _getActiveHandles skips unref'd handles. Keep their lifetime and origin
  // observable without holding the native wrapper alive.
  const tracked = new Map<number, { type: string; source: string[]; resource: WeakRef<Handle> }>()
  createHook({
    init(id, type, _trigger, resource: Handle) {
      if (!trackedTypes.has(type)) return
      const source = Error().stack?.split('\n').slice(4, 11) ?? []
      tracked.set(id, { type, source, resource: new WeakRef(resource) })
    },
    destroy(id) { tracked.delete(id) },
  }).enable()
  const describe = (handle: Handle) => ({
    type: handle.constructor?.name,
    fd: handle.fd,
    pid: handle.pid,
    referenced: handle.hasRef?.(),
  })
  const record = (stage: string, code?: number): void => {
    try {
      appendFileSync(log, JSON.stringify({
        phase: 'app-handles', stage, ts: Date.now(), pid: process.pid, supervisorPid: process.ppid, code,
        handles: node._getActiveHandles().map(describe),
        requests: node._getActiveRequests().map(describe),
        resources: process.getActiveResourcesInfo(),
        tracked: Array.from(tracked.values()).flatMap(({ type, source, resource }) => {
          const handle = resource.deref()
          return handle ? [{ type, source, referenced: handle.hasRef?.(), pid: handle.pid }] : []
        }),
      }) + '\n')
    } catch { /* diagnostic only */ }
  }
  app.once('browser-window-created', () => {
    const directory = join(app.getPath('sessionData'), 'Code Cache', 'electron-preload')
    record(existsSync(directory) ? 'first-window-preload-cache-ready' : 'first-window-preload-cache-missing')
  })
  let attempts = 0
  app.prependListener('will-quit', () => {
    attempts++
    record('will-quit-entry-' + attempts)
    if (attempts === 1) {
      setImmediate(() => record('after-first-will-quit')).unref()
      return
    }
    setImmediate(() => record('after-final-will-quit')).unref()
    for (const ms of [250, 1000, 3000, 6000]) setTimeout(() => record('final-will-quit-plus-' + ms), ms).unref()
  })
  app.prependListener('quit', () => record('quit-entry'))
  app.on('quit', () => record('quit-handlers-end'))
  process.once('exit', (code) => record('node-exit', code))
}
