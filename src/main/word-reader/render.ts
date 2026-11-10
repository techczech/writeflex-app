/**
 * Markdown from reading runs. Pure string work; no Markdown parser is involved because the output is
 * the reader's own, escaped so that a paragraph's words cannot become Markdown structure: not by what
 * is inside a line, nor by what starts a line (the first line of a paragraph or one after a line
 * break). Every scan is linear in the text: a hostile file can make a paragraph long, never slow.
 */

import { WordRefusalError } from './refusal'

export type Run = {
  text: string
  bold: boolean
  italic: boolean
  link: string | null
  /** Inside a reviewer's insertion (an insertion that was later deleted is both). */
  inserted: boolean
  deleted: boolean
  author?: string
  date?: string
}

const WS = /\s/

/** Escape what would change meaning inside a line. The line-start cases are handled in `escapeLineStart`. */
export function escapeInline(text: string): string {
  return text
    .replace(/[\\`*_[\]<>~^]/g, '\\$&')
    .replace(/={2,}|\+{2,}/g, (m) => m.replace(/./g, '\\$&'))
    .replace(/&(?=#?\w+;)/g, '\\&')
}

/** A line that starts with any of these can turn into a heading, quote, list, rule, fence, table or definition. */
const LINE_START = '#>+-=~|:'

function escapeLineStart(line: string): string {
  if (line === '') return line
  if (LINE_START.includes(line[0])) return `\\${line}`
  let i = 0
  while (i < line.length && i < 10 && line[i] >= '0' && line[i] <= '9') i++
  if (i > 0 && i < line.length && (line[i] === '.' || line[i] === ')')) return `${line.slice(0, i)}\\${line.slice(i)}`
  return line
}

/** Trim whitespace at both ends with index loops (no backtracking). */
function bounds(text: string): [number, number] {
  let a = 0
  let b = text.length
  while (a < b && WS.test(text[a])) a++
  while (b > a && WS.test(text[b - 1])) b--
  return [a, b]
}

const keep = {
  revised: (r: Run): boolean => !r.deleted,
  original: (r: Run): boolean => !r.inserted
}

export type View = keyof typeof keep

/** Merge neighbouring runs that share formatting so emphasis markers are not repeated mid-word. */
function mergedFor(runs: Run[], view: View): Run[] {
  const out: Run[] = []
  for (const r of runs) {
    if (!keep[view](r) || r.text === '') continue
    const last = out[out.length - 1]
    if (last && last.bold === r.bold && last.italic === r.italic && last.link === r.link) last.text += r.text
    else out.push({ ...r })
  }
  return out
}

export function plainOf(runs: Run[], view: View): string {
  return runs
    .filter(keep[view])
    .map((r) => r.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/** One run as Markdown with its italics, leaving bold and any link to the groups it sits in. */
function piece(r: Run, italicMark: string): string {
  const [a, b] = bounds(r.text)
  if (a === b) return r.text
  let body = escapeInline(r.text.slice(a, b)).replace(/\n/g, '  \n')
  if (r.italic) body = `${italicMark}${body}${italicMark}`
  return r.text.slice(0, a) + body + r.text.slice(b)
}

/** What is left of the output budget. Every piece is counted before it is joined on, so a file that
 *  asks for gigabytes of Markdown is refused after the first few megabytes, not after building them. */
export type OutputBudget = { left: number }

function spend(budget: OutputBudget, chars: number): void {
  budget.left -= chars
  if (budget.left < 0) throw new WordRefusalError('output-too-large')
}

/** Runs with no link between them: neighbouring bold runs share one pair of markers. `lead` is what
 *  comes just before, so two emphasis marks that would touch can be told apart. */
function emphasised(merged: Run[], lead: string, budget: OutputBudget): string {
  let out = ''
  const endsWithStar = (): boolean => (out === '' ? lead : out).endsWith('*')
  // Two emphasis marks touching (`**a**` then `*c*`) read as one run of stars; the second uses the
  // underscore form instead, which has no such ambiguity at a mark's edge.
  for (let i = 0; i < merged.length; ) {
    if (!merged[i].bold) {
      const run = merged[i++]
      let md = piece(run, '*')
      if (endsWithStar() && md.startsWith('*')) md = piece(run, '_')
      spend(budget, md.length)
      out += md
      continue
    }
    let group = ''
    while (i < merged.length && merged[i].bold) {
      const md = piece(merged[i++], '*')
      spend(budget, md.length)
      group += md
    }
    const [a, b] = bounds(group)
    const mark = a === 0 && endsWithStar() ? '__' : '**'
    spend(budget, 4)
    out += a === b ? group : `${group.slice(0, a)}${mark}${group.slice(a, b)}${mark}${group.slice(b)}`
  }
  return out
}

/** The paragraph's inline Markdown for one view. Whitespace stays outside emphasis markers, neighbouring
 *  bold runs share one pair of markers, and neighbouring runs under one link share one link, so a link
 *  target is written once however many differently formatted runs it covers. */
export function inlineMarkdown(runs: Run[], view: View, budget: OutputBudget): string {
  const merged = mergedFor(runs, view)
  let out = ''
  for (let i = 0; i < merged.length; ) {
    const link = merged[i].link
    let j = i + 1
    while (j < merged.length && merged[j].link === link) j++
    const segment = merged.slice(i, j)
    i = j
    if (link === null) {
      out += emphasised(segment, out, budget)
      continue
    }
    const inner = emphasised(segment, '', budget)
    const [a, b] = bounds(inner)
    if (a === b) {
      out += inner
      continue
    }
    spend(budget, link.length + 4)
    out += `${inner.slice(0, a)}[${inner.slice(a, b)}](${link})${inner.slice(b)}`
  }
  const [a, b] = bounds(out)
  // Each line is escaped for what could start a block; spaces before a hard break are kept, spaces that start a line are not.
  const lines = out.slice(a, b).split('\n')
  return lines.map((line, n) => escapeLineStart(n === 0 ? line : line.replace(/^[ \t]+/, ''))).join('\n')
}

export function escapeCell(text: string): string {
  return escapeInline(text).replace(/\|/g, '\\|')
}

/**
 * Charge the output budget with the Markdown a table will become: every cell as escaped (escaping can
 * double a cell), plus the pipes, spaces, separator row and line breaks around them. Called before the
 * table is joined, so escape-heavy cells are refused rather than built. A cell's own length is charged
 * first, so one huge cell is refused before it is escaped.
 */
export function chargeTable(rows: string[][], budget: OutputBudget): void {
  if (rows.length === 0) return
  let width = 0
  for (const r of rows) if (r.length > width) width = r.length
  // A row line is "| " + cells joined by " | " + " |"; the separator line is the same with "---" cells; one line break between lines.
  const frame = 4 + 3 * Math.max(0, width - 1)
  spend(budget, (rows.length + 1) * frame + 3 * width + rows.length)
  for (const r of rows) {
    for (let i = 0; i < width; i++) {
      const cell = r[i] ?? ''
      if (cell === '') continue
      spend(budget, cell.length)
      const extra = escapeCell(cell).length - cell.length
      if (extra > 0) spend(budget, extra)
    }
  }
}

export function tableMarkdown(rows: string[][]): string {
  if (rows.length === 0) return ''
  let width = 0
  for (const r of rows) if (r.length > width) width = r.length
  const line = (cells: string[]): string => `| ${Array.from({ length: width }, (_, i) => escapeCell(cells[i] ?? '')).join(' | ')} |`
  return [line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n')
}
