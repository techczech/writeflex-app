import { afterEach, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from '../../src/main/settings'
import {
  FIXED_LINE_DEFAULT,
  FIXED_LINE_PRESETS,
  FIXED_LINE_SETTING,
  fixedLineCustomLabel,
  fixedLineFromPointer,
  fixedLineMargin,
  fixedLinePreset,
  getFixedLine,
  normaliseFixedLine,
  nudgeFixedLine,
  setLiveFixedLine,
} from '../../src/renderer/src/editor/fixed-line'
import { typewriterScrollEffect } from '../../src/renderer/src/editor/typewriter'

afterEach(() => setLiveFixedLine(FIXED_LINE_DEFAULT))

test('presets are the drawn thirds and the default is the top third', () => {
  expect(FIXED_LINE_PRESETS).toEqual({ top: 0.33, middle: 0.5, lower: 0.67 })
  expect(FIXED_LINE_DEFAULT).toBe(0.33)
  expect(normaliseFixedLine(undefined)).toBe(0.33)
  expect(normaliseFixedLine('nonsense')).toBe(0.33)
  expect(normaliseFixedLine(null)).toBe(0.33)
})

test('stored values are clamped so the line cannot leave the editor', () => {
  expect(normaliseFixedLine(0)).toBe(0.1)
  expect(normaliseFixedLine(2)).toBe(0.9)
  expect(normaliseFixedLine(0.31)).toBe(0.31)
  expect(normaliseFixedLine('0.5')).toBe(0.5)
})

test('a fraction is a preset only when it matches one; anything else is Custom with its percentage', () => {
  expect(fixedLinePreset(0.33)).toBe('top')
  expect(fixedLinePreset(0.5)).toBe('middle')
  expect(fixedLinePreset(0.67)).toBe('lower')
  expect(fixedLinePreset(0.31)).toBe('custom')
  expect(fixedLineCustomLabel(0.31)).toBe('Custom 31%')
})

test('the scroll margin is the fraction of the visible height, shared by both modes', () => {
  expect(fixedLineMargin(0.33, 600)).toBe(198)
  expect(fixedLineMargin(0.5, 600)).toBe(300)
  expect(fixedLineMargin(0.67, 601)).toBe(403)
  expect(fixedLineMargin(0.5, 0)).toBe(0)
  // The same number feeds the scroll effect both modes dispatch.
  expect(typewriterScrollEffect(10, fixedLineMargin(0.33, 600))).toBeDefined()
})

test('dragging maps the pointer to a fraction of the scroller and stays inside the allowed range', () => {
  expect(fixedLineFromPointer(400, 100, 600)).toBe(0.5)
  expect(fixedLineFromPointer(298, 100, 600)).toBe(0.33)
  expect(fixedLineFromPointer(0, 100, 600)).toBe(0.1)
  expect(fixedLineFromPointer(5000, 100, 600)).toBe(0.9)
  expect(fixedLineFromPointer(400, 100, 0)).toBe(FIXED_LINE_DEFAULT)
})

test('arrow keys step the marker by 2% and stop at the limits', () => {
  expect(nudgeFixedLine(0.33, 1)).toBe(0.35)
  expect(nudgeFixedLine(0.33, -1)).toBe(0.31)
  expect(nudgeFixedLine(0.9, 1)).toBe(0.9)
  expect(nudgeFixedLine(0.1, -1)).toBe(0.1)
})

test('the live value is what the scroll code reads, and it is normalised on the way in', () => {
  expect(getFixedLine()).toBe(0.33)
  setLiveFixedLine(0.67)
  expect(getFixedLine()).toBe(0.67)
  setLiveFixedLine(7)
  expect(getFixedLine()).toBe(0.9)
})

test('the choice persists across launches in the settings file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-fixed-line-'))
  const path = join(dir, 'settings.json')
  const store = new SettingsStore(path)
  store.set(FIXED_LINE_SETTING, 0.31, 'Fixed line position', { log: false })
  const reloaded = new SettingsStore(path)
  expect(normaliseFixedLine(reloaded.get(FIXED_LINE_SETTING))).toBe(0.31)
  expect(fixedLinePreset(normaliseFixedLine(reloaded.get(FIXED_LINE_SETTING)))).toBe('custom')
  expect(reloaded.changelog()).toEqual([])
})
