/**
 * The standard-widget recipe (contracts §3): `visualisations/<name>/widget.md`, whose frontmatter is the recipe
 * and whose body is the author's own text, never rewritten. This module reads a recipe (the nested frontmatter
 * subset of frontmatter.ts), checks it against the registered template catalogue, names the source fields it
 * maps, and writes one: a new recipe whole, an existing one by replacing only the top-level keys that change,
 * so unknown keys, comments outside a changed key and the body keep their bytes.
 *
 * Every write is checked by reading it back: text this module produces must parse to exactly the map it was
 * asked to write, or it is refused (`recipe-invalid`), never written approximately.
 */
import { parseNestedFrontmatter, type NestedMap, type NestedValue } from '../frontmatter'

export type RecipeMap = NestedMap
export type RecipeValue = NestedValue
/** A named problem, flat (the fixtures' shape: `{ code, line?, record?, field?, value?, detail? }`). */
export type WidgetIssue = { code: string } & Record<string, unknown>

export const isRecipeMap = (value: unknown): value is RecipeMap => typeof value === 'object' && value !== null && !Array.isArray(value)

const STRUCTURED = ['structured-markdown', 'structured-text']
const TABULAR = ['csv', 'json', 'markdown-table']
export const SOURCE_FORMATS: readonly string[] = [...TABULAR, ...STRUCTURED, 'folder']

/** The registered templates (§3): which source formats each takes, its views, and its required mappings. */
export const TEMPLATE_CATALOGUE: Readonly<Record<string, { formats: readonly string[]; views: readonly string[]; required: readonly string[] }>> = {
  browser: { formats: [...STRUCTURED, 'csv', 'json'], views: ['browser', 'list'], required: ['title', 'detail'] },
  pyramid: { formats: STRUCTURED, views: ['pyramid', 'list', 'table'], required: ['title', 'detail'] },
  'data-explorer': { formats: TABULAR, views: ['table', 'cards', 'bar', 'line', 'scatter'], required: ['title'] },
  'file-catalogue': { formats: ['folder'], views: ['tree', 'list'], required: [] },
  calendar: { formats: TABULAR, views: ['month', 'agenda', 'timeline'], required: ['id', 'title', 'start'] },
  timeline: { formats: TABULAR, views: ['timeline', 'agenda', 'month'], required: ['id', 'title', 'start'] },
}

export type ParsedRecipe = { ok: true; recipe: RecipeMap; body: string } | { ok: false; errors: WidgetIssue[] }

/** Read a recipe file's text. Unreadable frontmatter is `recipe-unreadable`, with the line when one is to blame. */
export function parseRecipeText(text: string): ParsedRecipe {
  const parsed = parseNestedFrontmatter(text)
  if (!parsed.ok) return { ok: false, errors: [{ code: 'recipe-unreadable', ...(parsed.line !== undefined ? { line: parsed.line } : {}), detail: parsed.detail }] }
  return { ok: true, recipe: parsed.value, body: text.slice(parsed.bodyStart) }
}

/**
 * §3 recipe rules. Schema, template and template-version errors stop the check; the rest are collected, in
 * this order: source shape, selectors, template/format fit, views, required mappings, chart keys.
 */
export function checkRecipe(recipe: RecipeMap): WidgetIssue[] {
  if (recipe.widget_schema !== 1) return [{ code: 'recipe-schema-unsupported', value: recipe.widget_schema }]
  if (typeof recipe.template !== 'string') return [{ code: 'recipe-invalid', field: 'template' }]
  // Own entries only: `toString` or `constructor` names no registered template.
  const template = Object.hasOwn(TEMPLATE_CATALOGUE, recipe.template) ? TEMPLATE_CATALOGUE[recipe.template] : undefined
  if (!template) return [{ code: 'recipe-unknown-template', value: recipe.template }]
  if (recipe.template_version !== 1) return [{ code: 'recipe-template-version-unsupported', value: recipe.template_version }]
  const errors: WidgetIssue[] = []
  const source = recipe.source
  if (!isRecipeMap(source) || typeof source.format !== 'string' || !SOURCE_FORMATS.includes(source.format)) return [{ code: 'recipe-invalid', field: 'source.format' }]
  const select = source.select
  if (source.format === 'folder') {
    if (!isRecipeMap(select) || typeof select.folder !== 'string') errors.push({ code: 'recipe-invalid', field: 'source.select.folder' })
  } else if ((typeof source.path === 'string') === (typeof source.resource === 'string')) {
    errors.push({ code: 'recipe-invalid', field: 'source', detail: 'exactly one of path and resource' })
  }
  if (source.format === 'json' && !(isRecipeMap(select) && typeof select.pointer === 'string' && (select.pointer === '' || select.pointer.startsWith('/')))) {
    errors.push({ code: 'recipe-invalid', field: 'source.select.pointer' })
  }
  if (STRUCTURED.includes(source.format)) {
    if (!isRecipeMap(select) || typeof select.level !== 'number' || !Number.isInteger(select.level) || select.level < 1 || select.level > 6) errors.push({ code: 'recipe-invalid', field: 'source.select.level' })
    else if (Object.hasOwn(select, 'section') && typeof select.section !== 'string') errors.push({ code: 'recipe-invalid', field: 'source.select.section' })
  }
  if (!template.formats.includes(source.format)) errors.push({ code: 'recipe-mapping-incompatible', field: 'source.format', value: source.format })
  const views = recipe.views
  if (!Array.isArray(views) || views.length === 0 || views.some((view) => typeof view !== 'string' || !template.views.includes(view))) errors.push({ code: 'recipe-invalid', field: 'views' })
  if (Object.hasOwn(recipe, 'initial')) {
    const initial = recipe.initial
    if (!isRecipeMap(initial)) errors.push({ code: 'recipe-invalid', field: 'initial' })
    else if (Object.hasOwn(initial, 'view') && !(typeof initial.view === 'string' && Array.isArray(views) && views.includes(initial.view))) errors.push({ code: 'recipe-invalid', field: 'initial.view', value: initial.view })
  }
  const mapping = isRecipeMap(recipe.mapping) ? recipe.mapping : {}
  for (const key of template.required) if (typeof mapping[key] !== 'string') errors.push({ code: 'recipe-mapping-missing', field: `mapping.${key}` })
  const types = isRecipeMap(mapping.types) ? mapping.types : {}
  const chart = isRecipeMap(recipe.chart) ? recipe.chart : {}
  const viewList = Array.isArray(views) ? views : []
  const need = (key: string): string | null => {
    if (typeof chart[key] === 'string') return chart[key] as string
    errors.push({ code: 'recipe-mapping-missing', field: `chart.${key}` })
    return null
  }
  const typedAs = (key: string, field: string | null, allowed: string[], detail: string): void => {
    if (field !== null && !allowed.includes(types[field] as string)) errors.push({ code: 'recipe-mapping-incompatible', field: `chart.${key}`, value: field, detail })
  }
  if (viewList.includes('bar')) {
    need('category')
    const metric = need('metric')
    if (metric !== null && !['count', 'sum', 'mean'].includes(metric)) errors.push({ code: 'recipe-invalid', field: 'chart.metric', value: metric })
    if (metric === 'sum' || metric === 'mean') typedAs('measure', need('measure'), ['number'], 'sum and mean need a number field')
  }
  if (viewList.includes('line')) {
    typedAs('x', need('x'), ['number', 'date', 'datetime'], 'a line needs an ordered number or date axis')
    typedAs('y', need('y'), ['number'], 'a line needs a number field')
  }
  if (viewList.includes('scatter')) {
    typedAs('x', need('x'), ['number'], 'scatter needs two number fields')
    typedAs('y', need('y'), ['number'], 'scatter needs two number fields')
  }
  return errors
}

/** Every source field the recipe names, in mapping order then chart keys then declared types; each once. */
export function mappedFields(recipe: RecipeMap): string[] {
  const mapping = isRecipeMap(recipe.mapping) ? recipe.mapping : {}
  const chart = isRecipeMap(recipe.chart) ? recipe.chart : {}
  const names: string[] = []
  const add = (value: RecipeValue | undefined): void => {
    if (typeof value === 'string') names.push(value)
    else if (Array.isArray(value)) value.forEach(add)
  }
  for (const key of ['id', 'title', 'detail', 'group', 'tags', 'columns', 'search', 'filters', 'start', 'end', 'zone', 'category', 'lane', 'resource']) add(mapping[key])
  for (const key of ['category', 'measure', 'x', 'y']) add(chart[key])
  if (isRecipeMap(mapping.types)) names.push(...Object.keys(mapping.types))
  return [...new Set(names)]
}

/** The declared number/date types of `mapping.types`, as strings. */
export function declaredTypes(recipe: RecipeMap): Record<string, string> | undefined {
  const mapping = isRecipeMap(recipe.mapping) ? recipe.mapping : {}
  if (!isRecipeMap(mapping.types)) return undefined
  return Object.fromEntries(Object.entries(mapping.types).map(([key, value]) => [key, String(value)]))
}

// ---------------------------------------------------------------- writing

const KEY = /^[^\s:#-][^:\n\r]*$/

function scalarText(value: string | number): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RecipeWriteRefused(`${value} is not a whole number`)
    return String(value)
  }
  if (/[\r\n]/.test(value)) throw new RecipeWriteRefused('a recipe value cannot hold a line break')
  const plain = value !== '' && value === value.trim() && !/^["'[#]/.test(value) && !/^-?\d+$/.test(value) && !/^-(\s|$)/.test(value)
  return plain ? value : `"${value}"`
}

function valueText(value: RecipeValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => {
      if (Array.isArray(item) || isRecipeMap(item)) throw new RecipeWriteRefused('a list holds plain values only')
      const text = scalarText(item)
      if (/[,\]]/.test(text) || (typeof item === 'string' && item.trim() !== item) || item === '') throw new RecipeWriteRefused(`the list value ${JSON.stringify(item)} cannot be written in a recipe list`)
      return text
    }).join(', ')}]`
  }
  if (isRecipeMap(value)) throw new RecipeWriteRefused('internal: a map has no single-line form')
  return scalarText(value)
}

/** The frontmatter lines of one key and its value (a map nests below it). */
function keyLines(key: string, value: RecipeValue, indent: number): string[] {
  if (!KEY.test(key) || key !== key.trim()) throw new RecipeWriteRefused(`${JSON.stringify(key)} cannot be a recipe key`)
  const pad = ' '.repeat(indent)
  if (isRecipeMap(value)) return [`${pad}${key}:`, ...Object.entries(value).flatMap(([child, inner]) => keyLines(child, inner, indent + 2))]
  return [`${pad}${key}: ${valueText(value)}`]
}

export class RecipeWriteRefused extends Error {}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b) && sameKeys(a, b)
function sameKeys(a: unknown, b: unknown): boolean {
  if (isRecipeMap(a) && isRecipeMap(b)) return Object.keys(a).join('\0') === Object.keys(b).join('\0') && Object.keys(a).every((key) => sameKeys(a[key], b[key]))
  return true
}

/** The recipe read back from `text` must be `expected`, key order included, and the body must be unchanged. */
function confirmRoundTrip(text: string, expected: RecipeMap, body: string): string {
  const back = parseRecipeText(text)
  if (!back.ok || !sameValue(back.recipe, expected) || back.body !== body) throw new RecipeWriteRefused('the recipe would not read back as written')
  return text
}

/** A new recipe file: frontmatter for `recipe`, then `body` as given. Throws RecipeWriteRefused. */
export function recipeText(recipe: RecipeMap, body = ''): string {
  const lines = Object.entries(recipe).flatMap(([key, value]) => keyLines(key, value, 0))
  return confirmRoundTrip(`---\n${lines.join('\n')}\n---\n${body}`, recipe, body)
}

/**
 * `text` with the top-level keys of `patch` replaced (a value), removed (null) or added at the end of the
 * frontmatter. Every other line keeps its bytes: other keys, their comments, the body. Throws RecipeWriteRefused
 * when the existing text is not a readable recipe or the result would not read back as the merged recipe.
 */
export function updatedRecipeText(text: string, patch: Record<string, RecipeValue | null>): string {
  const current = parseRecipeText(text)
  if (!current.ok) throw new RecipeWriteRefused('the recipe as it stands cannot be read, so it is not rewritten')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const bodyStart = text.length - current.body.length
  const head = text.slice(0, bodyStart)
  const lines = head.split('\n')
  // lines[0] is the opening fence (maybe after a BOM); the closing fence is the last non-empty piece.
  const close = lines.length - 1 - (lines[lines.length - 1] === '' ? 1 : 0)
  const blocks: Array<{ key: string | null; lines: string[] }> = [{ key: null, lines: [] }]
  for (let i = 1; i < close; i += 1) {
    const bare = lines[i].replace(/\r$/, '')
    const top = /^([^\s:#][^:]*?):(?:[ \t]|$)/.exec(bare)
    if (top) blocks.push({ key: top[1].trim(), lines: [lines[i]] })
    else blocks[blocks.length - 1].lines.push(lines[i])
  }
  const merged: RecipeMap = {}
  // Own keys only, on both sides: an authored `toString` key is not a patch of it, and a patch key is new
  // unless the recipe itself has it.
  const patched = (key: string): boolean => Object.hasOwn(patch, key)
  for (const [key, value] of Object.entries(current.recipe)) if (!patched(key)) merged[key] = value
  const out: string[] = []
  for (const block of blocks) {
    if (block.key === null || !patched(block.key)) { out.push(...block.lines); continue }
    const next = patch[block.key]
    if (next === null) continue
    merged[block.key] = next
    out.push(...keyLines(block.key, next, 0).map((line) => `${line}${eol === '\r\n' ? '\r' : ''}`))
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || Object.hasOwn(current.recipe, key)) continue
    merged[key] = value
    out.push(...keyLines(key, value, 0).map((line) => `${line}${eol === '\r\n' ? '\r' : ''}`))
  }
  const rebuilt = [lines[0], ...out, ...lines.slice(close)].join('\n') + current.body
  // Key order of the merged map is the order the lines now carry.
  const ordered = parseRecipeText(rebuilt)
  if (!ordered.ok) throw new RecipeWriteRefused('the recipe would not read back as written')
  const expected: RecipeMap = {}
  for (const key of Object.keys(ordered.recipe)) if (Object.hasOwn(merged, key)) expected[key] = merged[key]
  if (Object.keys(expected).length !== Object.keys(merged).length) throw new RecipeWriteRefused('the recipe would not read back as written')
  return confirmRoundTrip(rebuilt, expected, current.body)
}

