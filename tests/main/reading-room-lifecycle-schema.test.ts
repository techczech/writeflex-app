import { expect, test } from 'bun:test'
import { boundedReaderDTO, validReaderPayload, ReaderPort } from '../../src/shared/reading-room-channel'
import { ReadingRoomClient } from '../../src/renderer/src/reading-room-client'
import { createKeyboardGate } from '../../src/main/widget-keyboard'
const lease = { id: 'a'.repeat(32), origin: 'wf-reader://' + 'a'.repeat(32), url: 'wf-reader://' + 'a'.repeat(32) + '/reader-host.html', nonce: 'b'.repeat(48), generation: 1, slot: 0 as const }
const state = { pageIndex: 0, scale: 'page-width', top: 0, left: 0, scrollMode: 0, spreadMode: 0 }
const snapshot = { liveness: { activeViewInitialised: true, canvas: null, page: 1, pageCount: 2 }, viewState: state }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

test('DTO descriptors reject symbols, hidden fields, sparse arrays, prototypes and getters without executing a getter', () => {
 let reads = 0
 for (const value of [ { [Symbol('hidden')]: 1 }, Object.defineProperty({}, 'hidden', { value: 1 }), new Array(2), Object.create({ x: 1 }), { get pageIndex() { reads++; return 0 } } ]) expect(boundedReaderDTO(value)).toBe(false)
 expect(reads).toBe(0)
 expect(boundedReaderDTO({ x: 'x'.repeat(13 * 1024 * 1024) })).toBe(false)
})
for (const value of [{}, { pageIndex: -1 }, { ...state, top: '0' }, { ...state, spreadMode: 3 }, { ...state, path: '/synthetic' }, { ...state, scale: 'javascript:bad' }]) {
 test('view-state rejects invalid or unknown fields ' + JSON.stringify(value), () => { expect(validReaderPayload('view-state-changed', value)).toBe(false) })
}
test('selection annotations use the actual public adapter type', () => {
 const selection = { annotation: { type: 'highlight', text: null, color: null, pageLabel: null, sortIndex: '1', position: '{}' }, text: '', pageLabel: null, pageIndex: 0, pageLink: '' }
 expect(validReaderPayload('selection', selection)).toBe(true)
 expect(validReaderPayload('selection', { ...selection, pageIndex: -1 })).toBe(false)
 expect(validReaderPayload('selection', { ...selection, annotation: {} })).toBe(false)
 expect(validReaderPayload('selection', { ...selection, annotation: { ...selection.annotation, key: 'unexpected' } })).toBe(false)
 expect(validReaderPayload('view-state-changed', state)).toBe(true)
})
function fakePort() {
 const messages: any[] = []; const p = { onmessage: null as any, onmessageerror: null as any, start() {}, close() {}, postMessage(m: any) { messages.push(m) } }
 const reader = new ReaderPort(p as unknown as MessagePort, lease, 'parent', () => null)
 const answer = async (payload: unknown, changes = {}) => { const m = messages.at(-1); await p.onmessage({ data: { ...m, type: 'ok', payload, ...changes } }); await tick() }
 return { reader, messages, answer }
}
for (const payload of [null, {}, { ...snapshot, extra: true }, { ...snapshot, liveness: { activeViewInitialised: false, canvas: null, page: 1, pageCount: 2 } }, { ...snapshot, viewState: { path: '/synthetic' } }]) {
 test('live replies validate the requested snapshot schema ' + JSON.stringify(payload), async () => {
  const f = fakePort(); let outcome = 'pending'
  try { const pending = f.reader.request('live', null); void pending.then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' }); await f.answer(payload); expect(outcome).toBe('rejected') } finally { f.reader.close() }
 })
}
test('reply validation retains exact request id, reader and generation and accepts one valid response', async () => {
 const f = fakePort(); let outcome = 'pending'
 try {
  const pending = f.reader.request('live', null); void pending.then(() => { outcome = 'resolved' }, () => { outcome = 'rejected' })
  for (const changes of [{ id: 99 }, { reader: 'other' }, { generation: 2 }]) { await f.answer(snapshot, changes); expect(outcome).toBe('pending') }
  await f.answer(snapshot); expect(await pending).toEqual(snapshot)
  await f.answer(null); expect(outcome).toBe('resolved')
 } finally { f.reader.close() }
})
test('keyboard gate accepts only a main-authorised reader and keeps widget gates', () => {
 const focused = { origin: lease.origin, processId: 2, routingId: 3 }
 let authorised = true
 const host: any = { focusedFrame: () => focused, mainFrame: () => ({ origin: 'file://', processId: 1, routingId: 1 }), shellOrigin: () => 'file://', readerFrame: () => authorised, reclaim: async () => {}, send() {}, wait: async () => {}, now: () => 0, findWidgetFrame: () => null }
 const reader = createKeyboardGate(host, { attempts: 0 })
 const key = { type: 'keyDown', key: 'Escape', shift: false, control: false, alt: false, meta: false }
 expect(reader.onInput(key)).toBe(false)
 authorised = false; expect(reader.onInput(key)).toBe(true)
 reader.reset()
})

async function clientFixture(receive: (type: string) => unknown | Promise<unknown>) {
 const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
 const listeners = new Set<(e: any) => void>(); const order: string[] = []; let host: ReaderPort | undefined
 const frame = { contentWindow: { postMessage(_m: unknown, _origin: string, ports: MessagePort[]) { host = new ReaderPort(ports[0], lease, 'host', receive) } }, isConnected: true, remove() { throw Error('Client tried to remove a React-owned frame') } }
 Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'file://' } })
 Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener(_t: string, f: any) { listeners.add(f) }, removeEventListener(_t: string, f: any) { listeners.delete(f) }, writeflex: { readingRoom: { async releaseReaderLease() { order.push('lease-revoke') } } } } })
 const client = new ReadingRoomClient(lease, () => frame as unknown as HTMLIFrameElement, () => { order.push('frame-remove'); frame.isConnected = false })
 for (const f of listeners) f({ source: frame.contentWindow, origin: lease.origin, data: { type: 'reader-ready', version: 1, reader: lease.id, generation: 1, nonce: lease.nonce } })
 await client.ready
 return { client, order, host: () => host!, async cleanup() { host?.close(); if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else delete (globalThis as any).window; if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else delete (globalThis as any).location } }
}
test('disposal immediately refuses new commands and repeated calls await the same native teardown', async () => {
 const close = gate<null>(); const seen = gate<void>(); let disposals = 0
 const f = await clientFixture(type => { if (type === 'dispose') { disposals++; seen.resolve(); return close.promise } return snapshot })
 try {
  const first = f.client.dispose(); let secondDone = false
  const second = f.client.dispose(); void second.then(() => { secondDone = true })
  await seen.promise
  await expect(f.client.navigateTo({ page: 1 })).rejects.toThrow('closed')
  expect(secondDone).toBe(false); expect(f.order).toEqual([])
  close.resolve(null); await Promise.all([first, second])
  expect(disposals).toBe(1); expect(f.order).toEqual(['frame-remove', 'lease-revoke'])
 } finally { close.resolve(null); await f.cleanup() }
})
test('a failed native disposal never removes the frame or revokes resources as though teardown succeeded', async () => {
 const f = await clientFixture(type => { if (type === 'dispose') throw Error('Synthetic teardown refusal'); return snapshot })
 try { await expect(f.client.dispose()).rejects.toThrow('Synthetic teardown refusal'); expect(f.order).toEqual([]) } finally { await f.cleanup() }
})

test('incoming replay, stale, role and unknown messages never invoke an event listener', async () => {
 let received = 0
 const messages: any[] = [], port: any = { start() {}, close() {}, onmessage: null, onmessageerror: null, postMessage(m: unknown) { messages.push(m) } }
 const parent = new ReaderPort(port, lease, 'parent', () => { received++; return null })
 const data = { version: 1, reader: lease.id, generation: 1, id: 1, type: 'mark-mode-cancelled', payload: null }
 try {
  for (const patch of [{ type: 'eval' }, { type: 'live' }, { reader: 'other' }, { generation: 2 }]) { port.onmessage({ data: { ...data, ...patch } }); await tick() }
  expect(received).toBe(0)
  port.onmessage({ data }); await tick(); expect(received).toBe(1)
  port.onmessage({ data }); await tick(); expect(received).toBe(1); expect(messages).toHaveLength(1)
 } finally { parent.close() }
})
test('already authorised durable view-state acknowledgements finish before frame removal and revocation', async () => {
 const durable = gate<void>(), arrived = gate<void>(), flush = gate<void>(); let event: Promise<unknown> | undefined
 const f = await clientFixture(type => type === 'dispose' ? event!.then(() => null) : snapshot)
 f.client.on('view-state-changed', async () => { arrived.resolve(); await durable.promise })
 f.client.beforeRelease(() => flush.promise)
 try {
  event = f.host().request('view-state-changed', state); await arrived.promise
  const closing = f.client.dispose(); await tick(); expect(f.order).toEqual([])
  durable.resolve(); await event; await tick(); expect(f.order).toEqual([])
  flush.resolve(); await closing; expect(f.order).toEqual(['frame-remove', 'lease-revoke'])
 } finally { durable.resolve(); flush.resolve(); await f.cleanup() }
})
