// No IPC listener answers a frame that is not its window's top frame (src/main/ipc-main-frame-only.ts,
// interactive-widgets ticket 02; ported from TalkWeaver scripts/test-ipc-main-frame-only.mjs at
// 6ec8102f). Driven against a fake ipcMain that behaves as Electron's does: one handler per channel for
// invoke, an event emitter for send.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMainFrameOnly, senderFrameVerdict } from '../../src/main/ipc-main-frame-only'

type Fn = (...args: any[]) => any

function fakeIpcMain() {
  const handlers = new Map<string, Fn>()
  const listeners = new Map<string, Fn[]>()
  const ipc = {
    handlers, listeners,
    handle(channel: string, fn: Fn) { if (handlers.has(channel)) throw new Error(`second handler for ${channel}`); handlers.set(channel, fn) },
    handleOnce(channel: string, fn: Fn) { ipc.handle(channel, (e: unknown, ...a: unknown[]) => { ipc.removeHandler(channel); return fn(e, ...a) }) },
    removeHandler(channel: string) { handlers.delete(channel) },
    on(channel: string, fn: Fn) { listeners.set(channel, [...(listeners.get(channel) ?? []), fn]); return ipc },
    once(channel: string, fn: Fn) { const w: Fn = (...a) => { ipc.removeListener(channel, w); fn(...a) }; return ipc.on(channel, w) },
    removeListener(channel: string, fn: Fn) { listeners.set(channel, (listeners.get(channel) ?? []).filter((l) => l !== fn)); return ipc },
    off(channel: string, fn: Fn) { return ipc.removeListener(channel, fn) },
    async invoke(channel: string, event: unknown, ...args: unknown[]) { const fn = handlers.get(channel); if (!fn) throw new Error(`No handler registered for '${channel}'`); return fn(event, ...args) },
    send(channel: string, event: unknown, ...args: unknown[]) { for (const fn of [...(listeners.get(channel) ?? [])]) fn(event, ...args) },
  }
  return ipc
}

/** A window with a top frame and one widget frame; events as Electron builds them. */
function fakeWindow(id = 7) {
  const mainFrame = { name: 'main', parent: null }
  const subframe = { name: 'widget', parent: mainFrame }
  const sender = { id, mainFrame, getURL: () => 'file:///Applications/WriteFlex.app/out/renderer/index.html' }
  return {
    fromMain: () => ({ sender, senderFrame: mainFrame }),
    fromSubframe: () => ({ sender, senderFrame: subframe }),
    fromGoneFrame: () => ({ sender, senderFrame: null }),
  }
}

test('the verdict: top frame, subframe, no frame, and everything unreadable', () => {
  const w = fakeWindow()
  expect(senderFrameVerdict(w.fromMain())).toBe('main-frame')
  expect(senderFrameVerdict(w.fromSubframe())).toBe('subframe')
  expect(senderFrameVerdict(w.fromGoneFrame())).toBe('no-frame')
  expect(senderFrameVerdict({ sender: { mainFrame: {} } })).toBe('no-frame')
  expect(senderFrameVerdict({ senderFrame: {}, sender: {} })).toBe('no-frame')
  expect(senderFrameVerdict({ senderFrame: {}, sender: { mainFrame: null } })).toBe('no-frame')
  expect(senderFrameVerdict({ senderFrame: null, sender: { mainFrame: null } })).toBe('no-frame')
  expect(senderFrameVerdict({ senderFrame: undefined, sender: { mainFrame: undefined } })).toBe('no-frame')
  expect(senderFrameVerdict(null)).toBe('no-frame')
  expect(senderFrameVerdict({ get senderFrame() { throw new Error('destroyed') }, sender: {} })).toBe('no-frame')
  // Another window's top frame is not this window's top frame.
  expect(senderFrameVerdict({ sender: fakeWindow(1).fromMain().sender, senderFrame: fakeWindow(2).fromMain().senderFrame })).toBe('subframe')
})

test('handle: runs for the top frame; rejects for a subframe and for a gone frame, with one log line each', async () => {
  const ipc = fakeIpcMain()
  const logs: string[] = []
  applyMainFrameOnly(ipc, { log: (m) => logs.push(m) })
  const calls: unknown[] = []
  ipc.handle('widget:read', (event: { sender: { id: number } }, a: unknown, b: unknown) => { calls.push([event.sender.id, a, b]); return { ok: true } })
  const w = fakeWindow()
  expect(await ipc.invoke('widget:read', w.fromMain(), 1, 'x')).toEqual({ ok: true })
  expect(calls).toEqual([[7, 1, 'x']])
  await expect(ipc.invoke('widget:read', w.fromSubframe(), 2)).rejects.toThrow(/refused call on widget:read from a frame that is not the window's top frame/)
  await expect(ipc.invoke('widget:read', w.fromGoneFrame(), 3)).rejects.toThrow(/refused call on widget:read from a frame that is gone or unknown/)
  expect(calls.length).toBe(1)
  expect(logs.length).toBe(2)
  expect(logs[0]).toMatch(/^\[ipc\] refused call on widget:read .* in window 7 \(file:\/\/\/Applications\/WriteFlex\.app/)
  ipc.handle('file:save', async () => 'saved')
  expect(await ipc.invoke('file:save', w.fromMain())).toBe('saved')
})

test('handleOnce: a refused call does not use the registration up', async () => {
  const ipc = fakeIpcMain()
  applyMainFrameOnly(ipc, { log: () => {} })
  let ran = 0
  ipc.handleOnce('once:thing', () => { ran++; return 'done' })
  const w = fakeWindow()
  await expect(ipc.invoke('once:thing', w.fromSubframe())).rejects.toThrow()
  await expect(ipc.invoke('once:thing', w.fromGoneFrame())).rejects.toThrow()
  expect(ran).toBe(0)
  expect(await ipc.invoke('once:thing', w.fromMain())).toBe('done')
  expect(ran).toBe(1)
  await expect(ipc.invoke('once:thing', w.fromMain())).rejects.toThrow(/No handler registered/)
})

test('on: delivers the top frame\'s messages; drops a subframe\'s and a gone frame\'s, with one log line each', () => {
  const ipc = fakeIpcMain()
  const logs: string[] = []
  applyMainFrameOnly(ipc, { log: (m) => logs.push(m) })
  const got: unknown[] = []
  ipc.on('state:publish', (_event: unknown, state: unknown) => got.push(state))
  const w = fakeWindow()
  ipc.send('state:publish', w.fromMain(), { id: 'a' })
  ipc.send('state:publish', w.fromSubframe(), { id: 'forged' })
  ipc.send('state:publish', w.fromGoneFrame(), { id: 'late' })
  ipc.send('state:publish', w.fromMain(), { id: 'b' })
  expect(got).toEqual([{ id: 'a' }, { id: 'b' }])
  expect(logs.length).toBe(2)
  expect(logs[0]).toMatch(/^\[ipc\] refused message on state:publish from a frame that is not the window's top frame/)
})

test('once: a refused message does not use the listener up; the top frame\'s first message does', () => {
  const ipc = fakeIpcMain()
  applyMainFrameOnly(ipc, { log: () => {} })
  const got: unknown[] = []
  ipc.once('ready', (_event: unknown, n: unknown) => got.push(n))
  const w = fakeWindow()
  ipc.send('ready', w.fromSubframe(), 1)
  ipc.send('ready', w.fromMain(), 2)
  ipc.send('ready', w.fromMain(), 3)
  expect(got).toEqual([2])
  expect(ipc.listeners.get('ready')!.length).toBe(0)
})

test('removeListener / off take the listener that was registered', () => {
  const ipc = fakeIpcMain()
  applyMainFrameOnly(ipc, { log: () => {} })
  const got: string[] = []
  const a = () => got.push('a')
  const b = () => got.push('b')
  ipc.on('x', a); ipc.on('x', b); ipc.once('x', a)
  ipc.removeListener('x', a)
  ipc.off('x', b)
  ipc.send('x', fakeWindow().fromMain())
  expect(got).toEqual(['a'])
  ipc.removeListener('x', a)
  ipc.send('x', fakeWindow().fromMain())
  expect(got).toEqual(['a'])
  expect(ipc.listeners.get('x')!.length).toBe(0)
})

test('a throwing log never lets a refused call through; applying twice wraps once', async () => {
  const ipc = fakeIpcMain()
  applyMainFrameOnly(ipc, { log: () => { throw new Error('log is broken') } })
  const once = ipc.handle
  applyMainFrameOnly(ipc, { log: () => {} })
  expect(ipc.handle).toBe(once)
  let ran = 0
  ipc.handle('h', () => { ran++ })
  ipc.on('m', () => { ran++ })
  await expect(ipc.invoke('h', fakeWindow().fromSubframe())).rejects.toThrow()
  ipc.send('m', fakeWindow().fromSubframe())
  expect(ran).toBe(0)
})

// ── The app's own wiring ─────────────────────────────────────────────────────────────────────────
const mainDir = fileURLToPath(new URL('../../src/main/', import.meta.url))
const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name)
  return statSync(path).isDirectory() ? sources(path) : /\.(ts|mts|mjs|js)$/.test(name) ? [path] : []
})

test('no window runs a preload in subframes: the preference is named nowhere in src/main, and no <webview>', () => {
  const preference = ['nodeIntegration', 'In', 'SubFrames'].join('')
  for (const path of sources(mainDir)) {
    const text = readFileSync(path, 'utf8')
    expect(text.includes(preference), `${path} names ${preference}`).toBe(false)
    expect(/webviewTag\s*:\s*true/.test(text), `${path} turns <webview> on`).toBe(false)
  }
})

test('index.ts applies the guard to ipcMain before the first registration, and no module registers on import', () => {
  const index = readFileSync(join(mainDir, 'index.ts'), 'utf8')
  const applied = index.indexOf('\napplyMainFrameOnly(ipcMain')
  expect(applied).toBeGreaterThan(0)
  const firstUse = index.search(/^(?!import\b|\s*\/\/).*\bipcMain\b/m)
  const firstRegistration = index.search(/\bipcMain\.(handle|handleOnce|on|once)\(/)
  if (firstRegistration >= 0) expect(firstRegistration).toBeGreaterThan(applied)
  expect(firstUse).toBe(applied + 1)
  // registerIpc and the registration helpers it calls run inside app.whenReady, after the guard.
  expect(index.indexOf('registerIpc(')).toBeGreaterThan(applied)
  for (const path of sources(mainDir)) {
    if (path.endsWith('/index.ts') || path.endsWith('ipc-main-frame-only.ts')) continue
    const text = readFileSync(path, 'utf8')
    expect(/^(ipcMain|ipc)\.(handle|handleOnce|on|once)\(/m.test(text), `${path} registers an IPC listener when it is imported`).toBe(false)
    expect(/^register\w*Ipc\w*\(/m.test(text), `${path} calls an IPC registration when it is imported`).toBe(false)
  }
})
