/**
 * Tabular source adapters for standard widgets (contracts §4, §5, §7): CSV (RFC 4180) and a JSON array of
 * objects, each read into `adapter-output/1`, the record set every tabular template builds from.
 *
 *   readCsvRecords   - header row required; quoted separators, doubled quotes, quoted CR/LF; one BOM stripped.
 *   readJsonRecords  - an RFC 6901 pointer to an array of objects; numbers keep their source spelling
 *                      (`9007199254740993`), booleans read as "true"/"false", null stays null; nested scalars
 *                      are fields by pointer (`/provider/name`, label `provider name`); arrays are not fields.
 *
 * Values are the ORIGINAL text: never trimmed, re-cased or reformatted. `''` is an empty cell, null a JSON
 * null, an absent key an absent value. Declared `number` types add a `typed` value; nothing is guessed.
 *
 * Pure: text in, records or named problems out. Errors are collected (not first-only), at most `BUILD_ERROR_CAP` of
 * them (the first ones, in source order: a build reports no more), and keep the fixtures' flat shape (`{ code, line?, pointer?, record?, field?, value?, detail?, first_line?, first_pointer? }`).
 */
import { BUILD_ERROR_CAP } from './build-errors'
import type { WidgetIssue } from './recipe'

export type Locator = { line: number; record: number } | { pointer: string; line: number }
export type TabularRecord = {
  id: string
  id_origin: 'mapped'
  locator: Locator
  values: Record<string, string | null>
  typed?: Record<string, number | null>
}
export type RecordSet = {
  source: { path: string; format: string }
  selection: { pointer: string } | null
  fields: Array<{ key: string; label: string }>
  records: TabularRecord[]
}
export type RecordRead = { ok: true; value: RecordSet } | { ok: false; errors: WidgetIssue[] }
/** `idField`: the mapped id; `types`: `mapping.types`; `mapped`: every field the recipe names (§3 column check). */
export type TabularOptions = { idField?: string; types?: Record<string, string>; mapped?: string[] }

const fail = (...errors: WidgetIssue[]): { ok: false; errors: WidgetIssue[] } => ({ ok: false, errors: errors.slice(0, BUILD_ERROR_CAP) })
/** A failure from a collected list (never spread: a list can be long). */
const failWith = (errors: WidgetIssue[]): { ok: false; errors: WidgetIssue[] } => ({ ok: false, errors: errors.slice(0, BUILD_ERROR_CAP) })

/** An error list that keeps the first `BUILD_ERROR_CAP` problems and drops the rest, so a source with a problem on
 *  every line holds a bounded list. `full` says when no more is worth collecting. */
class Problems {
  readonly list: WidgetIssue[] = []
  push(issue: WidgetIssue): void { if (this.list.length < BUILD_ERROR_CAP) this.list.push(issue) }
  get full(): boolean { return this.list.length >= BUILD_ERROR_CAP }
  get length(): number { return this.list.length }
}

/** §4: `[+-]digits[.digits][e±digits]`, `.` decimal point, no grouping. */
const NUMBER = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/

/** Code-point order (not UTF-16 unit order), as §3 names it for `column-missing`. */
function byCodePoint(a: string, b: string): number {
  const x = [...a]
  const y = [...b]
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!
    if (d !== 0) return d
  }
  return x.length - y.length
}

/** A record's own value for `key` (never one inherited from Object.prototype, whatever a header is called). */
const own = (values: Record<string, string | null>, key: string): string | null | undefined => Object.hasOwn(values, key) ? values[key] : undefined

type Row = { locator: Locator; at: { line: number } | { pointer: string }; values: Record<string, string | null> }

/** The part every tabular source shares: mapped columns present, ids, declared numbers, at least one record. */
function tabular(source: RecordSet['source'], selection: RecordSet['selection'], fields: RecordSet['fields'], rows: Row[], options: TabularOptions): RecordRead {
  const keys = new Set(fields.map((field) => field.key))
  const missing = [...new Set(options.mapped ?? [])].filter((name) => !keys.has(name)).sort(byCodePoint)
  if (missing.length > 0) return failWith(missing.map((field) => ({ code: 'column-missing', field })))
  const errors = new Problems()
  const seen = new Map<string, Row>()
  const records = rows.map((row, index): TabularRecord => {
    const record = index + 1
    const id = options.idField === undefined ? '' : own(row.values, options.idField) ?? ''
    if (options.idField !== undefined) {
      if (id === '') errors.push({ code: 'id-missing', ...row.at, record, field: options.idField })
      else if (seen.has(id)) {
        const first = seen.get(id)!.at
        errors.push({ code: 'id-duplicate', ...row.at, record, field: options.idField, value: id, ...('line' in first ? { first_line: first.line } : { first_pointer: first.pointer }) })
      } else seen.set(id, row)
    }
    const out: TabularRecord = { id, id_origin: 'mapped', locator: row.locator, values: row.values }
    if (options.types) {
      out.typed = {}
      for (const [field, type] of Object.entries(options.types)) {
        if (type !== 'number') continue
        const raw = own(row.values, field)
        if (raw === null || raw === undefined || raw === '') out.typed[field] = null
        else if (NUMBER.test(raw)) out.typed[field] = Number(raw)
        else errors.push({ code: 'value-invalid-number', ...row.at, record, field, value: raw })
      }
    }
    return out
  })
  if (errors.length > 0) return failWith(errors.list)
  if (records.length === 0) return fail({ code: 'source-empty' })
  return { ok: true, value: { source, selection, fields, records } }
}

// ---------------------------------------------------------------- CSV

type CsvRow = { line: number; cells: string[] }

/** RFC 4180 rows with the line each starts on. A quoted field never closed, or text after a closing quote, is `csv-malformed`. */
function csvRows(text: string): { ok: true; rows: CsvRow[] } | { ok: false; errors: WidgetIssue[] } {
  const input = text.startsWith('﻿') ? text.slice(1) : text
  const rows: CsvRow[] = []
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
  return { ok: true, rows }
}

/** A CSV file's records. `path` is how the source is named in the output (Folio-relative). */
export function readCsvRecords(path: string, text: string, options: TabularOptions): RecordRead {
  const parsed = csvRows(text)
  if (!parsed.ok) return parsed
  const [header, ...body] = parsed.rows
  if (!header) return fail({ code: 'source-empty' })
  const errors = new Problems()
  const seen = new Set<string>()
  for (const name of header.cells) {
    if (name === '') errors.push({ code: 'csv-header-empty', line: 1 })
    else if (seen.has(name)) errors.push({ code: 'csv-header-duplicate', line: 1, field: name })
    seen.add(name)
  }
  for (const row of body) {
    if (errors.full) break
    if (row.cells.length !== header.cells.length) errors.push({ code: 'csv-malformed', line: row.line, detail: `expected ${header.cells.length} fields, found ${row.cells.length}` })
  }
  if (errors.length > 0) return failWith(errors.list)
  const fields = header.cells.map((key) => ({ key, label: key }))
  const rows = body.map((row, index): Row => ({
    locator: { line: row.line, record: index + 1 },
    at: { line: row.line },
    values: Object.fromEntries(header.cells.map((key, column) => [key, row.cells[column]])),
  }))
  return tabular({ path, format: 'csv' }, null, fields, rows, options)
}

// ---------------------------------------------------------------- JSON

type JsonNode =
  | { kind: 'object'; line: number; entries: Array<[string, JsonNode]> }
  | { kind: 'array'; line: number; items: JsonNode[] }
  | { kind: 'string' | 'number' | 'boolean'; line: number; text: string }
  | { kind: 'null'; line: number }

class Malformed { constructor(readonly line: number) {} }
const JSON_SPACE = new Set([' ', '\t', '\n', '\r'])
const LITERAL = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/

/** Strict JSON, read with each value's starting line and each number's source spelling. */
function jsonTree(text: string): { ok: true; root: JsonNode } | { ok: false; errors: WidgetIssue[] } {
  const input = text.startsWith('﻿') ? text.slice(1) : text
  let i = 0
  let line = 1
  const malformed = (): never => { throw new Malformed(line) }
  const space = (): void => { while (i < input.length && JSON_SPACE.has(input[i])) { if (input[i] === '\n') line += 1; i += 1 } }
  const stringToken = (): string => {
    const start = i
    i += 1
    while (i < input.length && input[i] !== '"') {
      if (input[i] === '\\') i += 1
      if (input[i] === '\n' || input[i] === '\r') malformed()
      i += 1
    }
    if (i >= input.length) malformed()
    i += 1
    try { return JSON.parse(input.slice(start, i)) as string } catch { return malformed() }
  }
  const value = (depth: number): JsonNode => {
    if (depth > 512) malformed()
    space()
    const at = line
    const char = input[i]
    if (char === '{') {
      i += 1
      const entries: Array<[string, JsonNode]> = []
      space()
      if (input[i] === '}') { i += 1; return { kind: 'object', line: at, entries } }
      for (;;) {
        space()
        if (input[i] !== '"') malformed()
        const key = stringToken()
        space()
        if (input[i] !== ':') malformed()
        i += 1
        entries.push([key, value(depth + 1)])
        space()
        if (input[i] === ',') { i += 1; continue }
        if (input[i] === '}') { i += 1; return { kind: 'object', line: at, entries } }
        malformed()
      }
    }
    if (char === '[') {
      i += 1
      const items: JsonNode[] = []
      space()
      if (input[i] === ']') { i += 1; return { kind: 'array', line: at, items } }
      for (;;) {
        items.push(value(depth + 1))
        space()
        if (input[i] === ',') { i += 1; continue }
        if (input[i] === ']') { i += 1; return { kind: 'array', line: at, items } }
        malformed()
      }
    }
    if (char === '"') return { kind: 'string', line: at, text: stringToken() }
    const literal = LITERAL.exec(input.slice(i, i + 400))?.[1]
    if (!literal) return malformed()
    i += literal.length
    if (literal === 'null') return { kind: 'null', line: at }
    return { kind: literal === 'true' || literal === 'false' ? 'boolean' : 'number', line: at, text: literal }
  }
  try {
    const root = value(0)
    space()
    if (i !== input.length) malformed()
    return { ok: true, root }
  } catch (error) {
    if (error instanceof Malformed) return fail({ code: 'json-malformed', line: error.line })
    throw error
  }
}

const escapePointer = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1')
const unescapePointer = (part: string): string => part.replace(/~1/g, '/').replace(/~0/g, '~')

/** Scalar leaves by pointer, in source order. Arrays (and anything inside them) are not record fields. */
function leaves(node: JsonNode, prefix: string, out: Array<[string, string | null]>): void {
  if (node.kind === 'object') for (const [key, child] of node.entries) leaves(child, `${prefix}/${escapePointer(key)}`, out)
  else if (node.kind === 'null') out.push([prefix, null])
  else if (node.kind !== 'array') out.push([prefix, node.text])
}

/** The records of the array `selection.pointer` names in a JSON file. */
export function readJsonRecords(path: string, text: string, selection: { pointer: string }, options: TabularOptions): RecordRead {
  const parsed = jsonTree(text)
  if (!parsed.ok) return parsed
  let node: JsonNode | undefined = parsed.root
  for (const part of selection.pointer === '' ? [] : selection.pointer.split('/').slice(1).map(unescapePointer)) {
    if (node?.kind === 'object') node = node.entries.find(([key]) => key === part)?.[1]
    else if (node?.kind === 'array' && /^(0|[1-9]\d*)$/.test(part)) node = node.items[Number(part)]
    else node = undefined
  }
  if (!node) return fail({ code: 'json-selector-not-found', pointer: selection.pointer })
  if (node.kind !== 'array') return fail({ code: 'json-selector-not-array', pointer: selection.pointer })
  const notObjects = new Problems()
  node.items.forEach((item, index) => { if (item.kind !== 'object') notObjects.push({ code: 'json-record-not-object', pointer: `${selection.pointer}/${index}`, record: index + 1 }) })
  if (notObjects.length > 0) return failWith(notObjects.list)
  const fieldKeys: string[] = []
  const known = new Set<string>()
  const rows = node.items.map((item, index): Row => {
    const found: Array<[string, string | null]> = []
    leaves(item, '', found)
    for (const [key] of found) if (!known.has(key)) { known.add(key); fieldKeys.push(key) }
    const pointer = `${selection.pointer}/${index}`
    return { locator: { pointer, line: item.line }, at: { pointer }, values: Object.fromEntries(found) }
  })
  const fields = fieldKeys.map((key) => ({ key, label: key.split('/').slice(1).map(unescapePointer).join(' ') }))
  return tabular({ path, format: 'json' }, { pointer: selection.pointer }, fields, rows, options)
}
