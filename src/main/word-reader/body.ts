/**
 * Walks `word/document.xml` into blocks: paragraphs (with their tracked changes), tables as grids,
 * and figures as notes. Nothing here opens, runs or follows anything in the file: a picture is noticed,
 * never read; a link target is kept as text; a field code is skipped.
 */
import { W_NAMESPACES, headingLevelOfStyle, isW, safeLinkTarget, wChild, wVal, type Numbering, type Relationship, type StyleInfo } from './package-model'
import { WordRefusalError } from './refusal'
import { chargeTable, escapeInline, inlineMarkdown, plainOf, tableMarkdown, type OutputBudget, type Run } from './render'
import type { WordBlock, WordChange, WordFigure, WordParagraph, WordReaderLimits, WordSegment, WordTable } from './types'
import type { XmlElement } from './xml'

export type BodyContext = {
  limits: WordReaderLimits
  tableCells: number
  cellChanges: number
  styles: Map<string, StyleInfo>
  numbering: Numbering
  /** Markdown the reader may still build; shared by every paragraph and both views. */
  budget: OutputBudget
  links: Map<string, string>
  changes: WordChange[]
  footnoteRefs: number
  commentRefs: number
  formattingChanges: number
  textBoxes: number
  equations: number
  tableCount: number
  figureCount: number
}

export type RawParagraph = { block: WordParagraph; headingLevel?: number; headingOriginal: string; headingRevised: string }
export type RawBlock = { kind: 'paragraph'; raw: RawParagraph } | { kind: 'other'; block: WordTable | WordFigure }

export function makeContext(styles: Map<string, StyleInfo>, numbering: Numbering, rels: Relationship[], limits: WordReaderLimits): BodyContext {
  const links = new Map<string, string>()
  for (const r of rels) {
    if (r.external && /\/hyperlink$/.test(r.type)) {
      const target = safeLinkTarget(r.target)
      if (target) links.set(r.id, target)
    }
  }
  return { limits, tableCells: 0, cellChanges: 0, styles, numbering, budget: { left: limits.maxOutputChars }, links, changes: [], footnoteRefs: 0, commentRefs: 0, formattingChanges: 0, textBoxes: 0, equations: 0, tableCount: 0, figureCount: 0 }
}

const inW = (el: XmlElement): boolean => W_NAMESPACES.has(el.uri)
const MATH_NAMESPACES = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/math', 'http://purl.oclc.org/ooxml/officeDocument/math'])
/** An equation (Office Math) in a paragraph: noticed and reported, never rendered. */
const isEquation = (el: XmlElement): boolean => (el.name === 'oMath' || el.name === 'oMathPara') && MATH_NAMESPACES.has(el.uri)
const MAX_REVISION_NESTING = 4
const CONTAINERS = new Set(['smartTag', 'sdt', 'sdtContent', 'customXml', 'fldSimple', 'dir', 'bdo'])
const FORMATTING_CHANGES = new Set(['rPrChange', 'pPrChange', 'sectPrChange', 'tblPrChange', 'tblGridChange', 'trPrChange', 'tcPrChange', 'numberingChange'])

const isOn = (el: XmlElement | undefined): boolean => el !== undefined && !['0', 'false', 'off'].includes(el.attrs.val ?? '')

function cleanAuthor(raw: string | undefined): string {
  // eslint-disable-next-line no-control-regex
  const a = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
  return a === '' ? 'Unknown author' : a
}
const cleanDate = (raw: string | undefined): string | undefined => (raw && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})?$/.test(raw) ? raw : undefined)

function newChange(ctx: BodyContext, el: XmlElement, scope: WordChange['scope']): WordChange {
  if (ctx.changes.length >= ctx.limits.maxChanges) throw new WordRefusalError('zip-bomb')
  const insertion = el.name === 'ins' || el.name === 'moveTo'
  const change: WordChange = {
    index: ctx.changes.length,
    kind: insertion ? 'insertion' : 'deletion',
    moved: el.name === 'moveTo' || el.name === 'moveFrom',
    scope,
    author: cleanAuthor(el.attrs.author),
    date: cleanDate(el.attrs.date),
    text: '',
    sectionIndex: -1
  }
  if (change.date === undefined) delete change.date
  ctx.changes.push(change)
  return change
}

const isInsertion = (el: XmlElement): boolean => isW(el, 'ins') || isW(el, 'moveTo')
const isDeletion = (el: XmlElement): boolean => isW(el, 'del') || isW(el, 'moveFrom')

type Open = { inserted: boolean; deleted: boolean; open: WordChange[]; author?: string; date?: string }

function describeFigure(el: XmlElement): string | undefined {
  // The alt text or title of a drawing, found by a bounded walk; the picture itself is never read.
  const stack: XmlElement[] = [el]
  let seen = 0
  while (stack.length && seen++ < 200) {
    const cur = stack.pop()!
    if (cur.name === 'docPr') return (cur.attrs.descr || cur.attrs.title || undefined)?.replace(/\s+/g, ' ').trim().slice(0, 300) || undefined
    for (let i = cur.children.length - 1; i >= 0; i--) stack.push(cur.children[i])
  }
  return undefined
}

function makeFigure(el: XmlElement, ctx: BodyContext): WordFigure {
  ctx.figureCount++
  if (hasTextBox(el)) ctx.textBoxes++
  const description = describeFigure(el)
  return description === undefined ? { type: 'figure', note: 'figure here' } : { type: 'figure', note: 'figure here', description }
}

function hasTextBox(el: XmlElement): boolean {
  const stack: XmlElement[] = [el]
  let seen = 0
  while (stack.length && seen++ < 400) {
    const cur = stack.pop()!
    if (cur.name === 'txbxContent') return true
    for (const c of cur.children) stack.push(c)
  }
  return false
}

/** Inside a run these hold field codes, never words: skipped on purpose, not by accident. */
const SKIPPED_IN_RUN = new Set(['instrText', 'delInstrText'])

/** Whether an element, or anything under it, holds reading text. A bounded walk; the tree is already bounded. */
function carriesText(el: XmlElement): boolean {
  const stack: XmlElement[] = [el]
  while (stack.length) {
    const cur = stack.pop()!
    if ((cur.name === 't' || cur.name === 'delText') && cur.text !== '') return true
    for (const c of cur.children) stack.push(c)
  }
  return false
}

function readRun(r: XmlElement, state: Open, link: string | null, runs: Run[], figures: WordFigure[], ctx: BodyContext): void {
  const rPr = wChild(r, 'rPr')
  const bold = isOn(rPr && wChild(rPr, 'b'))
  const italic = isOn(rPr && wChild(rPr, 'i'))
  if (rPr) for (const c of rPr.children) if (FORMATTING_CHANGES.has(c.name)) ctx.formattingChanges++
  let text = ''
  const flush = (): void => {
    if (text === '') return
    runs.push({ text, bold, italic, link, inserted: state.inserted, deleted: state.deleted, author: state.author, date: state.date })
    for (const ch of state.open) ch.text += text
    text = ''
  }
  for (const c of r.children) {
    if (!inW(c)) {
      if (c.name === 'AlternateContent') figures.push(makeFigure(c, ctx))
      else if (carriesText(c)) throw new WordRefusalError('damaged')
      continue
    }
    switch (c.name) {
      case 't':
      case 'delText':
        text += c.text
        break
      case 'tab':
        text += ' '
        break
      case 'br':
        text += c.attrs.type === 'page' || c.attrs.type === 'column' ? ' ' : '\n'
        break
      case 'cr':
        text += '\n'
        break
      case 'noBreakHyphen':
        text += '-'
        break
      case 'drawing':
      case 'pict':
      case 'object':
        figures.push(makeFigure(c, ctx))
        break
      case 'footnoteReference':
      case 'endnoteReference':
        ctx.footnoteRefs++
        break
      case 'commentReference':
        ctx.commentRefs++
        break
      case 'ins':
      case 'del':
      case 'moveFrom':
      case 'moveTo':
        // Revision markup belongs around runs, never inside one. Reading on would drop the text it holds and
        // lose the change; the file is not one Word wrote.
        throw new WordRefusalError('damaged')
      default:
        if (!SKIPPED_IN_RUN.has(c.name) && carriesText(c)) throw new WordRefusalError('damaged')
        break
    }
  }
  flush()
}

function collectRuns(el: XmlElement, state: Open, link: string | null, runs: Run[], figures: WordFigure[], ctx: BodyContext): void {
  for (const c of el.children) {
    if (isEquation(c)) {
      ctx.equations++
      continue
    }
    if (!inW(c)) continue
    if (c.name === 'r') readRun(c, state, link, runs, figures, ctx)
    else if (isInsertion(c) || isDeletion(c)) {
      // Word nests an insertion and a deletion at most; deeper is a file trying to copy its text into every level.
      if (state.open.length >= MAX_REVISION_NESTING) throw new WordRefusalError('damaged')
      const change = newChange(ctx, c, 'text')
      const ins = isInsertion(c)
      collectRuns(
        c,
        { inserted: state.inserted || ins, deleted: state.deleted || !ins, open: [...state.open, change], author: change.author, date: change.date },
        link,
        runs,
        figures,
        ctx
      )
    } else if (c.name === 'hyperlink') collectRuns(c, state, (c.attrs['r:id'] && ctx.links.get(c.attrs['r:id'])) || null, runs, figures, ctx)
    else if (CONTAINERS.has(c.name)) collectRuns(c, state, link, runs, figures, ctx)
  }
}

function segmentsOf(runs: Run[]): WordSegment[] {
  const out: WordSegment[] = []
  for (const r of runs) {
    const type: WordSegment['type'] = r.deleted ? 'deleted' : r.inserted ? 'inserted' : 'same'
    const last = out[out.length - 1]
    if (last && last.type === type && last.author === r.author && last.date === r.date) last.text += r.text
    else {
      const seg: WordSegment = { type, text: r.text }
      if (type !== 'same') {
        if (r.author !== undefined) seg.author = r.author
        if (r.date !== undefined) seg.date = r.date
      }
      out.push(seg)
    }
  }
  return out
}

function readParagraph(p: XmlElement, ctx: BodyContext, inTable: boolean): { raw: RawParagraph | null; figures: WordFigure[]; runs: Run[] } {
  const startChanges = ctx.changes.length
  const pPr = wChild(p, 'pPr')
  const styleId = pPr ? wVal(wChild(pPr, 'pStyle')) : undefined
  const numPr = pPr ? wChild(pPr, 'numPr') : undefined
  const direct = pPr ? wVal(wChild(pPr, 'outlineLvl')) : undefined
  if (pPr) for (const c of pPr.children) if (FORMATTING_CHANGES.has(c.name)) ctx.formattingChanges++

  const runs: Run[] = []
  const figures: WordFigure[] = []
  collectRuns(p, { inserted: false, deleted: false, open: [] }, null, runs, figures, ctx)

  // The paragraph break itself, added or removed.
  const markProps = pPr ? wChild(pPr, 'rPr') : undefined
  if (markProps) for (const c of markProps.children) if (isInsertion(c) || isDeletion(c)) newChange(ctx, c, 'paragraph-mark')
  const changes = ctx.changes.slice(startChanges)

  const revisedPlain = plainOf(runs, 'revised')
  const originalPlain = plainOf(runs, 'original')
  if (revisedPlain === '' && originalPlain === '' && changes.length === 0) return { raw: null, figures, runs }

  let headingLevel: number | undefined
  if (!inTable) {
    if (direct !== undefined && /^\d$/.test(direct)) headingLevel = Number(direct) <= 8 ? Number(direct) + 1 : undefined
    else headingLevel = headingLevelOfStyle(ctx.styles, styleId)
  }

  let list: WordParagraph['list']
  const numId = numPr ? wVal(wChild(numPr, 'numId')) : undefined
  if (numPr && numId && numId !== '0' && headingLevel === undefined) {
    const lvlRaw = wVal(wChild(numPr, 'ilvl')) ?? '0'
    const level = /^\d$/.test(lvlRaw) ? Number(lvlRaw) : 0
    list = { ordered: ctx.numbering.ordered(numId, level), level }
  }

  const prefix = (marker: string, text: string): string => (text === '' ? '' : marker + text)
  const lead = list ? '   '.repeat(list.level) + (list.ordered ? '1. ' : '- ') : ''
  const block: WordParagraph = {
    type: 'paragraph',
    revised: '',
    original: '',
    segments: segmentsOf(runs),
    changes
  }
  if (list) block.list = list
  const subHeading = (level: number): string => `${'#'.repeat(level)} `
  const render = (view: 'revised' | 'original'): string => {
    const md = inlineMarkdown(runs, view, ctx.budget)
    return headingLevel !== undefined ? prefix(subHeading(headingLevel), md) : prefix(lead, md)
  }
  block.revised = render('revised')
  block.original = render('original')
  return { raw: { block, headingLevel, headingOriginal: originalPlain, headingRevised: revisedPlain }, figures, runs }
}

const rowMark = (tr: XmlElement): XmlElement | undefined => {
  const trPr = wChild(tr, 'trPr')
  return trPr ? (wChild(trPr, 'ins') ?? wChild(trPr, 'del')) : undefined
}

function cellText(tc: XmlElement, ctx: BodyContext): { revised: string; original: string } {
  const rev: string[] = []
  const orig: string[] = []
  // `gone` and `added` are true inside a row of a nested table that was deleted or inserted: the revised
  // view leaves out what was deleted, the original view what was inserted, as for the outer table.
  const walk = (el: XmlElement, gone: boolean, added: boolean): void => {
    for (const c of el.children) {
      if (isW(c, 'p')) {
        const { raw, runs, figures } = readParagraph(c, ctx, true)
        if (raw) {
          const r = plainOf(runs, 'revised')
          const o = plainOf(runs, 'original')
          if (r && !gone) rev.push(r)
          if (o && !added) orig.push(o)
        }
        for (let f = 0; f < figures.length; f++) {
          if (!gone) rev.push('[figure here]')
          if (!added) orig.push('[figure here]')
        }
      } else if (isW(c, 'tbl')) walk(c, gone, added)
      else if (isW(c, 'tr')) {
        // A row inside a table nested in a cell: it is a change, and it belongs to only one of the two views.
        const mark = rowMark(c)
        const change = mark ? newChange(ctx, mark, 'row') : undefined
        walk(c, gone || change?.kind === 'deletion', added || change?.kind === 'insertion')
      } else if (isW(c, 'tc') || isW(c, 'sdt') || isW(c, 'sdtContent') || isW(c, 'customXml')) walk(c, gone, added)
    }
  }
  walk(tc, false, false)
  return { revised: rev.join(' '), original: orig.join(' ') }
}

/** The grid columns a row skips (`gridBefore`, `gridAfter`). A count that is not a small whole number cannot be placed, so the file is refused. */
function skippedColumns(trPr: XmlElement | undefined, name: 'gridBefore' | 'gridAfter'): number {
  const raw = trPr ? wVal(wChild(trPr, name)) : undefined
  if (raw === undefined) return 0
  if (!/^\d{1,2}$/.test(raw) || Number(raw) >= 64) throw new WordRefusalError('damaged')
  return Number(raw)
}

/** The `name` children of an element in document order, looking through content controls and custom XML that wrap them (a row's cells, a table's rows). */
function descend(el: XmlElement, name: 'tc' | 'tr'): XmlElement[] {
  const out: XmlElement[] = []
  const walk = (parent: XmlElement): void => {
    for (const c of parent.children) {
      if (isW(c, name)) out.push(c)
      else if (isW(c, 'sdt') || isW(c, 'sdtContent') || isW(c, 'customXml')) walk(c)
    }
  }
  walk(el)
  return out
}

function readTable(tbl: XmlElement, ctx: BodyContext): WordTable {
  const startChanges = ctx.changes.length
  ctx.tableCount++
  const rows: string[][] = []
  const originalRows: string[][] = []
  for (const tr of descend(tbl, 'tr')) {
    const mark = rowMark(tr)
    const rowChange = mark ? newChange(ctx, mark, 'row') : undefined
    const revised: string[] = []
    const original: string[] = []
    // Grid columns the row leaves empty before its first cell and after its last: the cells sit in the columns after / before them.
    const trPr = wChild(tr, 'trPr')
    const before = skippedColumns(trPr, 'gridBefore')
    const after = skippedColumns(trPr, 'gridAfter')
    revised.push(...Array(before).fill(''))
    original.push(...Array(before).fill(''))
    for (const tc of descend(tr, 'tc')) {
      const tcPr = wChild(tc, 'tcPr')
      if (tcPr && (wChild(tcPr, 'cellIns') || wChild(tcPr, 'cellDel') || wChild(tcPr, 'cellMerge'))) ctx.cellChanges++
      const span = tcPr ? Number(wVal(wChild(tcPr, 'gridSpan')) ?? '1') : 1
      const vm = tcPr ? wChild(tcPr, 'vMerge') : undefined
      const continuation = vm !== undefined && vm.attrs.val !== 'restart'
      const t = cellText(tc, ctx)
      const pad = Number.isInteger(span) && span > 1 && span < 64 ? span - 1 : 0
      revised.push(continuation ? '' : t.revised, ...Array(pad).fill(''))
      original.push(continuation ? '' : t.original, ...Array(pad).fill(''))
      if (revised.length > ctx.limits.maxTableColumns) throw new WordRefusalError('zip-bomb')
    }
    revised.push(...Array(after).fill(''))
    original.push(...Array(after).fill(''))
    if (revised.length > ctx.limits.maxTableColumns) throw new WordRefusalError('zip-bomb')
    if (!(rowChange && rowChange.kind === 'deletion')) rows.push(revised)
    if (!(rowChange && rowChange.kind === 'insertion')) originalRows.push(original)
  }
  const width = (g: string[][]): number => g.reduce((m, r) => (r.length > m ? r.length : m), 0)
  const w = Math.max(width(rows), width(originalRows))
  // Padding to a rectangle is where a thin table becomes a huge one: count it before it is built.
  ctx.tableCells += Math.max(rows.length, originalRows.length) * w
  if (ctx.tableCells > ctx.limits.maxTableCells) throw new WordRefusalError('zip-bomb')
  const pad = (g: string[][]): string[][] => g.map((r) => (r.length < w ? [...r, ...Array(w - r.length).fill('')] : r))
  const padded = pad(rows)
  const paddedOriginal = pad(originalRows)
  // Both views will be written out: charge the escaped Markdown now, before anything is joined.
  chargeTable(padded, ctx.budget)
  chargeTable(paddedOriginal, ctx.budget)
  return { type: 'table', rows: padded, originalRows: paddedOriginal, changes: ctx.changes.slice(startChanges) }
}

/** Blocks of a container (the body, or a content control inside it), in order. */
export function readBlocks(container: XmlElement, ctx: BodyContext, out: RawBlock[]): void {
  for (const c of container.children) {
    if (isW(c, 'p')) {
      const { raw, figures } = readParagraph(c, ctx, false)
      if (raw) out.push({ kind: 'paragraph', raw })
      for (const f of figures) out.push({ kind: 'other', block: f })
    } else if (isW(c, 'tbl')) out.push({ kind: 'other', block: readTable(c, ctx) })
    else if (isW(c, 'sdt') || isW(c, 'sdtContent') || isW(c, 'customXml')) readBlocks(c, ctx, out)
  }
}

export function blockMarkdown(block: WordBlock, view: 'revised' | 'original'): string {
  switch (block.type) {
    case 'paragraph':
      return block[view]
    case 'table':
      return tableMarkdown(view === 'revised' ? block.rows : block.originalRows)
    case 'figure':
      return block.description ? `[figure here: ${escapeInline(block.description)}]` : '[figure here]'
  }
}
