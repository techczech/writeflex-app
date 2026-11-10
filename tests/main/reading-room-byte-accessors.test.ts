import { expect, test } from 'bun:test'
import { boundedReaderDTO, validReaderPayload } from '../../src/shared/reading-room-channel'
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
