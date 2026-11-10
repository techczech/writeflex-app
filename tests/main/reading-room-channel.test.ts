import { expect, test } from 'bun:test'
import { boundedReaderDTO, validReaderPayload, ReaderPort } from '../../src/shared/reading-room-channel'
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
