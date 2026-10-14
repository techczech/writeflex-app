import { expect, test } from 'bun:test'
import { externalLinksOnly } from '../../src/shared/markdown/external-links'
import { assembleDocument, type HtmlDocumentData } from '../../src/shared/markdown/html-document'
import { type Block, type Inline } from '../../src/shared/markdown/model'
import { docxBundleContent } from '../../src/shared/markdown/to-docx'
import { repairTable, serialiseTable } from '../../src/shared/object-markup'

// A spread in call position (`out.push(...items)`, `Math.max(...items)`) passes one argument per
// element and throws `RangeError: Maximum call stack size exceeded` on a long array: above about
// 125,000 elements in the app's main process (V8), above 600,000 under bun, which runs these tests
// (600,000 passes, 700,000 throws, bun 1.3.10). Document content is untrusted, so every such call on
// the export, copy and reading path is a loop. Each test here hands the function 1,000,000 elements
// and fails with that RangeError when its loop is a spread again.
//
// Not covered here, because no pure function reaches them with a million elements in test time:
// model.ts `blocks` (one widget block per embed line: reading a paragraph of N embed lines is
// quadratic before it reaches the loop, 16 s for 100,000 lines), model.ts `inlineRange` (the parts
// of one inline node), src/main/export.ts (needs a workspace on disk) and the two reader runtimes
// (they run in the exported page).

const MILLION = 1_000_000

test('Word bundle: a piece of 1,000,000 paragraphs is gathered without overflowing the stack', () => {
  const blocks = Array.from({ length: MILLION }, (): Block => ({ kind: 'paragraph', children: [{ kind: 'text', text: 'x' }] }))
  const content = docxBundleContent([{ title: 'T', document: { blocks, footnotes: [] } }])
  expect(content.children).toHaveLength(MILLION + 1) // the piece's heading, then its paragraphs
  expect(content.missingImages).toEqual([])
}, 60_000)

test('Word bundle: 1,000,000 unreadable pictures in one piece are all reported, in order', () => {
  const children = Array.from({ length: MILLION }, (_, i): Inline => ({ kind: 'image', src: `p${i}.png`, alt: '' }))
  const piece = { title: 'T', document: { blocks: [{ kind: 'paragraph', children } satisfies Block], footnotes: [] } }
  const { missingImages } = docxBundleContent([piece, piece], { images: { resolve: () => null } })
  expect(missingImages).toHaveLength(2 * MILLION)
  expect([missingImages[0], missingImages[MILLION - 1], missingImages[MILLION]]).toEqual(['p0.png', `p${MILLION - 1}.png`, 'p0.png'])
}, 60_000)

test('external links only: a refused link with 1,000,000 parts in its text is replaced by them', () => {
  const words = Array.from({ length: MILLION }, (): Inline => ({ kind: 'break' }))
  const paragraph: Block = { kind: 'paragraph', children: [{ kind: 'text', text: 'a ' }, { kind: 'link', href: 'file:///x', children: words }, { kind: 'text', text: ' z' }] }
  const read = externalLinksOnly({ blocks: [paragraph], footnotes: [] }).blocks[0]
  if (read.kind !== 'paragraph') throw new Error('not a paragraph')
  expect(read.children).toHaveLength(MILLION + 2)
  expect([read.children[0], read.children[1], read.children[MILLION], read.children[MILLION + 1]]).toEqual([{ kind: 'text', text: 'a ' }, { kind: 'break' }, { kind: 'break' }, { kind: 'text', text: ' z' }])
})

test('external links only: a refused link is replaced in place, and the links after it are still handled', () => {
  const link = (href: string, text: string): Inline => ({ kind: 'link', href, children: [{ kind: 'text', text }, { kind: 'strong', children: [{ kind: 'text', text: '!' }] }] })
  const paragraph: Block = { kind: 'paragraph', children: [{ kind: 'text', text: 'a ' }, link('file:///x', 'one'), { kind: 'text', text: ' b ' }, link('https://example.org', 'two'), link('file:///y', 'three')] }
  const read = externalLinksOnly({ blocks: [paragraph], footnotes: [] }).blocks[0]
  if (read.kind !== 'paragraph') throw new Error('not a paragraph')
  expect(read.children).toEqual([
    { kind: 'text', text: 'a ' }, { kind: 'text', text: 'one' }, { kind: 'strong', children: [{ kind: 'text', text: '!' }] }, { kind: 'text', text: ' b ' },
    link('https://example.org', 'two'), { kind: 'text', text: 'three' }, { kind: 'strong', children: [{ kind: 'text', text: '!' }] },
  ])
})

const data = (modified: number): HtmlDocumentData => ({ frontmatter: {}, outline: [], metadata: { title: 't', description: null, purpose: null, status: null, modified, words: 1 } })
const tiles = (documents: HtmlDocumentData[]): string => assembleDocument({ title: 'T', sections: [{ anchor: 'a', title: 'A', body: '<p>x</p>' }], sidebar: false, titleBlock: false, summaryTiles: true, documents })

test('HTML summary tiles: the last-modified date of 1,000,000 documents is found without overflowing the stack', () => {
  const day = 86_400_000
  const latest = Date.UTC(2031, 5, 15, 12)
  const documents = Array.from({ length: MILLION }, (_, i) => data(i === 123_456 ? latest : Date.UTC(2020, 0, 1, 12) + (i % 1000) * day))
  const html = tiles(documents)
  // the same page as a collection whose every document was modified at the latest time
  expect(html).toBe(tiles(Array.from({ length: MILLION }, () => data(latest))))
  expect(html).not.toBe(tiles(Array.from({ length: MILLION }, () => data(Date.UTC(2020, 0, 1, 12)))))
}, 60_000)

test('table text: 1,000,000 rows are repaired and written back without overflowing the stack', () => {
  const repaired = repairTable(`| h | i |\n|---|---|\n${'| y |\n'.repeat(MILLION - 1)}| a | b | c |\n`)!
  expect(repaired.cells).toHaveLength(MILLION + 1)
  expect([repaired.cells[0], repaired.cells[1], repaired.cells[MILLION]]).toEqual([['h', 'i', ''], ['y', '', ''], ['a', 'b', 'c']])
  expect(repaired.alignments).toHaveLength(3)
  const written = serialiseTable({ cells: [['h'], ...Array.from({ length: MILLION - 1 }, () => ['y']), ['a', 'b']], alignments: ['left'] })
  const lines = written.split('\n')
  expect(lines).toHaveLength(MILLION + 2)
  expect([lines[0], lines[1], lines[2], lines[MILLION + 1]]).toEqual(['| h |  |', '| :--- | :--- |', '| y |  |', '| a | b |'])
}, 60_000)

test('table text: the width is the widest row, and a table with no cells is one column wide', () => {
  expect(serialiseTable({ cells: [], alignments: [] })).toBe('|  |\n| :--- |')
  expect(serialiseTable({ cells: [['a'], ['b', 'c', 'd'], ['e', 'f']], alignments: ['right'] })).toBe('| a |  |  |\n| ---: | :--- | :--- |\n| b | c | d |\n| e | f |  |')
  expect(repairTable('| a |\n|:-:|\n| b | c |')!.cells).toEqual([['a', ''], ['b', 'c']])
})
