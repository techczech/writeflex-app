import { expect, test } from 'bun:test'
import { forwardBrowserWindowFocus } from '../../src/main/window-focus'
import { multiplexIpcChannel } from '../../src/preload/subscriptions'

type Listener = () => void

class FakeIpc {
  listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>()

  on(channel: string, listener: (event: unknown, payload: unknown) => void): void {
    const listeners = this.listeners.get(channel) ?? new Set()
    listeners.add(listener)
    this.listeners.set(channel, listeners)
  }

  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void {
    this.listeners.get(channel)?.delete(listener)
  }

  emit(channel: string): void {
    for (const listener of this.listeners.get(channel) ?? []) listener({}, undefined)
  }
}

class FakeBrowserWindow {
  listeners = new Map<string, Set<Listener>>()

  constructor(private readonly ipc: FakeIpc) {}

  webContents = {
    isDestroyed: (): boolean => false,
    send: (channel: string): void => this.ipc.emit(channel),
  }

  on(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }
}

test('three reader-to-draft focus round trips sync zero times, while one app focus syncs exactly once', () => {
  const ipc = new FakeIpc()
  const browserWindow = new FakeBrowserWindow(ipc)
  const subscribe = multiplexIpcChannel<void>(ipc, 'window:focused')
  let syncs = 0
  subscribe(() => {
    syncs += 1
  })
  forwardBrowserWindowFocus(browserWindow)

  const rendererWindow = new EventTarget()
  for (let roundTrip = 0; roundTrip < 3; roundTrip += 1) {
    rendererWindow.dispatchEvent(new Event('blur'))
    rendererWindow.dispatchEvent(new Event('focus'))
  }
  expect(syncs).toBe(0)

  browserWindow.emit('focus')
  expect(syncs).toBe(1)
})
