import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Backlog 2026-09-12: dark `--ink-3` (#71717a on #242428) measured ~3.2:1 at the 10–11.5px sizes
 * the muted labels use, under WCAG AA's 4.5:1. The token is read out of tokens.css itself, so the
 * guard fails the moment someone dims it again, and it must still sit BELOW `--ink-2` so "muted"
 * stays muted rather than collapsing into the secondary ink.
 */
const css = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'renderer', 'src', 'styles', 'tokens.css'), 'utf8')

function tokensOf(block: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const match of block.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) out[match[1]] = match[2].toLowerCase()
  return out
}

function darkBlock(): string {
  const start = css.indexOf('[data-theme="dark"]{')
  expect(start).toBeGreaterThan(-1)
  return css.slice(start, css.indexOf('}', start))
}

/** WCAG 2.x relative luminance of a #rrggbb colour. */
function relativeLuminance(hex: string): number {
  const channel = (index: number): number => {
    const c = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
}

/** WCAG contrast ratio, ≥ 1. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

test('the WCAG helper agrees with the published reference points', () => {
  expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
  expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2)
})

test('dark --ink-3 clears WCAG AA on every dark surface it is drawn on', () => {
  const dark = tokensOf(darkBlock())
  for (const surface of ['--bg-elev', '--bg-toolbar', '--bg-side', '--bg-pane', '--bg-sunk']) {
    expect(dark[surface]).toBeDefined()
    expect(contrastRatio(dark['--ink-3'], dark[surface])).toBeGreaterThanOrEqual(4.5)
  }
})

test('dark --ink-3 stays muted: dimmer than --ink-2, brighter than --ink-4', () => {
  const dark = tokensOf(darkBlock())
  expect(relativeLuminance(dark['--ink-3'])).toBeLessThan(relativeLuminance(dark['--ink-2']))
  expect(relativeLuminance(dark['--ink-3'])).toBeGreaterThan(relativeLuminance(dark['--ink-4']))
})
