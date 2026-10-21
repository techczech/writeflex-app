import { parseFrontmatterEntries, serialiseFrontmatterEntries } from './object-markup'
import { metadataEntry } from './metadata-registry'

export type MetadataRow = {
  key: string; from: number; to: number; value: string | string[]; editable: boolean; comment: string; itemComments: string[]
  /** The key's own bytes through its colon (`title :`, `'odd key':`), rewritten on edit exactly as found. */
  keyPrefix: string
  /** The value as written on the key's line, without its comment. */
  valueText: string
  /** For a list: each item as written, parallel to `value`; for a dashed list also the dash indent. */
  items: string[] | null; dash: string | null
  /** A top-level entry the key reader cannot name (`[a]: x`, `? key`): shown read-only, never edited. `valueText` is its first line. */
  opaque?: true
}
/** A field as the panel first loaded it: an edit session restores these bytes when the value is typed back. */
export type MetadataOriginal = MetadataRow & { text: string }

/** One top-level YAML key and its colon: a quoted key, or a plain one (`foo/bar`, `.custom`, `title `). */
const KEY_LINE = /^("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|(?:[^\s#'"\[\]{},&*!|>%@`?:-]|[?:-](?=\S))(?:[^:#\r\n]|:(?=\S)|(?<=\S)#)*?)[ \t]*:(?=[ \t\r\n]|$)/u

type ScalarType = 'string' | 'null' | 'bool' | 'boolword' | 'number' | 'timestamp'
/** How YAML (1.1 or 1.2) may read an unquoted scalar; anything not plainly a string counts as typed. */
function plainType(text: string): ScalarType {
  if (text === '' || /^(?:~|null|Null|NULL)$/.test(text)) return 'null'
  if (/^(?:true|True|TRUE|false|False|FALSE)$/.test(text)) return 'bool'
  if (/^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/.test(text)) return 'boolword'
  if (/^[-+]?(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][-+]?\d+)?$/.test(text) || /^(?:0x[\da-fA-F_]+|0o[0-7_]+|0b[01_]+)$/.test(text)
    || /^(?:[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/.test(text) || /^[-+]?\d[\d_]*(?::[0-5]?\d)+(?:\.[\d_]*)?$/.test(text)) return 'number'
  if (/^\d{4}-\d\d?-\d\d?(?:(?:[Tt]|[ \t]+)\d\d?:\d\d:\d\d(?:\.\d*)?(?:[ \t]*(?:Z|[-+]\d\d?(?::\d\d)?))?)?$/.test(text)) return 'timestamp'
  return 'string'
}
const quotedWith = (text: string): string => text.startsWith('"') ? '"' : text.startsWith("'") ? "'" : ''

/** A string the writer typed, quoted whenever YAML would otherwise read it as something else. */
function stringScalar(value: string, quote = '', list = false): string {
  // The object editor's encoder decides quoting; a list item also quotes a comma.
  const entry = serialiseFrontmatterEntries([list ? { kind: 'list', key: '_', values: [value] } : { kind: 'scalar', key: '_', value }])
  let text = !list ? entry.slice(3) : entry.startsWith('_: [') ? entry.slice(4, -1) : entry.replace(/^_:\n {2}- /, '')
  if (text === value && plainType(value) !== 'string') text = JSON.stringify(value)
  // Keep a single-quoted value single-quoted when it still needs quotes.
  if (quote === "'" && text !== value && !/[\n\r\t\u0085\u2028\u2029]/.test(value)) text = `'${value.replaceAll("'", "''")}'`
  return text
}
/** A field absent when editing began: bare only for a registry number or date field given exactly that. */
function declaredText(key: string, value: string): string {
  const type = metadataEntry(key)?.type
  // Bare only for a plain decimal: no sign but `-`, no leading zero (`012` is octal in YAML 1.1).
  if (type === 'number' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return value
  if (type === 'date' && /^\d{4}-\d\d-\d\d$/.test(value)) return value
  return stringScalar(value)
}
/** Bare only when the field held this exact non-string type when editing began and the new text is strictly that type. */
function scalarText(value: string, original: { valueText: string } | undefined): string {
  const quote = original ? quotedWith(original.valueText) : ''
  const type = original && !quote ? plainType(original.valueText) : 'string'
  if (type !== 'string' && plainType(value) === type) return value
  return stringScalar(value, quote)
}

/** Split a flow list's items as written, outside quotes and nested brackets; null when it is not a `[a, b]`. */
function flowItems(tail: string): string[] | null {
  if (!tail.startsWith('[') || !tail.endsWith(']')) return null
  const body = tail.slice(1, -1), items: string[] = []
  let quote = '', start = 0, depth = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quote) { if (quote === '"' && ch === '\\') i++; else if (ch === quote) quote = ''; continue }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) { items.push(body.slice(start, i).trim()); start = i + 1 }
  }
  const last = body.slice(start).trim()
  if (last || items.length) items.push(last)
  return items
}

/** Split comments only outside quotes; their whitespace belongs to the comment and survives a value edit. */
function commentAt(line: string): number {
  let quote = '', escaped = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (escaped) { escaped = false; continue }
    if (quote === '"' && ch === '\\') { escaped = true; continue }
    if (quote) { if (ch === quote) quote = ''; continue }
    if ((ch === '"' || ch === "'") && /^(?:\s*|.*[\[,]\s*)$/.test(line.slice(0, i))) { quote = ch; continue }
    if (ch === '#' && /\s/.test(line[i - 1] ?? '')) { while (i > 0 && /[ \t]/.test(line[i - 1])) i--; return i }
  }
  return line.length
}

/** Byte spans, not a YAML reserialisation: untouched keys, comments and opaque values never move. */
export function metadataRows(inner: string): MetadataRow[] {
  const lines = [...inner.matchAll(/[^\n]*(?:\n|$)/g)].filter(m => m[0] !== '')
  // Every top-level entry starts a row: a key line, or any other unindented content line (not a comment,
  // not a `- item` or `: value` continuation), which becomes an opaque row instead of joining its neighbour.
  const opaqueStart = (line: string): boolean => !/^(?:[ \t]|#|[-:](?:[ \t]|\r?\n|$)|\r?\n|$)/.test(line)
  const starts = lines.flatMap((m, i) => KEY_LINE.test(m[0]) || opaqueStart(m[0]) ? [i] : [])
  return starts.map((index, n): MetadataRow => {
    const first = lines[index], match = KEY_LINE.exec(first[0])
    let endIndex = (starts[n + 1] ?? lines.length) - 1
    // A standalone comment/blank line belongs to the document, never to a removable field.
    while (endIndex > index && /^[ \t]*(?:#.*)?\r?\n?$/.test(lines[endIndex][0])) endIndex--
    const from = first.index!, to = lines[endIndex].index! + lines[endIndex][0].length
    if (!match) {
      const text = first[0].replace(/\r?\n$/, '')
      return { key: `\u0000${text}`, from, to, value: '', editable: false, comment: '', itemComments: [], keyPrefix: '', valueText: text, items: null, dash: null, opaque: true }
    }
    const token = match[1]
    // YAML's own key: quotes decoded, spaces before the colon not part of it.
    const key = token.startsWith('"') ? (() => { try { return JSON.parse(token) as string } catch { return token } })() : token.startsWith("'") ? token.slice(1, -1).replaceAll("''", "'") : token.trim()
    const line = first[0].replace(/\r?\n$/, ''), prefix = match[0].length
    const cut = prefix + commentAt(line.slice(prefix)), comment = line.slice(cut)
    const raw = inner.slice(from, to).replace(/\r\n/g, '\n').replace(/\n$/, '')
    const itemComments: string[] = [], dashed: string[] = []
    let dash: string | null = null
    // The field parser reads the value under a stand-in key, so any key spelling YAML accepts can be edited.
    const withoutComment = ('_:' + line.slice(prefix, cut) + raw.slice(line.length)).split('\n').map((text, i) => {
      const found = i > 0 ? /^([ \t]+-[ \t]+)(.*)$/.exec(text) : null
      if (!found) return text
      const at = commentAt(found[2]); itemComments.push(found[2].slice(at)); dashed.push(found[2].slice(0, at).trimEnd()); dash ??= found[1]
      return found[1] + found[2].slice(0, at)
    }).join('\n')
    const parsed = parseFrontmatterEntries(withoutComment)
    const entry = parsed.length === 1 && parsed[0].kind !== 'raw' ? parsed[0] : null
    const tail = line.slice(prefix, cut).trim()
    const written = entry?.kind === 'list' ? (tail ? flowItems(tail) : dashed) : null
    // A list holding a nested list or map, an item with an anchor, alias or tag, or items the split cannot
    // match one-to-one with the parsed values is read-only: the panel shows it and leaves it to Edit as Markup.
    const nested = entry?.kind === 'list' && (written === null || written.length !== entry.values.length
      || written.some(item => /^(?:[\[{&*!]|-(?:[ \t]|$))/.test(item) || KEY_LINE.test(item)))
    const editable = entry !== null && !nested && !/^[{&*!> |]/.test(tail) && !/^\s*[^"'\[].*:\s/.test(tail)
    const value = entry?.kind === 'list' ? entry.values : entry?.kind === 'scalar' ? entry.value : ''
    const items = written && Array.isArray(value) && written.length === value.length ? written : null
    return { key, from, to, value, editable, comment, itemComments, keyPrefix: match[0], valueText: tail, items, dash: tail ? null : dash }
  })
}

/** Each uniquely named field as first loaded, for `editMetadataInner`'s `original`. */
export function metadataOriginals(inner: string): Map<string, MetadataOriginal> {
  const rows = metadataRows(inner), originals = new Map<string, MetadataOriginal>()
  for (const row of rows) if (rows.filter(r => r.key === row.key).length === 1) originals.set(row.key, { ...row, text: inner.slice(row.from, row.to).replace(/\r?\n$/, '') })
  return originals
}

const sameValue = (a: string | string[], b: string | string[]): boolean =>
  Array.isArray(a) ? Array.isArray(b) && a.length === b.length && a.every((item, i) => item === b[i]) : a === b

/**
 * Changes only one owned span. Null removes it. A scalar is a string unless `original` (the field when editing began;
 * defaults to the field as it is now) held the same non-string type; list items keep their spelling; a value typed
 * back to `original` restores its bytes.
 */
export function editMetadataInner(inner: string, key: string, value: string | string[] | null, lineEnding?: string, original?: MetadataOriginal | null): string {
  const matches = metadataRows(inner).filter(row => row.key === key)
  if (matches.length > 1) throw new Error('This key appears more than once. Resolve it in Edit as Markup first.')
  const row = matches[0]
  // An entry the key reader cannot name is never edited or removed by the panel.
  if (key.startsWith('\u0000') || row?.opaque) throw new Error('This entry uses structured YAML. Use Edit as Markup to change it.')
  if (row && value !== null && !row.editable) throw new Error('This value uses structured YAML. Use Edit as Markup to preserve it.')
  const eol = lineEnding ?? (inner.includes('\r\n') ? '\r\n' : '\n')
  const replace = (text: string): string => inner.slice(0, row.from) + text + (inner.slice(row.from, row.to).endsWith('\n') ? eol : '') + inner.slice(row.to)
  if (!row) {
    if (value === null || value === '' || (Array.isArray(value) && !value.length)) return inner
    const name = serialiseFrontmatterEntries([{ kind: 'scalar', key, value: 'x' }]).slice(0, -2)
    const items = Array.isArray(value) ? value.map(item => stringScalar(item, '', true)) : []
    // A new scalar field has no earlier type to keep: the encoder writes it as before (a registry field such as
    // toc_depth or goal stays a number). New list items are always strings.
    const encoded = !Array.isArray(value) ? original === null ? `${name} ${declaredText(key, value)}` : serialiseFrontmatterEntries([{ kind: 'scalar', key, value }])
      : items.some((item, i) => item.length > 40 || item !== value[i]) ? name + items.map(item => `${eol}  - ${item}`).join('') : `${name} [${items.join(', ')}]`
    return inner + (inner ? eol : '') + encoded
  }
  if (value === null) {
    // A removed key's inline comment stays as a standalone comment.
    const ending = inner.slice(row.from, row.to).endsWith('\n') ? eol : ''
    return inner.slice(0, row.from) + (row.comment ? row.comment.trimStart() + ending : '') + inner.slice(row.to)
  }
  // `null`: the field was absent when editing began, so its type comes from the registry for the whole session.
  if (original === null && typeof value === 'string') { const text = declaredText(key, value); return replace(`${row.keyPrefix}${text ? ' ' + text : ''}${row.comment}`) }
  const base = original ?? { ...row, text: inner.slice(row.from, row.to).replace(/\r?\n$/, '') }
  // Typing a value back to what the field held restores those bytes, quoting, spelling and comments included.
  if (sameValue(value, base.value)) return sameValue(row.value, base.value) && !original ? inner : replace(base.text.replace(/\r?\n/g, eol))
  if (typeof value === 'string') {
    const text = scalarText(value, base)
    return replace(`${row.keyPrefix}${text ? ' ' + text : ''}${row.comment}`)
  }
  // A list keeps its form; existing items keep their spelling and comments; only new items are encoded.
  const oldValues = Array.isArray(row.value) ? row.value : row.value ? [row.value] : []
  const written = row.items ?? oldValues.map(item => stringScalar(item, '', true))
  const retained = new Set<number>()
  const items = value.map(item => {
    const index = oldValues.findIndex((old, i) => old === item && !retained.has(i))
    if (index < 0) return { text: stringScalar(item, '', true), comment: '' }
    retained.add(index); return { text: written[index], comment: row.itemComments[index] ?? '' }
  })
  const leftover = row.itemComments.flatMap((comment, i) => comment && !retained.has(i) ? [comment.trimStart()] : [])
  const indent = (row.dash ?? '  - ').replace(/-[ \t]*$/, '')
  const tailComments = leftover.map(comment => `${eol}${indent}${comment}`).join('')
  if (row.dash && items.length) return replace(`${row.keyPrefix}${row.comment}` + items.map(item => `${eol}${row.dash}${item.text}${item.comment}`).join('') + tailComments)
  return replace(`${row.keyPrefix} [${items.map(item => item.text).join(', ')}]${row.comment}` + tailComments)
}

export function metadataSummary(inner: string): string {
  const rows = metadataRows(inner)
  const value = (key: string) => rows.find(row => row.key === key)?.value
  const tags = value('tags'), count = Array.isArray(tags) ? tags.length : tags ? 1 : 0
  return [value('title'), value('status'), count ? `${count} tag${count === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || 'Document metadata'
}
