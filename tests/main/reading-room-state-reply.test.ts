import { expect, test } from 'bun:test'
import vm from 'node:vm'
import { copyReaderViewState } from '../../src/shared/reading-room-schema'
import { validReaderPayload, validReaderReply } from '../../src/shared/reading-room-channel'

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
