/**
 * Does writing a parsed JSON object back out keep every value it carries over exactly as the file had
 * it? `JSON.parse` turns numbers into JavaScript numbers, so `9007199254740993` comes back as
 * `9007199254740992` and `1e400` as `null`; a key written twice keeps only its last value. A store that
 * rewrites a whole file (vault-store.ts) asks this before it writes, and refuses rather than change a
 * value it does not own.
 *
 * The comparison is textual and conservative: each carried value's source text, with whitespace outside
 * strings removed and every string re-spelled the way `JSON.stringify` spells it, must equal
 * `JSON.stringify(value)`. A number spelled differently from JavaScript's own spelling (`1.0`, `1e5`,
 * `-0`) therefore counts as not kept. No JSON library: a small scanner over text that `JSON.parse`
 * has already accepted.
 */

const WHITESPACE = new Set([' ', '\t', '\n', '\r'])

/** Index just past the string literal that opens at `start` (`text[start]` is `"`). */
function stringEnd(text: string, start: number): number {
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') i += 2
    else if (ch === '"') return i + 1
    else i += 1
  }
  return i
}

function skipWhitespace(text: string, i: number): number {
  while (i < text.length && WHITESPACE.has(text[i]!)) i += 1
  return i
}

/** Index just past the JSON value that starts at `start`. */
function valueEnd(text: string, start: number): number {
  const first = text[start]
  if (first === '"') return stringEnd(text, start)
  if (first === '{' || first === '[') {
    let depth = 0
    let i = start
    while (i < text.length) {
      const ch = text[i]!
      if (ch === '"') {
        i = stringEnd(text, i)
        continue
      }
      if (ch === '{' || ch === '[') depth += 1
      else if (ch === '}' || ch === ']') {
        depth -= 1
        if (depth === 0) return i + 1
      }
      i += 1
    }
    return i
  }
  let i = start
  while (i < text.length && !WHITESPACE.has(text[i]!) && text[i] !== ',' && text[i] !== '}' && text[i] !== ']') i += 1
  return i
}

/** The value's text as `JSON.stringify` would spell it if nothing were lost: whitespace out, strings re-spelled. */
export function canonicalJsonText(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const ch = source[i]!
    if (ch === '"') {
      const end = stringEnd(source, i)
      out += JSON.stringify(JSON.parse(source.slice(i, end)) as string)
      i = end
    } else {
      if (!WHITESPACE.has(ch)) out += ch
      i += 1
    }
  }
  return out
}

/** For each top-level key of a JSON object text, the canonical text of every value written under it (in order); null when the text is not an object. */
export function topLevelValueTexts(text: string): Map<string, string[]> | null {
  const values = new Map<string, string[]>()
  let i = skipWhitespace(text, 0)
  if (text[i] !== '{') return null
  i = skipWhitespace(text, i + 1)
  if (text[i] === '}') return values
  while (i < text.length) {
    if (text[i] !== '"') return null
    const keyEnd = stringEnd(text, i)
    const key = JSON.parse(text.slice(i, keyEnd)) as string
    i = skipWhitespace(text, keyEnd)
    if (text[i] !== ':') return null
    const start = skipWhitespace(text, i + 1)
    const end = valueEnd(text, start)
    const list = values.get(key) ?? []
    list.push(canonicalJsonText(text.slice(start, end)))
    values.set(key, list)
    i = skipWhitespace(text, end)
    if (text[i] === '}') return values
    if (text[i] !== ',') return null
    i = skipWhitespace(text, i + 1)
  }
  return null
}

/**
 * The first key of `output` whose value is carried over unchanged from `parsed` (the result of
 * `JSON.parse(sourceText)`) but would not be written back exactly as `sourceText` has it; null when
 * every carried value is kept. Keys whose value the writer replaced are not judged.
 */
export function firstLossyCarriedKey(sourceText: string, parsed: Record<string, unknown>, output: Record<string, unknown>): string | null {
  let texts: Map<string, string[]> | null = null
  for (const key of Object.keys(output)) {
    if (!Object.hasOwn(parsed, key) || !Object.is(output[key], parsed[key])) continue
    texts ??= topLevelValueTexts(sourceText) ?? new Map()
    const sources = texts.get(key)
    // Written twice in the file: the earlier value would be dropped.
    if (!sources || sources.length !== 1) return key
    if (sources[0] !== JSON.stringify(output[key])) return key
  }
  return null
}
