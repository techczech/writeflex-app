// Where a reader's note belongs in the piece as it stands now (0.24 ticket 07; spec docs/plans/
// spec-writeflex-sharing-and-reader-notes-2026-10-14.md section 6.1 "Note arrives…", section 7 "Anchoring
// therefore rests on the quoted words and their context, with the block id as a hint only").
//
// The reader selected words on the published page: the quote is rendered text with white-space runs
// made one space, and the context is up to 200 characters of the block either side. The piece is
// Markdown. So the words are looked for in a PROJECTION of the Markdown: inline markers (`*`, `_`,
// `` ` ``, `~`, `[`, a link's `](…)`, an image's `![`, a heading's or list item's or quote's leading
// marker) left out and white space made one space, with each projected character mapped back to its
// place in the file.
//
// Three outcomes, one per row of the spec's table:
//   unchanged  the quoted words stand in the piece. Where they stand more than once, the place whose
//              context agrees best wins, never the block hint (ticket 06 review); a tie is `ambiguous`.
//   changed    the words are not there as written, but a passage near them is: the text between the
//              context the reader saw before and after them, or else the stretch of the piece with the
//              most of the quote's words. `quote` keeps the reader's words.
//   gone       neither: no place.
//
// Pure: no file, no clock.

export type ReaderAnchorInput = { quote: string; before: string; after: string }

export type ReaderAnchor =
  /** `from`/`to`: the quoted words' place in the Markdown source. */
  | { state: 'unchanged'; from: number; to: number; ambiguous: boolean }
  | { state: 'changed'; from: number; to: number }
  | { state: 'gone' }

type Projection = { text: string; map: number[] }

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The Markdown as a reader reads it, roughly, with each character's place in the source. */
export function projectMarkdown(source: string): Projection {
  let text = ''
  const map: number[] = []
  let lineStart = true
  let lastSpace = true
  const push = (ch: string, at: number): void => {
    if (/\s/.test(ch)) {
      if (lastSpace) return
      text += ' '
      map.push(at)
      lastSpace = true
      return
    }
    text += ch
    map.push(at)
    lastSpace = false
  }
  let i = 0
  while (i < source.length) {
    if (lineStart) {
      // A line's leading markers: heading, list item, quote, task box.
      const lead = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d{1,9}[.)][ \t]+)*/.exec(source.slice(i, i + 64))
      if (lead && lead[0].length > 0) { i += lead[0].length; lineStart = false; continue }
      lineStart = false
    }
    const ch = source[i]
    if (ch === '\n') { push(' ', i); i += 1; lineStart = true; continue }
    if (ch === '!' && source[i + 1] === '[') { i += 2; continue }
    if (ch === ']' && source[i + 1] === '(') {
      const close = source.indexOf(')', i + 2)
      if (close !== -1 && close - i < 2048 && !source.slice(i, close).includes('\n')) { i = close + 1; continue }
    }
    if (ch === '*' || ch === '_' || ch === '`' || ch === '~' || ch === '[' || ch === ']') {
      // A marker inside a word ("snake_case", "2*3") is text; one at a word's edge is not.
      const prev = source[i - 1] ?? ' '
      const next = source[i + 1] ?? ' '
      const inside = /[\p{L}\p{N}]/u.test(prev) && /[\p{L}\p{N}]/u.test(next)
      if (!inside || ch === '`' || ch === '[' || ch === ']') { i += 1; continue }
    }
    push(ch, i)
    i += 1
  }
  if (text.endsWith(' ')) { text = text.slice(0, -1); map.pop() }
  return { text, map }
}

function occurrencesOf(text: string, needle: string, max = 50): number[] {
  const out: number[] = []
  if (!needle) return out
  let at = text.indexOf(needle)
  while (at !== -1 && out.length < max) { out.push(at); at = text.indexOf(needle, at + 1) }
  return out
}

/** How many characters of `context` end exactly where `at` begins (before), or begin where it ends (after). */
function agreeBefore(text: string, at: number, before: string): number {
  let n = 0
  while (n < before.length && at - n - 1 >= 0 && text[at - n - 1] === before[before.length - n - 1]) n += 1
  return n
}
function agreeAfter(text: string, at: number, after: string): number {
  let n = 0
  while (n < after.length && at + n < text.length && text[at + n] === after[n]) n += 1
  return n
}

/** Back from projected positions to the source: `[from, to)` over the projected characters `start..end-1`. */
function toSource(p: Projection, start: number, end: number): { from: number; to: number } {
  return { from: p.map[start], to: p.map[end - 1] + 1 }
}

const words = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((w) => w.length > 0)

/** The stretch of the projection, word-aligned and about as long as the quote, holding the most of its words. */
function bestWordWindow(text: string, quote: string): { start: number; end: number; score: number } | null {
  const wanted = words(quote)
  if (wanted.length === 0) return null
  const tokens: Array<{ word: string; start: number; end: number }> = []
  const re = /[\p{L}\p{N}']+/gu
  for (let m = re.exec(text); m; m = re.exec(text)) tokens.push({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length })
  const span = Math.max(1, wanted.length)
  let best: { start: number; end: number; score: number } | null = null
  for (let i = 0; i < tokens.length; i += 1) {
    const window = tokens.slice(i, i + span)
    const pool = [...wanted]
    let hits = 0
    for (const token of window) {
      const k = pool.indexOf(token.word)
      if (k !== -1) { hits += 1; pool.splice(k, 1) }
    }
    const score = hits / wanted.length
    if (!best || score > best.score) best = { start: window[0].start, end: window[window.length - 1].end, score }
  }
  return best
}

/** The smallest the nearest match may be, as a share of the quote's words found in it. */
export const NEAREST_MATCH_SHARE = 0.5
/** How far apart the context either side of a changed passage may be, past the quote's own length. */
const CONTEXT_GAP_SLACK = 200

export function anchorReaderNote(source: string, input: ReaderAnchorInput): ReaderAnchor {
  const quote = collapse(input.quote)
  if (!quote) return { state: 'gone' }
  const before = collapse(input.before)
  const after = collapse(input.after)
  const p = projectMarkdown(source)
  // The context is the block's text either side, which the projection joins to the quote with one
  // space or none: compare with that space taken off.
  const beforeTrim = before.replace(/ $/, '')
  const afterTrim = after.replace(/^ /, '')
  const scoreAt = (at: number, length: number): number => {
    const b = agreeBefore(p.text, at - (p.text[at - 1] === ' ' && !before.endsWith(' ') && beforeTrim.length > 0 ? 1 : 0), beforeTrim)
    const a = agreeAfter(p.text, at + length + (p.text[at + length] === ' ' && !after.startsWith(' ') && afterTrim.length > 0 ? 1 : 0), afterTrim)
    return b + a
  }

  const found = occurrencesOf(p.text, quote)
  if (found.length > 0) {
    const scored = found.map((at) => ({ at, score: scoreAt(at, quote.length) })).sort((x, y) => y.score - x.score || x.at - y.at)
    const best = scored[0]
    const ambiguous = scored.length > 1 && scored[1].score === best.score
    return { state: 'unchanged', ...toSource(p, best.at, best.at + quote.length), ambiguous }
  }

  // Changed: the text between the context the reader saw either side, when both still stand close together.
  const tail = beforeTrim.slice(-40)
  const head = afterTrim.slice(0, 40)
  if (tail.length >= 4 && head.length >= 4) {
    for (const b of occurrencesOf(p.text, tail, 10)) {
      let start = b + tail.length
      if (p.text[start] === ' ') start += 1
      const a = p.text.indexOf(head, start)
      if (a === -1) continue
      let end = a
      if (p.text[end - 1] === ' ') end -= 1
      if (end > start && end - start <= quote.length + CONTEXT_GAP_SLACK) return { state: 'changed', ...toSource(p, start, end) }
    }
  }
  const window = bestWordWindow(p.text, quote)
  if (window && window.score >= NEAREST_MATCH_SHARE) return { state: 'changed', ...toSource(p, window.start, window.end) }
  return { state: 'gone' }
}

/**
 * The smallest stretch of `source` around `[from, to)` that stands in it once (R1 of the save fix: a
 * pending record is placed at the unique occurrence of its text), grown a word at a time either side,
 * within the paragraph. Null when no such stretch is found.
 */
export function uniqueSpan(source: string, from: number, to: number, maxGrow = 600): { from: number; to: number } | null {
  let a = from
  let b = to
  const unique = (): boolean => {
    const text = source.slice(a, b)
    if (!text) return false
    const first = source.indexOf(text)
    return source.indexOf(text, first + 1) === -1
  }
  const stop = (ch: string | undefined, next: string | undefined): boolean => ch === undefined || (ch === '\n' && next === '\n')
  for (let step = 0; step < maxGrow; step += 1) {
    if (unique()) return { from: a, to: b }
    const canLeft = a > 0 && !stop(source[a - 1], source[a - 2])
    const canRight = b < source.length && !stop(source[b], source[b + 1])
    if (!canLeft && !canRight) return null
    if (canLeft) { a -= 1; while (a > 0 && !/\s/.test(source[a - 1]) && source[a - 1] !== '\n') a -= 1 }
    if (canRight) { b += 1; while (b < source.length && !/\s/.test(source[b])) b += 1 }
  }
  return null
}
