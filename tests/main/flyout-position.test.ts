import { describe, expect, test } from 'bun:test'
import { placeFlyout, type Rect } from '../../src/renderer/src/commands/flyout-position'

const view = { width: 1000, height: 700 }
const child = { width: 236, height: 200 }
const parent: Rect = { left: 100, top: 100, right: 440, bottom: 500 }
const row: Rect = { left: 101, top: 240, right: 439, bottom: 265 }

describe('placeFlyout', () => {
  test('opens on the right, 6px from the panel, top aligned with the opener row less the 3px padding', () => {
    expect(placeFlyout(parent, row, child, view)).toEqual({ left: 446, top: 237, side: 'right' })
  })
  test('opens on the left when the right has no room inside the window', () => {
    expect(placeFlyout({ ...parent, left: 600, right: 940 }, row, child, view)).toEqual({ left: 358, top: 237, side: 'left' })
  })
  test('the right side is kept when it fits exactly to the edge margin', () => {
    const p = { ...parent, left: 400, right: 1000 - 8 - 236 - 6 }
    expect(placeFlyout(p, row, child, view).side).toBe('right')
    expect(placeFlyout({ ...p, right: p.right + 1 }, row, child, view).side).toBe('left')
  })
  test('shifts up to stay inside the window at the bottom', () => {
    const low = { ...row, top: 600, bottom: 625 }
    expect(placeFlyout(parent, low, child, view).top).toBe(700 - 200 - 8)
  })
  test('never above the top edge, even when taller than the window', () => {
    expect(placeFlyout(parent, row, { width: 236, height: 900 }, view).top).toBe(8)
  })
  test('with no room either side it takes the roomier side and stays inside the window', () => {
    const narrow = { width: 400, height: 700 }
    const out = placeFlyout({ left: 20, top: 100, right: 360, bottom: 500 }, row, child, narrow)
    expect(out.side).toBe('right')
    expect(out.left + child.width).toBeLessThanOrEqual(narrow.width - 8)
    expect(out.left).toBeGreaterThanOrEqual(8)
  })

  describe('a list inside a list (Insert object → Flow diagram)', () => {
    const second: Rect = { left: 446, top: 237, right: 706, bottom: 600 }
    const third = { width: 236, height: 160 }
    test('with no preference it follows the same rule as the first level', () => {
      expect(placeFlyout(second, row, third, view).side).toBe('right')
    })
    test('prefers the side its parent took when that side fits', () => {
      const out = placeFlyout({ ...second, left: 300, right: 560 }, row, third, view, undefined, undefined, 'left')
      expect(out.side).toBe('left')
      expect(out.left).toBe(300 - 6 - 236)
    })
    test('a preferred side without room is given up for the other side', () => {
      const out = placeFlyout({ left: 40, top: 100, right: 300, bottom: 500 }, row, third, view, undefined, undefined, 'left')
      expect(out.side).toBe('right')
      expect(out.left).toBe(306)
    })
    test('top aligned with its own opener row, shifted up at the foot of the window', () => {
      expect(placeFlyout(second, { ...row, top: 300 }, third, view, undefined, undefined, 'right').top).toBe(297)
      expect(placeFlyout(second, { ...row, top: 650 }, third, view, undefined, undefined, 'right').top).toBe(700 - 160 - 8)
    })
    test('in a 760 px window the third list stays on screen, beside its parent when either side fits, else pinned to the roomier side', () => {
      const narrow = { width: 760, height: 700 }
      const insertList: Rect = { left: 446, top: 237, right: 706, bottom: 600 }
      const flipped = placeFlyout(insertList, row, third, narrow, undefined, undefined, 'right')
      expect(flipped.side).toBe('left') // right has no room (706+6+236 > 752), left of the second list does
      expect(flipped.left).toBe(446 - 6 - 236)
      const cramped = placeFlyout({ left: 150, top: 100, right: 610, bottom: 500 }, row, third, narrow, undefined, undefined, 'right')
      expect(cramped.left).toBeGreaterThanOrEqual(8)
      expect(cramped.left + third.width).toBeLessThanOrEqual(760 - 8)
    })
  })
})
