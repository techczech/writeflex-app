/**
 * The frontmatter organ (Task 22, ADR-0008). READS a file's YAML frontmatter into a typed shape and
 * derives the Frontmatter Pattern an Index Note declares. It **NEVER writes** — there is no write API
 * here, by design: frontmatter is never auto-inserted (bare files stay bare; a repo under review must
 * not be polluted). Normalising an archive's metadata is agent housekeeping — staged, reviewable,
 * undoable (T24, through the suggestion pipeline) — not something this module can do.
 *
 * The parser is a hand-rolled minimal YAML subset (scalars, quoted scalars, inline `[a, b]` lists and
 * dashed block lists) — deliberately NO `yaml` dependency: it would fail the release-age gate and add
 * weight for a fraction of YAML we ever meet in a writing folder. Anything it cannot parse is kept raw
 * rather than thrown away, and a malformed block never throws.
 */

import {
  frontmatterBlock,
  FRONTMATTER_DASH_ITEM,
  FRONTMATTER_KEY_VALUE,
} from '../shared/markdown/frontmatter'
import { eachInline, readDocument, type Block } from '../shared/markdown/model'

/** Core fields promote to typed properties; everything else is preserved verbatim in `extra`. The
 *  frontmatter key `series-order` maps to `seriesOrder`. `extra._raw` holds unparseable lines. */
export type Frontmatter = {
  title?: string
  date?: string
  status?: string
  author?: string
  description?: string
  purpose?: string
  related?: string[]
  tags?: string[]
  series?: string
  seriesOrder?: number
  extra: Record<string, unknown>
}

/** A Frontmatter Pattern: the ordered columns a Collection is browsed/sorted by (ADR-0008, PRD S32).
 *  Columns are core-field keys or any `extra` key an Index Note names. */
export type Pattern = { name: string; columns: Array<keyof Frontmatter | string> }

/** The universal-core pattern every Collection inherits implicitly (ADR-0034). Title is derived. */
export const DEFAULT_PATTERN: Array<keyof Frontmatter | string> = ['date', 'status', 'purpose', 'related']

// What a frontmatter block IS lives in shared/markdown/frontmatter.ts, because the exporters must
// remove exactly the block this organ reads (finding 4). It is imported, never restated here.
const KEY_VALUE = FRONTMATTER_KEY_VALUE
const DASH_ITEM = FRONTMATTER_DASH_ITEM

/** Strip a single matching pair of surrounding quotes (single or double); leave inner text as-is. */
function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && v[0] === '"' && v.at(-1) === '"') {
    try { return JSON.parse(v) as string } catch { return v.slice(1, -1) }
  }
  if (v.length >= 2 && v[0] === "'" && v.at(-1) === "'") {
    return v.slice(1, -1).replace(/''/g, "'")
  }
  return v
}

/** `[a, b, "c, still c-ish"]` → string items. Minimal: splits on commas (quote-aware enough for the
 *  writing-folder frontmatter we meet); each item is unquoted and empties are dropped. */
function parseInlineList(value: string): string[] {
  const inner = value.trim().slice(1, -1) // drop the surrounding [ ]
  if (inner.trim() === '') return []
  const items: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ',') {
      items.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  items.push(current.trim())
  return items.map((i) => unquote(i)).filter((i) => i !== '')
}

/** The frontmatter body lines — or null when the document has no LEADING frontmatter block. A `---`
 *  anywhere but the first line is a thematic break, not frontmatter (bare files stay bare); a
 *  leading `---` with no closing fence is likewise not frontmatter; and a leading block that
 *  declares no YAML key at all is a document that opens on a rule, not metadata. The rule and its
 *  BOM handling live in shared/markdown/frontmatter.ts, so the exporters strip exactly this block. */
function fencedBody(text: string): string[] | null {
  return frontmatterBlock(text)?.lines ?? null
}

/** Where a parsed value lands: a core typed field, or `extra`. Core list fields coerce a lone scalar
 *  to a one-element list; an empty list-key contributes nothing (stays absent). */
function assign(fm: Frontmatter, key: string, value: string | string[]): void {
  const asString = Array.isArray(value) ? (value[0] ?? '') : value
  const asList = Array.isArray(value) ? value : value === '' ? [] : [value]
  switch (key) {
    case 'title': fm.title = asString; break
    case 'date': fm.date = asString; break
    case 'status': fm.status = asString; break
    case 'author': fm.author = asString; break
    case 'description': fm.description = asString; break
    case 'purpose': fm.purpose = asString; break
    case 'series': fm.series = asString; break
    case 'related': if (asList.length) fm.related = asList; break
    case 'tags': if (asList.length) fm.tags = asList; break
    case 'series-order': {
      const n = Number(asString)
      if (asString !== '' && Number.isFinite(n)) fm.seriesOrder = n
      break
    }
    default: fm.extra[key] = Array.isArray(value) ? value : value
  }
}

/**
 * Parse a document's leading frontmatter into a typed shape, or return null when the document has no
 * leading `---` block (bare files stay bare — the hardest ADR-0008 rule). Malformed lines inside a
 * valid fence never throw: parseable `key: value` / list forms are kept, and anything unparseable is
 * preserved raw under `extra._raw` so nothing is silently lost.
 */
export function parseFrontmatter(text: string): Frontmatter | null {
  const body = fencedBody(text)
  if (body === null) return null

  const fm: Frontmatter = { extra: {} }
  const raw: string[] = []
  for (let i = 0; i < body.length; i += 1) {
    const line = body[i]
    if (line.trim() === '') continue
    const kv = KEY_VALUE.exec(line)
    if (!kv) { raw.push(line.trim()); continue } // stray dash / junk line: keep it, never throw
    const key = kv[1]
    const value = kv[2].trim()
    if (value === '') {
      // An empty value may head a dashed block list on the following lines.
      const items: string[] = []
      while (i + 1 < body.length && DASH_ITEM.test(body[i + 1])) {
        i += 1
        items.push(unquote(DASH_ITEM.exec(body[i])![1]))
      }
      assign(fm, key, items.length ? items.filter((v) => v !== '') : '')
    } else if (value.startsWith('[') && value.endsWith(']')) {
      assign(fm, key, parseInlineList(value))
    } else {
      assign(fm, key, unquote(value))
    }
  }
  if (raw.length) fm.extra._raw = raw
  return fm
}

// ---- Writing goals (Round A T5, ADR-0002/0019/0028) --------------------------------------------
// `goal:`/`due:` are ORDINARY frontmatter keys (they live in `extra` — no schema promotion, so the
// observed Frontmatter Pattern and query blocks see them like any other key). parseGoal is the one
// sanctioned reading; anything malformed reads as null — the status bar shows a plain count, never
// error chrome (frontmatter problems are not status-bar problems).

export type Goal = { target: number; due: string | null }

/** A calendar date the gauge can trust: ISO `YYYY-MM-DD` with a real month/day. */
function validDue(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [, month, day] = value.split('-').map(Number)
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return value
}

/**
 * Read a document's writing goal from its parsed frontmatter. The target must be a positive whole
 * number; anything else (absent, `soon`, lists, zero, decimals) → null. An invalid `due` degrades to
 * no due while a valid goal survives — the deadline is garnish, the target is the instrument.
 */
export function parseGoal(fm: Frontmatter | null): Goal | null {
  const raw = fm?.extra.goal
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null
  const target = Number(raw)
  if (!Number.isSafeInteger(target) || target <= 0) return null
  return { target, due: validDue(fm?.extra.due) }
}

/** Gauge fill: proportional below target, capped at 100 (the done state takes over from there). */
export function goalPercent(words: number, target: number): number {
  if (target <= 0) return 0
  return Math.min(100, (words / target) * 100)
}

/** Local-date compare: overdue strictly BEFORE today — a goal due today is still on time. */
export function isOverdue(due: string | null, today: Date = new Date()): boolean {
  if (due === null) return false
  const localISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return due < localISO
}

/** The exact key vocabulary present in a valid leading frontmatter block, in source order. This is
 *  deliberately separate from the promoted typed shape: empty and unknown keys still belong to the
 *  folder's observed Frontmatter Pattern. */
export function frontmatterKeys(text: string): string[] {
  const body = fencedBody(text)
  if (body === null) return []
  const keys: string[] = []
  for (const line of body) {
    const key = KEY_VALUE.exec(line)?.[1]
    if (key !== undefined && !keys.includes(key)) keys.push(key)
  }
  return keys
}

/**
 * The Frontmatter Pattern for a Collection: the columns it is browsed/sorted by. Reads `pattern:` from
 * an Index Note's OWN frontmatter (inline or dashed list); falls back to the universal-core default
 * when there is no Index Note, no frontmatter, or no `pattern:` key.
 */
export function patternFor(indexNoteText: string | null): Pattern {
  const declared = indexNoteText ? parseFrontmatter(indexNoteText)?.extra.pattern : undefined
  const columns = Array.isArray(declared)
    ? (declared as unknown[]).map((c) => String(c))
    : typeof declared === 'string' && declared !== ''
      ? [declared]
      : null
  return columns && columns.length
    ? { name: 'custom', columns }
    : { name: 'default', columns: DEFAULT_PATTERN }
}

/**
 * WHAT A PIECE IS CALLED: its first heading of any level, else the file's own name. Legacy `title:` keys remain
 * intact but never become listing display truth (ADR-0034). Export has a metadata-first
 * exception in export-title.ts (owner instruction, 2026-10-19).
 */
export function documentTitle(source: string, path: string): string {
  const heading = readDocument(source).blocks.find(
    (block): block is Extract<Block, { kind: 'heading' }> => block.kind === 'heading',
  )
  if (heading) {
    let text = ''
    eachInline([heading], (part) => {
      if (part.kind === 'text' || part.kind === 'code') text += part.text
      if (part.kind === 'wikilink') text += part.label
    })
    if (text.trim()) return text.trim()
  }
  return (path.split('/').pop() ?? path).replace(/\.(?:md|markdown|mdx)$/i, '')
}

// ---- Nested subset (standard widget recipes, contracts §3 + C2) -------------------------------------
// A widget recipe (`visualisations/<name>/widget.md`) nests: `source.select.pointer`, `mapping.types.Hours`.
// The flat reader above keeps indented keys raw, by design; recipes are read by this second reader over the
// SAME block (`frontmatterBlock`), still with no YAML dependency. The documented subset, and nothing more:
//   - `key: value` lines; a key with no value opens a map whose keys are indented two spaces deeper;
//   - maps nest at most three levels (indent 0, 2, 4);
//   - a value is a quoted scalar ("…" or '…', taken verbatim between the quotes), an integer (`-?digits`),
//     an inline flow list of scalars (`[a, b]`, split on commas), or plain text (trimmed);
//   - blank lines and whole-line `#` comments are skipped.
// Refused (never guessed): tabs or odd indentation, a key deeper than its map allows, dashed block lists,
// anchors, block scalars, a key written twice in one map.

export type NestedValue = string | number | NestedValue[] | NestedMap
export type NestedMap = { [key: string]: NestedValue }
export type NestedFrontmatter =
  | { ok: true; value: NestedMap; /** Index in the ORIGINAL text where the body starts. */ bodyStart: number }
  | { ok: false; /** 1-based line of the file, when one line is to blame. */ line?: number; detail: string }

/** Deepest map level a recipe uses (`mapping.types.<field>`). */
export const NESTED_MAX_DEPTH = 3
const NESTED_LINE = /^( *)([^\s:#][^:]*?):(?:[ \t]+(.*))?$/

/** One scalar or inline list, by the subset's rules. */
function nestedScalar(raw: string): NestedValue {
  const value = raw.trim()
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((part) => part.trim()).filter((part) => part !== '').map(nestedScalar)
  }
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^(["']).*\1$/.test(value)) return value.slice(1, -1)
  return value
}

/** Read a leading frontmatter block as nested maps. Never throws; refuses what the subset does not cover. */
export function parseNestedFrontmatter(text: string): NestedFrontmatter {
  const block = frontmatterBlock(text)
  if (block === null) return { ok: false, detail: 'the file has no frontmatter block' }
  const firstLine = 2 // the body lines start on the line after the opening fence
  const root: NestedMap = {}
  const stack: Array<{ indent: number; map: NestedMap }> = [{ indent: -2, map: root }]
  let opened: { indent: number; map: NestedMap } | null = null
  for (let i = 0; i < block.lines.length; i += 1) {
    const line = block.lines[i]
    const at = i + firstLine
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^ *\t/.test(line)) return { ok: false, line: at, detail: 'indented with a tab' }
    const match = NESTED_LINE.exec(line)
    if (!match || /^-(\s|$)/.test(match[2])) return { ok: false, line: at, detail: 'not a key: value line' }
    const indent = match[1].length
    if (indent % 2 !== 0) return { ok: false, line: at, detail: 'indented by an odd number of spaces' }
    if (opened) {
      // The line after a `key:` with no value must be its first child, or the map stays empty.
      if (indent === opened.indent + 2) stack.push(opened)
      opened = null
    }
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack[stack.length - 1]
    if (indent !== parent.indent + 2) return { ok: false, line: at, detail: 'indented deeper than its map' }
    const key = match[2].trim()
    if (Object.prototype.hasOwnProperty.call(parent.map, key)) return { ok: false, line: at, detail: `the key ${key} is written twice` }
    if (match[3] === undefined || match[3].trim() === '') {
      if (stack.length >= NESTED_MAX_DEPTH) return { ok: false, line: at, detail: `maps nest at most ${NESTED_MAX_DEPTH} levels` }
      const child: NestedMap = {}
      parent.map[key] = child
      opened = { indent, map: child }
    } else {
      parent.map[key] = nestedScalar(match[3])
    }
  }
  return { ok: true, value: root, bodyStart: block.end }
}
