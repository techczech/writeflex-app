import { test, expect } from 'bun:test'
import { toRtf } from '../../src/shared/markdown/to-rtf'

// RTF is the flavour Word, Teams and Outlook treat as authoritative, which is why HTML alone loses
// the paste. It cannot be checked by opening it, so it is checked structurally: a well-formed
// document, balanced braces, the right control words in the right places, and — the case that has
// broken every hand-rolled RTF writer — non-ASCII surviving as `\uN?`.

/** Every brace in the output is matched, and none of them came from unescaped writer text. */
function balanced(rtf: string): boolean {
  let depth = 0
  for (let index = 0; index < rtf.length; index += 1) {
    if (rtf[index] === '\\') { index += 1; continue } // an escaped character is never structure
    if (rtf[index] === '{') depth += 1
    if (rtf[index] === '}') { depth -= 1; if (depth < 0) return false }
  }
  return depth === 0
}

test('the output is a complete RTF document', () => {
  const rtf = toRtf('# Title\n\nProse.\n')
  expect(rtf.startsWith('{\\rtf1\\ansi')).toBe(true)
  expect(rtf.endsWith('}')).toBe(true)
  expect(rtf).toContain('\\fonttbl')
  expect(rtf).toContain('\\colortbl')
  expect(rtf).toContain('\\par')
  expect(balanced(rtf)).toBe(true)
})

test('headings are sized, bold paragraphs', () => {
  const rtf = toRtf('# One\n\n## Two\n\nBody.\n')
  expect(rtf).toContain('{\\b\\fs36 One}\\par')
  expect(rtf).toContain('{\\b\\fs32 Two}\\par')
  expect(rtf).toContain('Body.\\par')
})

test('bold, italic, strikethrough, marks and code carry their own runs', () => {
  const rtf = toRtf('**bold** *italic* ~~struck~~ ==marked== `code()`\n')
  expect(rtf).toContain('{\\b bold}')
  expect(rtf).toContain('{\\i italic}')
  expect(rtf).toContain('{\\strike struck}')
  expect(rtf).toContain('\\highlight4 marked')
  expect(rtf).toContain('{\\f1 code()}')
  expect(balanced(rtf)).toBe(true)
})

test('unordered and ordered lists carry a marker and a hanging indent', () => {
  const rtf = toRtf('- one\n- two\n\n1. first\n2. second\n')
  expect(rtf).toContain('\\fi-360\\li720')
  // Markers are literal characters against a hanging indent, so every reader shows them.
  expect(rtf).toContain('\\u8226?\\tab ')
  expect(rtf).toContain('1.\\tab ')
  expect(rtf).toContain('2.\\tab ')
  expect(rtf).toContain('one\\par')
  expect(balanced(rtf)).toBe(true)
})

test('a nested list indents one level further', () => {
  const rtf = toRtf('- one\n  - nested\n')
  expect(rtf).toContain('\\li720')
  expect(rtf).toContain('\\li1440')
})

test('task boxes travel as characters, so they survive any paste', () => {
  const rtf = toRtf('- [ ] todo\n- [x] done\n')
  expect(rtf).toContain('\\u9744?')  // ☐
  expect(rtf).toContain('\\u9745?')  // ☑
})

test('block quotes are indented paragraphs', () => {
  const rtf = toRtf('> quoted\n')
  expect(rtf).toContain('\\li720')
  expect(rtf).toContain('quoted\\par')
})

test('code blocks are a monospace run, line by line', () => {
  const rtf = toRtf('```js\nconst a = 1\nconst b = 2\n```\n')
  expect(rtf).toContain('\\f1')
  expect(rtf).toContain('const a = 1')
  expect(rtf).toContain('const b = 2')
  expect(balanced(rtf)).toBe(true)
})

test('links are hyperlink fields', () => {
  const rtf = toRtf('A [link](https://example.com) here.\n')
  expect(rtf).toContain('{\\field{\\*\\fldinst{HYPERLINK "https://example.com"}}{\\fldrslt{\\cf2\\ul link}}}')
  expect(balanced(rtf)).toBe(true)
})

test('tables are real RTF rows with borders', () => {
  const rtf = toRtf('| Column | Another |\n| --- | --- |\n| **bold** | plain |\n')
  expect(rtf).toContain('\\trowd')
  expect(rtf).toContain('\\clbrdrt\\brdrs')
  expect(rtf).toContain('\\cellx')
  expect(rtf).toContain('\\intbl')
  expect(rtf).toContain('\\row')
  expect(rtf).toContain('{\\b bold}')
  expect(balanced(rtf)).toBe(true)
})

test('footnotes travel to the end, numbered, with the marks superscript', () => {
  const rtf = toRtf('Prose[^1] here.\n\n[^1]: The note.\n')
  expect(rtf).toContain('{\\super 1}')
  expect(rtf).toContain('The note.')
  expect(rtf.indexOf('{\\super 1}')).toBeLessThan(rtf.indexOf('The note.'))
  expect(balanced(rtf)).toBe(true)
})

test('a footnote referenced twice is one note carrying both marks', () => {
  const rtf = toRtf('First[^a] and again[^a].\n\n[^a]: Once only.\n')
  // Two marks in the prose, and one more numbering the single note at the end.
  expect([...rtf.matchAll(/\{\\super 1\}/g)]).toHaveLength(3)
  expect([...rtf.matchAll(/Once only\./g)]).toHaveLength(1)
})

// ---- The case that breaks hand-rolled RTF ------------------------------------------------------

test('non-ASCII survives as \\uN? escapes — Czech and em-dashes', () => {
  const rtf = toRtf('Čeština — příliš žluťoučký kůň.\n')
  expect(rtf).toContain('\\u268?')   // Č
  expect(rtf).toContain('\\u8212?')  // —
  expect(rtf).toContain('\\u382?')   // ž
  expect(rtf).toContain('\\u367?')   // ů
  // Nothing non-ASCII may reach the output as a raw byte.
  expect(/[^\x00-\x7f]/.test(rtf)).toBe(false)
  expect(balanced(rtf)).toBe(true)
})

test('an astral character escapes as its surrogate pair', () => {
  const rtf = toRtf('A 😀 face.\n')
  expect(rtf).toContain('\\u-10179?\\u-8704?') // U+1F600 as signed UTF-16 units
  expect(/[^\x00-\x7f]/.test(rtf)).toBe(false)
})

test('RTF structural characters in the writer text are escaped, not structure', () => {
  const rtf = toRtf('A \\backslash, a {brace} and a }close{.\n')
  expect(rtf).toContain('\\\\backslash')
  expect(rtf).toContain('\\{brace\\}')
  expect(balanced(rtf)).toBe(true)
})

// ---- The laws ----------------------------------------------------------------------------------

test('wikilinks disappear, leaving their label text', () => {
  const rtf = toRtf('See [[The River]] and [[x|that piece]].\n')
  expect(rtf).toContain('See The River and that piece.')
  expect(rtf).not.toContain('[[')
  expect(rtf).not.toContain('HYPERLINK')
})

test('a resolver may promote a wikilink to an internal link; declining leaves text', () => {
  const rtf = toRtf('Inside [[here]], outside [[elsewhere]].\n', {
    wikilinks: { resolve: (target) => (target === 'here' ? 'piece-1' : null) },
  })
  expect(rtf).toContain('HYPERLINK \\\\l "piece-1"')
  expect(rtf).toContain('outside elsewhere')
  expect(balanced(rtf)).toBe(true)
})

test('frontmatter and comments never reach the RTF', () => {
  const rtf = toRtf('---\nstatus: draft\n---\n\n// a post-it\nProse.\n')
  expect(rtf).not.toContain('draft')
  expect(rtf).not.toContain('post-it')
  expect(rtf).toContain('Prose.')
})

test('an image travels as its alt text — RTF in a clipboard cannot host a file', () => {
  const rtf = toRtf('![A river](pictures/river.png)\n')
  expect(rtf).toContain('A river')
  expect(rtf).not.toContain('river.png')
})

test('an empty document is still a valid RTF document', () => {
  const rtf = toRtf('')
  expect(rtf.startsWith('{\\rtf1\\ansi')).toBe(true)
  expect(balanced(rtf)).toBe(true)
})

// ---- The round-trip: does a real RTF engine accept it? -----------------------------------------
// `textutil` is the AppKit text engine behind TextEdit, Mail and Notes. Converting back to text
// proves the document parses and that the writer's characters survived — the "opens in TextEdit"
// check, asserted structurally rather than by opening anything.

test('a real RTF engine parses the document and keeps the writer characters', async () => {
  const rtf = toRtf([
    '# Nadpis',
    '',
    'Prose with **bold**, ==marked== and a [link](https://example.com).',
    'Čeština — příliš žluťoučký kůň.',
    '',
    '> A quote.',
    '',
    '- one',
    '  - nested',
    '',
    '1. first',
    '',
    '- [x] done',
    '',
    '| Column | Another |',
    '| --- | --- |',
    '| cell | plain |',
    '',
    'A note[^1].',
    '',
    '[^1]: The note itself.',
    '',
  ].join('\n'))
  const path = `${process.env.TMPDIR ?? '/tmp'}/writeflex-rtf-roundtrip-${process.pid}.rtf`
  await Bun.write(path, rtf)
  const converted = Bun.spawnSync(['textutil', '-convert', 'txt', '-stdout', path])
  if (converted.exitCode !== 0) throw new Error(`textutil refused the document: ${converted.stderr.toString()}`)
  const text = converted.stdout.toString()
  expect(text).toContain('Nadpis')
  expect(text).toContain('Čeština — příliš žluťoučký kůň.')
  expect(text).toContain('bold')
  expect(text).toContain('A quote.')
  expect(text).toContain('•\tone')
  expect(text).toContain('1.\tfirst')
  expect(text).toContain('☑ done')
  expect(text).toContain('cell')
  expect(text).toContain('The note itself.')
})
