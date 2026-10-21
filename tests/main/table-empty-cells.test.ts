import { expect, test } from 'bun:test'
// jszip is the zip library `docx` itself packs with; reading the package back is the honest check.
import JSZip from 'jszip'
import { clipboardPayload } from '../../src/main/clipboard'
import { externalLinksOnly } from '../../src/shared/markdown/external-links'
import { eachInline, readDocument, type Block, type Inline } from '../../src/shared/markdown/model'
import { toDocx } from '../../src/shared/markdown/to-docx'
import { toHtml } from '../../src/shared/markdown/to-html'
import { toPlain } from '../../src/shared/markdown/to-plain'
import { toRtf } from '../../src/shared/markdown/to-rtf'

// The table reader seam (src/shared/markdown/model.ts): every row has one cell per column, an empty
// cell included, the table is as wide as its widest row so no cell is left out, and each output
// format keeps every cell in its place. Before this, `| 1 | | 3 |` was
// read as two cells and "3" came out under the second column everywhere.

type Table = Extract<Block, { kind: 'table' }>
function table(markdown: string): Table {
  const found = readDocument(markdown).blocks.find((block): block is Table => block.kind === 'table')
  if (!found) throw new Error(`not read as a table:\n${markdown}`)
  return found
}
/** A cell as the text a reader sees; code is marked so a code cell cannot pass as plain text. */
const cellText = (cell: Inline[]): string => cell.map((part): string =>
  part.kind === 'text' ? part.text : part.kind === 'code' ? `\`${part.text}\`` : 'children' in part ? cellText(part.children) : `<${part.kind}>`).join('')
const grid = (markdown: string): string[][] => { const read = table(markdown); return [read.header, ...read.rows].map((row) => row.map(cellText)) }
const HEAD = '| A | B | C |\n|---|---|---|\n'
/** The body rows of a three-column table holding these row lines. */
const body = (...lines: string[]): string[][] => grid(HEAD + lines.join('\n')).slice(1)

test('an empty cell is a cell: in the middle, at the start, at the end, and several side by side', () => {
  expect(body('| 1 | | 3 |')).toEqual([['1', '', '3']])
  expect(body('| | 2 | 3 |')).toEqual([['', '2', '3']])
  expect(body('| 1 | 2 | |')).toEqual([['1', '2', '']])
  expect(body('| 1 | | |')).toEqual([['1', '', '']])
  expect(body('| | | 3 |')).toEqual([['', '', '3']])
  expect(body('| | | |')).toEqual([['', '', '']])
  expect(body('| 1 || 3 |')).toEqual([['1', '', '3']])
  // The empty cell is an empty inline list, the same value every emitter already renders as nothing.
  expect(table(`${HEAD}| 1 | | 3 |`).rows[0][1]).toEqual([])
})

test('a cell holding only spaces or tabs is an empty cell', () => {
  expect(body('|     | 2 | 3 |')).toEqual([['', '2', '3']])
  expect(body('| 1 |\t\t| 3 |')).toEqual([['1', '', '3']])
  expect(body('| 1 | 2 |      |')).toEqual([['1', '2', '']])
})

test('rows without the leading pipe, the trailing pipe or both keep their empty cells', () => {
  expect(body('1 | | 3')).toEqual([['1', '', '3']])
  expect(body('1 | | 3 |')).toEqual([['1', '', '3']])
  expect(body('| 1 | | 3')).toEqual([['1', '', '3']])
  expect(body('1 | 2 |')).toEqual([['1', '2', '']])
  expect(body('1 | |')).toEqual([['1', '', '']])
  // A row that opens with a pipe has a LEADING pipe, as GFM reads it: an empty first cell needs both.
  expect(body(' | 2 | 3')).toEqual([['2', '3', '']])
  expect(body('| | 2 | 3')).toEqual([['', '2', '3']])
  expect(grid('A | B\n--- | ---\n1 | \n | 2\n| | 2\n')).toEqual([['A', 'B'], ['1', ''], ['2', ''], ['', '2']])
})

test('an escaped pipe is cell text, in prose and in inline code, and never a delimiter', () => {
  expect(body('| a \\| b | | 3 |')).toEqual([['a | b', '', '3']])
  expect(table(`${HEAD}| \`a\\|b\` | | 3 |`).rows[0].map((cell) => cell.map((part) => part.kind))).toEqual([['code'], [], ['text']])
  // GFM (and this parser) split a cell at an UNESCAPED pipe even inside backticks; the reader follows
  // the parser, so the row is one cell longer than the header: all four cells are kept.
  expect(grid(`${HEAD}| \`a|b\` | 2 | 3 |`)).toEqual([['A', 'B', 'C', ''], ['`a', 'b`', '2', '3']])
})

test('a short row is padded with empty cells to the width of the widest row', () => {
  expect(body('| 1 |')).toEqual([['1', '', '']])
  expect(body('| 1 | 2 |')).toEqual([['1', '2', '']])
  expect(body('|')).toEqual([['', '', '']])
})

test('a row longer than the header keeps every cell, and the header and the other rows are padded to match', () => {
  expect(grid(`${HEAD}| 1 | 2 | 3 | 4 | 5 |`)).toEqual([['A', 'B', 'C', '', ''], ['1', '2', '3', '4', '5']])
  expect(grid(`${HEAD}| | 2 | 3 | 4 |`)).toEqual([['A', 'B', 'C', ''], ['', '2', '3', '4']])
  expect(grid(`${HEAD}| 1 | 2 | 3 |\n| 4 |\n| 5 | 6 | 7 | 8 |\n| | | 9 |`)).toEqual([['A', 'B', 'C', ''], ['1', '2', '3', ''], ['4', '', '', ''], ['5', '6', '7', '8'], ['', '', '9', '']])
  // the added header cells are empty cells, and the added columns have no alignment of their own
  const read = table('| A | B |\n|:-:|--:|\n| 1 | 2 | 3 | 4 |\n')
  expect(read.header).toEqual([[{ kind: 'text', text: 'A' }], [{ kind: 'text', text: 'B' }], [], []])
  expect(read.alignments).toEqual(['centre', 'right', null, null])
  // a table whose rows all fit the header is untouched: the alignments are the delimiter row's own
  expect(table('| A | B |\n|:-:|--:|\n| 1 | 2 |\n| 3 |\n').alignments).toEqual(['centre', 'right'])
})

test('an empty header cell keeps its column, and alignment stays with the column it was written for', () => {
  const read = table('| A | | C |\n|:--|:-:|--:|\n| 1 | | 3 |\n| | 2 | |\n')
  expect(read.header.map(cellText)).toEqual(['A', '', 'C'])
  expect(read.alignments).toEqual(['left', 'centre', 'right'])
  expect(read.rows.map((row) => row.map(cellText))).toEqual([['1', '', '3'], ['', '2', '']])
  expect(grid('| | B |\n|---|---|\n| 1 | 2 |')).toEqual([['', 'B'], ['1', '2']])
  expect(grid('| A | |\n|---|---|\n| 1 | 2 |')).toEqual([['A', ''], ['1', '2']])
  expect(grid('| | |\n|---|---|\n| 1 | 2 |')).toEqual([['', ''], ['1', '2']])
  // third column right-aligned in the HTML, with the empty cell standing in the second
  const { html } = toHtml('| A | | C |\n|:--|:-:|--:|\n| 1 | | 3 |\n')
  expect(html).toMatch(/<td style="[^"]*text-align:center;?[^"]*"><\/td><td style="[^"]*text-align:right;?[^"]*">3<\/td>/)
})

test('a table inside a quote or a list item keeps its empty cells', () => {
  const quoted = readDocument('> | A | B |\n> |---|---|\n> | 1 | |\n> | | 2 |\n').blocks[0]
  expect(quoted.kind === 'quote' && quoted.children[0].kind === 'table' ? quoted.children[0].rows.map((row) => row.map(cellText)) : null).toEqual([['1', ''], ['', '2']])
  const listed = readDocument('- | A | B |\n  |---|---|\n  | | 2 |\n').blocks[0]
  const inItem = listed.kind === 'list' ? listed.items[0].children[0] : null
  expect(inItem && inItem.kind === 'table' ? inItem.rows.map((row) => row.map(cellText)) : null).toEqual([['', '2']])
})

test('a table with no empty cell is read exactly as before: the same model, cell for cell', () => {
  expect(readDocument('| Left | Mid | Right |\n|:--|:-:|--:|\n| **b** | `c` | [l](https://example.com) |\n| x \\| y | 2 | 3 |\n').blocks).toEqual([{
    kind: 'table',
    alignments: ['left', 'centre', 'right'],
    header: [[{ kind: 'text', text: 'Left' }], [{ kind: 'text', text: 'Mid' }], [{ kind: 'text', text: 'Right' }]],
    rows: [
      [[{ kind: 'strong', children: [{ kind: 'text', text: 'b' }] }], [{ kind: 'code', text: 'c' }], [{ kind: 'link', href: 'https://example.com', children: [{ kind: 'text', text: 'l' }] }]],
      [[{ kind: 'text', text: 'x | y' }], [{ kind: 'text', text: '2' }], [{ kind: 'text', text: '3' }]],
    ],
  }])
  expect(toPlain('| Column | Another |\n| --- | --- |\n| **bold** | plain |\n')).toBe('Column\tAnother\nbold\tplain\n')
})

/* ---- every output format keeps the empty cell in its place ---- */

const GAPS = '| A | B | C |\n|---|---|---|\n| 1 | | 3 |\n| | 5 | |\n'

test('HTML: the empty cell is an empty <td>, so "3" stays under the third column', () => {
  const { html } = toHtml(GAPS)
  const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((row) => [...row[1].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/g)].map((cell) => cell[1]))
  expect(rows).toEqual([['A', 'B', 'C'], ['1', '', '3'], ['', '5', '']])
  expect(toHtml(GAPS, { tableRegions: true }).html).toBe(`<div class="wf-table-region table-scroll">${html}</div>`)
})

test('plain text: the empty cell keeps its tab', () => {
  expect(toPlain(GAPS)).toBe('A\tB\tC\n1\t\t3\n\t5\t\n')
})

test('RTF: every row has three cells and the empty ones are empty', () => {
  const rtf = toRtf(GAPS)
  const rows = rtf.split('\\row').slice(0, -1).map((row) => [...row.matchAll(/\\pard\\intbl\\fs\d+ (.*?)\\cell(?!x)/g)].map((cell) => cell[1]))
  expect(rows).toEqual([['{\\b A}', '{\\b B}', '{\\b C}'], ['1', '', '3'], ['', '5', '']])
})

test('Word: every row has three cells and the empty ones hold an empty paragraph', async () => {
  const zip = await JSZip.loadAsync((await toDocx(GAPS)).buffer)
  const xml = await zip.file('word/document.xml')!.async('string')
  const rows = [...xml.matchAll(/<w:tr>.*?<\/w:tr>|<w:tr [^>]*>.*?<\/w:tr>/gs)].map((row) =>
    [...row[0].matchAll(/<w:tc>(.*?)<\/w:tc>/gs)].map((cell) => [...cell[1].matchAll(/<w:t(?: [^>]*)?>(.*?)<\/w:t>/g)].map((run) => run[1]).join('')))
  expect(rows).toEqual([['A', 'B', 'C'], ['1', '', '3'], ['', '5', '']])
  // Word refuses a cell with no paragraph in it: the empty cell still has one.
  expect([...xml.matchAll(/<w:tc>(.*?)<\/w:tc>/gs)].every((cell) => cell[1].includes('<w:p>') || cell[1].includes('<w:p '))).toBe(true)
})

/* ---- every output format keeps the cells beyond the header's width ---- */

const LONG = '| A | B |\n|---|--:|\n| 1 | 2 | beyond |\n| 4 | 5 |\n'

test('HTML: a cell beyond the header is written, under an empty <th>, and the table stays rectangular', () => {
  const { html } = toHtml(LONG)
  const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/g)].map((row) => [...row[1].matchAll(/<(t[dh])[^>]*>(.*?)<\/t[dh]>/g)].map((cell) => `${cell[1]}:${cell[2]}`))
  expect(rows).toEqual([['th:A', 'th:B', 'th:'], ['td:1', 'td:2', 'td:beyond'], ['td:4', 'td:5', 'td:']])
  // the added column has no alignment; the second keeps the one written for it
  expect(html).toMatch(/<td style="[^"]*text-align:right;?[^"]*">2<\/td><td style="(?![^"]*text-align)[^"]*">beyond<\/td>/)
})

test('plain text: a cell beyond the header keeps its tab field, and the header its tab', () => {
  expect(toPlain(LONG)).toBe('A\tB\t\n1\t2\tbeyond\n4\t5\t\n')
})

test('RTF: a cell beyond the header is written, and every row has the same three cells', () => {
  const rtf = toRtf(LONG)
  const rows = rtf.split('\\row').slice(0, -1).map((row) => [...row.matchAll(/\\pard\\intbl\\fs\d+ (.*?)\\cell(?!x)/g)].map((cell) => cell[1]))
  expect(rows).toEqual([['{\\b A}', '{\\b B}', '{\\b }'], ['1', '2', 'beyond'], ['4', '5', '']])
  expect(rtf.split('\\row').slice(0, -1).map((row) => row.match(/\\cellx\d+/g)?.length)).toEqual([3, 3, 3])
})

test('Word: a cell beyond the header is written, and the added header cell holds an empty paragraph', async () => {
  const zip = await JSZip.loadAsync((await toDocx(LONG)).buffer)
  const xml = await zip.file('word/document.xml')!.async('string')
  const rows = [...xml.matchAll(/<w:tr>.*?<\/w:tr>|<w:tr [^>]*>.*?<\/w:tr>/gs)].map((row) =>
    [...row[0].matchAll(/<w:tc>(.*?)<\/w:tc>/gs)].map((cell) => [...cell[1].matchAll(/<w:t(?: [^>]*)?>(.*?)<\/w:t>/g)].map((run) => run[1]).join('')))
  expect(rows).toEqual([['A', 'B', ''], ['1', '2', 'beyond'], ['4', '5', '']])
  expect([...xml.matchAll(/<w:tc>(.*?)<\/w:tc>/gs)].every((cell) => cell[1].includes('<w:p>') || cell[1].includes('<w:p '))).toBe(true)
})

test('clipboard: the rich copy keeps the empty cell in its HTML, RTF and plain flavours; the Markdown copy is the writer\'s own bytes', async () => {
  const rich = (await clipboardPayload(GAPS, 'rich')).payload
  expect(rich.html).toBe(toHtml(GAPS, { images: 'omit' }).html)
  expect(rich.html).toMatch(/<td[^>]*>1<\/td><td[^>]*><\/td><td[^>]*>3<\/td>/)
  expect(rich.text).toBe('A\tB\tC\n1\t\t3\n\t5\t\n')
  expect(rich.rtf).toMatch(/\\fs\d+ 1\\cell\\pard\\intbl\\fs\d+ \\cell\\pard\\intbl\\fs\d+ 3\\cell/)
  expect((await clipboardPayload(GAPS, 'markdown')).payload.text).toBe(GAPS)
})

test('the walkers over a model pass through empty cells: external links only, and every inline', () => {
  const document = readDocument('| A | B |\n|---|---|\n| [in](<Note.md>) | |\n| | [out](https://example.com) |\n')
  const flattened = externalLinksOnly(document).blocks[0]
  expect(flattened.kind === 'table' ? flattened.rows.map((row) => row.map((cell) => cell.length)) : null).toEqual([[1, 0], [0, 1]])
  const kinds: string[] = []
  eachInline(document.blocks, (part) => kinds.push(part.kind))
  expect(kinds.filter((kind) => kind === 'link')).toHaveLength(2)
})
