/**
 * The record browser's authoring model (ticket 04b): what the Source and preview tab knows, without any DOM.
 * Pure: it reads a CSV or JSON source far enough to offer its fields, guesses a mapping, and shapes the three
 * things the engine takes (a create request, a recipe patch, a reading of an existing recipe). The engine
 * itself (src/main/standard-widgets/) decides what is valid; this module never builds a page.
 *
 * Interface in one line each:
 *   readSource(kind, text)            the fields, the record sets (JSON) and a few rows to preview
 *   guessMapping(fields)              title, detail and group fields to start from
 *   browserRecipe(input)              the recipe a create sends (no `widget_schema`, no `source.path`)
 *   browserPatch(existing, input)     the top-level keys an update changes, keeping every other key
 *   readRecipe(text)                  an existing recipe as the tab's settings, or why it is not one it can edit
 *   embedTarget(documentPath, line)   the recipe behind an embed line, or null when the line is not a made widget
 */
import { parseRecipeText, isRecipeMap, type RecipeMap, type RecipeValue } from '../../../main/standard-widgets/recipe'
import { embedLine } from '../../../shared/markdown/embed-line'

export type SourceKind = 'csv' | 'json'

/** The source format a file name asks for, or null when the record browser cannot read it. */
export function sourceKindOf(path: string): SourceKind | null {
  if (/\.csv$/i.test(path)) return 'csv'
  if (/\.json$/i.test(path)) return 'json'
  return null
}

export type PreviewRow = Record<string, string>
export type SourceReading =
  | { ok: true; kind: SourceKind; fields: string[]; rows: PreviewRow[]; count: number; /** JSON: where the records are. */ pointer: string; /** JSON: every place that holds a list of records. */ pointers: string[] }
  | { ok: false; message: string }

const ROWS_SHOWN = 200

/** RFC 4180 rows: quoted cells, doubled quotes, line breaks inside quotes. A stray quote is the engine's to name. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const body = text.replace(/^﻿/, '')
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]
    if (quoted) {
      if (char === '"') {
        if (body[i + 1] === '"') { cell += '"'; i += 1 } else quoted = false
      } else cell += char
    } else if (char === '"' && cell === '') quoted = true
    else if (char === ',') { row.push(cell); cell = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[i + 1] === '\n') i += 1
      row.push(cell); cell = ''
      rows.push(row); row = []
    } else cell += char
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row) }
  return rows.filter((candidate) => !(candidate.length === 1 && candidate[0] === ''))
}

const scalar = (value: unknown): string | null => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Pointers (RFC 6901, `~` and `/` escaped) to every list of records, outermost first, down three levels. */
function recordLists(value: unknown, pointer: string, depth: number, found: string[]): void {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isRecord)) found.push(pointer)
    return
  }
  if (!isRecord(value) || depth >= 3) return
  for (const [key, inner] of Object.entries(value)) recordLists(inner, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, depth + 1, found)
}
function atPointer(value: unknown, pointer: string): unknown {
  let here = value
  if (pointer === '') return here
  for (const part of pointer.slice(1).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isRecord(here) || !Object.hasOwn(here, key)) return undefined
    here = here[key]
  }
  return here
}

/** The fields of a CSV or JSON source and a few of its rows; a plain sentence when it cannot be read as records. */
export function readSource(kind: SourceKind, text: string, pointer?: string): SourceReading {
  if (kind === 'csv') {
    const rows = csvRows(text)
    if (rows.length === 0) return { ok: false, message: 'This file has no rows. A CSV needs a header row of field names, then one record per row.' }
    const fields = rows[0].map((name) => name.trim())
    if (fields.some((name) => name === '')) return { ok: false, message: 'The first row of this CSV has an empty field name. Every column needs a name in the header row.' }
    if (new Set(fields).size !== fields.length) return { ok: false, message: 'The first row of this CSV names a field twice. Every column needs its own name.' }
    const records = rows.slice(1)
    if (records.length === 0) return { ok: false, message: 'This CSV has a header row but no records.' }
    return { ok: true, kind, fields, count: records.length, pointer: '', pointers: [], rows: records.slice(0, ROWS_SHOWN).map((cells) => Object.fromEntries(fields.map((name, index) => [name, cells[index] ?? '']))) }
  }
  let json: unknown
  try { json = JSON.parse(text.replace(/^﻿/, '')) } catch { return { ok: false, message: 'This JSON cannot be read. Check for a missing bracket or comma.' } }
  const pointers: string[] = []
  recordLists(json, '', 0, pointers)
  if (pointers.length === 0) return { ok: false, message: 'This JSON has no list of records. The record browser needs a list of objects, such as [{ "title": "…" }].' }
  const chosen = pointer !== undefined && pointers.includes(pointer) ? pointer : pointers[0]
  const list = atPointer(json, chosen) as Array<Record<string, unknown>>
  const fields: string[] = []
  for (const record of list) for (const [key, value] of Object.entries(record)) if (scalar(value) !== null && !fields.includes(key)) fields.push(key)
  if (fields.length === 0) return { ok: false, message: 'The records in this JSON hold no text or number fields to show.' }
  return { ok: true, kind, fields, count: list.length, pointer: chosen, pointers, rows: list.slice(0, ROWS_SHOWN).map((record) => Object.fromEntries(fields.map((name) => [name, scalar(record[name]) ?? '']))) }
}

export type FieldMapping = { title: string; detail: string; group: string | null }

const TITLE = /^(title|name|label|heading|subject)$/i
const DETAIL = /^(detail|details|description|body|text|summary|notes?|content|explanation)$/i
const GROUP = /^(group|category|stage|type|audience|section|status|kind|theme|topic)$/i

/** A start the writer can change: the best-named field for each role. Detail never repeats the title unless it must. */
export function guessMapping(fields: readonly string[]): FieldMapping {
  const title = fields.find((name) => TITLE.test(name)) ?? fields[0]
  const detail = fields.find((name) => DETAIL.test(name)) ?? fields.find((name) => name !== title) ?? title
  const group = fields.find((name) => GROUP.test(name) && name !== title && name !== detail) ?? null
  return { title, detail, group }
}

export type RecipeInput = { title: string; kind: SourceKind; pointer: string; mapping: FieldMapping }

/** A mapping value as the recipe writes it: a CSV column by its name, a JSON field as a pointer into the record. */
export const mappedName = (kind: SourceKind, field: string): string => (kind === 'json' ? `/${field.replace(/~/g, '~0').replace(/\//g, '~1')}` : field)
/** The reverse, for showing a recipe's mapping value as a field name. */
export const fieldOfMapped = (kind: SourceKind, value: string): string => (kind === 'json' && value.startsWith('/') ? value.slice(1).replace(/~1/g, '/').replace(/~0/g, '~') : value)

const sourceBlock = (input: RecipeInput): RecipeMap => (input.kind === 'json' ? { format: 'json', select: { pointer: input.pointer } } : { format: 'csv' })
const mappingBlock = (input: RecipeInput): RecipeMap => ({
  title: mappedName(input.kind, input.mapping.title),
  detail: mappedName(input.kind, input.mapping.detail),
  ...(input.mapping.group !== null ? { group: mappedName(input.kind, input.mapping.group) } : {}),
})

/** The recipe a create sends: the engine adds `widget_schema` and `source.path`. */
export function browserRecipe(input: RecipeInput): RecipeMap {
  return { template: 'browser', template_version: 1, title: input.title.trim() || 'Records', source: sourceBlock(input), mapping: mappingBlock(input), views: ['browser', 'list'] }
}

/**
 * The top-level keys an update sets. `mapping` keeps the recipe's other mapping keys (id, search, types …)
 * for the fields the writer did not touch; `group` is removed when none is chosen.
 */
export function browserPatch(existing: RecipeMap, input: RecipeInput, sourceFile?: string): Record<string, RecipeValue | null> {
  const old = isRecipeMap(existing.mapping) ? existing.mapping : {}
  const mapping: RecipeMap = { ...old, ...mappingBlock(input) }
  if (input.mapping.group === null) delete mapping.group
  const patch: Record<string, RecipeValue | null> = { title: input.title.trim() || 'Records', mapping }
  if (sourceFile !== undefined) {
    const oldSource = isRecipeMap(existing.source) ? existing.source : {}
    const { path: _path, resource: _resource, select: _select, format: _format, ...rest } = oldSource
    void _path; void _resource; void _select; void _format
    patch.source = { file: sourceFile, ...rest, ...sourceBlock(input) }
  }
  return patch
}

export type RecipeReading =
  | { ok: true; recipe: RecipeMap; title: string; kind: SourceKind; /** As written in the recipe: relative to the widget's folder ('' when the source is a declared resource). */ sourcePath: string; /** The declared resource the widget reads (a file brought into the document's resources), or null. */ sourceResource: string | null; pointer: string; mapping: FieldMapping }
  | { ok: false; message: string }

/** An existing recipe as the tab's settings. Only the record browser over a CSV or JSON file in a Folio can be edited here. */
export function readRecipe(text: string): RecipeReading {
  const parsed = parseRecipeText(text)
  if (!parsed.ok) return { ok: false, message: 'This widget\'s settings file cannot be read, so it cannot be edited here.' }
  const { recipe } = parsed
  const source = isRecipeMap(recipe.source) ? recipe.source : null
  const mapping = isRecipeMap(recipe.mapping) ? recipe.mapping : null
  if (recipe.template !== 'browser' || source === null || mapping === null) return { ok: false, message: 'This widget is not a record browser, so it cannot be edited here.' }
  if (source.format !== 'csv' && source.format !== 'json') return { ok: false, message: 'This record browser reads something other than a CSV or JSON file, so it cannot be edited here.' }
  if (typeof source.path !== 'string' && typeof source.resource !== 'string') return { ok: false, message: 'This record browser names no source file, so it cannot be edited here.' }
  if (typeof mapping.title !== 'string' || typeof mapping.detail !== 'string') return { ok: false, message: 'This record browser has no title and detail fields set.' }
  const kind: SourceKind = source.format
  const select = isRecipeMap(source.select) ? source.select : {}
  return {
    ok: true, recipe, kind, sourcePath: typeof source.path === 'string' ? source.path : '', sourceResource: typeof source.path === 'string' ? null : source.resource as string,
    title: typeof recipe.title === 'string' ? recipe.title : '',
    pointer: typeof select.pointer === 'string' ? select.pointer : '',
    mapping: { title: fieldOfMapped(kind, mapping.title), detail: fieldOfMapped(kind, mapping.detail), group: typeof mapping.group === 'string' ? fieldOfMapped(kind, mapping.group) : null },
  }
}

const WIDGET_HTML = /(^|\/)visualisations\/([^/]+)\/widget\.html$/

/** `dir/` + a typed path, `.` and `..` folded: the workspace path an embed line or a recipe's source names. */
export function resolveFrom(dir: string, typed: string): string | null {
  const parts = dir === '' ? [] : dir.split('/')
  for (const part of typed.trim().split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') { if (parts.length === 0) return null; parts.pop() } else parts.push(part)
  }
  return parts.join('/')
}
export const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

/** The recipe behind an embed line, as a workspace path, or null when the line is not a standard widget's page. */
export function embedTarget(documentPath: string, line: string): { rawPath: string; pagePath: string; recipePath: string } | null {
  const embed = embedLine(line)
  if (!embed || embed.refusal) return null
  const pagePath = resolveFrom(dirOf(documentPath), embed.path)
  if (pagePath === null || !WIDGET_HTML.test(pagePath)) return null
  return { rawPath: embed.path, pagePath, recipePath: pagePath.replace(/widget\.html$/, 'widget.md') }
}

/** Whether a raw embed path is where a standard widget's page lives (the caption's Edit button shows only then). */
export const isStandardWidgetPath = (rawPath: string): boolean => WIDGET_HTML.test(rawPath.trim())

/** The plain sentence for a refused or failed step: the engine's message, then each named error's own sentence. */
export function refusalText(result: { message: string; errors: ReadonlyArray<{ message: string; severity: string }> }): string {
  const named = result.errors.filter((error) => error.severity === 'error').map((error) => error.message)
  return [result.message, ...named.filter((message) => !result.message.includes(message))].join(' ')
}

/** A title to start from: the file's name, spaced and capitalised. */
export function titleFromFile(path: string): string {
  const stem = (path.split('/').at(-1) ?? path).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim()
  return stem === '' ? 'Records' : stem.charAt(0).toUpperCase() + stem.slice(1)
}

/** A source file as the Source file list shows it: its path from the folder listed (the Folio folder). */
export function sourceLabel(folder: string, path: string): string {
  return folder !== '' && path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path
}

/** A declared resource of a Folio manifest's text: its Folio-relative path and how it was brought in, or null. */
export function declaredResource(manifestText: string, id: string): { path: string; inclusion: string } | null {
  try {
    const json = JSON.parse(manifestText) as { resources?: { items?: unknown } }
    const items = Array.isArray(json.resources?.items) ? json.resources.items as Array<Record<string, unknown>> : []
    const item = items.find((candidate) => typeof candidate === 'object' && candidate !== null && candidate.id === id)
    return item && typeof item.path === 'string' && typeof item.inclusion === 'string' ? { path: item.path, inclusion: item.inclusion } : null
  } catch { return null }
}

/** The 1-based line a create inserts at: the caret's line, or the document's last line when the text is now
 *  shorter (null: no caret known, so the end). */
export function insertLine(caretLine: number | null | undefined, documentText: string): number | null {
  if (caretLine === null || caretLine === undefined || !Number.isSafeInteger(caretLine) || caretLine < 1) return null
  const lines = documentText.split('\n').length - (documentText.endsWith('\n') && documentText.length > 0 ? 1 : 0) || 1
  return Math.min(caretLine, lines)
}

/** `historyDepth`: the document editor's undo depth (CodeMirror `undoDepth`) taken right after the Create, with its
 *  history closed there; the insert itself came from disk and is not in that history. */
export type JustCreated = { kind: 'create' | 'update'; documentPath: string; documentText?: string; historyDepth?: number }
/**
 * Whether ⌘Z (Ctrl+Z) now undoes the widget step rather than the editor's own last change: only right after a
 * Create, with the keyboard in that document's editor, its own undo history where the Create left it (no edit since,
 * or every edit since already undone), and its text what the Create left. Decided by the editor's history, never by
 * the text alone: typing a character and deleting it leaves the text as it was, but two undoable edits, so ⌘Z is the
 * editor's. Every other ⌘Z, ⇧⌘Z included, stays the editor's; so does any ⌘Z when the history depth was not taken.
 */
export function undoesWidgetCreate(key: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }, step: JustCreated | null, editor: { inEditor: boolean; documentPath: string | null; text: string; undoDepth: number | null }): boolean {
  if (key.key.toLowerCase() !== 'z' || key.shiftKey || key.altKey || !(key.metaKey || key.ctrlKey)) return false
  if (!step || step.kind !== 'create' || step.documentText === undefined || step.historyDepth === undefined) return false
  if (editor.undoDepth === null || editor.undoDepth !== step.historyDepth) return false
  return editor.inEditor && editor.documentPath === step.documentPath && editor.text === step.documentText
}
