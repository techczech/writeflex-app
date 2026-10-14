import { expect, test } from 'bun:test'
import { multiplexIpcChannel } from '../../src/preload/subscriptions'

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

  emit(channel: string, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) listener({}, payload)
  }
}

test('many App subscribers share one menu:action IPC listener and clean up idempotently', () => {
  const ipc = new FakeIpc()
  const subscribe = multiplexIpcChannel<string>(ipc, 'menu:action')
  const received: string[] = []
  const unsubscribers = Array.from({ length: 11 }, (_, index) => subscribe((payload) => received.push(`${index}:${payload}`)))

  expect(ipc.listeners.get('menu:action')?.size).toBe(1)
  ipc.emit('menu:action', 'save')
  expect(received).toHaveLength(11)

  for (const unsubscribe of unsubscribers) {
    unsubscribe()
    unsubscribe()
  }
  expect(ipc.listeners.get('menu:action')?.size).toBe(0)
})

test('models-changed has a typed, transcript-free preload subscription', async () => {
  const source = await Bun.file(new URL('../../src/preload/index.ts', import.meta.url)).text()
  expect(source).toContain("onModelsChanged: on('agent:models-changed')")
  expect(source).toContain('onModelsChanged: (fn: (payload: AgentModelsChanged) => void) => () => void')
  expect(source).toContain("modelPickerOpened: () => ipcRenderer.invoke('agent:models-picker-opened')")
  const ipc = new FakeIpc()
  const subscribe = multiplexIpcChannel<import('../../src/preload').AgentModelsChanged>(ipc, 'agent:models-changed')
  const payload: import('../../src/preload').AgentModelsChanged = {
    catalogue: [{ provider: 'openai-codex', id: 'new', name: 'New' }],
    models: [], discovery: 'failed', reason: 'offline', at: 123, modelNotice: 'Model refresh failed: offline.',
  }
  const received: unknown[] = []
  const off = subscribe(value => received.push(value))
  ipc.emit('agent:models-changed', payload)
  expect(received).toEqual([payload])
  off()
  ipc.emit('agent:models-changed', payload)
  expect(received).toHaveLength(1)
})
