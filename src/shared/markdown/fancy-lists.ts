/**
 * Lettered and roman lists (docs/design/2026-09-27-checkbox-lists, hifi-direction-1 frames 5–6):
 * `a.`, `A.`, `i.`, `I.` — or with `)` — start an ordered list, the way Pandoc's fancy_lists
 * extension reads them. The file keeps exactly what the writer typed; nothing here rewrites text.
 *
 * Two halves, both pure and platform-free (renderer, main process and `bun test` alike):
 *
 *  - the NUMBERING arithmetic — which style a marker opens, its ordinal, the marker after it
 *    (a→b, z→aa, ii→iii, xxxix→xl). The editor's Return continuation, the List type rewrite and
 *    the exporters all read it, so a list can never be one style on screen and another on paper;
 *  - the MARKER recognition the parser extension in the one dialect (dialect.ts, `FancyLists`) is
 *    built on. A fancy list parses as a `FancyList` block of ordinary `ListItem`s whose markers are
 *    ordinary `ListMark`s, so the muted marker ink, GFM task items and every "is this a real list
 *    marker" question already work.
 *
 * Recognition follows Pandoc:
 *  - a list OPENS on a single letter or a roman numeral; `i`/`I` alone is roman, any other single
 *    letter is alphabetic (so `v.` is the 22nd letter, `ii.` is two). Inside an alphabetic list a
 *    label may run to three letters (z → aa), which is how the continuation writes it — except a
 *    roman numeral, which starts a roman list ({@link continuesNumbering});
 *  - a single CAPITAL letter followed by a period needs two spaces (or a tab) after it. That is
 *    Pandoc's guard for initials — "B. Russell", "I. M. Pei" — and it is what keeps prose that
 *    begins "I. " a paragraph;
 *  - like CommonMark's "an ordered list may interrupt a paragraph only when it starts at 1", a fancy
 *    list interrupts a paragraph only when it starts at `a`, `A`, `i` or `I` and the item has text.
 */
export type FancyNumbering = 'lower-alpha' | 'upper-alpha' | 'lower-roman' | 'upper-roman'
export type ListNumbering = 'decimal' | FancyNumbering
export type ListDelimiter = '.' | ')'

export const FANCY_NUMBERINGS: readonly FancyNumbering[] = ['lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman']

// ---- Numbering arithmetic ------------------------------------------------------------------------

const ROMAN = /^m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/
const ROMAN_VALUES: Array<[string, number]> = [
  ['m', 1000], ['cm', 900], ['d', 500], ['cd', 400], ['c', 100], ['xc', 90],
  ['l', 50], ['xl', 40], ['x', 10], ['ix', 9], ['v', 5], ['iv', 4], ['i', 1],
]

function romanValue(label: string): number | null {
  const lower = label.toLowerCase()
  if (lower === '' || !ROMAN.test(lower)) return null
  let value = 0
  let rest = lower
  for (const [glyph, amount] of ROMAN_VALUES) {
    while (rest.startsWith(glyph)) {
      value += amount
      rest = rest.slice(glyph.length)
    }
  }
  return value
}

function romanLabel(value: number): string {
  let rest = Math.max(1, Math.min(3999, Math.floor(value)))
  let out = ''
  for (const [glyph, amount] of ROMAN_VALUES) {
    while (rest >= amount) {
      out += glyph
      rest -= amount
    }
  }
  return out
}

/** Bijective base 26, as HTML's `type="a"` counts: a…z, aa, ab… */
function alphaValue(label: string): number {
  let value = 0
  for (const character of label.toLowerCase()) value = value * 26 + (character.charCodeAt(0) - 96)
  return value
}

function alphaLabel(value: number): string {
  let rest = Math.max(1, Math.floor(value))
  let out = ''
  while (rest > 0) {
    const digit = (rest - 1) % 26
    out = String.fromCharCode(97 + digit) + out
    rest = Math.floor((rest - 1) / 26)
  }
  return out
}

const isLower = (label: string): boolean => /^[a-z]+$/.test(label)
const isUpper = (label: string): boolean => /^[A-Z]+$/.test(label)

/** Is `label` a label of `numbering`? Alphabetic labels run to three letters (z → aa → … → zzz). */
export function labelFits(label: string, numbering: ListNumbering): boolean {
  switch (numbering) {
    case 'decimal': return /^\d{1,9}$/.test(label)
    case 'lower-alpha': return isLower(label) && label.length <= 3
    case 'upper-alpha': return isUpper(label) && label.length <= 3
    case 'lower-roman': return isLower(label) && romanValue(label) !== null
    case 'upper-roman': return isUpper(label) && romanValue(label) !== null
  }
}

/**
 * Does an item labelled `label` carry on a list counting in `numbering`? Any label of the numbering
 * does, with one exception that keeps a lettered list from swallowing a roman one after it: a
 * multi-letter label that is a roman numeral (`ii`, `iv`, `xl`) starts a roman list instead. The
 * cost is that a lettered list stops at `cc`, its 81st item.
 */
export function continuesNumbering(label: string, numbering: ListNumbering): boolean {
  if (!labelFits(label, numbering)) return false
  const lettered = numbering === 'lower-alpha' || numbering === 'upper-alpha'
  return !(lettered && label.length > 1 && romanValue(label) !== null)
}

/**
 * The numbering a list OPENING on `label` has, or null when `label` cannot open a list: digits are
 * decimal; `i`/`I` alone is roman; any other single letter is alphabetic; a longer run is roman when
 * it is a valid numeral. `aa` cannot open a list — it only continues one.
 */
export function numberingOfFirst(label: string): ListNumbering | null {
  if (/^\d{1,9}$/.test(label)) return 'decimal'
  const lower = isLower(label)
  if (!lower && !isUpper(label)) return null
  if (label.length === 1 && label.toLowerCase() !== 'i') return lower ? 'lower-alpha' : 'upper-alpha'
  if (romanValue(label) !== null) return lower ? 'lower-roman' : 'upper-roman'
  return null
}

/** The ordinal `label` stands for in `numbering` (b → 2, iv → 4, aa → 27), or null if it does not fit. */
export function ordinalOf(label: string, numbering: ListNumbering): number | null {
  if (!labelFits(label, numbering)) return null
  if (numbering === 'decimal') return Number.parseInt(label, 10)
  if (numbering === 'lower-alpha' || numbering === 'upper-alpha') return alphaValue(label)
  return romanValue(label)
}

/** The label for `ordinal` in `numbering` (2 → b, 27 → aa, 40 → xl). */
export function labelFor(ordinal: number, numbering: ListNumbering): string {
  switch (numbering) {
    case 'decimal': return String(Math.max(0, Math.floor(ordinal)))
    case 'lower-alpha': return alphaLabel(ordinal)
    case 'upper-alpha': return alphaLabel(ordinal).toUpperCase()
    case 'lower-roman': return romanLabel(ordinal)
    case 'upper-roman': return romanLabel(ordinal).toUpperCase()
  }
}

/**
 * THE CONTINUATION SEAM: the marker after `marker` (`a.` → `b.`, `z)` → `aa)`, `xxxix.` → `xl.`,
 * `9.` → `10.`). The delimiter is kept. `numbering` is the list's own numbering when known — a list
 * that opened on `h.` continues `i.` → `j.` — and otherwise the numbering `marker` would open.
 * Returns null for a bullet or anything that is not an ordered marker.
 */
export function nextMarker(marker: string, numbering?: ListNumbering): string | null {
  const match = /^([0-9]{1,9}|[A-Za-z]+)([.)])$/.exec(marker)
  if (!match) return null
  const [, label, delimiter] = match
  const style = numbering ?? numberingOfFirst(label)
  if (!style) return null
  const ordinal = ordinalOf(label, style)
  if (ordinal === null) return null
  return `${labelFor(ordinal + 1, style)}${delimiter}`
}

/** The fancy numberings the List type commands and exporters name, as HTML's `type` letter. */
export const HTML_LIST_TYPE: Readonly<Record<FancyNumbering, 'a' | 'A' | 'i' | 'I'>> = {
  'lower-alpha': 'a',
  'upper-alpha': 'A',
  'lower-roman': 'i',
  'upper-roman': 'I',
}

// ---- Marker recognition --------------------------------------------------------------------------

/**
 * Every list marker as a regex SOURCE, for line scanners that then ask the syntax tree whether the
 * marker is real (task-items.ts, list-typography.ts): bullets, numbers, and letter runs — the last
 * a candidate only, since `etc.` at a line start is prose. Never use it alone to decide a list.
 */
export const LIST_MARKER_SOURCE = '[-+*]|\\d+[.)]|[A-Za-z]{1,12}[.)]'

export type FancyMarker = { label: string; delimiter: ListDelimiter; numbering: FancyNumbering | null; length: number }

const isSpace = (code: number): boolean => code === 32 || code === 9

/**
 * A fancy marker candidate at `pos` in `text`: letters, then `.` or `)`, then a space, a tab or the
 * end of the line. `numbering` is what the marker would OPEN (null when it can only continue a list,
 * like `aa.`). Pandoc's initials guard is applied: a single capital with a period must be followed by
 * two spaces, a tab, or nothing. Digits are not fancy — CommonMark's own list owns them.
 */
export function fancyMarkerAt(text: string, pos = 0): FancyMarker | null {
  let end = pos
  while (end < text.length && end - pos < 12 && /[A-Za-z]/.test(text[end])) end += 1
  if (end === pos || end >= text.length) return null
  const delimiter = text[end]
  if (delimiter !== '.' && delimiter !== ')') return null
  const label = text.slice(pos, end)
  if (!isLower(label) && !isUpper(label)) return null
  const after = end + 1
  if (after < text.length && !isSpace(text.charCodeAt(after))) return null
  if (delimiter === '.' && label.length === 1 && isUpper(label) && after < text.length) {
    const tab = text[after] === '\t'
    const twoSpaces = text[after] === ' ' && (after + 1 >= text.length || isSpace(text.charCodeAt(after + 1)))
    if (!tab && !twoSpaces) return null
  }
  const opens = numberingOfFirst(label)
  const numbering = opens === 'decimal' ? null : opens
  if (!numbering && !FANCY_NUMBERINGS.some((style) => labelFits(label, style))) return null
  return { label, delimiter, numbering, length: after - pos }
}
