import { expect, test } from 'bun:test'
import { registerRoomPending, flushRoomPending, rememberRoomNotes, roomNotesDraft, forgetRoomNotes } from '../../src/renderer/src/folio-room-pending'

test('leaving a room keeps its write registered until it settles, and a close waits for it', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let dirty = true, calls = 0
  const off = registerRoomPending({ path: 'paper/evidence.md', dirty: () => dirty, flush: async () => { calls++; await gate; dirty = false; return true } })
  off()
  let ended = false
  const close = flushRoomPending().then(result => { ended = true; return result })
  await Promise.resolve(); expect(ended).toBe(false)
  release()
  expect((await close).failed).toEqual([])
  expect(calls).toBe(1)
})

test('a refused room write prevents a clean close and preserves the recoverable notes draft', async () => {
  rememberRoomNotes('owner/part', { text: 'Unsaved notes', basis: 'Old notes', error: 'Changed elsewhere' })
  let dirty = true
  const off = registerRoomPending({ path: 'paper/evidence.md', dirty: () => dirty, flush: async () => false })
  expect((await flushRoomPending()).failed).toEqual(['paper/evidence.md'])
  expect(roomNotesDraft('owner/part')?.text).toBe('Unsaved notes')
  forgetRoomNotes('owner/part')
  dirty = false; off()
})
