import { expect, test } from 'bun:test'
import JSZip from 'jszip'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { clipboardPayload } from '../../src/main/clipboard'
import { NoteMarkdown } from '../../src/renderer/src/components/NoteMarkdown'
import { externalLinksOnly } from '../../src/shared/markdown/external-links'
import { eachInline, readDocument, type Block, type Inline } from '../../src/shared/markdown/model'
import { toDocx } from '../../src/shared/markdown/to-docx'
import { toHtml } from '../../src/shared/markdown/to-html'
import { toPlain } from '../../src/shared/markdown/to-plain'
import { toRtf } from '../../src/shared/markdown/to-rtf'

// The bound on table padding (src/shared/markdown/model.ts, tableWidthIfAtMostDoubled). A table is
// padded to a rectangle only while that adds at most as many empty cells as the writer typed, so a
// table's model never holds more than twice the cells typed, for any table and any number of tables.
// A table that would grow more is read exactly as written, ragged, so one long row over many short
// ones cannot turn 3N characters into N x N cells, and every output format takes the ragged table.

type Table = Extract<Block, { kind: 'table' }>
function table(markdown: string): Table {
  const found = readDocument(markdown).blocks.find((block): block is Table => block.kind === 'table')
  if (!found) throw new Error('not read as a table')
  return found
}
const cellText = (cell: Inline[]): string => cell.map((part): string =>
  part.kind === 'text' ? part.text : 'children' in part ? cellText(part.children) : `<${part.kind}>`).join('')
const cellCount = (read: Table): number => read.rows.reduce((sum, row) => sum + row.length, read.header.length)
const texts = (read: Table): string[] => [read.header, ...read.rows].flatMap((row) => row.map(cellText)).filter((text) => text !== '')
const timed = <T>(read: () => T): { value: T; ms: number } => { const start = performance.now(); const value = read(); return { value, ms: Math.round(performance.now() - start) } }
const line = (cells: string[]): string => `| ${cells.join(' | ')} |\n`

const N = 20_000
/** One header cell, one row of `wide` cells, then `short` rows of one cell: about 3N characters for N x N padded cells. */
const wideRow = (wide: number, short: number): string =>
  `| h |\n|---|\n${line(Array.from({ length: wide }, (_, j) => `w${j}`))}${Array.from({ length: short }, (_, i) => `| s${i} |\n`).join('')}`
/** A header of `wide` cells over `short` rows of one cell. */
const wideHeader = (wide: number, short: number): string =>
  `${line(Array.from({ length: wide }, (_, j) => `h${j}`))}|${'---|'.repeat(wide)}\n${Array.from({ length: short }, (_, i) => `| s${i} |\n`).join('')}`

test('one 20,000-cell row over 20,000 one-cell rows is read as typed, not as 400 million cells', () => {
  const { value: read, ms } = timed(() => table(wideRow(N, N)))
  console.log('wide row over short rows, N = 20,000: ms to read', ms)
  expect(ms).toBeLessThan(3000)
  expect(cellCount(read)).toBe(1 + N + N) // exactly the cells typed
  expect(read.header).toHaveLength(1)
  expect(read.rows).toHaveLength(N + 1)
  expect(read.rows[0]).toHaveLength(N)
  expect(read.rows[1]).toHaveLength(1)
  expect(read.alignments).toEqual([null]) // as read: one delimiter cell
})

test('a 20,000-cell header over 20,000 one-cell rows is read as typed', () => {
  const { value: read, ms } = timed(() => table(wideHeader(N, N)))
  console.log('wide header over short rows, N = 20,000: ms to read', ms)
  expect(ms).toBeLessThan(3000)
  expect(cellCount(read)).toBe(N + N)
  expect(read.header).toHaveLength(N)
  expect(read.rows).toHaveLength(N)
  expect(read.rows.every((row) => row.length === 1)).toBe(true)
  expect(read.alignments).toHaveLength(N)
})

test('a one-column table of 300,000 rows is read without overflowing the stack, and RTF writes it', () => {
  const tall = `| h |\n|---|\n${'| y |\n'.repeat(300_000)}`
  const { value: read, ms } = timed(() => table(tall))
  console.log('300,000 one-cell rows: ms to read', ms)
  expect(read.rows).toHaveLength(300_000)
  expect(cellCount(read)).toBe(300_001)
  // to-rtf.ts found its widest row with the same spread
  expect(toRtf(tall).split('\\row').length - 1).toBe(300_001)
}, 30_000)

// The app's main process (V8) overflows its stack on a spread of about 125,000 arguments; bun, which
// runs these tests, only above 600,000. A million rows is past both, so this test fails under bun
// when the width is found with a spread again, in the reader or in the RTF emitter.
test('a one-column table of 1,000,000 rows is read and written as RTF without overflowing the stack', () => {
  const tall = `| h |\n|---|\n${'| y |\n'.repeat(1_000_000)}`
  const { value: read, ms } = timed(() => table(tall))
  console.log('1,000,000 one-cell rows: ms to read', ms)
  expect(read.rows).toHaveLength(1_000_000)
  expect(read.rows.every((row) => row.length === 1)).toBe(true)
  expect(toRtf(tall).length).toBeGreaterThan(100_000_000)
}, 60_000)

test('an ordinary table with a few short rows is still padded to a rectangle', () => {
  const read = table('| A | B | C |\n|:--|:-:|--:|\n| 1 |\n| 1 | 2 | 3 | 4 |\n|\n')
  expect([read.header, ...read.rows].map((row) => row.map(cellText))).toEqual([['A', 'B', 'C', ''], ['1', '', '', ''], ['1', '2', '3', '4'], ['', '', '', '']])
  expect(read.alignments).toEqual(['left', 'centre', 'right', null])
})

/** A header of `wide` cells, `full` rows of `wide` cells, then `short` rows of one cell. */
const fullThenShort = (wide: number, full: number, short: number): string => {
  const header = Array.from({ length: wide }, (_, j) => `h${j}`)
  return `${line(header)}|${'---|'.repeat(wide)}\n${Array.from({ length: full }, (_, i) => line(header.map((_, j) => `f${i}.${j}`))).join('')}${Array.from({ length: short }, (_, i) => `| s${i} |\n`).join('')}`
}
const widths = (read: Table): number[] => [read.header.length, ...read.rows.map((row) => row.length)]

test('the bound: padding that adds exactly as many cells as were typed is done; one cell more is left as written', () => {
  // header of 10, three rows of 10, then m rows of 1 cell: typed = 40 + m, a rectangle adds 9m.
  const typed = (short: number) => 40 + short
  const added = (short: number) => 9 * short
  expect(added(5)).toBe(typed(5))
  expect(added(6)).toBe(typed(6) + 8) // the next table this shape can make; one cell over is a row of 9 below

  const under = table(fullThenShort(10, 3, 5))
  expect(widths(under)).toEqual(Array<number>(9).fill(10))
  expect(cellCount(under)).toBe(2 * typed(5)) // exactly doubled, never more
  expect(under.rows[3].map(cellText)).toEqual(['s0', '', '', '', '', '', '', '', '', ''])

  const over = table(fullThenShort(10, 3, 6))
  expect(widths(over)).toEqual([10, 10, 10, 10, 1, 1, 1, 1, 1, 1])
  expect(cellCount(over)).toBe(typed(6))
  expect(over.alignments).toHaveLength(10)

  // exactly one cell over: header of 4 and a row of 4 (8 typed, +8 for two empty rows) against
  // header of 4 and a row of 3 (7 typed, +9).
  expect(widths(table('| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |\n|\n|\n'))).toEqual([4, 4, 4, 4])
  expect(widths(table('| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 |\n|\n|\n'))).toEqual([4, 3, 0, 0])
})

test('a short table with a few missing trailing cells is padded; one whose rows are mostly far shorter than its header is left as written', () => {
  const header = ['A', 'B', 'C', 'D', 'E', 'F']
  const rule = `|${'---|'.repeat(6)}\n`
  // header of 6, ten rows, three of them with 4 cells: 60 typed, 6 to add.
  const fewShort = table(`${line(header)}${rule}${Array.from({ length: 10 }, (_, i) => line(header.slice(0, i % 4 === 1 ? 4 : 6).map((name) => `${name}${i}`))).join('')}`)
  expect(widths(fewShort)).toEqual(Array<number>(11).fill(6))
  expect(fewShort.rows[1].map(cellText)).toEqual(['A1', 'B1', 'C1', 'D1', '', ''])
  expect(cellCount(fewShort)).toBe(66)
  // header of 6, ten rows of 1 cell: 16 typed, 50 to add. Left as written: this is the cost of the rule.
  const mostlyShort = table(`${line(header)}${rule}${Array.from({ length: 10 }, (_, i) => `| r${i} |\n`).join('')}`)
  expect(widths(mostlyShort)).toEqual([6, ...Array<number>(10).fill(1)])
  expect(texts(mostlyShort)).toEqual([...header, ...Array.from({ length: 10 }, (_, i) => `r${i}`)])
})

test('2,000 small tables: the padding of one table is not an allowance that a document of many multiplies', () => {
  // A header of 32 cells over 32 one-cell rows is about 260 characters and 64 cells; a rectangle
  // would be 1,056. With a fixed allowance per table every copy gained 992 empty cells.
  const one = `${'|a'.repeat(32)}|\n${'|-'.repeat(32)}|\n${'|a|\n'.repeat(32)}`
  expect(one.length).toBeLessThan(300)
  expect([table(one).header.length, table(one).rows.length]).toEqual([32, 32])
  const { value: document, ms } = timed(() => readDocument(`${one}\n`.repeat(2000)))
  const tables = document.blocks.filter((block): block is Table => block.kind === 'table')
  const typed = 2000 * 64
  const cells = tables.reduce((sum, read) => sum + cellCount(read), 0)
  console.log('2,000 tables of 32 x 32: ms to read', ms, 'cells', cells, 'typed', typed)
  expect(tables).toHaveLength(2000)
  expect(ms).toBeLessThan(3000)
  expect(cells).toBeLessThanOrEqual(2 * typed)
  expect(cells).toBe(typed) // each is left as written
  // and the HTML written from it has one cell element per typed cell, none added
  expect(toHtml(`${one}\n`.repeat(2000)).html.match(/<t[dh][ >]/g)).toHaveLength(typed)
})

test('no typed cell is missing in either branch, and an empty cell between two delimiters is a cell in both', () => {
  for (const short of [5, 6]) {
    const written = [...Array.from({ length: 10 }, (_, j) => `h${j}`), ...Array.from({ length: 30 }, (_, k) => `f${Math.floor(k / 10)}.${k % 10}`), ...Array.from({ length: short }, (_, i) => `s${i}`)]
    expect(texts(table(fullThenShort(10, 3, short)))).toEqual(written)
  }
  // an empty cell counts as typed: header 1, a row of `wide`, then `| a | | c |` and `| | |`
  const gaps = (wide: number) => `| h |\n|---|\n${line(Array.from({ length: wide }, (_, j) => `w${j}`))}| a | | c |\n| | |\n`
  const padded = table(gaps(4)) // 10 typed, 6 to add
  expect(padded.rows[1].map(cellText)).toEqual(['a', '', 'c', ''])
  expect(padded.rows[2]).toHaveLength(4)
  expect(padded.header).toHaveLength(4)
  const ragged = table(gaps(300)) // 306 typed, 894 to add
  expect(ragged.rows[1].map(cellText)).toEqual(['a', '', 'c'])
  expect(ragged.rows[2].map(cellText)).toEqual(['', ''])
  expect(ragged.header).toHaveLength(1)
})

/* ---- every consumer takes a ragged table that was left as written ---- */

// 300 cells in one row over 300 one-cell rows, then a row holding a pipe alone (no cell at all):
// 601 cells typed, 90,000 to pad, so it is over the bound.
const WIDE = 300
const RAGGED = `${wideRow(WIDE, WIDE)}|\n`
const RAGGED_TYPED = 1 + WIDE + WIDE
const RAGGED_ROWS = 1 + 1 + WIDE + 1 // header, the wide row, the short rows, the empty row

test('the ragged fixture is over the bound and holds a row with no cell', () => {
  const read = table(RAGGED)
  expect(cellCount(read)).toBe(RAGGED_TYPED)
  expect(read.rows.at(-1)).toEqual([])
})

test('HTML: a ragged table is written row by row with the cells each row has', () => {
  const { html } = toHtml(RAGGED, { tableRegions: true })
  const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((row) => [...row[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/g)].map((cell) => cell[1]))
  expect(rows.map((row) => row.length)).toEqual([1, WIDE, ...Array<number>(WIDE).fill(1), 0])
  expect(rows[1][WIDE - 1]).toBe(`w${WIDE - 1}`)
  expect(rows[WIDE + 1]).toEqual([`s${WIDE - 1}`])
})

test('plain text: a ragged table is one line per row', () => {
  const lines = toPlain(RAGGED).split('\n')
  expect(lines.slice(0, RAGGED_ROWS).map((text) => text === '' ? 0 : text.split('\t').length)).toEqual([1, WIDE, ...Array<number>(WIDE).fill(1), 0])
  expect(lines[1].endsWith(`\tw${WIDE - 1}`)).toBe(true)
})

test('RTF: a ragged table is not padded again, every row has its own cells, and a row with none has one', () => {
  const rtf = toRtf(RAGGED)
  const rows = rtf.split('\\row').slice(0, -1)
  const cells = rows.map((row) => [...row.matchAll(/\\pard\\intbl\\fs\d+ (.*?)\\cell(?!x)/g)].map((cell) => cell[1]))
  expect(cells.map((row) => row.length)).toEqual([1, WIDE, ...Array<number>(WIDE).fill(1), 1])
  // each row is defined with as many cell boundaries as it has cells
  expect(rows.map((row) => row.match(/\\cellx\d+/g)?.length)).toEqual(cells.map((row) => row.length))
  expect(cells[1][WIDE - 1]).toBe(`w${WIDE - 1}`)
  expect(cells.at(-1)).toEqual([''])
  // every cell is the same width, the page divided by the widest row, so the columns line up
  expect(rows[1].match(/\\cellx\d+/g)!.slice(0, 2)).toEqual(['\\cellx31', '\\cellx62'])
  expect(rows[2].match(/\\cellx\d+/g)).toEqual(['\\cellx31'])
})

test('RTF: the 20,000-cell row over 20,000 short rows is written at the size it was typed', () => {
  const { value: rtf, ms } = timed(() => toRtf(wideRow(N, N)))
  console.log('RTF of the wide row over short rows, N = 20,000: ms', ms, 'characters', rtf.length)
  expect(ms).toBeLessThan(5000)
  expect(rtf.length).toBeLessThan(20_000_000)
})

test('Word: a ragged table makes a file whose every row has a cell and every cell a paragraph', async () => {
  const zip = await JSZip.loadAsync((await toDocx(RAGGED)).buffer)
  const xml = await zip.file('word/document.xml')!.async('string')
  const rows = [...xml.matchAll(/<w:tr>.*?<\/w:tr>|<w:tr [^>]*>.*?<\/w:tr>/gs)].map((row) => [...row[0].matchAll(/<w:tc>(.*?)<\/w:tc>/gs)].map((cell) => cell[1]))
  expect(rows.map((row) => row.length)).toEqual([1, WIDE, ...Array<number>(WIDE).fill(1), 1])
  expect(rows.flat().every((cell) => cell.includes('<w:p>') || cell.includes('<w:p '))).toBe(true)
  expect(xml).toContain(`w${WIDE - 1}`)
})

test('clipboard: every kind of copy takes a ragged table', async () => {
  const rich = (await clipboardPayload(RAGGED, 'rich')).payload
  expect(rich.html).toBe(toHtml(RAGGED, { images: 'omit' }).html)
  expect(rich.rtf).toBe(toRtf(RAGGED))
  expect(rich.text).toBe(toPlain(RAGGED))
  expect((await clipboardPayload(RAGGED, 'plain')).payload.text).toBe(toPlain(RAGGED))
  expect((await clipboardPayload(RAGGED, 'markdown')).payload.text).toBe(RAGGED)
})

test('an agent note draws a ragged table with the cells each row has', () => {
  const html = renderToStaticMarkup(createElement(NoteMarkdown, { text: RAGGED }))
  const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((row) => row[1].match(/<t[dh][ >]/g)?.length ?? 0)
  expect(rows).toEqual([1, WIDE, ...Array<number>(WIDE).fill(1), 0])
  expect(html).toContain(`w${WIDE - 1}`)
})

test('the walkers over a model pass through a ragged table', () => {
  const document = readDocument(RAGGED)
  const flattened = externalLinksOnly(document).blocks[0]
  expect(flattened.kind === 'table' ? cellCount(flattened) : null).toBe(RAGGED_TYPED)
  let seen = 0
  eachInline(document.blocks, () => { seen += 1 })
  expect(seen).toBe(RAGGED_TYPED)
})
