import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from '../../src/main/settings'
import {
  applyLineOverlaySetting,
  bandRect,
  clampRect,
  handY,
  pickLine,
  type HandLock,
  DEFAULT_LINE_OVERLAY,
  dimRects,
  INITIAL_FOLLOW,
  lineFocusChipLabel,
  LINE_OVERLAY_SETTINGS,
  linesNeeded,
  normaliseRulerOpacity,
  readLineOverlayConfig,
  resolveExclusive,
  rulerHandleY,
  reduceFollow,
  resolveAnchor,
  rulerChipLabel,
  rulerShape,
  tileLines,
  type LineRect,
  LINE_FOLLOWS,
  LINE_FOLLOW_NAMES,
  normaliseLineFollow,
  TYPEWRITER_PROBE_PX,
  wantsTypewriterFollow,
} from '../../src/renderer/src/editor/line-overlay'
import { nudgeFixedLine } from '../../src/renderer/src/editor/fixed-line'

// Ten visual lines, 20px tall with a 10px gap (leading), the first at y=100.
const LINES: LineRect[] = Array.from({ length: 10 }, (_, i) => ({ top: 100 + i * 30, bottom: 120 + i * 30 }))
const H = 600

test('tileLines closes the gaps halfway between lines and grows the ends by half a gap', () => {
  const tiled = tileLines(LINES)
  expect(tiled[0]).toEqual({ top: 95, bottom: 125 })
  expect(tiled[1]).toEqual({ top: 125, bottom: 155 })
  expect(tiled[9]).toEqual({ top: 365, bottom: 395 })
})

test('band is 1, 3 or 5 visual lines centred on the focus line', () => {
  expect(bandRect(LINES, 4, 1, H)).toEqual({ top: 215, bottom: 245 })
  expect(bandRect(LINES, 4, 3, H)).toEqual({ top: 185, bottom: 275 })
  expect(bandRect(LINES, 4, 5, H)).toEqual({ top: 155, bottom: 305 })
})

test('band keeps what exists at the ends of the line list and clamps to the viewport', () => {
  expect(bandRect(LINES, 0, 3, H)).toEqual({ top: 95, bottom: 155 })
  expect(bandRect(LINES, 9, 5, H)).toEqual({ top: 305, bottom: 395 })
  expect(bandRect(LINES, 0, 5, 140)).toEqual({ top: 95, bottom: 140 })
  expect(bandRect([{ top: -50, bottom: -30 }], 0, 1, H)).toBeNull()
  expect(bandRect(LINES, 12, 3, H)).toBeNull()
  expect(clampRect({ top: -10, bottom: 700 }, H)).toEqual({ top: 0, bottom: 600 })
})

test('dim covers everything outside the band and nothing inside', () => {
  const band = bandRect(LINES, 4, 3, H)
  expect(dimRects(band, H)).toEqual({ above: { top: 0, bottom: 185 }, below: { top: 275, bottom: 600 } })
  expect(dimRects({ top: 0, bottom: 50 }, H).above).toBeNull()
  expect(dimRects(null, H)).toEqual({ above: null, below: null })
})

test('ruler: thin rule covers nothing; 1/3/5 start under the focus line; all below runs to the bottom', () => {
  const edge = tileLines(LINES)[4].bottom
  const thin = rulerShape(LINES, 4, 'thin', H)!
  expect(thin.kind).toBe('rule')
  expect(thin.bottom - thin.top).toBe(2)
  expect(thin.top).toBeLessThan(edge)
  expect(rulerShape(LINES, 4, '1', H)).toEqual({ kind: 'bar', top: edge, bottom: tileLines(LINES)[5].bottom })
  expect(rulerShape(LINES, 4, '3', H)).toEqual({ kind: 'bar', top: edge, bottom: tileLines(LINES)[7].bottom })
  expect(rulerShape(LINES, 4, '5', H)).toEqual({ kind: 'bar', top: edge, bottom: tileLines(LINES)[9].bottom })
  expect(rulerShape(LINES, 4, 'below', H)).toEqual({ kind: 'bar', top: edge, bottom: H })
  // The focus line and every line above stay uncovered.
  expect(rulerShape(LINES, 4, '3', H)!.top).toBeGreaterThanOrEqual(LINES[4].bottom)
})

test('ruler 3 lines hides exactly three lines: the covered span contains lines 5-7 and no part of 4 or 8', () => {
  const bar = rulerShape(LINES, 4, '3', H)!
  const covered = LINES.map((line, i) => ({ i, inside: line.top >= bar.top && line.bottom <= bar.bottom })).filter((x) => x.inside).map((x) => x.i)
  expect(covered).toEqual([5, 6, 7])
})

test('ruler with nothing below the focus line has no bar; below-the-fold clamps', () => {
  expect(rulerShape(LINES.slice(0, 5), 4, '3', H)).toBeNull()
  expect(rulerShape(LINES, 9, 'below', H)!.bottom).toBe(H)
  expect(rulerShape(LINES, 9, 'thin', H)).not.toBeNull()
})

test('linesNeeded asks the collector only for what the active overlays use', () => {
  const base = DEFAULT_LINE_OVERLAY
  expect(linesNeeded(base)).toEqual({ above: 0, below: 0 })
  expect(linesNeeded({ ...base, lineFocus: { ...base.lineFocus, on: true, size: 5 } })).toEqual({ above: 2, below: 2 })
  expect(linesNeeded({ ...base, ruler: { ...base.ruler, on: true, covers: '5' } })).toEqual({ above: 0, below: 5 })
  expect(linesNeeded({ ...base, ruler: { ...base.ruler, on: true, covers: 'below' } })).toEqual({ above: 0, below: 0 })
})

test('follow: cursor follows the caret, read-aloud follows the voice (caret when silent), by hand uses pointer then stored height', () => {
  const common = { head: 40, spoken: 90, state: INITIAL_FOLLOW, fixedLine: 0.33, height: 600 }
  expect(resolveAnchor({ ...common, follow: 'cursor' })).toEqual({ kind: 'pos', pos: 40 })
  expect(resolveAnchor({ ...common, follow: 'read-aloud' })).toEqual({ kind: 'pos', pos: 90 })
  expect(resolveAnchor({ ...common, follow: 'read-aloud', spoken: null })).toEqual({ kind: 'pos', pos: 40 })
  expect(resolveAnchor({ ...common, follow: 'by-hand' })).toEqual({ kind: 'y', y: 198 })
  expect(resolveAnchor({ ...common, follow: 'by-hand', state: { pointerY: 310 } })).toEqual({ kind: 'y', y: 310 })
})

test('follow: a handle drag under Cursor resolves to a height like by-hand; other modes and no drag are unchanged', () => {
  const common = { head: 40, spoken: 90, state: INITIAL_FOLLOW, fixedLine: 0.33, height: 600 }
  expect(resolveAnchor({ ...common, follow: 'cursor', drag: 0.5 })).toEqual({ kind: 'y', y: 300 })
  expect(resolveAnchor({ ...common, follow: 'cursor', drag: null })).toEqual({ kind: 'pos', pos: 40 })
  expect(resolveAnchor({ ...common, follow: 'read-aloud', drag: 0.5 })).toEqual({ kind: 'pos', pos: 90 })
  // By hand ignores the drag field: its own fixed line / pointer still decide.
  expect(resolveAnchor({ ...common, follow: 'by-hand', drag: 0.5 })).toEqual({ kind: 'y', y: 198 })
})

test('follow state: the pointer moves only by-hand aids; the handle and a follow change clear it', () => {
  let state = reduceFollow(INITIAL_FOLLOW, { type: 'pointer', y: 250, byHand: true })
  expect(state.pointerY).toBe(250)
  expect(reduceFollow(INITIAL_FOLLOW, { type: 'pointer', y: 250, byHand: false })).toBe(INITIAL_FOLLOW)
  state = reduceFollow(state, { type: 'pointer', y: 260, byHand: true })
  expect(state.pointerY).toBe(260)
  expect(reduceFollow(state, { type: 'handle' }).pointerY).toBeNull()
  expect(reduceFollow(state, { type: 'follow-changed' }).pointerY).toBeNull()
  expect(reduceFollow(INITIAL_FOLLOW, { type: 'handle' })).toBe(INITIAL_FOLLOW)
})

test('the handle nudges one visual line, not 2%, and stays inside the allowed range', () => {
  expect(nudgeFixedLine(0.5, 1)).toBe(0.52)
  expect(nudgeFixedLine(0.5, 1, 0.045)).toBe(0.545)
  expect(nudgeFixedLine(0.5, -1, 0.045)).toBe(0.455)
  expect(nudgeFixedLine(0.89, 1, 0.045)).toBe(0.9)
})

test('settings normalise: unknown values read as defaults, opacity snaps to 5% inside 10-100', () => {
  expect(readLineOverlayConfig(() => undefined)).toEqual(DEFAULT_LINE_OVERLAY)
  expect(normaliseRulerOpacity(3)).toBe(10)
  expect(normaliseRulerOpacity(101)).toBe(100)
  expect(normaliseRulerOpacity(37)).toBe(35)
  expect(normaliseRulerOpacity('60')).toBe(60)
  expect(normaliseRulerOpacity('x')).toBe(35)
  const odd = readLineOverlayConfig((key) => ({ [LINE_OVERLAY_SETTINGS.lineFocusSize]: 4, [LINE_OVERLAY_SETTINGS.rulerCovers]: 'everything', [LINE_OVERLAY_SETTINGS.rulerFollow]: 'mouse' })[key])
  expect(odd.lineFocus.size).toBe(3)
  expect(odd.ruler.covers).toBe('3')
  expect(odd.ruler.follow).toBe('cursor')
})

test('applyLineOverlaySetting merges one key; null reverts it; foreign keys are ignored', () => {
  let config = applyLineOverlaySetting(DEFAULT_LINE_OVERLAY, LINE_OVERLAY_SETTINGS.lineFocusOn, true)!
  config = applyLineOverlaySetting(config, LINE_OVERLAY_SETTINGS.lineFocusSize, 5)!
  config = applyLineOverlaySetting(config, LINE_OVERLAY_SETTINGS.rulerOpacity, 80)!
  expect(config.lineFocus).toMatchObject({ on: true, size: 5 })
  expect(config.ruler.opacity).toBe(80)
  expect(applyLineOverlaySetting(config, LINE_OVERLAY_SETTINGS.lineFocusSize, null)!.lineFocus.size).toBe(3)
  expect(applyLineOverlaySetting(config, 'editor.typewriter', true)).toBeNull()
})

test('chip labels read like the design', () => {
  expect(lineFocusChipLabel({ ...DEFAULT_LINE_OVERLAY.lineFocus, size: 3 })).toBe('Line focus · 3 lines')
  expect(lineFocusChipLabel({ ...DEFAULT_LINE_OVERLAY.lineFocus, size: 1 })).toBe('Line focus · 1 line')
  // "· by hand" shows only in that mode.
  expect(lineFocusChipLabel({ ...DEFAULT_LINE_OVERLAY.lineFocus, size: 3, follow: 'by-hand' })).toBe('Line focus · 3 lines · by hand')
  expect(lineFocusChipLabel({ ...DEFAULT_LINE_OVERLAY.lineFocus, size: 3, follow: 'read-aloud' })).toBe('Line focus · 3 lines')
  expect(rulerChipLabel({ ...DEFAULT_LINE_OVERLAY.ruler, covers: '3', opacity: 35, follow: 'by-hand' })).toBe('Ruler · 3 lines · 35% · by hand')
  expect(rulerChipLabel({ ...DEFAULT_LINE_OVERLAY.ruler, covers: 'thin', follow: 'by-hand' })).toBe('Ruler · thin rule · by hand')
  expect(rulerChipLabel({ ...DEFAULT_LINE_OVERLAY.ruler, covers: '3', opacity: 35 })).toBe('Ruler · 3 lines · 35%')
  expect(rulerChipLabel({ ...DEFAULT_LINE_OVERLAY.ruler, covers: 'thin' })).toBe('Ruler · thin rule')
  expect(rulerChipLabel({ ...DEFAULT_LINE_OVERLAY.ruler, covers: 'below', opacity: 60 })).toBe('Ruler · all below · 60%')
})

test('every choice persists across launches in the settings file, silently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-line-overlay-'))
  const path = join(dir, 'settings.json')
  const store = new SettingsStore(path)
  const choices: Array<[string, boolean | string | number]> = [
    [LINE_OVERLAY_SETTINGS.lineFocusOn, true],
    [LINE_OVERLAY_SETTINGS.lineFocusSize, 5],
    [LINE_OVERLAY_SETTINGS.lineFocusDim, 'dark'],
    [LINE_OVERLAY_SETTINGS.lineFocusFollow, 'by-hand'],
    [LINE_OVERLAY_SETTINGS.rulerOn, true],
    [LINE_OVERLAY_SETTINGS.rulerCovers, 'below'],
    [LINE_OVERLAY_SETTINGS.rulerOpacity, 60],
    [LINE_OVERLAY_SETTINGS.rulerFollow, 'read-aloud'],
  ]
  for (const [key, value] of choices) store.set(key, value, key, { log: false })
  const reloaded = new SettingsStore(path)
  // Both were stored on (as alpha.29 allowed): the overlays are exclusive now, so Line focus stays on and Ruler resolves off.
  expect(readLineOverlayConfig((key) => reloaded.get(key))).toEqual({
    lineFocus: { on: true, size: 5, dim: 'dark', follow: 'by-hand' },
    ruler: { on: false, covers: 'below', opacity: 60, follow: 'read-aloud' },
  })
  // Ruler alone persists as on.
  reloaded.set(LINE_OVERLAY_SETTINGS.lineFocusOn, false, 'x', { log: false })
  expect(readLineOverlayConfig((key) => new SettingsStore(path).get(key)).ruler.on).toBe(true)
  expect(reloaded.changelog()).toEqual([])
})

test('pickLine: inside wins, a gap goes to the nearest line, an exact tie goes to the upper one', () => {
  expect(pickLine(LINES, 110)).toBe(0)
  expect(pickLine(LINES, 120)).toBe(0) // gap 120-130: tie → upper
  expect(pickLine(LINES, 121)).toBe(0)
  expect(pickLine(LINES, 129)).toBe(1)
  expect(pickLine(LINES, 130)).toBe(1) // top is inclusive
})

test('a stored height within 1px of a line boundary resolves to the same line on every re-measure', () => {
  // The boundary sits halfway between line 3 and line 4 (y = 220 + 5 = 225 in the gap).
  const boundary = (LINES[3].bottom + LINES[4].top) / 2
  for (const stored of [boundary - 1, boundary - 0.5, boundary, boundary + 0.5, boundary + 1]) {
    // Re-measures see the lines shifted by layout noise (a scrollbar, a font load): up to ±1px.
    const noise = [0, 1, -1, 0.5, -0.5, 1, -1, 0, 0.75, -0.75]
    const resolve = (lock: HandLock | null, shift: number): { index: number; lock: HandLock } => {
      const lines = LINES.map((line) => ({ top: line.top + shift, bottom: line.bottom + shift }))
      // The lock stores a position inside the chosen line; in this model position i is line i.
      const y = handY(lock, stored, (l) => (lines[l.pos].top + lines[l.pos].bottom) / 2)
      const index = pickLine(lines, y)
      return { index, lock: lock && lock.sourceY === stored ? lock : { sourceY: stored, pos: index, side: 1 } }
    }
    let first = resolve(null, 0)
    for (const shift of noise) {
      const next = resolve(first.lock, shift)
      expect(next.index).toBe(first.index)
    }
    // Without the lock the same noise flips the line for a height on the boundary.
    if (Math.abs(stored - boundary) < 0.01) {
      const flips = new Set(noise.map((shift) => pickLine(LINES.map((l) => ({ top: l.top + shift, bottom: l.bottom + shift })), stored)))
      expect(flips.size).toBeGreaterThan(1)
    }
  }
})

test('a new source height (pointer moved, handle dragged) chooses afresh; an unmeasurable line falls back to the height', () => {
  const lock: HandLock = { sourceY: 225, pos: 3, side: 1 }
  expect(handY(lock, 225, () => 210)).toBe(210)
  expect(handY(lock, 300, () => 210)).toBe(300)
  expect(handY(lock, 225, () => null)).toBe(225)
  expect(handY(null, 225, () => 210)).toBe(225)
})

test('Line focus and Ruler are mutually exclusive: the preferred one stays on, hydration prefers Line focus', () => {
  const both = { lineFocus: { ...DEFAULT_LINE_OVERLAY.lineFocus, on: true }, ruler: { ...DEFAULT_LINE_OVERLAY.ruler, on: true } }
  expect(resolveExclusive(both).lineFocus.on).toBe(true)
  expect(resolveExclusive(both).ruler.on).toBe(false)
  expect(resolveExclusive(both, 'ruler').lineFocus.on).toBe(false)
  expect(resolveExclusive(both, 'ruler').ruler.on).toBe(true)
  const one = { ...both, ruler: { ...both.ruler, on: false } }
  expect(resolveExclusive(one)).toBe(one)
  // Any key order of a stored both-on state lands on Line focus.
  const keys = [LINE_OVERLAY_SETTINGS.lineFocusOn, LINE_OVERLAY_SETTINGS.rulerOn]
  for (const order of [keys, [...keys].reverse()]) {
    let config = DEFAULT_LINE_OVERLAY
    for (const key of order) config = resolveExclusive(applyLineOverlaySetting(config, key, true)!)
    expect(config.lineFocus.on).toBe(true)
    expect(config.ruler.on).toBe(false)
  }
})

test('the follow default is Cursor, and a stored by-hand stays an explicit choice', () => {
  expect(DEFAULT_LINE_OVERLAY.lineFocus.follow).toBe('cursor')
  expect(DEFAULT_LINE_OVERLAY.ruler.follow).toBe('cursor')
  expect(readLineOverlayConfig(() => undefined).ruler.follow).toBe('cursor')
})

test('the ruler handle sits ON the ruler: a thin rule on the rule, a covering ruler on its first covered line', () => {
  const tiled = tileLines(LINES)
  const rule = rulerShape(LINES, 4, 'thin', H)!
  expect(rulerHandleY(LINES, 4, 'thin', H)).toBe((rule.top + rule.bottom) / 2)
  for (const covers of ['1', '3', '5', 'below'] as const) {
    const y = rulerHandleY(LINES, 4, covers, H)!
    const bar = rulerShape(LINES, 4, covers, H)!
    expect(y).toBeGreaterThan(bar.top)
    expect(y).toBeLessThan(bar.bottom)
    expect(y).toBe((tiled[5].top + tiled[5].bottom) / 2) // the first covered line, not the focus line above
    expect(y).toBeGreaterThan(tiled[4].bottom)
  }
  // Nothing below: it rests on the focus line's lower edge; the viewport clamps it.
  expect(rulerHandleY(LINES.slice(0, 5), 4, '3', H)).toBe(tileLines(LINES.slice(0, 5))[4].bottom)
  expect(rulerHandleY(LINES, 9, 'thin', 380)).toBe(380)
  expect(rulerHandleY(LINES, 12, 'thin', H)).toBeNull()
})

test('the dim scale: Light 0.50, Medium 0.72, Dark 0.90 on both themes, and dark still lets the text show', async () => {
  const css = await Bun.file(new URL('../../src/renderer/src/styles/app.css', import.meta.url).pathname).text()
  const alpha = (selector: string): number => Number(new RegExp(`${selector.replace(/[[\]().*"]/g, '\\$&')}\\s*\\{background:rgba\\([^)]*,\\s*([0-9.]+)\\)\\}`).exec(css)?.[1])
  expect(alpha('.wf-lo-dim')).toBe(0.72)
  expect(alpha('.wf-line-overlay[data-dim="light"] .wf-lo-dim')).toBe(0.5)
  expect(alpha('.wf-line-overlay[data-dim="dark"] .wf-lo-dim')).toBe(0.9)
  expect(alpha('[data-theme="dark"] .wf-lo-dim')).toBe(0.72)
  expect(alpha('[data-theme="dark"] .wf-line-overlay[data-dim="light"] .wf-lo-dim')).toBe(0.5)
  expect(alpha('[data-theme="dark"] .wf-line-overlay[data-dim="dark"] .wf-lo-dim')).toBe(0.9)
  // Never fully opaque: the dimmed lines stay faintly legible, as in the Edge reference.
  expect(alpha('.wf-line-overlay[data-dim="dark"] .wf-lo-dim')).toBeLessThan(1)
})

test('follow: Typewriter is the second choice, normalises, round-trips and is read back from the store key', () => {
  expect(LINE_FOLLOWS).toEqual(['cursor', 'typewriter', 'read-aloud', 'by-hand'])
  expect(LINE_FOLLOW_NAMES.typewriter).toBe('Typewriter')
  expect(normaliseLineFollow('typewriter')).toBe('typewriter')
  // What an older build does with the value: its normaliser falls back to Cursor, as for any unknown value.
  expect(normaliseLineFollow('typewriter-v2')).toBe('cursor')
  const config = readLineOverlayConfig((key) => (key === LINE_OVERLAY_SETTINGS.rulerFollow ? 'typewriter' : undefined))
  expect(config.ruler.follow).toBe('typewriter')
  expect(applyLineOverlaySetting(DEFAULT_LINE_OVERLAY, LINE_OVERLAY_SETTINGS.lineFocusFollow, 'typewriter')!.lineFocus.follow).toBe('typewriter')
})

test('follow: Typewriter resolves to the fixed line height (probe just inside the line), without a lock, whatever the caret does', () => {
  const common = { head: 40, spoken: 90, state: INITIAL_FOLLOW, fixedLine: 0.33, height: 600 }
  expect(resolveAnchor({ ...common, follow: 'typewriter' })).toEqual({ kind: 'y', y: 198 + TYPEWRITER_PROBE_PX, lock: false })
  expect(resolveAnchor({ ...common, follow: 'typewriter', head: 5000, state: { pointerY: 310 }, drag: 0.5 })).toEqual({ kind: 'y', y: 198 + TYPEWRITER_PROBE_PX, lock: false })
  expect(resolveAnchor({ ...common, follow: 'typewriter', fixedLine: 0.5 })).toEqual({ kind: 'y', y: 300 + TYPEWRITER_PROBE_PX, lock: false })
})

test('chip labels: Typewriter follow adds "· typewriter" the way By hand adds "· by hand"', () => {
  expect(lineFocusChipLabel({ ...DEFAULT_LINE_OVERLAY.lineFocus, size: 3, follow: 'typewriter' })).toBe('Line focus · 3 lines · typewriter')
  expect(rulerChipLabel({ ...DEFAULT_LINE_OVERLAY.ruler, covers: '3', opacity: 35, follow: 'typewriter' })).toBe('Ruler · 3 lines · 35% · typewriter')
  expect(rulerChipLabel({ ...DEFAULT_LINE_OVERLAY.ruler, covers: 'thin', follow: 'typewriter' })).toBe('Ruler · thin rule · typewriter')
})

test('wantsTypewriterFollow: only an overlay that is ON with the Typewriter choice asks for the scroll', () => {
  const base = DEFAULT_LINE_OVERLAY
  expect(wantsTypewriterFollow(base)).toBe(false)
  expect(wantsTypewriterFollow({ ...base, ruler: { ...base.ruler, follow: 'typewriter' } })).toBe(false) // off
  expect(wantsTypewriterFollow({ ...base, ruler: { ...base.ruler, on: true, follow: 'typewriter' } })).toBe(true)
  expect(wantsTypewriterFollow({ ...base, lineFocus: { ...base.lineFocus, on: true, follow: 'typewriter' } })).toBe(true)
  expect(wantsTypewriterFollow({ ...base, lineFocus: { ...base.lineFocus, on: true, follow: 'by-hand' } })).toBe(false)
})
