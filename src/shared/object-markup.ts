export type ObjectKind = 'table' | 'mermaid' | 'markmap' | 'svg'
export type TableAlignment = 'left' | 'center' | 'right'
export type TableModel = { cells: string[][]; alignments: TableAlignment[] }
export type FmEntry =
  | { kind: 'scalar'; key: string; value: string }
  | { kind: 'list'; key: string; values: string[] }
  | { kind: 'raw'; lines: string }

const FM_KEY = /^((?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[A-Za-z0-9_-]+)):(?:[ \t]*([\s\S]*))$/
const FM_DASH = /^[ \t]*-[ \t]+([\s\S]*)$/

function decodeYamlString(source: string): string | null {
  const value = source.trim()
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) return null
    try { const parsed = JSON.parse(value); return typeof parsed === 'string' ? parsed : null } catch { return null }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) return null
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

function inlineYamlList(source: string): string[] | null {
  const value = source.trim()
  if (!value.startsWith('[') || !value.endsWith(']')) return null
  const body = value.slice(1, -1)
  if (!body.trim()) return []
  const parts: string[] = []; let part = ''; let quote: '"' | "'" | null = null; let escaped = false
  for (const char of body) {
    if (escaped) { part += char; escaped = false; continue }
    if (quote === '"' && char === '\\') { part += char; escaped = true; continue }
    if (quote) { part += char; if (char === quote) quote = null; continue }
    if (char === '"' || char === "'") { quote = char; part += char; continue }
    if (char === ',') { parts.push(part); part = ''; continue }
    part += char
  }
  if (quote) return null
  parts.push(part)
  const decoded = parts.map(decodeYamlString)
  return decoded.some((item) => item === null) ? null : decoded as string[]
}

/** Parse only the safe, flat subset. Everything else remains one or more byte-exact raw runs. */
export function parseFrontmatterEntries(inner: string): FmEntry[] {
  if (inner === '') return []
  const lines = inner.split('\n'); const entries: FmEntry[] = []; let raw: string[] = []
  const flushRaw = (): void => { if (raw.length) { entries.push({ kind: 'raw', lines: raw.join('\n') }); raw = [] } }
  for (let index = 0; index < lines.length;) {
    const line = lines[index]; const match = FM_KEY.exec(line)
    if (!match || /^\s/.test(line)) { raw.push(line); index += 1; continue }
    const key = decodeYamlString(match[1]), tail = match[2]
    if (key === null) { raw.push(line); index += 1; continue }
    if (tail === '') {
      const listLines: string[] = []; const values: string[] = []; let cursor = index + 1
      while (cursor < lines.length) {
        const dash = FM_DASH.exec(lines[cursor]); if (!dash) break
        const decoded = decodeYamlString(dash[1]); if (decoded === null) break
        listLines.push(lines[cursor]); values.push(decoded); cursor += 1
      }
      if (listLines.length) { flushRaw(); entries.push({ kind: 'list', key, values }); index = cursor; continue }
      if (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) { raw.push(line); index += 1; continue }
      flushRaw(); entries.push({ kind: 'scalar', key, value: '' }); index += 1; continue
    }
    if (tail.startsWith('[')) {
      const values = inlineYamlList(tail)
      if (values !== null) { flushRaw(); entries.push({ kind: 'list', key, values }); index += 1; continue }
      raw.push(line); index += 1; continue
    }
    if (/^[|>]/.test(tail) || /\s+#/.test(tail)) { raw.push(line); index += 1; continue }
    const value = decodeYamlString(tail)
    if (value === null) { raw.push(line); index += 1; continue }
    flushRaw(); entries.push({ kind: 'scalar', key, value }); index += 1
  }
  flushRaw(); return entries
}

const YAML_SPECIAL_START = /^[\-?:,\[\]{}#&*!|>'"%@`]/
const YAML_IMPLICIT_NON_STRING = /^(?:~|null|no|yes|on|off|true|false)$/i
function yamlString(value: string): string {
  const needsQuote = value === '' || value.trim() !== value || /[:#'"\[\]{}]/.test(value) || YAML_SPECIAL_START.test(value)
    || YAML_IMPLICIT_NON_STRING.test(value) || /[\n\r\t\u0085\u2028\u2029]/.test(value)
  return needsQuote ? JSON.stringify(value) : value
}
function yamlKey(key: string): string { return /^[A-Za-z0-9_-]+$/.test(key) && key ? key : JSON.stringify(key) }
function yamlListString(value: string): string { return value.includes(',') && yamlString(value) === value ? JSON.stringify(value) : yamlString(value) }

/** Canonicalise structured entries while copying opaque entries without changing a byte. */
export function serialiseFrontmatterEntries(entries: readonly FmEntry[]): string {
  return entries.map((entry) => {
    if (entry.kind === 'raw') return entry.lines
    const key = yamlKey(entry.key)
    if (entry.kind === 'scalar') return `${key}: ${yamlString(entry.value)}`
    const dashed = entry.values.some((value) => value.length > 40 || yamlListString(value) !== value)
    return dashed
      ? `${key}:\n${entry.values.map((value) => `  - ${yamlListString(value)}`).join('\n')}`
      : `${key}: [${entry.values.map(yamlListString).join(', ')}]`
  }).join('\n')
}

const RECORDED_START = '<!-- writeflex:recorded:start -->'
const RECORDED_END = '<!-- writeflex:recorded:end -->'

function afterFollowingNewlines(doc: string, position: number): number {
  let safe = position
  while (doc[safe] === '\n' || doc[safe] === '\r') safe += 1
  return safe
}

/** Keep ordinary insertions out of leading frontmatter and recorded machine-owned blocks. */
export function frontmatterSafeInsertPosition(doc: string, position: number): number {
  const frontmatter = frontmatterBlock(doc)
  if (frontmatter) {
    const safe = afterFollowingNewlines(doc, frontmatter.end)
    if (position >= 0 && position <= safe) return safe
  }
  let from = 0
  while (from < doc.length) {
    const start = doc.indexOf(RECORDED_START, from)
    if (start === -1) break
    const closingStart = doc.indexOf(RECORDED_END, start + RECORDED_START.length)
    if (closingStart === -1) break
    const end = closingStart + RECORDED_END.length
    const safe = afterFollowingNewlines(doc, end)
    if (position >= start && position <= safe) return safe
    from = end
  }
  return position
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/)
    .map((value) => value.trim().replace(/\\\|/g, '|').replace(/<br\s*\/?>/gi, '\n'))
}

export function parseTable(source: string): TableModel | null {
  const lines = source.trim().split('\n')
  if (lines.length < 2) return null
  const all = lines.map(tableCells)
  const separators = all[1]
  if (!lines[0].includes('|') || !lines[1].includes('|') || all[0].length !== separators.length || !separators.every((value) => /^:?-{3,}:?$/.test(value))) return null
  if (all.slice(2).some((row) => row.length !== separators.length)) return null
  return {
    cells: [all[0], ...all.slice(2)],
    alignments: separators.map((value) => value.startsWith(':') && value.endsWith(':') ? 'center' : value.endsWith(':') ? 'right' : 'left'),
  }
}

/**
 * Lenient reading of hand-typed pipe-table text: blank lines are dropped, the second line must be a
 * separator row, the width is the widest header/body row (the separator's own width is ignored), short
 * rows are padded and alignment markers survive per column. Null = the text is not a table at all.
 */
export function repairTable(source: string): TableModel | null {
  const lines = source.replace(/\r/g, '').split('\n').filter((line) => line.trim() !== '')
  if (lines.length < 2 || !lines[0].includes('|') || !lines[1].includes('|')) return null
  const separators = tableCells(lines[1])
  if (!separators.every((value) => /^:?-+:?$/.test(value))) return null
  const rows = [lines[0], ...lines.slice(2)].map(tableCells)
  const width = widestRow(rows)
  return {
    cells: rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? '')),
    alignments: Array.from({ length: width }, (_, index): TableAlignment => {
      const value = separators[index] ?? ''
      return value.length > 1 && value.startsWith(':') && value.endsWith(':') ? 'center' : value.endsWith(':') && value.length > 1 ? 'right' : 'left'
    }),
  }
}

/** The length of the longest row, 0 for no rows. A loop: `Math.max(...rows.map(...))` passes one argument
 *  per row and overflows the stack on a table of a few hundred thousand rows. */
function widestRow(rows: readonly (readonly string[])[]): number {
  let width = 0
  for (const row of rows) if (row.length > width) width = row.length
  return width
}

/** The canonical, valid Markdown for hand-typed table text, or null when it is not a table. */
export function normaliseTableMarkup(source: string): string | null {
  const table = repairTable(source)
  return table ? serialiseTable(table) : null
}

function tableCell(value: string): string { return value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>') }
export function serialiseTable(table: TableModel): string {
  const width = Math.max(widestRow(table.cells), 1)
  const rows = table.cells.filter((row, index) => index === 0 || row.some((value) => value.trim()))
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => tableCell(row[index] ?? '')).join(' | ')} |`
  const separators = Array.from({ length: width }, (_, index) => table.alignments[index] ?? 'left').map((alignment) => alignment === 'center' ? ':---:' : alignment === 'right' ? '---:' : ':---')
  return [line(rows[0] ?? Array(width).fill('')), line(separators), ...rows.slice(1).map(line)].join('\n')
}

const MERMAID_TYPES = new Set(['flowchart', 'graph', 'sequenceDiagram', 'stateDiagram', 'stateDiagram-v2', 'pie', 'gantt', 'journey', 'classDiagram', 'erDiagram', 'mindmap', 'timeline'])

function delimiterError(line: string): string | null {
  const stack: string[] = []
  const closes: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if ((char === '"' || char === "'") && line[i - 1] !== '\\') { quote = quote === char ? null : quote ?? char; continue }
    if (quote) continue
    if ('([{'.includes(char)) stack.push(char)
    else if (')]}'.includes(char) && stack.pop() !== closes[char]) return 'brackets'
  }
  return quote ? 'quotes' : stack.length ? 'brackets' : null
}

export function validateObjectMarkup(kind: ObjectKind, content: string): void {
  const inner = content.trim()
  if (!inner) throw new Error(`${kind} content must not be empty; provide inner markup without fences and retry.`)
  if (kind === 'svg') {
    if (/^```/m.test(inner)) throw new Error('SVG content must be inner markup without fences; remove the fences and retry.')
    if (!/^<svg(?:\s|>)/i.test(inner) || !/(?:<\/svg\s*>|<svg\b[^>]*\/\s*>)$/i.test(inner)) {
      throw new Error('SVG content must be one complete SVG document with an <svg> root; correct the markup and retry.')
    }
    return
  }
  if (kind === 'table') {
    if (!parseTable(inner)) throw new Error('Table content must be a valid pipe table with a header, a matching `---` separator row, and the same number of cells on every row; correct the table and retry.')
    return
  }
  const lines = inner.split('\n')
  if (kind === 'markmap') {
    let previousLevel = 0
    lines.forEach((line, index) => {
      if (!/^\s*- /.test(line)) throw new Error(`Markmap line ${index + 1} must begin with "- " after optional two-space indentation; correct the list and retry.`)
      const spaces = line.match(/^\s*/)?.[0].length ?? 0
      if (spaces % 2 !== 0) throw new Error(`Markmap line ${index + 1} must use indentation steps of two spaces; correct the indentation and retry.`)
      const level = spaces / 2
      if (level > previousLevel + 1) throw new Error(`Markmap line ${index + 1} jumps more than one level; indent by at most one level at a time and retry.`)
      previousLevel = level
    })
    return
  }
  const meaningful = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.trim())
  const firstWord = meaningful[0]?.line.trim().split(/\s+/)[0] ?? ''
  if (!MERMAID_TYPES.has(firstWord)) throw new Error(`Mermaid content must start with a supported diagram type (flowchart, graph, sequenceDiagram, stateDiagram-v2, pie, gantt, journey, classDiagram, erDiagram, mindmap, or timeline); correct the first line and retry.`)
  if (meaningful.length < 2) throw new Error('Mermaid content needs a non-empty diagram body after its type declaration; add at least one statement and retry.')
  for (const { line, index } of meaningful) {
    const problem = delimiterError(line)
    if (problem) throw new Error(`Mermaid content has unbalanced ${problem} on line ${index + 1}; balance them and retry.`)
  }
}

export function objectBlock(kind: ObjectKind, content: string): string {
  const inner = content.trimEnd()
  return kind === 'table' ? inner : `\`\`\`${kind}\n${inner}\n\`\`\``
}
import { frontmatterBlock } from './markdown/frontmatter'
