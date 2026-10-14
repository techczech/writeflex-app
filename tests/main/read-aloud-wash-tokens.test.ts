import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../../src/renderer/src/styles/app.css', import.meta.url), 'utf8')

test('the three read-aloud colours derive from one hue token, with light and dark values', () => {
  expect(css).toMatch(/:root\{[^}]*--ra-hue:rgb\(196 98 66\);/)
  for (const level of ['paragraph', 'sentence', 'word']) {
    expect(css).toMatch(new RegExp(`--ra-${level}:color-mix\\(in srgb,var\\(--ra-hue\\) var\\(--ra-${level}-strength\\),transparent\\)`))
  }
  const dark = /\[data-theme="dark"\]\{([^}]*--ra-hue[^}]*)\}/.exec(css)?.[1] ?? ''
  expect(dark).toContain('--ra-hue:')
  for (const level of ['paragraph', 'sentence', 'word']) expect(dark).toContain(`--ra-${level}-strength:`)
})

test('the washes read their colour from the tokens and pad with box-shadows, never gradients or layout padding', () => {
  const rule = (selector: string): string => new RegExp(`${selector.replace(/[.]/g, '\\.')}\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
  for (const [selector, token, em] of [['.cm-line.ra-paragraph', 'ra-paragraph', '.5em'], ['.ra-sentence', 'ra-sentence', '.3em'], ['.ra-word', 'ra-word', '.15em']] as const) {
    const body = rule(selector)
    expect(body).toContain(`var(--${token})`)
    expect(body).toContain(`box-shadow:-${em} 0 0 var(--${token}),${em} 0 0 var(--${token})`)
    expect(body).not.toMatch(/gradient|padding|margin/)
  }
})
