import { test, expect } from 'bun:test'
import { flattenWikilinks, wikilinkRanges } from '../../src/shared/markdown/dialect'
import { toHtml } from '../../src/shared/markdown/to-html'
import { toRtf } from '../../src/shared/markdown/to-rtf'
import { toPlain } from '../../src/shared/markdown/to-plain'
import { toNormalisedMarkdown } from '../../src/shared/markdown/to-markdown'

// The disappearing-wikilink law (plan Global Constraints, PRD): `[[` and `]]` may not appear in ANY
// output, for ANY input, in every flavour — the Collection bundle's resolver is the one exception,
// and it emits an anchor, never a bracket. This file is the law's adversarial test: it renders the
// same hostile source through every flavour at once, so no emitter can be quietly exempt.
//
// THE ONE DELIBERATE BOUNDARY, stated once here and asserted at the bottom of the file: code is
// QUOTED text. A backtick span, a fenced block and an indented block keep their literal characters,
// because a code example ABOUT wikilinks must still read `[[x]]`. Everything else — prose, headings,
// table cells, link labels, alt text, raw HTML the writer typed — is the writer's words, and obeys
// the law.

const FLAVOURS: Record<string, (source: string) => string> = {
  html: (source) => toHtml(source).html,
  'html (standalone)': (source) => toHtml(source, { standalone: true }).html,
  rtf: (source) => toRtf(source),
  plain: (source) => toPlain(source),
  'normalised markdown': (source) => toNormalisedMarkdown(source),
}

/** Assert the law over every flavour at once, naming the flavour that broke it. */
function expectNoBrackets(source: string): void {
  for (const [flavour, render] of Object.entries(FLAVOURS)) {
    const output = `${flavour} → ${render(source)}`
    expect(output).not.toContain('[[')
    expect(output).not.toContain(']]')
  }
}

/** What every flavour made of a source, for the cases where the surviving TEXT matters too. */
function rendered(source: string): string[] {
  return Object.values(FLAVOURS).map((render) => render(source))
}

// ---- The law ----------------------------------------------------------------------------------

test('a nested wikilink leaves no brackets in any flavour (the Finding 1 repro)', () => {
  const source = 'See [[a|[[b]]]] end.\n'
  expectNoBrackets(source)
  // The label survives as text — the inner link is flattened in its turn, not truncated.
  for (const output of rendered(source)) expect(output).toContain('See b end.')
})

test('an unbalanced wikilink leaves no brackets in any flavour', () => {
  expectNoBrackets('An opening [[a with no close.\n')
  expectNoBrackets('A closing a]] with no open.\n')
  expectNoBrackets('Three [[[a]]] deep.\n')
  expectNoBrackets('Ragged [[a]]] and [[[b]].\n')
})

test('a wikilink inside a heading, a table cell and a link label leaves no brackets', () => {
  expectNoBrackets('# A [[Target]] in a heading\n')
  expectNoBrackets('| Column | Another |\n| --- | --- |\n| [[Target]] | [[t|labelled]] |\n')
  expectNoBrackets('A [label with [[Target]] inside](https://example.com) link.\n')
  expectNoBrackets('![alt with [[Target]] inside](picture.png)\n')
  expectNoBrackets('> Quoted [[Target]] prose.\n')
  expectNoBrackets('- A [[Target]] in a list\n- [ ] and a [[Target]] in a task\n')
})

test('a wikilink split across lines leaves no brackets in any flavour', () => {
  // The scanner is single-line, exactly like the editor's own classifier (editor/wikilinks.ts): a
  // `[[` with no `]]` before the newline is not a link. The sweep is what keeps the law anyway.
  expectNoBrackets('A wikilink broken [[across\nlines]] here.\n')
})

test('the empty and label-only wikilink forms leave no brackets in any flavour', () => {
  expectNoBrackets('Empty [[]] and [[|]] and [[ ]] links.\n')
  for (const output of rendered('Empty [[]] link.\n')) expect(output).toContain('Untitled idea')
})

test('a wikilink inside raw HTML the writer typed leaves no brackets', () => {
  expectNoBrackets('<span>[[Target]]</span>\n')
  expectNoBrackets('Inline <b>[[Target]]</b> markup.\n')
})

test('a wikilink inside a footnote definition leaves no brackets', () => {
  expectNoBrackets('Prose[^1] here.\n\n[^1]: A note about [[Target]].\n')
  expectNoBrackets('Prose ^[an inline note about [[Target]]] here.\n')
})

// ---- The one deliberate boundary: code is quoted, so a code example about wikilinks survives ----

test('code is quoted, not prose: a code span, a fenced block and an indented block keep their literal [[x]]', () => {
  for (const output of rendered('Write `[[Target]]` to link a piece.\n')) expect(output).toContain('[[Target]]')
  for (const output of rendered('```md\n[[Target]]\n```\n')) expect(output).toContain('[[Target]]')
  for (const output of rendered('Example:\n\n    [[Target]]\n')) expect(output).toContain('[[Target]]')
})

// ---- The helpers the law is built on -----------------------------------------------------------

test('wikilinkRanges scans nested brackets as one link and flattens the label in turn', () => {
  expect(wikilinkRanges('See [[a|[[b]]]] end.').map((link) => [link.from, link.to, link.target, link.label]))
    .toEqual([[4, 15, 'a', 'b']])
  // Unchanged for the ordinary forms the editor classifier defines.
  expect(wikilinkRanges('a [[Target]] b [[t#head|Label]] c [[]]').map((link) => [link.target, link.label]))
    .toEqual([['Target', 'Target'], ['t', 'Label'], ['', 'Untitled idea']])
})

test('a document made of nothing but brackets is swept in linear time, and never overflows', () => {
  // A copy runs on the writer's keystroke, so the scan must stay linear: a per-`[[` rescan to the
  // end of the line made 25,000 unclosed openers take seven seconds, and a label read recursively
  // made 20,000 nested openers throw RangeError out of the middle of a copy.
  for (const source of ['[['.repeat(25_000), '[['.repeat(20_000) + 'x' + ']]'.repeat(20_000), '[[ x\n'.repeat(20_000)]) {
    const started = performance.now()
    const out = flattenWikilinks(source)
    expect(out).not.toContain('[[')
    expect(out).not.toContain(']]')
    expect(performance.now() - started).toBeLessThan(5_000)
  }
})

test('flattenWikilinks sweeps residual brackets whatever the scanner declined to claim', () => {
  expect(flattenWikilinks('See [[The River]] and [[x|that]].')).toBe('See The River and that.')
  expect(flattenWikilinks('See [[a|[[b]]]] end.')).toBe('See b end.')
  expect(flattenWikilinks('[[a')).toBe('a')
  expect(flattenWikilinks('a]]')).toBe('a')
  expect(flattenWikilinks('[[across\nlines]]')).toBe('across\nlines')
})
