/**
 * The fixed line: one vertical position, as a fraction of the editor's visible height, where
 * read-aloud and typewriter mode both keep the active line. Pure maths and the live value; the
 * persisted setting is `editor.fixedLine`.
 */

export const FIXED_LINE_SETTING = 'editor.fixedLine'
export const FIXED_LINE_MIN = 0.1
export const FIXED_LINE_MAX = 0.9
/** Keyboard step on the marker (↑/↓), 2% of the visible height. */
export const FIXED_LINE_STEP = 0.02

export const FIXED_LINE_PRESETS = {
  top: 0.33,
  middle: 0.5,
  lower: 0.67,
} as const

export type FixedLinePreset = keyof typeof FIXED_LINE_PRESETS | 'custom'

export const FIXED_LINE_DEFAULT: number = FIXED_LINE_PRESETS.top

export const FIXED_LINE_PRESET_LABELS: Record<keyof typeof FIXED_LINE_PRESETS, string> = {
  top: 'Top third',
  middle: 'Middle',
  lower: 'Lower third',
}

function clampFraction(value: number): number {
  return Math.round(Math.max(FIXED_LINE_MIN, Math.min(FIXED_LINE_MAX, value)) * 1000) / 1000
}

/** Any stored value → a usable fraction. Unset or unreadable falls back to Top third. */
export function normaliseFixedLine(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(numeric)) return FIXED_LINE_DEFAULT
  return clampFraction(numeric)
}

/** Which preset the fraction is (within half a percent), else 'custom'. */
export function fixedLinePreset(fraction: number): FixedLinePreset {
  for (const [name, value] of Object.entries(FIXED_LINE_PRESETS)) {
    if (Math.abs(fraction - value) < 0.005) return name as keyof typeof FIXED_LINE_PRESETS
  }
  return 'custom'
}

/** "Custom 31%" — the label the Settings control shows while the marker sits off a preset. */
export function fixedLineCustomLabel(fraction: number): string {
  return `Custom ${Math.round(fraction * 100)}%`
}

/**
 * Fraction → the `yMargin` for a `y:'start'` scroll: the line's top is placed this many px below
 * the scroller's top. Shared by read-aloud's typewriter scroll and typewriter mode.
 */
export function fixedLineMargin(fraction: number, viewportHeight: number): number {
  return Math.max(0, Math.round(normaliseFixedLine(fraction) * Math.max(0, viewportHeight)))
}

/** Pointer position → fraction of the scroller's visible height, clamped to the allowed range. */
export function fixedLineFromPointer(clientY: number, scrollerTop: number, scrollerHeight: number): number {
  if (scrollerHeight <= 0) return FIXED_LINE_DEFAULT
  return clampFraction((clientY - scrollerTop) / scrollerHeight)
}

/** One keyboard step up (-1) or down (+1); stays on the 2% grid and inside the allowed range. */
export function nudgeFixedLine(fraction: number, direction: 1 | -1, step?: number): number {
  // A custom step (one visual line, for Line focus and Ruler) is not snapped to the 2% grid.
  if (step !== undefined && step > 0) return clampFraction(fraction + direction * step)
  return clampFraction(Math.round((fraction + direction * FIXED_LINE_STEP) * 100) / 100)
}

let liveFixedLine = FIXED_LINE_DEFAULT

/** The live value the editor reads at scroll time (typewriter mode has no React props of its own). */
export function getFixedLine(): number {
  return liveFixedLine
}

export function setLiveFixedLine(fraction: number): void {
  liveFixedLine = normaliseFixedLine(fraction)
}
