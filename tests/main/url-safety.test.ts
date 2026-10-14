import { test, expect } from 'bun:test'
import { safeUrl } from '../../src/shared/markdown/url-safety'
import { toHtml } from '../../src/shared/markdown/to-html'
import { toRtf } from '../../src/shared/markdown/to-rtf'

// An exported file is opened by other people, and a paste lands inside someone else's application.
// Both emitters that write a destination are measured against the SAME table of hostile URLs below
// (findings 2 and 3), so the flavours cannot drift apart again the way they already had.

/** Destinations that must never reach an output, and why each one gets past a naive scheme check. */
export const HOSTILE_URLS: Array<[label: string, url: string]> = [
  ['a plain javascript: destination', 'javascript:alert(1)'],
  ['a tab inside the scheme — browsers strip it before parsing (WHATWG)', 'java\tscript:alert(1)'],
  ['a newline inside the scheme', 'java\nscript:alert(1)'],
  ['a carriage return inside the scheme', 'java\rscript:alert(1)'],
  ['a NUL inside the scheme', 'java\u0000script:alert(1)'],
  ['leading whitespace before the scheme', '   javascript:alert(1)'],
  ['leading control characters before the scheme', '\u0001\u0002javascript:alert(1)'],
  ['mixed case', 'JaVaScRiPt:alert(1)'],
  ['vbscript', 'vbscript:msgbox(1)'],
  ['an HTML data: page', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
  ['a data: page with a tab in the scheme', 'da\tta:text/html,<script>alert(1)</script>'],
  ['blob:', 'blob:https://example.com/1234'],
  ['filesystem:', 'filesystem:https://example.com/temporary/x'],
  ['file:', 'file:///etc/passwd'],
  ['an unknown app scheme', 'x-evil-app:do-something'],
]

/** Destinations a piece of writing legitimately points at, which must survive intact. */
const HARMLESS_URLS: string[] = [
  'https://example.com/a?b=1#c',
  'http://example.com',
  'mailto:someone@example.com',
  'tel:+441865000000',
  'pictures/river.png',
  './notes/piece.md',
  '/absolute/path.png',
  '#a-fragment',
  '//cdn.example.com/logo.png',
]

// ---- The rule itself ----------------------------------------------------------------------------

test('every hostile destination is refused by the shared rule', () => {
  for (const [label, url] of HOSTILE_URLS) expect(`${label} → ${String(safeUrl(url))}`).toEndWith('null')
})

test('ordinary destinations survive the shared rule unchanged', () => {
  for (const url of HARMLESS_URLS) expect(safeUrl(url)).toBe(url)
})

test('a data: PICTURE is allowed for an image and refused for a link', () => {
  const picture = 'data:image/png;base64,AAAA'
  expect(safeUrl(picture, 'image')).toBe(picture)
  expect(safeUrl(picture, 'link')).toBeNull()
  // Still a picture only: an HTML page dressed as one is refused in both uses.
  expect(safeUrl('data:text/html,<script>alert(1)</script>', 'image')).toBeNull()
  expect(safeUrl('data:image/svg+xml;base64,AAAA', 'image')).toBe('data:image/svg+xml;base64,AAAA')
})

test('mailto: and tel: are links, not image sources', () => {
  expect(safeUrl('mailto:someone@example.com', 'image')).toBeNull()
  expect(safeUrl('https://example.com/river.png', 'image')).toBe('https://example.com/river.png')
})

test('a destination that is only whitespace or controls is nothing at all', () => {
  expect(safeUrl('   ')).toBeNull()
  expect(safeUrl('\t\r\n')).toBeNull()
  expect(safeUrl('')).toBeNull()
})

// ---- The HTML emitter (finding 2) ---------------------------------------------------------------

test('HTML: no hostile destination reaches an href, and the label survives as words', () => {
  for (const [label, url] of HOSTILE_URLS) {
    const { html } = toHtml(`[click me](<${url.replace(/\n/g, '')}>)\n`)
    expect(`${label} → ${html}`).not.toContain('href=')
    expect(html).toContain('click me')
  }
})

test('HTML: the angle-bracket tab bypass emits no href (the Finding 2 repro)', () => {
  const { html } = toHtml('[click me](<java\tscript:alert(1)>)\n')
  expect(html).not.toContain('href=')
  expect(html).not.toContain('script:')
  expect(html).toContain('click me')
})

test('HTML: no hostile destination reaches an image src, and the alt text survives', () => {
  for (const [label, url] of HOSTILE_URLS) {
    const { html } = toHtml(`![a river](<${url.replace(/\n/g, '')}>)\n`)
    expect(`${label} → ${html}`).not.toContain('<img')
    expect(html).toContain('a river')
  }
})

test('HTML: a resolver that hands back a hostile src is refused too', () => {
  // The resolver runs in the main process and reads the disk; its answer is checked like any other.
  const result = toHtml('![a river](river.png)\n', { images: { resolve: () => 'javascript:alert(1)' } })
  expect(result.html).not.toContain('<img')
  expect(result.html).toContain('a river')
})

// ---- The RTF emitter (finding 3) ----------------------------------------------------------------

test('RTF: no hostile destination reaches a HYPERLINK field, and the label survives as words', () => {
  for (const [label, url] of HOSTILE_URLS) {
    const rtf = toRtf(`[click me](<${url.replace(/\n/g, '')}>)\n`)
    expect(`${label} → ${rtf}`).not.toContain('HYPERLINK')
    expect(rtf).toContain('click me')
  }
})

test('RTF: a javascript: destination writes no field at all (the Finding 3 repro)', () => {
  const rtf = toRtf('[click me](javascript:alert(1))\n')
  expect(rtf).not.toContain('HYPERLINK')
  expect(rtf).not.toContain('javascript:')
  expect(rtf).toContain('click me')
})

test('RTF: ordinary destinations still become hyperlink fields', () => {
  expect(toRtf('A [link](https://example.com) here.\n'))
    .toContain('{\\field{\\*\\fldinst{HYPERLINK "https://example.com"}}{\\fldrslt{\\cf2\\ul link}}}')
  expect(toRtf('Write to [me](mailto:someone@example.com).\n')).toContain('HYPERLINK "mailto:someone@example.com"')
})

// ---- The two flavours agree, row by row ----------------------------------------------------------

test('HTML and RTF refuse and accept exactly the same destinations — one rule, not two', () => {
  const rows: Array<[label: string, url: string, allowed: boolean]> = [
    ...HOSTILE_URLS.map(([label, url]): [string, string, boolean] => [label, url, false]),
    ...HARMLESS_URLS.map((url): [string, string, boolean] => [url, url, true]),
  ]
  for (const [label, url, allowed] of rows) {
    const source = `[click me](<${url.replace(/\n/g, '')}>)\n`
    expect(`${label} → html linked: ${toHtml(source).html.includes('href=')}`).toBe(`${label} → html linked: ${allowed}`)
    expect(`${label} → rtf linked: ${toRtf(source).includes('HYPERLINK')}`).toBe(`${label} → rtf linked: ${allowed}`)
  }
})
