/**
 * Read-aloud highlight colour: ONE colour drives the paragraph, sentence and word washes, and a
 * Strength scales the three levels. Each preset has a deeper light-theme value and a brighter
 * dark-theme value; a custom colour is lightened automatically for dark. Values are the locked design
 * (docs/design/2026-10-07-read-aloud-highlight-colours). Pure: the app applies the result to the
 * `--ra-*` tokens in app.css.
 */

export const READ_ALOUD_COLOUR_SETTING = 'readAloud.colour'
export const READ_ALOUD_STRENGTH_SETTING = 'readAloud.strength'

export type Rgb = readonly [number, number, number]
export type ReadAloudTheme = 'light' | 'dark'

export const READ_ALOUD_PRESETS = {
  terracotta: { label: 'Terracotta', light: [196, 98, 66], dark: [224, 128, 98] },
  amber: { label: 'Amber', light: [232, 170, 20], dark: [240, 185, 50] },
  green: { label: 'Green', light: [60, 160, 95], dark: [90, 190, 125] },
  blue: { label: 'Blue', light: [46, 107, 230], dark: [92, 150, 255] },
  lilac: { label: 'Lilac', light: [140, 100, 225], dark: [170, 140, 255] },
  grey: { label: 'Grey', light: [110, 110, 118], dark: [170, 170, 180] },
} as const satisfies Record<string, { label: string; light: Rgb; dark: Rgb }>

export type ReadAloudPreset = keyof typeof READ_ALOUD_PRESETS
export const READ_ALOUD_PRESET_IDS = Object.keys(READ_ALOUD_PRESETS) as ReadAloudPreset[]

export type ReadAloudStrength = 'soft' | 'medium' | 'strong'
export const READ_ALOUD_STRENGTHS: readonly ReadAloudStrength[] = ['soft', 'medium', 'strong']

/** [paragraph, sentence, word] alphas per theme. */
const STRENGTH_ALPHAS: Record<ReadAloudTheme, Record<ReadAloudStrength, readonly [number, number, number]>> = {
  light: { soft: [0.05, 0.12, 0.26], medium: [0.08, 0.18, 0.38], strong: [0.12, 0.26, 0.52] },
  dark: { soft: [0.07, 0.16, 0.32], medium: [0.11, 0.24, 0.46], strong: [0.16, 0.32, 0.6] },
}

export const DEFAULT_READ_ALOUD_COLOUR = 'terracotta'
export const DEFAULT_READ_ALOUD_STRENGTH: ReadAloudStrength = 'medium'

const HEX = /^#[0-9a-f]{6}$/i

/** A stored colour → a preset id or a lower-case #rrggbb; anything else is the default. */
export function normaliseReadAloudColour(value: unknown): ReadAloudPreset | string {
  if (typeof value !== 'string') return DEFAULT_READ_ALOUD_COLOUR
  const lower = value.trim().toLowerCase()
  if (lower in READ_ALOUD_PRESETS) return lower
  return HEX.test(lower) ? lower : DEFAULT_READ_ALOUD_COLOUR
}

export function normaliseReadAloudStrength(value: unknown): ReadAloudStrength {
  return value === 'soft' || value === 'strong' ? value : DEFAULT_READ_ALOUD_STRENGTH
}

export function isReadAloudPreset(colour: string): colour is ReadAloudPreset {
  return colour in READ_ALOUD_PRESETS
}

export function hexToRgb(hex: string): Rgb {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}

/** The design's light→dark step for a colour with no hand-picked pair (Blue: 46,107,230 → 92,150,255). */
const CUSTOM_DARK_LIGHTEN = 0.25
export function lightenForDark(rgb: Rgb): Rgb {
  return rgb.map((channel) => Math.min(255, Math.round(channel + (255 - channel) * CUSTOM_DARK_LIGHTEN))) as unknown as Rgb
}

export function readAloudHue(colour: string, theme: ReadAloudTheme): Rgb {
  const normalised = normaliseReadAloudColour(colour)
  if (isReadAloudPreset(normalised)) return READ_ALOUD_PRESETS[normalised][theme]
  const rgb = hexToRgb(normalised)
  return theme === 'dark' ? lightenForDark(rgb) : rgb
}

export type ReadAloudWashes = {
  hue: Rgb
  alphas: { paragraph: number; sentence: number; word: number }
  paragraph: string
  sentence: string
  word: string
}

const rgba = (rgb: Rgb, alpha: number): string => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`

/** WCAG contrast helpers, for the readability guarantee below. */
function channelLuminance(value: number): number {
  const unit = value / 255
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
}
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * channelLuminance(rgb[0]) + 0.7152 * channelLuminance(rgb[1]) + 0.0722 * channelLuminance(rgb[2])
}
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
export function composite(over: Rgb, alpha: number, under: Rgb): Rgb {
  return over.map((channel, index) => channel * alpha + under[index] * (1 - alpha)) as unknown as Rgb
}

/** The editor's page and prose ink per theme (tokens.css: --bg-pane and --prose-ink; a test keeps them equal). */
export const READ_ALOUD_PAPER: Record<ReadAloudTheme, Rgb> = { light: [255, 255, 255], dark: [26, 26, 30] }
export const READ_ALOUD_INK: Record<ReadAloudTheme, Rgb> = { light: [38, 38, 42], dark: [217, 217, 222] }
export const READ_ALOUD_MIN_CONTRAST = 4.5

/** The word wash's ink contrast when all three washes are stacked (paragraph, sentence, word) at `scale` of Strong. */
export function strongWordContrast(hue: Rgb, theme: ReadAloudTheme, scale: number): number {
  const [paragraph, sentence, word] = STRENGTH_ALPHAS[theme].strong
  const underParagraph = composite(hue, paragraph * scale, READ_ALOUD_PAPER[theme])
  const underSentence = composite(hue, sentence * scale, underParagraph)
  return contrastRatio(READ_ALOUD_INK[theme], composite(hue, word * scale, underSentence))
}

/**
 * Readability guarantee: 1 when the locked design values keep the ink on the word wash at 4.5:1 or
 * better at Strong (every preset on a light page does); otherwise the largest fraction of every level
 * that does. One factor scales Soft, Medium and Strong together, so their order and proportions hold.
 * The locked dark values are brighter than light ink can read through at Strong (about 2 to 3:1), so
 * dark theme is scaled; this also covers any custom colour.
 */
export function readabilityScale(hue: Rgb, theme: ReadAloudTheme): number {
  if (strongWordContrast(hue, theme, 1) >= READ_ALOUD_MIN_CONTRAST) return 1
  let low = 0
  let high = 1
  for (let step = 0; step < 24; step++) {
    const mid = (low + high) / 2
    if (strongWordContrast(hue, theme, mid) >= READ_ALOUD_MIN_CONTRAST) low = mid
    else high = mid
  }
  return low
}

/** preset (or custom hex) + strength + theme → the three wash colours. */
export function readAloudWashes(colour: string, strength: ReadAloudStrength, theme: ReadAloudTheme): ReadAloudWashes {
  const hue = readAloudHue(colour, theme)
  const scale = readabilityScale(hue, theme)
  const [paragraph, sentence, word] = STRENGTH_ALPHAS[theme][normaliseReadAloudStrength(strength)].map(
    (alpha) => Math.floor(alpha * scale * 1000) / 1000,
  )
  return {
    hue,
    alphas: { paragraph, sentence, word },
    paragraph: rgba(hue, paragraph),
    sentence: rgba(hue, sentence),
    word: rgba(hue, word),
  }
}

/** The inline custom properties the app sets on the root element (and a preview sets on its own box). */
export function readAloudTokens(colour: string, strength: ReadAloudStrength, theme: ReadAloudTheme): Record<string, string> {
  const washes = readAloudWashes(colour, strength, theme)
  return {
    '--ra-hue': `rgb(${washes.hue.join(' ')})`,
    '--ra-paragraph': washes.paragraph,
    '--ra-sentence': washes.sentence,
    '--ra-word': washes.word,
  }
}

export function applyReadAloudTokens(
  root: HTMLElement,
  colour: string,
  strength: ReadAloudStrength,
  theme: ReadAloudTheme,
): void {
  for (const [name, value] of Object.entries(readAloudTokens(colour, strength, theme))) root.style.setProperty(name, value)
}
