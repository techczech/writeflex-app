/**
 * ONE reading of a WriteFlex document, shared by every emitter (Round B).
 *
 * The dialect (dialect.ts) says what the Markdown *is*; this module says what a document *contains*,
 * as a small tree of blocks and inlines. The HTML, RTF and plain-text emitters all render this same
 * model, which is the only way a rich copy can honestly claim its three flavours agree — they are
 * three renderings of one reading, not three parsers that happen to be similar.
 *
 * Everything the app must never let out is already gone by the time a model exists: frontmatter and
 * comments are removed from the source before it is parsed, and wikilinks are resolved here into a
 * single `wikilink` inline that each emitter renders under the disappearing-wikilink law.
 *
 * Pure: no DOM, no fs, no CodeMirror.
 */
import type { SyntaxNode } from '@lezer/common'
import {
  exportSource,
  footnoteDefinitions,
  parseMarkdown,
  sealWikilinkBrackets,
  wikilinkRanges,
  type Wikilink,
} from './dialect'
import { embedLine } from './embed-line'
import { numberingOfFirst, ordinalOf, type FancyNumbering, type ListDelimiter } from './fancy-lists'

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'emphasis'; children: Inline[] }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'strike'; children: Inline[] }
  /** WriteFlex's own `==mark==`. */
  | { kind: 'mark'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'link'; href: string; title?: string; children: Inline[] }
  | { kind: 'image'; src: string; alt: string; title?: string }
  /** `[[target]]` / `[[target|label]]` — every emitter applies the disappearing-wikilink law. */
  | { kind: 'wikilink'; target: string; label: string }
  /** A footnote mark. `index` is its 1-based number; `occurrence` distinguishes repeat references
   *  to the same note so each can carry its own back-reference. */
  | { kind: 'footnote'; index: number; occurrence: number }
  | { kind: 'break' }
  /** Raw HTML the writer typed. It is carried as source text and never executed — every emitter
   *  shows it literally, because a copy must not smuggle markup into the receiving document. */
  | { kind: 'html'; text: string }

export type Alignment = 'left' | 'centre' | 'right' | null
export type ListItem = { task: 'todo' | 'done' | null; children: Block[] }
/** A lettered or roman list's style (fancy-lists.ts). Absent on bullet and numbered lists. */
export type ListLettering = { numbering: FancyNumbering; delimiter: ListDelimiter }

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[]; lettering?: ListLettering }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'rule' }
  | { kind: 'table'; alignments: Alignment[]; header: Inline[][]; rows: Inline[][][] }
  | { kind: 'html'; text: string }
  /** An embed line (`[Simulation: path]`) alone on its line, outside code (widgets.ts). `source` is
   *  the line as typed, which is what every emitter shows until widgets render (ticket 06);
   *  `range` is its place in the prepared source the model was read from, not in the file. */
  | { kind: 'widget'; path: string; source: string; range: { from: number; to: number }; refusal?: 'web-address' }

/** A footnote as it will be rendered at the end of the output. `occurrences` is how many marks in
 *  the prose point at it (so an emitter can write one back-reference per mark). */
export type Footnote = { index: number; occurrences: number; children: Block[] }

export type MarkdownDocument = { blocks: Block[]; footnotes: Footnote[] }

// ---- Entities ---------------------------------------------------------------------------------
// The model holds PLAIN TEXT, so `&amp;` in the source becomes `&` here and each emitter escapes it
// again in its own alphabet. Leaving the entity un-decoded would double-escape in HTML and leak raw
// markup into RTF and plain text.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  trade: '™', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', deg: '°', pound: '£', euro: '€', times: '×', middot: '·',
}

function decodeEntity(source: string): string {
  const named = /^&([a-zA-Z][a-zA-Z0-9]*);$/.exec(source)
  if (named && NAMED_ENTITIES[named[1]]) return NAMED_ENTITIES[named[1]]
  const numeric = /^&#(x[0-9a-fA-F]+|[0-9]+);$/.exec(source)
  if (numeric) {
    const code = numeric[1][0] === 'x' || numeric[1][0] === 'X'
      ? Number.parseInt(numeric[1].slice(1), 16)
      : Number.parseInt(numeric[1], 10)
    if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code)
  }
  return source // unknown entity: keep the writer's bytes, they will be escaped like any other text
}

type Context = {
  src: string
  links: Wikilink[]
  /** `[id]: url` definitions, keyed by lower-cased label, for reference-style links. */
  references: Map<string, { href: string; title?: string }>
  /** Footnote definition text by label, lifted out of the source before parsing. */
  definitions: Map<string, string>
  /** `[^label]` → its assigned 1-based index, in order of first reference. */
  numbers: Map<string, number>
  /** How many marks point at each index so far. */
  counts: Map<number, number>
  /** Rendered footnote content, by index. */
  notes: Map<number, Block[]>
  /** False inside a footnote's own text: an embed line is a top-level block of the document. */
  widgets: boolean
}

const HEADING_LEVEL: Record<string, 1 | 2 | 3 | 4 | 5 | 6> = {
  ATXHeading1: 1, ATXHeading2: 2, ATXHeading3: 3, ATXHeading4: 4, ATXHeading5: 5, ATXHeading6: 6,
  SetextHeading1: 1, SetextHeading2: 2,
}

/** Marks are punctuation the reader never sees; they are consumed silently wherever they appear. */
const MARK_NODES = new Set([
  'HeaderMark', 'QuoteMark', 'ListMark', 'CodeMark', 'CodeInfo', 'EmphasisMark', 'HighlightMark',
  'StrikethroughMark', 'LinkMark', 'TaskMarker', 'TableDelimiter', 'LinkTitle', 'LinkLabel', 'URL',
])

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) out.push(child)
  return out
}

function childText(node: SyntaxNode, name: string, ctx: Context): string | null {
  const found = children(node).find((child) => child.name === name)
  return found ? ctx.src.slice(found.from, found.to) : null
}

/** Merge adjacent text runs and drop empties, so emitters see the tidiest possible stream. */
function condense(parts: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const part of parts) {
    if (part.kind === 'text') {
      if (part.text === '') continue
      const last = out[out.length - 1]
      if (last && last.kind === 'text') { last.text += part.text; continue }
      out.push({ kind: 'text', text: part.text })
      continue
    }
    out.push(part)
  }
  return out
}

/**
 * Inline content over `[from, to)` of one node.
 *
 * Wikilinks are matched on the SOURCE, ahead of the syntax tree, because `[[target]]` parses as an
 * ordinary (unresolvable) reference link — the parser has no wikilink node, and inventing one would
 * change what the editor sees. A wikilink therefore wins over any node starting inside it, while a
 * `[[…]]` inside a code span is never reached, because the code node starts first and consumes it.
 */
function inlineRange(node: SyntaxNode, from: number, to: number, ctx: Context): Inline[] {
  const parts: Inline[] = []
  let pos = from
  let child = node.firstChild
  const advance = (): void => { while (child && child.from < pos) child = child.nextSibling }
  while (pos < to) {
    advance()
    const link = ctx.links.find((candidate) => candidate.from >= pos && candidate.to <= to)
    const childStart = child && child.from < to ? child.from : to
    if (link && link.from <= childStart) {
      parts.push({ kind: 'text', text: ctx.src.slice(pos, link.from) })
      parts.push({ kind: 'wikilink', target: link.target, label: link.label })
      pos = link.to
      continue
    }
    if (!child || child.from >= to) break
    parts.push({ kind: 'text', text: ctx.src.slice(pos, child.from) })
    // one at a time: a spread in call position passes one argument per element and overflows the stack
    for (const part of inlineNode(child, ctx)) parts.push(part)
    pos = child.to
    child = child.nextSibling
  }
  parts.push({ kind: 'text', text: ctx.src.slice(Math.min(pos, to), to) })
  return condense(parts)
}

/** The inline content of a whole node. */
function inlineChildren(node: SyntaxNode, ctx: Context): Inline[] {
  return inlineRange(node, node.from, node.to, ctx)
}

/** Content between the node's first and last delimiter marks (emphasis, strike, `==mark==`). */
function delimited(node: SyntaxNode, ctx: Context): Inline[] {
  const marks = children(node).filter((child) => MARK_NODES.has(child.name))
  const open = marks[0]
  const close = marks.length > 1 ? marks[marks.length - 1] : null
  return inlineRange(node, open ? open.to : node.from, close ? close.from : node.to, ctx)
}

function linkLabelRange(node: SyntaxNode, ctx: Context): { from: number; to: number } {
  const marks = children(node).filter((child) => child.name === 'LinkMark')
  const open = marks[0]
  const close = marks.find((mark) => mark.from > (open?.to ?? node.from) && ctx.src.slice(mark.from, mark.to) === ']')
  return { from: open ? open.to : node.from, to: close ? close.from : node.to }
}

function inlineNode(node: SyntaxNode, ctx: Context): Inline[] {
  switch (node.name) {
    case 'Emphasis': return [{ kind: 'emphasis', children: delimited(node, ctx) }]
    case 'StrongEmphasis': return [{ kind: 'strong', children: delimited(node, ctx) }]
    case 'Strikethrough': return [{ kind: 'strike', children: delimited(node, ctx) }]
    case 'Highlight': return [{ kind: 'mark', children: delimited(node, ctx) }]
    case 'InlineCode': {
      const marks = children(node).filter((child) => child.name === 'CodeMark')
      const open = marks[0], close = marks[marks.length - 1]
      return [{ kind: 'code', text: ctx.src.slice(open ? open.to : node.from, close && close !== open ? close.from : node.to) }]
    }
    case 'Link': return [link(node, ctx)]
    case 'Image': {
      const label = linkLabelRange(node, ctx)
      const url = childText(node, 'URL', ctx)
      const title = childText(node, 'LinkTitle', ctx)
      return [{
        kind: 'image',
        src: url ? unwrapUrl(url) : '',
        alt: ctx.src.slice(label.from, label.to),
        ...(title ? { title: title.slice(1, -1) } : {}),
      }]
    }
    case 'Autolink': {
      const url = childText(node, 'URL', ctx) ?? ''
      return [{ kind: 'link', href: url, children: [{ kind: 'text', text: url }] }]
    }
    // A bare URL the GFM autolinker claimed (it is a child of Link when it is a destination, and
    // that path never reaches here).
    case 'URL': {
      const url = ctx.src.slice(node.from, node.to)
      return [{ kind: 'link', href: url, children: [{ kind: 'text', text: url }] }]
    }
    case 'Escape': return [{ kind: 'text', text: ctx.src.slice(node.from + 1, node.to) }]
    case 'Entity': return [{ kind: 'text', text: decodeEntity(ctx.src.slice(node.from, node.to)) }]
    case 'HardBreak': return [{ kind: 'break' }]
    case 'HTMLTag': return [{ kind: 'html', text: ctx.src.slice(node.from, node.to) }]
    case 'Comment': return [] // an HTML comment is not the writer's prose
    case 'FootnoteReference': return [footnoteMark(ctx.src.slice(node.from + 2, node.to - 1), null, ctx)]
    case 'FootnoteInline': return [footnoteMark(null, ctx.src.slice(node.from + 2, node.to - 1), ctx)]
    default:
      if (MARK_NODES.has(node.name)) return []
      return inlineChildren(node, ctx)
  }
}

/** `<url>` destinations are written with angle brackets when they contain spaces; strip them. */
function unwrapUrl(url: string): string {
  return url.startsWith('<') && url.endsWith('>') ? url.slice(1, -1) : url
}

function link(node: SyntaxNode, ctx: Context): Inline {
  const label = linkLabelRange(node, ctx)
  const url = childText(node, 'URL', ctx)
  const title = childText(node, 'LinkTitle', ctx)
  if (url !== null) {
    return {
      kind: 'link',
      href: unwrapUrl(url),
      ...(title ? { title: title.slice(1, -1) } : {}),
      children: inlineRange(node, label.from, label.to, ctx),
    }
  }
  // Reference form: `[text][id]`, or the shortcut `[id]`.
  const labelNode = children(node).find((child) => child.name === 'LinkLabel')
  const key = (labelNode ? ctx.src.slice(labelNode.from + 1, labelNode.to - 1) : ctx.src.slice(label.from, label.to))
    .trim().toLowerCase()
  const reference = ctx.references.get(key)
  if (reference) {
    return {
      kind: 'link',
      href: reference.href,
      ...(reference.title ? { title: reference.title } : {}),
      children: inlineRange(node, label.from, label.to, ctx),
    }
  }
  // Nothing to point at: the brackets stay as the writer typed them. Never a dead anchor.
  return { kind: 'text', text: ctx.src.slice(node.from, node.to) }
}

/** Assign (or reuse) a footnote number and record one more mark pointing at it. A `[^label]`
 *  reference reuses its number, so a note referenced twice is ONE entry with two back-references;
 *  every `^[inline]` note is its own. */
function footnoteMark(label: string | null, inlineText: string | null, ctx: Context): Inline {
  let index: number
  if (label !== null) {
    // A reference with no definition is not a footnote — it travels as the writer's own characters,
    // rather than becoming a numbered note pointing at nothing.
    if (!ctx.definitions.has(label)) return { kind: 'text', text: `[^${label}]` }
    const existing = ctx.numbers.get(label)
    if (existing !== undefined) index = existing
    else {
      index = ctx.notes.size + 1
      ctx.numbers.set(label, index)
      ctx.notes.set(index, []) // reserve the number before recursing into the note's own content
      ctx.notes.set(index, blocksOf(ctx.definitions.get(label) ?? '', ctx))
    }
  } else {
    index = ctx.notes.size + 1
    ctx.notes.set(index, [])
    ctx.notes.set(index, blocksOf(inlineText ?? '', ctx))
  }
  const occurrence = (ctx.counts.get(index) ?? 0) + 1
  ctx.counts.set(index, occurrence)
  return { kind: 'footnote', index, occurrence }
}

/** Parse a fragment (a footnote's own text) into blocks, sharing the outer document's context so a
 *  wikilink inside a footnote obeys the same law. */
function blocksOf(text: string, outer: Context): Block[] {
  if (text.trim() === '') return []
  const ctx: Context = { ...outer, src: text, links: wikilinkRanges(text), widgets: false }
  return blocks(parseMarkdown(text).topNode, ctx)
}

function tableAlignments(row: string): Alignment[] {
  return row.split('|').slice(1, -1).map((cell) => {
    const trimmed = cell.trim()
    const left = trimmed.startsWith(':')
    const right = trimmed.endsWith(':')
    return left && right ? 'centre' : right ? 'right' : left ? 'left' : null
  })
}

function blockNode(node: SyntaxNode, ctx: Context): Block | null {
  const level = HEADING_LEVEL[node.name]
  if (level) {
    const marks = children(node).filter((child) => child.name === 'HeaderMark')
    const open = node.name.startsWith('ATX') ? marks[0] : null
    const close = node.name.startsWith('ATX')
      ? (marks.length > 1 ? marks[marks.length - 1] : null)
      : marks[marks.length - 1] ?? null
    const from = open ? open.to : node.from
    const to = close ? close.from : node.to
    return { kind: 'heading', level, children: trimEdges(inlineRange(node, from, to, ctx)) }
  }
  switch (node.name) {
    case 'Paragraph': return { kind: 'paragraph', children: trimEdges(inlineChildren(node, ctx)) }
    case 'Blockquote': return { kind: 'quote', children: blocks(node, ctx) }
    case 'BulletList':
    case 'OrderedList': {
      const items = children(node).filter((child) => child.name === 'ListItem').map((item) => listItem(item, ctx))
      const firstMark = children(node)[0] ? childText(children(node)[0], 'ListMark', ctx) : null
      const start = node.name === 'OrderedList' ? Number.parseInt(firstMark ?? '1', 10) || 1 : 1
      return { kind: 'list', ordered: node.name === 'OrderedList', start, items }
    }
    // A lettered or roman list (fancy-lists.ts): ordered, numbered from its first label, and styled.
    case 'FancyList': {
      const items = children(node).filter((child) => child.name === 'ListItem').map((item) => listItem(item, ctx))
      const firstMark = children(node)[0] ? childText(children(node)[0], 'ListMark', ctx) ?? '' : ''
      const label = firstMark.slice(0, -1)
      const numbering = numberingOfFirst(label)
      if (!numbering || numbering === 'decimal') return { kind: 'list', ordered: true, start: 1, items }
      const delimiter = firstMark.endsWith(')') ? ')' : '.'
      return { kind: 'list', ordered: true, start: ordinalOf(label, numbering) ?? 1, items, lettering: { numbering, delimiter } }
    }
    case 'FencedCode':
    case 'CodeBlock': {
      const info = childText(node, 'CodeInfo', ctx) ?? ''
      // EVERY CodeText child, not the first. A fenced block has one; an INDENTED block has one per
      // chunk, with the four spaces that make it code sitting in the gaps between them — so reading
      // only the first child silently threw away every line of the example after the opening one.
      // Concatenating the runs also dedents the block exactly as the parser measured it.
      const text = children(node)
        .filter((child) => child.name === 'CodeText')
        .map((child) => ctx.src.slice(child.from, child.to))
        .join('')
      return { kind: 'code', language: info.trim().split(/\s+/)[0] ?? '', text }
    }
    case 'HorizontalRule': return { kind: 'rule' }
    case 'HTMLBlock': return { kind: 'html', text: ctx.src.slice(node.from, node.to) }
    case 'Table': return table(node, ctx)
    case 'LinkReference': return null // a definition, not content
    case 'CommentBlock': return null
    default: return null
  }
}

/** A top-level paragraph whose every line is an embed line becomes one widget block per line. */
function widgetBlocks(node: SyntaxNode, ctx: Context): Block[] | null {
  if (!ctx.widgets || node.parent?.name !== 'Document') return null
  const text = ctx.src.slice(node.from, node.to)
  const found: Block[] = []
  let offset = 0
  for (const line of text.split('\n')) {
    const embed = embedLine(line)
    if (!embed) return null
    const from = node.from + offset + (line.length - line.trimStart().length)
    found.push({ kind: 'widget', path: embed.path, source: line.trim(), range: { from, to: from + line.trim().length }, ...(embed.refusal ? { refusal: embed.refusal } : {}) })
    offset += line.length + 1
  }
  return found
}

function table(node: SyntaxNode, ctx: Context): Block {
  const rows = children(node)
  const delimiterRow = rows.find((row) => row.name === 'TableDelimiter')
  const alignments = delimiterRow ? tableAlignments(ctx.src.slice(delimiterRow.from, delimiterRow.to)) : []
  const headerRow = rows.find((row) => row.name === 'TableHeader')
  const header = headerRow ? rowCells(headerRow, ctx) : []
  const body = rows.filter((row) => row.name === 'TableRow').map((row) => rowCells(row, ctx))
  // The table is rectangular at the width of its WIDEST row, so no cell the writer typed is left out
  // of an output: a short row is padded with empty cells, and a row longer than the header keeps
  // every cell while the header is padded with empty header cells (alignment: none) to match.
  // A table that padding would more than double is left exactly as read (tableWidthIfAtMostDoubled).
  const width = tableWidthIfAtMostDoubled(header, body)
  if (width === 0) return { kind: 'table', alignments, header, rows: body }
  const toWidth = (cells: Inline[][]): Inline[][] => {
    if (cells.length === width) return cells
    const padded = cells.slice()
    while (padded.length < width) padded.push([])
    return padded
  }
  return {
    kind: 'table',
    alignments: width > header.length && alignments.length < width ? [...alignments, ...Array<Alignment>(width - alignments.length).fill(null)] : alignments,
    header: toWidth(header),
    rows: body.map(toWidth),
  }
}

/**
 * The width to pad a table's header and rows to, or 0 to leave them exactly as read.
 *
 * Document content is untrusted (pasted from anywhere, or written by an agent) and this reader runs
 * for every export, copy and note. Padding every row to the widest one turns one row of N cells
 * over N one-cell rows (about 3N characters) into N x N cells: 400 million for N = 20,000.
 *
 * The rule: with `typed` the cells actually read (header and rows, an empty cell between two
 * delimiters included) and `added` the empty cells a rectangle at the widest row would need, the
 * table is padded only when `added <= typed`. A padded table therefore never holds more than twice
 * the cells the writer typed, and an unpadded one holds exactly the cells typed, so the cells of a
 * whole document's tables are at most twice the cells typed in it, however many tables it has.
 * There is no fixed allowance on top: a constant per table is multiplied by a document of many
 * small tables (a header of 32 cells over 32 one-cell rows would gain 992 cells for 64 typed).
 * A table that would grow more is left as written, ragged, so no text is lost.
 *
 * The width is found with a loop: a spread (`Math.max(...rows)`) passes one argument per row and
 * overflows the stack on a very long table.
 */
function tableWidthIfAtMostDoubled(header: Inline[][], body: Inline[][][]): number {
  if (header.length === 0) return 0
  let width = header.length
  let typed = header.length
  for (const cells of body) {
    typed += cells.length
    if (cells.length > width) width = cells.length
  }
  const added = width * (body.length + 1) - typed
  return added <= typed ? width : 0
}

/**
 * One cell per column position of a table row, an EMPTY cell (`[]`) included.
 *
 * The parser emits a `TableCell` only for a cell with content: `| 1 | | 3 |` is delimiter, cell,
 * delimiter, delimiter, cell, delimiter. Collecting the cells alone therefore closed the gap and
 * moved "3" under the second column in every output format. The delimiters are what mark the
 * positions, so the row is read from them: two delimiters with no cell between them are an empty
 * cell. A row's FIRST delimiter is its leading pipe when nothing precedes it, and its last one is
 * the trailing pipe, so neither opens a cell of its own. Which `|` is a delimiter at all (an
 * escaped `\|` is not) is the parser's decision and is not second-guessed here.
 */
function rowCells(row: SyntaxNode, ctx: Context): Inline[][] {
  const cells: Inline[][] = []
  let first = true
  let filled = false // a cell has been read since the last delimiter
  for (const child of children(row)) {
    if (child.name === 'TableCell') {
      cells.push(trimEdges(inlineChildren(child, ctx)))
      filled = true
    } else if (child.name === 'TableDelimiter') {
      if (!first && !filled) cells.push([])
      filled = false
    } else continue
    first = false
  }
  return cells
}

function listItem(node: SyntaxNode, ctx: Context): ListItem {
  const kids = children(node)
  const task = kids.find((child) => child.name === 'Task')
  if (!task) return { task: null, children: blocks(node, ctx) }
  const marker = children(task).find((child) => child.name === 'TaskMarker')
  const ticked = marker ? /[xX]/.test(ctx.src.slice(marker.from, marker.to)) : false
  const rest = kids.filter((child) => child !== task && !MARK_NODES.has(child.name))
  return {
    task: ticked ? 'done' : 'todo',
    children: [
      { kind: 'paragraph', children: trimEdges(inlineRange(task, marker ? marker.to : task.from, task.to, ctx)) },
      ...rest.flatMap((child) => { const built = blockNode(child, ctx); return built ? [built] : [] }),
    ],
  }
}

function blocks(node: SyntaxNode, ctx: Context): Block[] {
  const out: Block[] = []
  for (const child of children(node)) {
    if (MARK_NODES.has(child.name)) continue
    const embeds = child.name === 'Paragraph' ? widgetBlocks(child, ctx) : null
    if (embeds) { for (const embed of embeds) out.push(embed); continue } // no spread: one embed per line of the paragraph
    const block = blockNode(child, ctx)
    if (block) out.push(block)
  }
  return out
}

/** Trim the whitespace that block structure leaves at the edges of inline content. */
function trimEdges(parts: Inline[]): Inline[] {
  const out = parts.slice()
  if (out[0]?.kind === 'text') out[0] = { kind: 'text', text: out[0].text.replace(/^[ \t]+/, '') }
  const last = out[out.length - 1]
  if (last?.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text.replace(/\s+$/, '') }
  return out.filter((part) => part.kind !== 'text' || part.text !== '')
}

// ---- Sealing the disappearing-wikilink law -----------------------------------------------------
// The scanner turns every balanced `[[…]]` into a wikilink inline, which each emitter renders as its
// label. What is left is the ragged remainder — an opener with no closer, a link broken across
// lines — and it is swept here, ONCE, on the shared model, so that the law holds for the HTML, RTF
// and plain flavours together and cannot be forgotten by one of them. (The byte-faithful Markdown
// flavour does not build a model; it sweeps with the same dialect helper, line by line.)
//
// THE ONE BOUNDARY: code is quoted text, not prose. A code span, a fenced block and an indented
// block keep their literal characters, because a code example ABOUT wikilinks must still read
// `[[x]]`. Raw HTML the writer typed is not quoting — it is shown as words — so it is swept.

function sealInlines(parts: Inline[]): void {
  for (const part of parts) {
    switch (part.kind) {
      case 'text': case 'html': part.text = sealWikilinkBrackets(part.text); break
      case 'image': part.alt = sealWikilinkBrackets(part.alt); break
      case 'link':
        if (part.title !== undefined) part.title = sealWikilinkBrackets(part.title)
        sealInlines(part.children)
        break
      case 'emphasis': case 'strong': case 'strike': case 'mark': sealInlines(part.children); break
      case 'code': break // quoted
      default: break
    }
  }
}

function sealBlocks(list: Block[]): void {
  for (const entry of list) {
    switch (entry.kind) {
      case 'heading': case 'paragraph': sealInlines(entry.children); break
      case 'quote': sealBlocks(entry.children); break
      case 'list': for (const item of entry.items) sealBlocks(item.children); break
      case 'table':
        for (const cell of entry.header) sealInlines(cell)
        for (const row of entry.rows) for (const cell of row) sealInlines(cell)
        break
      case 'html': entry.text = sealWikilinkBrackets(entry.text); break
      case 'code': case 'rule': break // quoted, or nothing to say
      case 'widget': break // an embed line is literal: its path is a file name, never a wikilink
    }
  }
}

function collectReferences(root: SyntaxNode, ctx: Context): void {
  for (const child of children(root)) {
    if (child.name !== 'LinkReference') continue
    const labelNode = children(child).find((node) => node.name === 'LinkLabel')
    const url = childText(child, 'URL', ctx)
    const title = childText(child, 'LinkTitle', ctx)
    if (!labelNode || url === null) continue
    ctx.references.set(ctx.src.slice(labelNode.from + 1, labelNode.to - 1).trim().toLowerCase(), {
      href: unwrapUrl(url),
      ...(title ? { title: title.slice(1, -1) } : {}),
    })
  }
}

/**
 * Read a Markdown document into the shared model. Frontmatter and comments are removed first, so
 * they cannot reach any emitter; footnote definitions are lifted out of the body and rendered at
 * the end by whoever renders the model.
 */
export function readDocument(original: string): MarkdownDocument {
  // One line ending, before anything reads lines: the parser and every line rule below split on
  // `\n`, so a `\r` left in would hide an embed line (and be carried into code blocks).
  const markdown = original.replace(/\r\n?/g, '\n')
  const source = exportSource(markdown)
  const { body, definitions } = footnoteDefinitions(source)
  const ctx: Context = {
    src: body,
    links: wikilinkRanges(body),
    references: new Map(),
    definitions: new Map(definitions.map((definition) => [definition.label, definition.text])),
    numbers: new Map(),
    counts: new Map(),
    notes: new Map(),
    widgets: true,
  }
  const root = parseMarkdown(body).topNode
  collectReferences(root, ctx)
  const documentBlocks = blocks(root, ctx)
  const footnotes: Footnote[] = [...ctx.notes.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, content]) => ({ index, occurrences: ctx.counts.get(index) ?? 1, children: content }))
  sealBlocks(documentBlocks)
  for (const note of footnotes) sealBlocks(note.children)
  return { blocks: documentBlocks, footnotes }
}

/** Every inline in a model, depth-first — for emitters and tests that need to sweep for a kind. */
export function eachInline(blocksToWalk: Block[], visit: (inline: Inline) => void): void {
  const walkInlines = (parts: Inline[]): void => {
    for (const part of parts) {
      visit(part)
      if ('children' in part) walkInlines(part.children)
    }
  }
  const walk = (list: Block[]): void => {
    for (const block of list) {
      switch (block.kind) {
        case 'heading': case 'paragraph': walkInlines(block.children); break
        case 'quote': walk(block.children); break
        case 'list': for (const item of block.items) walk(item.children); break
        case 'table':
          for (const cell of block.header) walkInlines(cell)
          for (const row of block.rows) for (const cell of row) walkInlines(cell)
          break
        default: break
      }
    }
  }
  walk(blocksToWalk)
}
