import { expect, test } from 'bun:test'
import { syncDroppedChips, type DropWrapper } from '../../src/renderer/src/components/status-bar-drop'

function wrapper(chipTop: number | null): DropWrapper & { attrs: Record<string, string> } {
  const attrs: Record<string, string> = {}
  return {
    attrs, inert: false,
    querySelector: () => (chipTop === null ? null : { getBoundingClientRect: () => ({ top: chipTop }) }),
    getBoundingClientRect: () => ({ top: 100 }),
    setAttribute: (name, value) => { attrs[name] = value },
    removeAttribute: (name) => { delete attrs[name] },
  }
}

test('a chip wrapped out of its box is inert and hidden from readers; one that fits is not touched', () => {
  const fits = wrapper(100), dropped = wrapper(122), none = wrapper(null)
  expect(syncDroppedChips({ querySelectorAll: () => [fits, dropped, none] })).toBe(1)
  expect(dropped.inert).toBe(true)
  expect(dropped.attrs['aria-hidden']).toBe('true')
  expect(fits.inert).toBe(false)
  expect(none.inert).toBe(false)
  // Room comes back: the same wrapper is focusable again.
  const later = wrapper(100)
  later.inert = true; later.attrs['aria-hidden'] = 'true'
  expect(syncDroppedChips({ querySelectorAll: () => [later] })).toBe(0)
  expect(later.inert).toBe(false)
  expect(later.attrs['aria-hidden']).toBeUndefined()
})

test('the wrapper and every slot that shares the bar are observed, so a change that leaves the bar\'s size alone still re-syncs', async () => {
  const { DROP_OBSERVED } = await import('../../src/renderer/src/components/status-bar-drop')
  for (const part of ['.sb-cue-fit', '.sb-folio-slot', '.sb-scratchpad-slot', '.sb-notice-slot']) expect(DROP_OBSERVED).toContain(part)
})

test('the inert state follows the wrapper as its room changes, in both directions', () => {
  let chipTop = 100
  const w = wrapper(100)
  w.querySelector = () => ({ getBoundingClientRect: () => ({ top: chipTop }) })
  const bar = { querySelectorAll: () => [w] }
  expect(syncDroppedChips(bar)).toBe(0)
  chipTop = 122 // the Scratchpad count gained a digit: the cue wrapped out of its box
  expect(syncDroppedChips(bar)).toBe(1)
  expect(w.inert).toBe(true)
  chipTop = 100
  expect(syncDroppedChips(bar)).toBe(0)
  expect(w.inert).toBe(false)
})
