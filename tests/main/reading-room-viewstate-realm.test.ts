import { expect, test } from 'bun:test'
import vm from 'node:vm'
import { ReaderEmbed, type ReaderHostWindow } from '@readflex/reader-embed'
import { copyReaderViewState } from '../../src/shared/reading-room-schema'
import { boundedReaderDTO, validReaderPayload } from '../../src/shared/reading-room-channel'

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
