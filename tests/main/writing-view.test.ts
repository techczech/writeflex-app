import { expect, test } from 'bun:test'
import { FIXED_LINE_SETTING } from '../../src/renderer/src/editor/fixed-line'
import { LINE_OVERLAY_SETTINGS as overlay } from '../../src/renderer/src/editor/line-overlay'
import {
  applyWritingViewSetting,
  DEFAULT_WRITING_VIEW,
  stepWritingViewZoom,
  toggleOverlayFollow,
} from '../../src/renderer/src/app/writing-view'

test('the writing view clamps a stored fixed line and restores its default on reset', () => {
  const low = applyWritingViewSetting(DEFAULT_WRITING_VIEW, FIXED_LINE_SETTING, '-1')!
  expect(low.fixedLine).toBe(0.1)
  const high = applyWritingViewSetting(low, FIXED_LINE_SETTING, 2)!
  expect(high.fixedLine).toBe(0.9)
  expect(applyWritingViewSetting(high, FIXED_LINE_SETTING, null)?.fixedLine).toBe(0.33)
})

test('line focus wins conflicting stored overlays in either order, but an explicit ruler choice wins live', () => {
  for (const [first, second] of [[overlay.rulerOn, overlay.lineFocusOn], [overlay.lineFocusOn, overlay.rulerOn]]) {
    const one = applyWritingViewSetting(DEFAULT_WRITING_VIEW, first, true)!
    const both = applyWritingViewSetting(one, second, true)!
    expect([both.lineOverlay.lineFocus.on, both.lineOverlay.ruler.on]).toEqual([true, false])
  }
  const lineFocus = applyWritingViewSetting(DEFAULT_WRITING_VIEW, overlay.lineFocusOn, true)!
  const ruler = applyWritingViewSetting(lineFocus, overlay.rulerOn, true, 'command')!
  expect([ruler.lineOverlay.lineFocus.on, ruler.lineOverlay.ruler.on]).toEqual([false, true])
})

test('overlays start with cursor follow and keep explicit follow choices when switched on', () => {
  const on = applyWritingViewSetting(DEFAULT_WRITING_VIEW, overlay.lineFocusOn, true)!
  expect(on.lineOverlay.lineFocus.follow).toBe('cursor')
  expect(toggleOverlayFollow(on, 'typewriter')).toBe('typewriter')
  const chosen = applyWritingViewSetting(DEFAULT_WRITING_VIEW, overlay.lineFocusFollow, 'typewriter')!
  const enabled = applyWritingViewSetting(chosen, overlay.lineFocusOn, true)!
  expect(enabled.lineOverlay.lineFocus.follow).toBe('typewriter')
  expect(toggleOverlayFollow(enabled, 'typewriter')).toBe('cursor')
})

test('prose size and line width step from the default and stop at both ends', () => {
  expect(stepWritingViewZoom('proseSize', undefined, 1)).toBe('21')
  expect(stepWritingViewZoom('proseSize', 21, 1)).toBe('21')
  expect(stepWritingViewZoom('proseSize', '17', -1)).toBe('17')
  expect(stepWritingViewZoom('lineWidth', 'unknown', -1)).toBe('narrow')
  expect(stepWritingViewZoom('lineWidth', 'narrow', -1)).toBe('narrow')
  expect(stepWritingViewZoom('lineWidth', 'wide', 1)).toBe('wide')
})
