import { expect, test } from 'bun:test'
import { boundedReaderDTO, validReaderPayload, ReaderPort, validReaderReply } from '../../src/shared/reading-room-channel'
import vm from 'node:vm'
import { copyReaderViewState } from '../../src/shared/reading-room-schema'
import { ReaderEmbed, type ReaderHostWindow } from '@readflex/reader-embed'

const lease = { id: 'a'.repeat(32), origin: 'wf-reader://' + 'a'.repeat(32), url: '', nonce: 'b'.repeat(48), generation: 1, slot: 0 as const }
test('the closed message boundary rejects unknown commands, accessors and non-data objects', () => {
  expect(validReaderPayload('eval', 'alert(1)')).toBe(false)
  expect(validReaderPayload('navigate', { page: 1, path: '/synthetic' })).toBe(false)
  expect(validReaderPayload('tool', { type: 'pointer' })).toBe(true)
  expect(validReaderPayload('open', { url: 'file:///synthetic' })).toBe(false)
  let read = false
  expect(boundedReaderDTO({ get unsafe() { read = true; return 1 } })).toBe(false)
  expect(read).toBe(false)
  expect(boundedReaderDTO(new Date())).toBe(false)
  const cyclic: any = {}; cyclic.self = cyclic
  expect(boundedReaderDTO(cyclic)).toBe(false)
  expect(boundedReaderDTO({ data: new Uint8Array(4) })).toBe(false)
})
test('an annotation save acknowledgement waits for the durable operation and propagates failures', async () => {
  const ports = new MessageChannel()
  let finish!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const seen = new Promise<void>(resolve => { started = resolve })
  const parent = new ReaderPort(ports.port1, lease, 'parent', async () => { started(); await gate; throw new Error('Synthetic durable write refusal') })
  const host = new ReaderPort(ports.port2, lease, 'host', () => null)
  try {
    let settled = false
    const saved = host.request('annotation-created', { key: 'SYNTH001', type: 'highlight', text: 'Synthetic', comment: null, color: null, pageLabel: '1', sortIndex: '1', position: '{}', tags: [], isExternal: false })
    void saved.then(() => { settled = true }, () => { settled = true })
    await seen
    expect(settled).toBe(false)
    finish()
    await expect(saved).rejects.toThrow('Synthetic durable write refusal')
  } finally { parent.close(); host.close() }
})
test('closing a port rejects outstanding requests instead of silently acknowledging them', async () => {
  const ports = new MessageChannel()
  const parent = new ReaderPort(ports.port1, lease, 'parent', () => null)
  try {
    const pending = parent.request('live', null)
    parent.close()
    await expect(pending).rejects.toThrow('closed')
  } finally { parent.close(); ports.port2.close() }
})

const open = (bytes: Uint8Array) => ({ bytes, kind: 'pdf', annotations: [], viewState: null, document: {attachmentKey:'A', authorYear:'Author', itemKey:'I', libraryId:1, shortTitle:'Title'}, citationBaseLink:'', side:'left' })
test('typed bytes use intrinsic brand and size without executing shadow accessors', () => {
 let reads = 0
 for (const key of ['byteLength','length','buffer','byteOffset']) {
  const bytes = new Uint8Array([1,2,3]); Object.defineProperty(bytes, key, { get() { reads++; return key === 'byteLength' ? 3 : null } })
  expect(boundedReaderDTO(bytes, true)).toBe(false)
  expect(validReaderPayload('open',open(bytes))).toBe(false)
 }
 expect(reads).toBe(0)
})
test('normal cloned Uint8Array is accepted, forged and arbitrary prototypes are refused', () => {
 const bytes = structuredClone(new Uint8Array([1,2,3]))
 expect(validReaderPayload('open',open(bytes))).toBe(true)
 expect(validReaderPayload('open',open(new Uint8Array()))).toBe(false)
 for (const bytes of [Object.create(Uint8Array.prototype),Object.setPrototypeOf(new Uint8Array([1]),{}),new Uint16Array([1]),new DataView(new ArrayBuffer(4))]) expect(boundedReaderDTO(bytes,true)).toBe(false)
})

// Exact seven-field state captured from the private native reader, before any repair.
const pdf = { pageIndex: 0, scale: 'page-width', top: 17, left: -1, scrollMode: 0, spreadMode: 0, lastReadAloudPosition: null }
const snapshot = { scale: 1, scrollYPercent: 0, appearance: { lineHeight: 1, wordSpacing: 0, letterSpacing: 0, pageWidth: 0, useOriginalFont: true }, lastReadAloudPosition: null }
const live = { activeViewInitialised: true, canvas: null, page: null, pageCount: null }
for (const [kind, state] of [['pdf', pdf], ['snapshot', snapshot]] as const) {
 test(kind + ' primary state retains the reader-added null read-aloud position through events and command replies', () => {
  const nested = vm.runInNewContext('(' + JSON.stringify(state) + ')')
  const copied = copyReaderViewState(nested, [Object.getPrototypeOf(nested)])
  expect(copied).toEqual(state)
  expect(validReaderPayload('view-state-changed', copied)).toBe(true)
  for (const command of ['open', 'live', 'tool', 'navigate', 'position', 'side', 'upsert']) expect(validReaderReply(command, { liveness: live, viewState: copied })).toBe(true)
 })
}
test('unsupported read-aloud data and unrelated fields stay refused without getter execution', () => {
 let reads = 0
 for (const value of [undefined, false, 0, '', {}, [], new Uint8Array([1])]) {
  expect(validReaderPayload('view-state-changed', { ...pdf, lastReadAloudPosition: value })).toBe(false)
 }
 expect(validReaderPayload('view-state-changed', { ...pdf, arbitrary: null })).toBe(false)
 expect(validReaderReply('live', { liveness: { ...live, activeViewInitialised: false }, viewState: pdf })).toBe(false)
 const accessor = { ...pdf }; Object.defineProperty(accessor, 'lastReadAloudPosition', { enumerable: true, get() { reads++; return null } })
 expect(() => copyReaderViewState(accessor, [])).toThrow('descriptor refused')
 expect(validReaderPayload('view-state-changed', accessor)).toBe(false)
 expect(reads).toBe(0)
})

test('the actual public adapter forwards nested-realm state while saveViewState returns a local clone', async () => {
  const nested = vm.runInNewContext('({pageIndex:0, scale:"page-width", top:0, left:0, scrollMode:0, spreadMode:0})')
  let options: any, received: unknown
  const embed = new ReaderEmbed({ readFile: async () => new Uint8Array([1]) })
  embed.attachWindow({ createReader(input: unknown) { options = input; return { _lastView: { initializedPromise: Promise.resolve() } } } } as ReaderHostWindow)
  embed.on('view-state-changed', value => { received = value })
  await embed.openDocument({ path: 'synthetic', kind: 'pdf' })
  options.onChangeViewState(nested, true)
  await Promise.resolve(); await Promise.resolve()
  expect(received).toBe(nested)
  expect(Object.getPrototypeOf(received)).not.toBe(Object.prototype)
  expect(boundedReaderDTO(received)).toBe(false)
  const copied = copyReaderViewState(received, [Object.getPrototypeOf(nested)])
  expect(Object.getPrototypeOf(copied)).toBe(Object.prototype)
  expect(validReaderPayload('view-state-changed', copied)).toBe(true)
  expect(boundedReaderDTO(embed.saveViewState())).toBe(true)
  expect(validReaderPayload('view-state-changed', embed.saveViewState())).toBe(true)
  embed.detachKeyboardDelivery()
})
