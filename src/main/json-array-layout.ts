export type RawJsonEntry = { start: number; end: number; raw: string; value: unknown }
export type JsonArrayLayout = { start: number; end: number; entries: RawJsonEntry[] }
type JsonObjectPropertyLayout = { valueStart: number; valueEnd: number }

function skipJsonString(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') index += 1
    else if (source[index] === '"') return index + 1
  }
  throw new Error('Unterminated JSON string.')
}

function skipJsonSpace(source: string, start: number): number {
  let index = start
  while (/\s/.test(source[index] ?? '')) index += 1
  return index
}

function jsonValueEnd(source: string, start: number): number {
  const first = source[start]
  if (first === '"') return skipJsonString(source, start)
  if (first === '{' || first === '[') {
    const stack = [first]
    for (let index = start + 1; index < source.length; index += 1) {
      const char = source[index]
      if (char === '"') {
        index = skipJsonString(source, index) - 1
        continue
      }
      if (char === '{' || char === '[') stack.push(char)
      else if (char === '}' || char === ']') {
        stack.pop()
        if (!stack.length) return index + 1
      }
    }
    throw new Error('Unterminated JSON value.')
  }
  let index = start
  while (index < source.length && !/[\s,}\]]/.test(source[index])) index += 1
  return index
}

function objectPropertyLayout(source: string, propertyKey: string): JsonObjectPropertyLayout | null {
  let index = skipJsonSpace(source, 0)
  if (source[index] !== '{') return null
  index += 1
  let match: JsonObjectPropertyLayout | null = null
  while (index < source.length) {
    index = skipJsonSpace(source, index)
    if (source[index] === '}') return match
    if (source[index] === ',') {
      index += 1
      continue
    }
    if (source[index] !== '"') return null
    const keyStart = index
    const keyEnd = skipJsonString(source, keyStart)
    const key = JSON.parse(source.slice(keyStart, keyEnd)) as string
    index = skipJsonSpace(source, keyEnd)
    if (source[index] !== ':') return null
    index = skipJsonSpace(source, index + 1)
    const valueEnd = jsonValueEnd(source, index)
    if (key === propertyKey) {
      if (match) throw new Error(`Cannot surgically update JSON with duplicate ${propertyKey} properties.`)
      match = { valueStart: index, valueEnd }
    }
    index = valueEnd
  }
  return match
}

/** Locate one top-level array and its entries without normalising any source bytes. */
export function jsonArrayLayout(source: string, arrayKey: string): JsonArrayLayout {
  const property = objectPropertyLayout(source, arrayKey)
  if (!property || source[property.valueStart] !== '[') {
    throw new Error(`Cannot surgically update JSON without a ${arrayKey} array.`)
  }
  const start = property.valueStart
  const end = property.valueEnd - 1
  const entries: RawJsonEntry[] = []
  let item = start + 1
  while (item < end) {
    item = skipJsonSpace(source, item)
    if (source[item] === ',') {
      item += 1
      continue
    }
    if (item >= end) break
    const itemEnd = jsonValueEnd(source, item)
    const raw = source.slice(item, itemEnd)
    entries.push({ start: item, end: itemEnd, raw, value: JSON.parse(raw) })
    item = itemEnd
  }
  return { start, end, entries }
}

/** Rewrite one top-level string property while retaining every other byte in the object. */
export function rewriteJsonObjectStringProperty(source: string, propertyKey: string, value: string): string {
  const property = objectPropertyLayout(source, propertyKey)
  if (!property || typeof JSON.parse(source.slice(property.valueStart, property.valueEnd)) !== 'string') {
    throw new Error(`Cannot surgically update JSON without a top-level ${propertyKey} string.`)
  }
  return `${source.slice(0, property.valueStart)}${JSON.stringify(value)}${source.slice(property.valueEnd)}`
}

function lineIndentBefore(source: string, index: number): string {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1
  return /^\s*/.exec(source.slice(lineStart, index))?.[0] ?? ''
}

/**
 * Replace one keyed JSON array while retaining untouched entries and all bytes outside the array.
 * The separators between the array's slots are retained in place too: only the elements move.
 * `verbatim` names desired entries that stand for one existing entry by its position in the array:
 * that entry's source bytes are written as they are, and it is not matched by key to anything else.
 */
export function rewriteJsonArrayByKey(
  source: string,
  arrayKey: string,
  entryKey: string,
  desired: Array<Record<string, unknown>>,
  verbatim: ReadonlyMap<Record<string, unknown>, number> = new Map(),
): string {
  const parsed = JSON.parse(source) as Record<string, unknown>
  if (!Array.isArray(parsed[arrayKey])) {
    throw new Error(`Cannot surgically update JSON without a ${arrayKey} array.`)
  }
  const layout = jsonArrayLayout(source, arrayKey)

  const heldVerbatim = new Set(verbatim.values())
  const existingByKey = new Map<string, RawJsonEntry[]>()
  for (const [index, entry] of layout.entries.entries()) {
    if (heldVerbatim.has(index)) continue
    if (typeof entry.value !== 'object' || entry.value === null) continue
    const key = (entry.value as Record<string, unknown>)[entryKey]
    if (typeof key !== 'string') continue
    const bucket = existingByKey.get(key)
    if (bucket) bucket.push(entry)
    else existingByKey.set(key, [entry])
  }

  const pretty = source.includes('\n')
  // A new line written here ends as the file's lines end, so a CRLF manifest gains CRLF lines.
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const arrayIndent = lineIndentBefore(source, layout.start)
  const entryIndent = layout.entries.length
    ? lineIndentBefore(source, layout.entries[0].start)
    : `${arrayIndent}${arrayIndent.includes('\t') ? '\t' : '  '}`
  // Separators stay where they are: the bytes between slot i and slot i + 1 are the source's own, whichever
  // elements end up in those slots. A slot past the source's last one (an append) repeats the last separator.
  const separators = layout.entries.slice(1).map((entry, at) => source.slice(layout.entries[at].end, entry.start))
  const appended = separators.at(-1) ?? (pretty ? `,${eol}${entryIndent}` : ',')
  const entries = desired.map((value) => {
    const held = verbatim.get(value)
    if (held !== undefined) {
      const entry = layout.entries[held]
      if (!entry) throw new Error(`Cannot keep ${arrayKey} entry ${held}: the array has no such entry.`)
      return entry.raw
    }
    const key = value[entryKey]
    const existing = typeof key === 'string' ? existingByKey.get(key)?.shift() : undefined
    if (existing) return existing.raw
    const raw = JSON.stringify(value, null, pretty ? 2 : undefined)
    return pretty ? raw.replaceAll('\n', `${eol}${entryIndent}`) : raw
  })
  const joined = entries.map((raw, at) => (at === 0 ? raw : `${separators[at - 1] ?? appended}${raw}`)).join('')

  let inner = ''
  if (entries.length && layout.entries.length) {
    const leading = source.slice(layout.start + 1, layout.entries[0].start)
    const trailing = source.slice(layout.entries.at(-1)!.end, layout.end)
    inner = `${leading}${joined}${trailing}`
  } else if (entries.length) {
    const whitespace = source.slice(layout.start + 1, layout.end)
    inner = pretty
      ? `${eol}${entryIndent}${joined}${eol}${arrayIndent}`
      : `${whitespace}${joined}${whitespace}`
  }
  return `${source.slice(0, layout.start + 1)}${inner}${source.slice(layout.end)}`
}
