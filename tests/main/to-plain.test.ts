import { test, expect } from 'bun:test'
import { toPlain } from '../../src/shared/markdown/to-plain'
import { toNormalisedMarkdown } from '../../src/shared/markdown/to-markdown'

// ---- Plain text: prose with the markup taken off ----------------------------------------------

test('inline markup is removed and the words stay', () => {
  expect(toPlain('**bold** *italic* ~~struck~~ ==marked== `code()`\n'))
    .toBe('bold italic struck marked code()\n')
})

test('headings keep their words and lose their hashes', () => {
  expect(toPlain('# One\n\n## Two\n\nBody.\n')).toBe('One\n\nTwo\n\nBody.\n')
})

test('list bullets are kept as text', () => {
  expect(toPlain('- one\n- two\n')).toBe('• one\n• two\n')
  expect(toPlain('1. first\n2. second\n')).toBe('1. first\n2. second\n')
  expect(toPlain('5. five\n6. six\n')).toBe('5. five\n6. six\n')
})

test('a nested list is indented', () => {
  expect(toPlain('- one\n  - nested\n')).toBe('• one\n  • nested\n')
})

test('task boxes stay as characters', () => {
  expect(toPlain('- [ ] todo\n- [x] done\n')).toBe('• ☐ todo\n• ☑ done\n')
})

test('links are reduced to their label', () => {
  expect(toPlain('A [link](https://example.com) here.\n')).toBe('A link here.\n')
  expect(toPlain('Bare https://example.com here.\n')).toBe('Bare https://example.com here.\n')
})

test('images are reduced to their alt text', () => {
  expect(toPlain('![A river](pictures/river.png)\n')).toBe('A river\n')
})

test('wikilinks disappear, leaving their label', () => {
  expect(toPlain('See [[The River]] and [[x|that piece]].\n')).toBe('See The River and that piece.\n')
})

test('block quotes read as prose', () => {
  expect(toPlain('> quoted\n> lines\n')).toBe('quoted lines\n')
})

test('a code fence keeps its lines verbatim', () => {
  expect(toPlain('```js\nconst a = 1\nconst b = 2\n```\n')).toBe('const a = 1\nconst b = 2\n')
})

test('a table becomes tab-separated rows', () => {
  expect(toPlain('| Column | Another |\n| --- | --- |\n| **bold** | plain |\n'))
    .toBe('Column\tAnother\nbold\tplain\n')
})

test('footnotes are marked in the prose and listed at the end', () => {
  expect(toPlain('Prose[^1] here.\n\n[^1]: The note.\n')).toBe('Prose[1] here.\n\n[1] The note.\n')
})

test('frontmatter and comments never reach plain text', () => {
  expect(toPlain('---\nstatus: draft\n---\n\n// a post-it\nProse.\n')).toBe('Prose.\n')
})

test('Czech text and em-dashes are untouched', () => {
  expect(toPlain('Čeština — příliš žluťoučký kůň.\n')).toBe('Čeština — příliš žluťoučký kůň.\n')
})

test('an empty document is an empty string', () => {
  expect(toPlain('')).toBe('')
})

// ---- Normalised Markdown: the document's own bytes, minus what never leaves --------------------

test('frontmatter and comments are removed and nothing else changes', () => {
  const source = '---\ntitle: Stage truth\n---\n\n# Heading\n\n// a post-it\nProse with **bold** and a [link](https://x.com).\n'
  expect(toNormalisedMarkdown(source)).toBe('# Heading\n\nProse with **bold** and a [link](https://x.com).\n')
})

test('wikilinks are flattened to their label text', () => {
  expect(toNormalisedMarkdown('See [[The River]] and [[x|that piece]].\n'))
    .toBe('See The River and that piece.\n')
})

test('a wikilink inside a code fence or a code span is code and survives', () => {
  expect(toNormalisedMarkdown('```md\n[[kept]]\n```\n')).toBe('```md\n[[kept]]\n```\n')
  expect(toNormalisedMarkdown('Type `[[kept]]` to link, then [[gone]].\n'))
    .toBe('Type `[[kept]]` to link, then gone.\n')
})

test('the rest of the document is byte-faithful, including tables, footnotes and fences', () => {
  const source = [
    '# Title',
    '',
    '| a | b |',
    '| --- | ---: |',
    '| 1 | 2 |',
    '',
    '- [ ] todo',
    '',
    '```js',
    "const x = '==not a mark=='",
    '```',
    '',
    'Prose[^1] — with an em-dash and Čeština.',
    '',
    '[^1]: The note.',
    '',
  ].join('\n')
  expect(toNormalisedMarkdown(source)).toBe(source)
})

test('a document that is only frontmatter normalises to nothing', () => {
  expect(toNormalisedMarkdown('---\ntitle: x\n---\n')).toBe('')
})

test('the output always ends with exactly one newline when there is content', () => {
  expect(toNormalisedMarkdown('Prose.')).toBe('Prose.\n')
  expect(toNormalisedMarkdown('Prose.\n\n\n')).toBe('Prose.\n')
})
