import { expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from '../../src/main/settings'
import {
  READ_ALOUD_COLOUR_SETTING,
  READ_ALOUD_INK,
  READ_ALOUD_MIN_CONTRAST,
  READ_ALOUD_PAPER,
  READ_ALOUD_PRESETS,
  READ_ALOUD_PRESET_IDS,
  READ_ALOUD_STRENGTHS,
  READ_ALOUD_STRENGTH_SETTING,
  composite,
  contrastRatio,
  hexToRgb,
  lightenForDark,
  normaliseReadAloudColour,
  normaliseReadAloudStrength,
  readAloudTokens,
  readAloudWashes,
  type ReadAloudTheme,
} from '../../src/renderer/src/editor/read-aloud-colours'

const tokens = readFileSync(new URL('../../src/renderer/src/styles/tokens.css', import.meta.url), 'utf8')
const THEMES: ReadAloudTheme[] = ['light', 'dark']

function tokenColour(theme: ReadAloudTheme, name: string): ReturnType<typeof hexToRgb> {
  const block = theme === 'dark' ? /\[data-theme="dark"\]\{([^}]*)\}/.exec(tokens)![1] : /:root\{([^}]*)\}/.exec(tokens)![1]
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)
  return hexToRgb(match![1])
}

test('the contrast constants are the real page and ink colours of both themes', () => {
  for (const theme of THEMES) {
    expect(READ_ALOUD_PAPER[theme]).toEqual(tokenColour(theme, '--bg-pane'))
    expect(READ_ALOUD_INK[theme]).toEqual(tokenColour(theme, '--prose-ink'))
  }
})

test('contrast: for every preset at Strong, in both themes, the editor ink on the word wash reaches 4.5:1', () => {
  for (const theme of THEMES) {
    const paper = tokenColour(theme, '--bg-pane')
    const ink = tokenColour(theme, '--prose-ink')
    for (const preset of READ_ALOUD_PRESET_IDS) {
      const washes = readAloudWashes(preset, 'strong', theme)
      // The word sits inside the sentence inside the paragraph: all three washes are stacked.
      const underParagraph = composite(washes.hue, washes.alphas.paragraph, paper)
      const underSentence = composite(washes.hue, washes.alphas.sentence, underParagraph)
      const underWord = composite(washes.hue, washes.alphas.word, underSentence)
      expect(contrastRatio(ink, underWord)).toBeGreaterThanOrEqual(READ_ALOUD_MIN_CONTRAST)
    }
  }
})

test('contrast also holds for a custom colour, however bright', () => {
  for (const theme of THEMES) {
    for (const hex of ['#ffe600', '#00ff88', '#ffffff', '#000000', '#ff0000']) {
      const washes = readAloudWashes(hex, 'strong', theme)
      const word = composite(washes.hue, washes.alphas.word, composite(washes.hue, washes.alphas.sentence, composite(washes.hue, washes.alphas.paragraph, READ_ALOUD_PAPER[theme])))
      expect(contrastRatio(READ_ALOUD_INK[theme], word)).toBeGreaterThanOrEqual(READ_ALOUD_MIN_CONTRAST)
    }
  }
})

test('light theme uses the locked design values exactly (Blue, Medium: 46,107,230 at 8% / 18% / 38%)', () => {
  const blue = readAloudWashes('blue', 'medium', 'light')
  expect(blue.hue).toEqual([46, 107, 230])
  expect(blue.alphas).toEqual({ paragraph: 0.08, sentence: 0.18, word: 0.38 })
  expect(readAloudWashes('terracotta', 'soft', 'light').alphas).toEqual({ paragraph: 0.05, sentence: 0.12, word: 0.26 })
  expect(readAloudWashes('terracotta', 'strong', 'light').alphas).toEqual({ paragraph: 0.12, sentence: 0.26, word: 0.52 })
})

test('dark theme uses the brighter dark hue; its washes keep the design order and never exceed the design alphas', () => {
  const blue = readAloudWashes('blue', 'medium', 'dark')
  expect(blue.hue).toEqual([92, 150, 255])
  const designMedium = { paragraph: 0.11, sentence: 0.24, word: 0.46 }
  expect(blue.alphas.paragraph).toBeLessThanOrEqual(designMedium.paragraph)
  expect(blue.alphas.word).toBeLessThanOrEqual(designMedium.word)
  for (const preset of READ_ALOUD_PRESET_IDS) {
    const [soft, medium, strong] = READ_ALOUD_STRENGTHS.map((strength) => readAloudWashes(preset, strength, 'dark').alphas)
    for (const level of ['paragraph', 'sentence', 'word'] as const) {
      expect(soft[level]).toBeLessThan(medium[level])
      expect(medium[level]).toBeLessThan(strong[level])
    }
    const levels = readAloudWashes(preset, 'medium', 'dark').alphas
    expect(levels.paragraph).toBeLessThan(levels.sentence)
    expect(levels.sentence).toBeLessThan(levels.word)
  }
})

test('every preset changes all three washes, and Strength scales them', () => {
  const seen = new Set<string>()
  for (const preset of READ_ALOUD_PRESET_IDS) {
    const medium = readAloudWashes(preset, 'medium', 'light')
    seen.add(medium.sentence)
    expect(readAloudWashes(preset, 'soft', 'light').word).not.toBe(medium.word)
    expect(readAloudWashes(preset, 'strong', 'light').paragraph).not.toBe(medium.paragraph)
    expect(medium.paragraph).toContain(`rgba(${READ_ALOUD_PRESETS[preset].light.join(', ')}`)
  }
  expect(seen.size).toBe(READ_ALOUD_PRESET_IDS.length)
})

test('a custom colour is used as is on light and lightened automatically for dark', () => {
  expect(readAloudWashes('#2e6be6', 'medium', 'light').hue).toEqual([46, 107, 230])
  const dark = readAloudWashes('#2e6be6', 'medium', 'dark').hue
  expect(dark).toEqual(lightenForDark([46, 107, 230]))
  // The design's hand-picked Blue pair (46,107,230 → 92,150,255) is the reference step.
  expect(Math.abs(dark[0] - 92)).toBeLessThanOrEqual(20)
  expect(Math.abs(dark[1] - 150)).toBeLessThanOrEqual(20)
  expect(Math.abs(dark[2] - 255)).toBeLessThanOrEqual(20)
})

test('stored values normalise: unknown colours and strengths fall back to Terracotta and Medium', () => {
  expect(normaliseReadAloudColour(undefined)).toBe('terracotta')
  expect(normaliseReadAloudColour('Blue')).toBe('blue')
  expect(normaliseReadAloudColour('#ABCDEF')).toBe('#abcdef')
  expect(normaliseReadAloudColour('red')).toBe('terracotta')
  expect(normaliseReadAloudColour('#fff')).toBe('terracotta')
  expect(normaliseReadAloudStrength('strong')).toBe('strong')
  expect(normaliseReadAloudStrength('loud')).toBe('medium')
})

test('the tokens the app sets are the one hue and the three washes', () => {
  const set = readAloudTokens('blue', 'strong', 'light')
  expect(Object.keys(set).sort()).toEqual(['--ra-hue', '--ra-paragraph', '--ra-sentence', '--ra-word'])
  expect(set['--ra-hue']).toBe('rgb(46 107 230)')
  expect(set['--ra-word']).toBe('rgba(46, 107, 230, 0.52)')
})

test('the choice persists across launches in the settings file, silently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-ra-colour-'))
  const path = join(dir, 'settings.json')
  const store = new SettingsStore(path)
  store.set(READ_ALOUD_COLOUR_SETTING, 'blue', 'Read-aloud highlight', { log: false })
  store.set(READ_ALOUD_STRENGTH_SETTING, 'strong', 'Highlight strength', { log: false })
  const reloaded = new SettingsStore(path)
  expect(normaliseReadAloudColour(reloaded.get(READ_ALOUD_COLOUR_SETTING))).toBe('blue')
  expect(normaliseReadAloudStrength(reloaded.get(READ_ALOUD_STRENGTH_SETTING))).toBe('strong')
  expect(JSON.parse(await readFile(path, 'utf8'))).toBeDefined()
})
