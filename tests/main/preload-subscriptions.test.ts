import { expect, test } from 'bun:test'
import { invokeTurnBackAfterNotifications, multiplexIpcChannel } from '../../src/preload/subscriptions'

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


test('Turn back resolves only after its own final notification, even when invoke resolves first', async () => {
  const ipc = new FakeIpc()
  const requests: Array<{ requestId: number }> = []
  const api = Object.assign(ipc, { invoke: async (_channel: string, input: { requestId: number }) => { requests.push(input); return true } })
  let completed = false
  const pending = invokeTurnBackAfterNotifications(api, 'book').then(value => { completed = true; return value })
  await Promise.resolve(); await Promise.resolve()
  expect(completed).toBe(false)
  ipc.emit('folio:turn-back-finished', requests[0].requestId + 1)
  await Promise.resolve()
  expect(completed).toBe(false)
  ipc.emit('folio:turn-back-finished', requests[0].requestId)
  expect(await pending).toBe(true)
  expect(ipc.listeners.get('folio:turn-back-finished')?.size).toBe(0)
})

test('cancelled or failed Turn back does not wait for a notification and cleans up', async () => {
  for (const fails of [false, true]) {
    const ipc = Object.assign(new FakeIpc(), { invoke: async () => { if (fails) throw new Error('refused'); return false } })
    if (fails) await expect(invokeTurnBackAfterNotifications(ipc, 'book')).rejects.toThrow('refused')
    else expect(await invokeTurnBackAfterNotifications(ipc, 'book')).toBe(false)
    expect(ipc.listeners.get('folio:turn-back-finished')?.size).toBe(0)
  }
})


test('Turn back carries the retired receipt notice after its notifications', async () => {
  const ipc = new FakeIpc()
  const notice = 'Turned back into a collection. Earlier parked bytes are kept in book/.folio-turn-back-retired-abc.json.'
  const api = Object.assign(ipc, { invoke: async (_channel: string, input: { requestId: number }) => {
    ipc.emit('folio:turn-back-finished', input.requestId)
    return notice
  } })
  expect(await invokeTurnBackAfterNotifications(api, 'book')).toBe(notice)
})
