/**
 * TEST-ONLY reference reading of the standard-widget and resource rules. Not production code and never imported
 * from src/: it exists so the fixtures' expected outputs and expected errors are checked against an actual
 * reading of each fixture, record by record and field by field, instead of "the value occurs somewhere".
 * The app's real adapters are tested against these fixtures; any disagreement with this file is a question
 * about the rules, not a licence to edit the expected files.
 *
 * Identity comes from the app itself: `nativeSlug` asks the native Markdown renderer for a heading id
 * (`toHtml` with stable heading ids), because `slug` in src/shared/markdown/to-html.ts is not exported.
 */
import { posix } from 'node:path'
import { manifestFilePathCandidates, type Folio } from '../../src/main/folio'
import { toHtml } from '../../src/shared/markdown/to-html'
import { eachInline, readDocument, type Inline } from '../../src/shared/markdown/model'
import { parseMarkdown } from '../../src/shared/markdown/dialect'
import { frontmatterBlock } from '../../src/shared/markdown/frontmatter'

export type RefError = { code: string } & Record<string, unknown>
type Result<T> = { ok: true; value: T } | { ok: false; errors: RefError[] }
const fail = <T>(...errors: RefError[]): Result<T> => ({ ok: false, errors })

// ---------------------------------------------------------------- identity

const slugCache = new Map<string, string>()
/** The native heading id of `text` (to-html.ts `slug`, `section` fallback included), read from the renderer. */
export function nativeSlug(text: string): string {
  const cached = slugCache.get(text)
  if (cached !== undefined) return cached
  const match = toHtml(`# ${text}`, { stableHeadingIds: true }).html.match(/<h1 id="([^"]*)"/)
  if (!match) throw new Error(`the renderer gave no heading id for ${JSON.stringify(text)}`)
  slugCache.set(text, match[1])
  return match[1]
}
/** An id is valid when the native slug leaves it unchanged and it is at most 80 characters. */
export const isSlugId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 80 && nativeSlug(value) === value

// ---------------------------------------------------------------- recipe (nested subset)

export type Yaml = string | number | Yaml[] | { [key: string]: Yaml }
export type YamlMap = { [key: string]: Yaml }

function scalar(raw: string): Yaml {
  const value = raw.trim()
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1).split(',').map((part) => part.trim()).filter((part) => part !== '').map(scalar)
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^(["']).*\1$/.test(value)) return value.slice(1, -1)
  return value
}

/** The documented subset: maps by two-space indent, `key: scalar`, inline flow lists of scalars. */
export function parseRecipe(text: string): Result<{ recipe: YamlMap; body: string }> {
  const lines = text.split('\n')
  if (lines[0] !== '---') return fail({ code: 'recipe-unreadable', detail: 'no frontmatter' })
  const close = lines.indexOf('---', 1)
  if (close < 0) return fail({ code: 'recipe-unreadable', detail: 'frontmatter never closed' })
  const root: YamlMap = {}
  const stack: Array<{ indent: number; map: YamlMap }> = [{ indent: -1, map: root }]
  for (let i = 1; i < close; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = line.match(/^( *)([^\s:][^:]*?):(?:\s+(.*))?$/)
    if (!match || match[1].length % 2 !== 0) return fail({ code: 'recipe-unreadable', line: i + 1 })
    const indent = match[1].length
    while (stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack[stack.length - 1].map
    if (match[3] === undefined || match[3].trim() === '') {
      const child: YamlMap = {}
      parent[match[2]] = child
      stack.push({ indent, map: child })
    } else parent[match[2]] = scalar(match[3])
  }
  return { ok: true, value: { recipe: root, body: lines.slice(close + 1).join('\n') } }
}

const STRUCTURED = ['structured-markdown', 'structured-text']
const TABULAR = ['csv', 'json', 'markdown-table']
const FORMATS = [...TABULAR, ...STRUCTURED, 'folder']
const TEMPLATES: Record<string, { formats: string[]; views: string[]; required: string[] }> = {
  // The browser path starts from CSV or a JSON array; structured text is the other browser source.
  browser: { formats: [...STRUCTURED, 'csv', 'json'], views: ['browser', 'list'], required: ['title', 'detail'] },
  pyramid: { formats: STRUCTURED, views: ['pyramid', 'list', 'table'], required: ['title', 'detail'] },
  'data-explorer': { formats: TABULAR, views: ['table', 'cards', 'bar', 'line', 'scatter'], required: ['title'] },
  'file-catalogue': { formats: ['folder'], views: ['tree', 'list'], required: [] },
  calendar: { formats: TABULAR, views: ['month', 'agenda', 'timeline'], required: ['id', 'title', 'start'] },
  timeline: { formats: TABULAR, views: ['timeline', 'agenda', 'month'], required: ['id', 'title', 'start'] },
}
const isMap = (value: unknown): value is YamlMap => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Recipe rules. Header errors (schema, template, version) stop the check; the rest are collected. */
export function checkRecipe(recipe: YamlMap): RefError[] {
  if (recipe.widget_schema !== 1) return [{ code: 'recipe-schema-unsupported', value: recipe.widget_schema }]
  if (typeof recipe.template !== 'string') return [{ code: 'recipe-invalid', field: 'template' }]
  const template = TEMPLATES[recipe.template]
  if (!template) return [{ code: 'recipe-unknown-template', value: recipe.template }]
  if (recipe.template_version !== 1) return [{ code: 'recipe-template-version-unsupported', value: recipe.template_version }]
  const errors: RefError[] = []
  const source = recipe.source
  if (!isMap(source) || typeof source.format !== 'string' || !FORMATS.includes(source.format)) return [{ code: 'recipe-invalid', field: 'source.format' }]
  const select = source.select
  if (source.format === 'folder') {
    if (!isMap(select) || typeof select.folder !== 'string') errors.push({ code: 'recipe-invalid', field: 'source.select.folder' })
  } else if ((typeof source.path === 'string') === (typeof source.resource === 'string')) errors.push({ code: 'recipe-invalid', field: 'source', detail: 'exactly one of path and resource' })
  // Selectors, checked before any adapter is reached: `json` needs `{ pointer }` (RFC 6901, `""` = root);
  // structured sources need `{ level }` 1-6 and, when present, a string `section`.
  if (source.format === 'json' && !(isMap(select) && typeof select.pointer === 'string' && (select.pointer === '' || select.pointer.startsWith('/')))) {
    errors.push({ code: 'recipe-invalid', field: 'source.select.pointer' })
  }
  if (STRUCTURED.includes(source.format)) {
    if (!isMap(select) || typeof select.level !== 'number' || !Number.isInteger(select.level) || select.level < 1 || select.level > 6) errors.push({ code: 'recipe-invalid', field: 'source.select.level' })
    else if ('section' in select && typeof select.section !== 'string') errors.push({ code: 'recipe-invalid', field: 'source.select.section' })
  }
  if (!template.formats.includes(source.format)) errors.push({ code: 'recipe-mapping-incompatible', field: 'source.format', value: source.format })
  const views = recipe.views
  if (!Array.isArray(views) || views.length === 0 || views.some((view) => typeof view !== 'string' || !template.views.includes(view))) errors.push({ code: 'recipe-invalid', field: 'views' })
  const mapping = isMap(recipe.mapping) ? recipe.mapping : {}
  for (const key of template.required) if (typeof mapping[key] !== 'string') errors.push({ code: 'recipe-mapping-missing', field: `mapping.${key}` })
  const types = isMap(mapping.types) ? mapping.types : {}
  const chart = isMap(recipe.chart) ? recipe.chart : {}
  const viewList = Array.isArray(views) ? views : []
  const need = (key: string): string | null => {
    if (typeof chart[key] === 'string') return chart[key] as string
    errors.push({ code: 'recipe-mapping-missing', field: `chart.${key}` })
    return null
  }
  const numberField = (key: string, field: string | null, allowed: string[], detail: string): void => {
    if (field !== null && !allowed.includes(types[field] as string)) errors.push({ code: 'recipe-mapping-incompatible', field: `chart.${key}`, value: field, detail })
  }
  if (viewList.includes('bar')) {
    need('category')
    const metric = need('metric')
    if (metric !== null && !['count', 'sum', 'mean'].includes(metric)) errors.push({ code: 'recipe-invalid', field: 'chart.metric', value: metric })
    if (metric === 'sum' || metric === 'mean') numberField('measure', need('measure'), ['number'], 'sum and mean need a number field')
  }
  if (viewList.includes('line')) {
    numberField('x', need('x'), ['number', 'date', 'datetime'], 'a line needs an ordered number or date axis')
    numberField('y', need('y'), ['number'], 'a line needs a number field')
  }
  if (viewList.includes('scatter')) {
    numberField('x', need('x'), ['number'], 'scatter needs two number fields')
    numberField('y', need('y'), ['number'], 'scatter needs two number fields')
  }
  return errors
}

/** Every source field a recipe names (pseudo-fields of structured sources excluded). */
export function mappedFields(recipe: YamlMap): string[] {
  const mapping = isMap(recipe.mapping) ? recipe.mapping : {}
  const chart = isMap(recipe.chart) ? recipe.chart : {}
  const names: string[] = []
  const add = (value: Yaml | undefined): void => {
    if (typeof value === 'string') names.push(value)
    else if (Array.isArray(value)) value.forEach(add)
  }
  for (const key of ['id', 'title', 'detail', 'group', 'tags', 'columns', 'search', 'filters', 'start', 'end', 'zone', 'category', 'lane', 'resource']) add(mapping[key])
  for (const key of ['category', 'measure', 'x', 'y']) add(chart[key])
  if (isMap(mapping.types)) names.push(...Object.keys(mapping.types))
  return [...new Set(names)]
}

// ---------------------------------------------------------------- tabular core

export type TabularRecord = { id: string; id_origin: 'mapped'; locator: Record<string, unknown>; values: Record<string, string | null>; typed?: Record<string, number | null> }
export type RecordSet = { source: { path: string; format: string }; selection: unknown; fields?: Array<{ key: string; label: string }>; records: unknown[] }
type Row = { locator: Record<string, unknown>; at: Record<string, unknown>; values: Record<string, string | null> }
export type TabularOptions = { idField?: string; types?: Record<string, string>; mapped?: string[] }

const NUMBER = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/

/** Column check, ids, declared number types and emptiness: the same for CSV, Markdown tables and JSON. */
function tabular(source: RecordSet['source'], selection: unknown, fields: RecordSet['fields'] & object, rows: Row[], options: TabularOptions): Result<RecordSet> {
  const keys = new Set(fields.map((field) => field.key))
  const missing = [...new Set(options.mapped ?? [])].filter((name) => !keys.has(name)).sort()
  if (missing.length > 0) return fail(...missing.map((field) => ({ code: 'column-missing', field })))
  const errors: RefError[] = []
  const seen = new Map<string, Row>()
  const records = rows.map((row, index): TabularRecord => {
    const record = index + 1
    const id = options.idField === undefined ? '' : row.values[options.idField] ?? ''
    if (options.idField !== undefined) {
      if (id === '') errors.push({ code: 'id-missing', ...row.at, record, field: options.idField })
      else if (seen.has(id)) errors.push({ code: 'id-duplicate', ...row.at, record, field: options.idField, value: id, ...firstAt(seen.get(id)!) })
      else seen.set(id, row)
    }
    const out: TabularRecord = { id, id_origin: 'mapped', locator: row.locator, values: row.values }
    if (options.types) {
      out.typed = {}
      for (const [field, type] of Object.entries(options.types)) {
        if (type !== 'number') continue
        const raw = row.values[field]
        if (raw === null || raw === '' || raw === undefined) out.typed[field] = null
        else if (NUMBER.test(raw)) out.typed[field] = Number(raw)
        else errors.push({ code: 'value-invalid-number', ...row.at, record, field, value: raw })
      }
    }
    return out
  })
  if (errors.length > 0) return fail(...errors)
  if (records.length === 0) return fail({ code: 'source-empty' })
  return { ok: true, value: { source, selection, fields, records } }
}
const firstAt = (row: Row): Record<string, unknown> => 'line' in row.at ? { first_line: row.at.line } : { first_pointer: row.at.pointer }

// ---------------------------------------------------------------- CSV (RFC 4180)

export function parseCsv(text: string): Result<Array<{ line: number; cells: string[] }>> {
  const input = text.startsWith('﻿') ? text.slice(1) : text
  const rows: Array<{ line: number; cells: string[] }> = []
  let line = 1
  let i = 0
  while (i < input.length) {
    const start = line
    const cells: string[] = []
    for (;;) {
      let cell = ''
      if (input[i] === '"') {
        const opened = line
        i += 1
        for (;;) {
          if (i >= input.length) return fail({ code: 'csv-malformed', line: opened, detail: 'a quoted field is never closed' })
          const char = input[i]
          if (char === '"' && input[i + 1] === '"') { cell += '"'; i += 2; continue }
          if (char === '"') { i += 1; break }
          if (char === '\n') line += 1
          cell += char
          i += 1
        }
        if (i < input.length && input[i] !== ',' && input[i] !== '\n' && input[i] !== '\r') return fail({ code: 'csv-malformed', line, detail: 'text after a closing quote' })
      } else {
        while (i < input.length && input[i] !== ',' && input[i] !== '\n' && input[i] !== '\r') cell += input[i++]
      }
      cells.push(cell)
      if (input[i] === ',') { i += 1; continue }
      if (input[i] === '\r') i += 1
      if (input[i] === '\n') { i += 1; line += 1 }
      break
    }
    rows.push({ line: start, cells })
  }
  return { ok: true, value: rows }
}

export function csvAdapter(path: string, text: string, options: TabularOptions): Result<RecordSet> {
  const parsed = parseCsv(text)
  if (!parsed.ok) return parsed
  const [header, ...body] = parsed.value
  if (!header) return fail({ code: 'source-empty' })
  const errors: RefError[] = []
  const seen = new Set<string>()
  for (const name of header.cells) {
    if (name === '') errors.push({ code: 'csv-header-empty', line: 1 })
    else if (seen.has(name)) errors.push({ code: 'csv-header-duplicate', line: 1, field: name })
    seen.add(name)
  }
  for (const row of body) {
    if (row.cells.length !== header.cells.length) errors.push({ code: 'csv-malformed', line: row.line, detail: `expected ${header.cells.length} fields, found ${row.cells.length}` })
  }
  if (errors.length > 0) return fail(...errors)
  const fields = header.cells.map((key) => ({ key, label: key }))
  const rows = body.map((row, index): Row => ({
    locator: { line: row.line, record: index + 1 },
    at: { line: row.line },
    values: Object.fromEntries(header.cells.map((key, column) => [key, row.cells[column]])),
  }))
  return tabular({ path, format: 'csv' }, null, fields, rows, options)
}

// ---------------------------------------------------------------- Markdown headings and tables

type Heading = { line: number; level: number; text: string }

const HEADING_NODES: Record<string, number> = {
  ATXHeading1: 1, ATXHeading2: 2, ATXHeading3: 3, ATXHeading4: 4, ATXHeading5: 5, ATXHeading6: 6, SetextHeading1: 1, SetextHeading2: 2,
}
const CODE_NODES = new Set(['FencedCode', 'CodeBlock'])

/**
 * Record boundaries as the app's own Markdown parser reads them: `parseMarkdown` (dialect.ts), the parser
 * `readDocument` (model.ts) runs. `readDocument`'s model carries no source positions, and records need their
 * heading line and an exact body slice, so the same parser is asked here with positions kept. Only top-level
 * heading nodes are headings; a `#` line inside any fenced (``` or ````, ~~~) or indented code block is code and
 * never a record. Frontmatter (the app's own `frontmatterBlock`) is blanked line for line before the parse so
 * line numbers stay those of the file; `skip` is every frontmatter or code line (for the table scan).
 */
function headingsOf(text: string): { headings: Heading[]; skip: Set<number> } {
  const front = frontmatterBlock(text)
  const prepared = front === null ? text : text.slice(0, front.end).replace(/[^\n]/g, '') + text.slice(front.end)
  const starts = [0]
  for (let i = 0; i < prepared.length; i += 1) if (prepared[i] === '\n') starts.push(i + 1)
  const lineAt = (offset: number): number => { let lo = 0; let hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1 } return lo }
  const skip = new Set<number>()
  if (front !== null) {
    const block = text.slice(0, front.end)
    const count = block.split('\n').length - (block.endsWith('\n') ? 1 : 0)
    for (let i = 0; i < count; i += 1) skip.add(i)
  }
  const headings: Heading[] = []
  const tree = parseMarkdown(prepared)
  tree.iterate({
    enter: (node) => {
      if (CODE_NODES.has(node.name)) { for (let i = lineAt(node.from), last = lineAt(Math.max(node.to - 1, node.from)); i <= last; i += 1) skip.add(i); return false }
      const level = HEADING_NODES[node.name]
      if (level === undefined) return undefined
      if (node.node.parent?.name === 'Document') {
        const marks: Array<{ from: number; to: number }> = []
        for (let child = node.node.firstChild; child; child = child.nextSibling) if (child.name === 'HeaderMark') marks.push({ from: child.from, to: child.to })
        const atx = node.name.startsWith('ATX')
        const from = atx && marks[0] ? marks[0].to : node.from
        const to = atx ? (marks.length > 1 ? marks[marks.length - 1].from : node.to) : marks[marks.length - 1]?.from ?? node.to
        headings.push({ line: lineAt(node.from) + 1, level, text: prepared.slice(from, to).trim() })
      }
      return false
    },
  })
  return { headings, skip }
}

const cellsOf = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  .split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

export function markdownTableAdapter(path: string, text: string, selection: { heading?: string; index?: number } | null, options: TabularOptions): Result<RecordSet> {
  const lines = text.split('\n')
  const { headings, skip } = headingsOf(text)
  const tables: Array<{ line: number; header: string[]; rows: Array<{ line: number; cells: string[] }> }> = []
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (skip.has(i) || !lines[i].includes('|') || !DELIMITER.test(lines[i + 1])) continue
    const table = { line: i + 1, header: cellsOf(lines[i]), rows: [] as Array<{ line: number; cells: string[] }> }
    let j = i + 2
    for (; j < lines.length && lines[j].includes('|') && lines[j].trim() !== ''; j += 1) table.rows.push({ line: j + 1, cells: cellsOf(lines[j]) })
    tables.push(table)
    i = j - 1
  }
  let scope = tables
  if (selection?.heading !== undefined) {
    const heading = headings.find((candidate) => candidate.text === selection.heading)
    const end = heading ? headings.find((h) => h.line > heading.line && h.level <= heading.level)?.line ?? Infinity : -1
    scope = heading ? tables.filter((table) => table.line > heading.line && table.line < end) : []
    if (scope.length === 0) return fail({ code: 'table-not-found', detail: `no table under the heading ${selection.heading}` })
  }
  if (selection === null || selection.index === undefined) {
    if (scope.length > 1) return fail({ code: 'table-ambiguous', detail: `${scope.length} tables; choose one` })
    if (scope.length === 0) return fail({ code: 'table-not-found', detail: 'no table in the file' })
  }
  const index = selection?.index ?? 1
  const table = scope[index - 1]
  if (!table) return fail({ code: 'table-not-found', detail: `no table ${index}` })
  const headingText = [...headings].reverse().find((heading) => heading.line < table.line)?.text ?? null
  const fields = table.header.map((key) => ({ key, label: key }))
  const rows = table.rows.map((row, record): Row => ({
    locator: { line: row.line, record: record + 1, table: index, heading: headingText },
    at: { line: row.line },
    values: Object.fromEntries(table.header.map((key, column) => [key, row.cells[column] ?? ''])),
  }))
  return tabular({ path, format: 'markdown-table' }, selection, fields, rows, options)
}

// ---------------------------------------------------------------- JSON (number spelling kept)

type JsonNode =
  | { kind: 'object'; line: number; entries: Array<[string, JsonNode]> }
  | { kind: 'array'; line: number; items: JsonNode[] }
  | { kind: 'string' | 'number' | 'boolean'; line: number; text: string }
  | { kind: 'null'; line: number }

/** A small JSON reader that keeps each number as its source token and each value's starting line. */
export function parseJson(text: string): Result<JsonNode> {
  let i = 0
  let line = 1
  const malformed = (): never => { throw { code: 'json-malformed', line } }
  const space = (): void => {
    while (i < text.length && /\s/.test(text[i])) { if (text[i] === '\n') line += 1; i += 1 }
  }
  const stringToken = (): string => {
    const start = i
    i += 1
    while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i += 1; if (text[i] === '\n') malformed(); i += 1 }
    if (i >= text.length) malformed()
    i += 1
    return JSON.parse(text.slice(start, i)) as string
  }
  const value = (): JsonNode => {
    space()
    const at = line
    const char = text[i]
    if (char === '{') {
      i += 1
      const entries: Array<[string, JsonNode]> = []
      space()
      if (text[i] === '}') { i += 1; return { kind: 'object', line: at, entries } }
      for (;;) {
        space()
        if (text[i] !== '"') malformed()
        const key = stringToken()
        space()
        if (text[i] !== ':') malformed()
        i += 1
        entries.push([key, value()])
        space()
        if (text[i] === ',') { i += 1; continue }
        if (text[i] === '}') { i += 1; return { kind: 'object', line: at, entries } }
        malformed()
      }
    }
    if (char === '[') {
      i += 1
      const items: JsonNode[] = []
      space()
      if (text[i] === ']') { i += 1; return { kind: 'array', line: at, items } }
      for (;;) {
        items.push(value())
        space()
        if (text[i] === ',') { i += 1; continue }
        if (text[i] === ']') { i += 1; return { kind: 'array', line: at, items } }
        malformed()
      }
    }
    if (char === '"') return { kind: 'string', line: at, text: stringToken() }
    const literal = text.slice(i).match(/^(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/)?.[1]
    if (!literal) return malformed()
    i += literal.length
    if (literal === 'null') return { kind: 'null', line: at }
    return { kind: literal === 'true' || literal === 'false' ? 'boolean' : 'number', line: at, text: literal }
  }
  try {
    const root = value()
    space()
    if (i !== text.length) malformed()
    return { ok: true, value: root }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) return fail(error as RefError)
    throw error
  }
}

const escapePointer = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1')
const unescapePointer = (part: string): string => part.replace(/~1/g, '/').replace(/~0/g, '~')

/** Scalar leaves by pointer, in source order. Arrays are not record fields in adapter-output/1. */
function leaves(node: JsonNode, prefix: string, out: Array<[string, string | null]>): void {
  if (node.kind === 'object') for (const [key, child] of node.entries) leaves(child, `${prefix}/${escapePointer(key)}`, out)
  else if (node.kind === 'null') out.push([prefix, null])
  else if (node.kind !== 'array') out.push([prefix, node.text])
}

export function jsonAdapter(path: string, text: string, selection: { pointer: string }, options: TabularOptions): Result<RecordSet> {
  const parsed = parseJson(text)
  if (!parsed.ok) return parsed
  let node: JsonNode | undefined = parsed.value
  for (const part of selection.pointer === '' ? [] : selection.pointer.split('/').slice(1).map(unescapePointer)) {
    if (node?.kind === 'object') node = node.entries.find(([key]) => key === part)?.[1]
    else if (node?.kind === 'array' && /^(0|[1-9]\d*)$/.test(part)) node = node.items[Number(part)]
    else node = undefined
  }
  if (!node) return fail({ code: 'json-selector-not-found', pointer: selection.pointer })
  if (node.kind !== 'array') return fail({ code: 'json-selector-not-array', pointer: selection.pointer })
  const notObjects = node.items.flatMap((item, index) => item.kind === 'object' ? [] : [{ code: 'json-record-not-object', pointer: `${selection.pointer}/${index}`, record: index + 1 }])
  if (notObjects.length > 0) return fail(...notObjects)
  const fieldKeys: string[] = []
  const rows = node.items.map((item, index): Row => {
    const found: Array<[string, string | null]> = []
    leaves(item, '', found)
    for (const [key] of found) if (!fieldKeys.includes(key)) fieldKeys.push(key)
    const pointer = `${selection.pointer}/${index}`
    return { locator: { pointer, line: item.line }, at: { pointer }, values: Object.fromEntries(found) }
  })
  const fields = fieldKeys.map((key) => ({ key, label: key.split('/').slice(1).map(unescapePointer).join(' ') }))
  return tabular({ path, format: 'json' }, selection, fields, rows, options)
}

// ---------------------------------------------------------------- structured Markdown / text

export type StructuredRecord = {
  id: string; id_origin: 'fields' | 'heading'; locator: { line: number; heading_level: number }
  title: string; group_path: string[]; fields: Record<string, string | string[]>; body_markdown: string; position: number
}

export function structuredAdapter(path: string, format: string, text: string, selection: { section?: string | null; level: number }): Result<RecordSet> {
  const lines = text.split('\n')
  const { headings } = headingsOf(text)
  let scope = headings
  let scopeEnd = lines.length + 1
  if (selection.section != null) {
    const at = headings.findIndex((heading) => heading.text === selection.section)
    if (at < 0) return fail({ code: 'section-not-found', detail: `no heading named ${selection.section}` })
    const section = headings[at]
    scopeEnd = headings.slice(at + 1).find((heading) => heading.level <= section.level)?.line ?? lines.length + 1
    scope = headings.slice(at + 1).filter((heading) => heading.line < scopeEnd)
  }
  const errors: RefError[] = []
  const records: StructuredRecord[] = []
  const seen = new Map<string, number>()
  const stack: Heading[] = []
  scope.forEach((heading, index) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop()
    const ancestors = stack.map((entry) => entry.text)
    stack.push(heading)
    if (heading.level !== selection.level) return
    const record = records.length + 1
    const end = scope.slice(index + 1).find((next) => next.level <= heading.level)?.line ?? scopeEnd
    let cursor = heading.line // 0-based index of the line after the heading
    while (cursor < end - 1 && lines[cursor].trim() === '') cursor += 1
    const fields: Record<string, string | string[]> = {}
    if (lines[cursor] === '```fields') {
      const close = lines.indexOf('```', cursor + 1)
      if (close < 0 || close >= end - 1) { errors.push({ code: 'fields-block-malformed', line: cursor + 1, record }); return }
      for (let i = cursor + 1; i < close; i += 1) {
        if (lines[i].trim() === '') continue
        const match = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
        if (!match) { errors.push({ code: 'fields-block-malformed', line: i + 1, record }); return }
        const value = match[2].trim()
        fields[match[1]] = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1).split(',').map((part) => part.trim()).filter(Boolean) : value
      }
      cursor = close + 1
    }
    const body = lines.slice(cursor, end - 1)
    while (body.length > 0 && body[0].trim() === '') body.shift()
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
    const fromFields = typeof fields.id === 'string'
    const id = fromFields ? fields.id as string : nativeSlug(heading.text)
    if (seen.has(id)) errors.push({ code: 'id-duplicate', line: heading.line, record, field: fromFields ? 'id' : 'heading', value: id, first_line: seen.get(id) })
    else seen.set(id, heading.line)
    records.push({
      id, id_origin: fromFields ? 'fields' : 'heading', locator: { line: heading.line, heading_level: heading.level },
      title: heading.text, group_path: ancestors, fields, body_markdown: body.join('\n'), position: record,
    })
  })
  if (errors.length > 0) return fail(...errors)
  if (records.length === 0) return fail({ code: 'structure-no-records' })
  return { ok: true, value: { source: { path, format }, selection, records } }
}

// ---------------------------------------------------------------- events

const zoneParts = (instant: number, zone: string): Record<string, string> => Object.fromEntries(
  new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' })
    .formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
)
export const wallTime = (instant: number, zone: string): string => { const p = zoneParts(instant, zone); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` }
export const zoneOffset = (instant: number, zone: string): string => { const name = zoneParts(instant, zone).timeZoneName; return name === 'GMT' ? '+00:00' : name.slice(3) }
const offsetMinutes = (offset: string): number => (offset[0] === '-' ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)))
const iso = (instant: number): string => new Date(instant).toISOString().replace('.000Z', 'Z')
const validZone = (zone: string): boolean => { try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); return true } catch { return false } }

type ZonedTime = { local: string; zone: string; offset: string; instant: string }
/** `seconds` is the authored `:SS` (null when none was written); it is carried into the instant, never dropped. */
type Parsed = { kind: 'date'; date: string } | { kind: 'time'; local: string; seconds: string | null; offset: string | null }

const LEAP = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
/** A calendar date is checked by its components; `Date.parse` is never the judge (it normalises 2026-02-30). */
const realDay = (year: number, month: number, day: number): boolean =>
  month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 ? (LEAP(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31)

function parseDateValue(raw: string): Parsed | null {
  const date = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (date) return realDay(Number(date[1]), Number(date[2]), Number(date[3])) ? { kind: 'date', date: raw } : null
  const time = raw.match(/^((\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}))(?::(\d{2}))?(Z|[+-](\d{2}):(\d{2}))?$/)
  if (!time || !realDay(Number(time[2]), Number(time[3]), Number(time[4]))) return null
  if (Number(time[5]) > 23 || Number(time[6]) > 59 || (time[7] !== undefined && Number(time[7]) > 59)) return null
  if (time[9] !== undefined && (Number(time[9]) > 23 || Number(time[10]) > 59)) return null
  return { kind: 'time', local: time[1], seconds: time[7] ?? null, offset: time[8] === undefined ? null : time[8] === 'Z' ? '+00:00' : time[8] }
}

/** Resolve a wall time in a zone; every candidate instant is returned so ambiguity and gaps are visible. Seconds
 *  ride along: zone transitions fall on whole minutes, so the minute-level wall-time comparison is exact. */
function resolveLocal(local: string, seconds: string | null, zone: string): number[] {
  const asUtc = Date.parse(`${local}:${seconds ?? '00'}Z`)
  const offsets = new Set([-86_400_000, 0, 86_400_000].map((shift) => zoneOffset(asUtc + shift, zone)))
  return [...offsets].map((offset) => asUtc - offsetMinutes(offset) * 60_000).filter((instant) => wallTime(instant, zone) === local).sort((a, b) => a - b)
}

export type EventMapping = { id: string; title: string; start: string; end?: string; zone?: string; category?: string; detail?: string; lane?: string }

export function eventsAdapter(text: string, mapping: EventMapping, recipeZone: string | undefined, displayZone: string | undefined): Result<Array<Record<string, unknown>>> {
  const parsed = parseCsv(text)
  if (!parsed.ok) return parsed
  const [header, ...body] = parsed.value
  if (!header) return fail({ code: 'source-empty' })
  // Every mapped column must exist, one error per field in code-point order, before any record is read.
  // A missing column is never read as empty cells (a misspelt `end` would turn every span into a milestone).
  const mapped = [...new Set(Object.values(mapping).filter((field): field is string => typeof field === 'string'))]
  const missing = mapped.filter((field) => !header.cells.includes(field)).sort()
  if (missing.length > 0) return fail(...missing.map((field) => ({ code: 'column-missing', field })))
  // The display zone is checked like any other zone; a bad one is the named error, never an Intl exception.
  const shown = displayZone ?? recipeZone ?? 'UTC'
  if (!validZone(shown)) return fail({ code: 'zone-unknown', field: displayZone !== undefined ? 'display_zone' : 'time_zone', value: shown })
  const errors: RefError[] = []
  const events: Array<Record<string, unknown>> = []
  const seen = new Map<string, number>()
  body.forEach((row, index) => {
    const record = index + 1
    const at = { line: row.line, record }
    const cell = (field: string | undefined): string => field === undefined ? '' : row.cells[header.cells.indexOf(field)] ?? ''
    const id = cell(mapping.id)
    if (id === '') { errors.push({ code: 'id-missing', ...at, field: mapping.id }); return }
    if (seen.has(id)) { errors.push({ code: 'id-duplicate', ...at, field: mapping.id, value: id, first_line: seen.get(id) }); return }
    seen.set(id, row.line)
    const zoneCell = cell(mapping.zone)
    const zone = zoneCell || recipeZone || ''
    const point = (field: string, raw: string): ZonedTime | string | RefError => {
      const value = parseDateValue(raw)
      if (value === null) return { code: 'value-invalid-date', ...at, field, value: raw }
      if (value.kind === 'date') return value.date
      if (zone === '') return { code: 'zone-missing', ...at, field }
      if (!validZone(zone)) return { code: 'zone-unknown', ...at, field: zoneCell ? mapping.zone : 'time_zone', value: zone }
      const withSeconds = (wall: string): string => value.seconds === null ? wall : `${wall}:${value.seconds}`
      if (value.offset !== null) {
        const instant = Date.parse(`${value.local}:${value.seconds ?? '00'}${value.offset === '+00:00' ? 'Z' : value.offset}`)
        if (zoneOffset(instant, zone) !== value.offset) return { code: 'date-offset-mismatch', ...at, field, value: raw }
        return { local: withSeconds(wallTime(instant, zone)), zone, offset: value.offset, instant: iso(instant) }
      }
      const candidates = resolveLocal(value.local, value.seconds, zone)
      if (candidates.length === 0) return { code: 'date-nonexistent-local-time', ...at, field, value: raw }
      if (candidates.length > 1) return { code: 'date-ambiguous-local-time', ...at, field, value: raw, candidates: candidates.map(iso) }
      return { local: withSeconds(value.local), zone, offset: zoneOffset(candidates[0], zone), instant: iso(candidates[0]) }
    }
    const startRaw = cell(mapping.start)
    if (startRaw === '') { errors.push({ code: 'date-missing', ...at, field: mapping.start }); return }
    const start = point(mapping.start, startRaw)
    if (typeof start === 'object' && 'code' in start) { errors.push(start); return }
    const endRaw = cell(mapping.end)
    const end = endRaw === '' ? null : point(mapping.end!, endRaw)
    if (end !== null && typeof end === 'object' && 'code' in end) { errors.push(end); return }
    if (end !== null && typeof start !== typeof end) { errors.push({ code: 'span-mixed-kinds', ...at, field: mapping.end }); return }
    const event: Record<string, unknown> = { id, title: cell(mapping.title) }
    for (const key of ['category', 'lane', 'detail'] as const) if (cell(mapping[key]) !== '') event[key] = cell(mapping[key])
    event.locator = at
    if (typeof start === 'string') {
      const last = (end as string | null) ?? start
      const days = (Date.parse(last) - Date.parse(start)) / 86_400_000 + 1
      if (days < 1) { errors.push({ code: 'span-reversed', ...at, field: mapping.end }); return }
      events.push({ ...event, kind: 'all-day', start_date: start, end_date: last, days })
      return
    }
    const finish = end as ZonedTime | null
    const from = Date.parse(start.instant)
    const to = finish ? Date.parse(finish.instant) : from
    if (to < from) { errors.push({ code: 'span-reversed', ...at, field: mapping.end }); return }
    events.push({
      ...event, kind: 'timed', start, end: finish, elapsed_minutes: (to - from) / 60_000,
      display: { start_date: wallTime(from, shown).slice(0, 10), end_date: wallTime(to, shown).slice(0, 10), start_time: wallTime(from, shown).slice(11), end_time: finish ? wallTime(to, shown).slice(11) : null },
    })
  })
  if (errors.length > 0) return fail(...errors)
  if (events.length === 0) return fail({ code: 'source-empty' })
  return { ok: true, value: events }
}

// ---------------------------------------------------------------- resource files

const RASTER = ['png', 'jpg', 'jpeg', 'gif', 'webp']
/** The extension table. */
export function classify(name: string): { kind: string; media_type: string; preview: string; text_searchable: boolean } {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  if (ext === 'md' || ext === 'markdown') return { kind: 'markdown', media_type: 'text/markdown', preview: 'native-markdown', text_searchable: true }
  if (ext === 'txt') return { kind: 'text', media_type: 'text/plain', preview: 'text', text_searchable: true }
  if (ext === 'csv') return { kind: 'csv', media_type: 'text/csv', preview: 'table', text_searchable: true }
  if (ext === 'json') return { kind: 'json', media_type: 'application/json', preview: 'tree', text_searchable: true }
  if (RASTER.includes(ext)) return { kind: 'image', media_type: `image/${ext === 'jpg' ? 'jpeg' : ext}`, preview: 'image', text_searchable: false }
  if (ext === 'pdf') return { kind: 'pdf', media_type: 'application/pdf', preview: 'pdf', text_searchable: false }
  if (ext === 'html') return { kind: 'html', media_type: 'text/html', preview: 'source-only', text_searchable: true }
  if (ext === 'svg') return { kind: 'svg', media_type: 'image/svg+xml', preview: 'source-only', text_searchable: true }
  return { kind: 'binary', media_type: 'application/octet-stream', preview: 'metadata-only', text_searchable: false }
}
/** Folder member id: folder id + native slug of the member path without its extension. */
export const memberId = (folderId: string, path: string): string => `${folderId}-${nativeSlug(path.replace(/\.[^./]+$/, ''))}`

// ---------------------------------------------------------------- resource declarations

export const GRANT_ID = /^g-[a-z2-7]{26}$/
const INCLUSIONS = ['in-place', 'copy', 'sync']

/** Declaration rules for `resources.items`, one error per item at most, in item order. */
export function checkResourceDeclarations(folioDir: string, manifest: { resources?: { items?: Array<Record<string, unknown>> } }): RefError[] {
  const folio: Folio = { contentRoot: '', files: [] }
  const errors: RefError[] = []
  const seen = new Set<string>()
  for (const [index, item] of (manifest.resources?.items ?? []).entries()) {
    const at = (key: string): string => `/resources/items/${index}/${key}`
    const id = item.id as string
    const first = seen.has(id)
    seen.add(id)
    if (typeof item.path !== 'string' || manifestFilePathCandidates(folioDir, folio, { path: item.path }).length === 0) errors.push({ code: 'resource-outside', pointer: at('path'), id })
    else if (first) errors.push({ code: 'resource-id-duplicate', pointer: at('id'), id })
    else if (!isSlugId(id)) errors.push({ code: 'resource-id-invalid', pointer: at('id'), id })
    else if (!INCLUSIONS.includes(item.inclusion as string)) errors.push({ code: 'resource-declaration-invalid', pointer: at('inclusion'), id })
    else if ('origin' in item) errors.push({ code: 'resource-declaration-invalid', pointer: at('origin'), id })
    // A `sync` item needs a well-formed grant; any other item may not carry a `grant` key at all, whatever its value.
    else if (item.inclusion === 'sync' ? !(typeof item.grant === 'string' && GRANT_ID.test(item.grant)) : 'grant' in item) errors.push({ code: 'resource-declaration-invalid', pointer: at('grant'), id })
  }
  return errors
}

export type Grant = { id: string; folio: string; resource: string; kind: string; origin: string; granted_at: string }
/** Grant lookup: the grant must exist on this Mac AND be bound to this Folio and this resource id. */
export function lookupSyncGrant(store: { grants: Grant[] }, request: { folio: string; resource: string; grant?: unknown }): { ok: true; origin: string } | { ok: false; code: string } {
  if (typeof request.grant !== 'string' || !GRANT_ID.test(request.grant)) return { ok: false, code: 'resource-declaration-invalid' }
  const grant = store.grants.find((candidate) => candidate.id === request.grant)
  if (!grant) return { ok: false, code: 'origin-not-on-this-mac' }
  if (grant.folio !== request.folio || grant.resource !== request.resource) return { ok: false, code: 'sync-grant-mismatch' }
  return { ok: true, origin: grant.origin }
}

// ---------------------------------------------------------------- per-frame allow-list

/** Link destinations in `markdown` as the app's own reader parses them (`readDocument`, model.ts): only real
 *  `link` inlines count, so a link written inside a code span or a code block is text and never a target. */
function linkTargets(markdown: string): string[] {
  const document = readDocument(markdown)
  const targets: string[] = []
  const visit = (inline: Inline): void => { if (inline.kind === 'link') targets.push(inline.href) }
  eachInline(document.blocks, visit)
  for (const note of document.footnotes) eachInline(note.children, visit)
  return targets
}

/** The path part of a relative destination, percent-decoded; null when it cannot be decoded (`bad%QZ`), which makes
 *  it an ordinary non-resource link rather than an exception. */
function decodedPath(target: string): string | null {
  try { return decodeURI(target.split('#')[0]) } catch { return null }
}

/**
 * Derivation part 1: every declared resource a built record's Markdown links to. A link counts when it is
 * relative, decodes, resolves (against the source file's folder, Folio-relative) to a place inside the Folio, and
 * that place is the `path` of a declared item. Anything else stays text and adds nothing.
 */
export function deriveFrameResources(sourcePath: string, bodies: string[], items: Array<{ id: string; path: string }>): string[] {
  const byPath = new Map(items.map((item) => [posix.normalize(item.path), item.id]))
  const found = new Set<string>()
  for (const body of bodies) {
    for (const target of linkTargets(body)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/')) continue
      const path = decodedPath(target)
      if (path === null || path === '') continue
      const resolved = posix.normalize(posix.join(posix.dirname(sourcePath), path))
      if (resolved === '..' || resolved.startsWith('../')) continue
      const id = byPath.get(resolved)
      if (id !== undefined) found.add(id)
    }
  }
  return [...found].sort()
}

export const FRAME_SET_MAX = 500
type ManifestResources = { resources?: { items?: Array<Record<string, unknown>>; folders?: Array<Record<string, unknown>> } }

/**
 * THE derivation, run by the build (to write the informational receipt field) and by the host when a frame
 * loads (to get the frame's authority). Inputs are only the recipe, the source it names and the manifest, all
 * read by main from the Folio now; the receipt is not an input. `read` returns a Folio-relative file's text or
 * null. Any input that does not read or validate gives the empty set (fail closed).
 */
export function deriveFrameSet(read: (folioPath: string) => string | null, recipePath: string, manifest: ManifestResources): string[] {
  // The host boundary never throws: whatever escapes (a reader error, an input no check anticipated) is no authority.
  try { return deriveFrameSetUnguarded(read, recipePath, manifest) } catch { return [] }
}

function deriveFrameSetUnguarded(read: (folioPath: string) => string | null, recipePath: string, manifest: ManifestResources): string[] {
  const items = (manifest.resources?.items ?? [])
    .filter((item): item is { id: string; path: string } => isSlugId(item.id) && typeof item.path === 'string')
  const declared = new Set(items.map((item) => item.id))
  const recipeText = read(recipePath)
  if (recipeText === null) return []
  const parsed = parseRecipe(recipeText)
  if (!parsed.ok || checkRecipe(parsed.value.recipe).length > 0) return []
  const r = parsed.value.recipe
  const source = r.source as YamlMap
  let set: string[] = []
  if (source.format === 'folder') {
    const folder = (manifest.resources?.folders ?? []).find((entry) => entry.id === (source.select as YamlMap).folder)
    set = Array.isArray(folder?.members) ? (folder.members as unknown[]).filter((id): id is string => typeof id === 'string' && declared.has(id)) : []
  } else {
    const sourcePath = typeof source.path === 'string'
      ? posix.normalize(posix.join(posix.dirname(recipePath), source.path))
      : items.find((item) => item.id === source.resource)?.path
    if (sourcePath === undefined || sourcePath === '..' || sourcePath.startsWith('../')) return []
    const text = read(sourcePath)
    if (text === null) return []
    const mapping = isMap(r.mapping) ? r.mapping : {}
    if (STRUCTURED.includes(source.format as string)) {
      const result = structuredAdapter(sourcePath, source.format as string, text, source.select as { level: number })
      if (!result.ok) return []
      set = deriveFrameResources(sourcePath, (result.value.records as StructuredRecord[]).map((record) => record.body_markdown), items)
    } else {
      const options: TabularOptions = { idField: mapping.id as string | undefined, types: mapping.types as Record<string, string> | undefined, mapped: mappedFields(r) }
      const result = source.format === 'csv' ? csvAdapter(sourcePath, text, options)
        : source.format === 'json' ? jsonAdapter(sourcePath, text, source.select as { pointer: string }, options)
        : markdownTableAdapter(sourcePath, text, (source.select ?? null) as { heading?: string; index?: number } | null, options)
      if (!result.ok) return []
      const records = result.value.records as TabularRecord[]
      const details = typeof mapping.detail === 'string' ? records.map((record) => record.values[mapping.detail as string]).filter((v): v is string => typeof v === 'string') : []
      const linked = typeof mapping.resource === 'string' ? records.map((record) => record.values[mapping.resource as string]).filter((v): v is string => typeof v === 'string' && declared.has(v)) : []
      set = [...deriveFrameResources(sourcePath, details, items), ...linked]
    }
  }
  const unique = [...new Set(set)].sort()
  return unique.length > FRAME_SET_MAX ? [] : unique
}

const MESSAGE_KEYS = ['wf', 'v', 'k', 't', 'r', 'a']
/** The proposed `open-resource` shape check: exact keys, plain object, slug-valid ids, 32-hex token. */
export function validOpenResource(message: unknown): message is { t: string; r: string; a?: string } {
  if (typeof message !== 'object' || message === null || Array.isArray(message) || Object.getPrototypeOf(message) !== Object.prototype) return false
  const record = message as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.some((key) => !MESSAGE_KEYS.includes(key)) || !['wf', 'v', 'k', 't', 'r'].every((key) => keys.includes(key))) return false
  return record.wf === 'writeflex-widget' && record.v === 1 && record.k === 'open-resource' && typeof record.t === 'string' && /^[0-9a-f]{32}$/.test(record.t)
    && isSlugId(record.r) && (!('a' in record) || isSlugId(record.a))
}

/**
 * What the host holds for one mounted frame. `allowed` is `deriveFrameSet` run by main when the frame loaded;
 * `declared` is the manifest's ids at the moment of the message. The receipt is a workspace file anyone can edit:
 * only its `output_sha256` is read, as a freshness signal; its `resources` is informational and never consulted.
 */
export type FrameState = {
  token: string; focused: boolean; loaded_sha256: string
  receipt: { output_sha256: string; resources?: unknown }
  allowed: string[]; declared: string[]
}
/** The host's decision for one message from one frame; the first failing check names the refusal. */
export function authoriseOpenResource(frame: FrameState, message: unknown): { open: { r: string; a?: string } } | { refused: string } {
  if (!validOpenResource(message)) return { refused: 'message-invalid' }
  if (message.t !== frame.token) return { refused: 'token-mismatch' }
  if (!frame.focused) return { refused: 'frame-not-focused' }
  if (frame.receipt.output_sha256 !== frame.loaded_sha256) return { refused: 'receipt-stale' }
  if (!frame.allowed.includes(message.r)) return { refused: 'resource-not-in-frame-set' }
  if (!frame.declared.includes(message.r)) return { refused: 'resource-not-declared' }
  return { open: message.a === undefined ? { r: message.r } : { r: message.r, a: message.a } }
}
