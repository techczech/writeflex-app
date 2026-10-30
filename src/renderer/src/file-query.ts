// Adapted from TalkWeaver src/shared/talk-query.ts. Dates here mean file modification dates.
export type FileFieldPrefix = 'fo' | 'fi' | 'met' | 'da'

export interface FilePrefixDef {
  prefix: FileFieldPrefix
  /** As typed: `fo:`. */
  token: string
  /** The hint row's word for it. */
  hint: string
  /** The field read from the loaded listing or vault index. */
  field: ('folder' | 'file' | 'details') | 'date'
}

export const FILE_FIELD_PREFIXES: readonly FilePrefixDef[] = [
  { prefix: 'fo', token: 'fo:', hint: 'folder', field: 'folder' },
  { prefix: 'fi', token: 'fi:', hint: 'file name', field: 'file' },
  { prefix: 'met', token: 'met:', hint: 'details', field: 'details' },
  { prefix: 'da', token: 'da:', hint: 'modified date', field: 'date' }
]

/** How `da:` reads a date (the ADR left this open; ticket 02 fixed it). Shown as help text. */
export const DATE_FORMS_HELP = 'da: reads 2026 (a year), 2026-07 (a month), 2026-07-22 (a day), or a month name such as jul or july (that month in any year)'

/** The search box's help: every prefix, and how dates read. */
export const FILE_QUERY_HELP =
  'Plain words match everywhere. Narrow with fo: folder · fi: file name · met: details · da: modified date. ' +
  `${DATE_FORMS_HELP}. Quote a value with spaces: fo:"AI Agent Workshops".`

export function prefixDef(prefix: FileFieldPrefix): FilePrefixDef {
  return FILE_FIELD_PREFIXES.find((p) => p.prefix === prefix)!
}

/** Case- and accent-insensitive form used for all matching. */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase()
}

// ── tokens ──────────────────────────────────────────────────────────────────

export interface QueryToken {
  /** [start, end) into the raw query. */
  start: number
  end: number
  /** The token as typed. */
  text: string
  prefix: FileFieldPrefix | null
  /** A prefixed token's value (unquoted), or a plain token's whole text. */
  value: string
}

const PREFIX_RE = /^(fo|fi|met|da):/i

export function tokenizeFileQuery(raw: string): QueryToken[] {
  const out: QueryToken[] = []
  let at = 0
  while (at < raw.length) {
    if (/\s/.test(raw[at])) { at += 1; continue }
    const start = at
    const head = PREFIX_RE.exec(raw.slice(at, at + 5))
    const prefixLength = head?.[0].length ?? 0
    if (raw[at + prefixLength] === '"') {
      // A quoted value runs to the closing quote (or the end while it is still being typed).
      const open = at + prefixLength
      const close = raw.indexOf('"', open + 1)
      at = close === -1 ? raw.length : close + 1
      // Anything glued on after the closing quote belongs to the same token.
      while (at < raw.length && !/\s/.test(raw[at])) at += 1
      const inner = raw.slice(open + 1, close === -1 ? raw.length : close)
      out.push({ start, end: at, text: raw.slice(start, at), prefix: head ? head[1].toLowerCase() as FileFieldPrefix : null, value: inner + raw.slice(close === -1 ? raw.length : close + 1, at) })
      continue
    }
    while (at < raw.length && !/\s/.test(raw[at])) at += 1
    const text = raw.slice(start, at)
    if (head) out.push({ start, end: at, text, prefix: head[1].toLowerCase() as FileFieldPrefix, value: text.slice(head[0].length) })
    else out.push({ start, end: at, text, prefix: null, value: text })
  }
  return out
}

/** A prefixed value as it must be typed: quoted when it holds a space. */
export function formatPrefixed(prefix: FileFieldPrefix, value: string): string {
  return `${prefix}:${/\s/.test(value) ? `"${value.replace(/"/g, '')}"` : value}`
}

/** True when the query holds anything to search for (a lone `fo:` is not yet a term). */
export function hasSearchTerms(raw: string): boolean {
  return tokenizeFileQuery(raw).some((t) => t.value.trim().length > 0)
}

/** The query with one token replaced (null removes it), spaces tidied. */
export function replaceToken(raw: string, token: QueryToken, next: string | null): string {
  const before = raw.slice(0, token.start)
  const after = raw.slice(token.end)
  if (next != null) return `${before}${next}${after}`
  return `${before.replace(/\s+$/, '')}${before.trim() && after.trim() ? ' ' : ''}${after.replace(/^\s+/, '')}`.trim()
}

// ── dates ───────────────────────────────────────────────────────────────────

/** A date, or a part of one: a year, a month in a year, a day, or a month in any year. */
export interface DateParts {
  year?: number
  month?: number
  day?: number
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** `jul`, `july`, `sept` → 7, 7, 9 (three letters at least, a prefix of the month's name). */
function monthOf(word: string): number | null {
  const w = foldText(word).replace(/\.$/, '')
  if (w.length < 3) return null
  const index = MONTH_NAMES.findIndex((m) => m.startsWith(w))
  return index === -1 ? null : index + 1
}

const validMonth = (m: number): boolean => m >= 1 && m <= 12
const validDay = (d: number): boolean => d >= 1 && d <= 31

/** What `da:` reads: `2026`, `2026-07`, `2026-07-22` (one-digit months and days too), or a
 *  month name meaning that month in any year. Null for anything else. */
export function parseDateQuery(value: string): DateParts | null {
  const v = value.trim()
  let m = /^(\d{4})$/.exec(v)
  if (m) return { year: Number(m[1]) }
  m = /^(\d{4})-(\d{1,2})$/.exec(v)
  if (m) return validMonth(Number(m[2])) ? { year: Number(m[1]), month: Number(m[2]) } : null
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v)
  if (m) return validMonth(Number(m[2])) && validDay(Number(m[3])) ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null
  if (/^\p{L}+\.?$/u.test(v)) {
    const month = monthOf(v)
    return month ? { month } : null
  }
  return null
}

/** Every part the query names must be present in the date and equal. */
export function datePartsMatch(query: DateParts, date: DateParts): boolean {
  if (query.year == null && query.month == null && query.day == null) return false
  if (query.year != null && date.year !== query.year) return false
  if (query.month != null && date.month !== query.month) return false
  if (query.day != null && date.day !== query.day) return false
  return true
}

// ── folders ─────────────────────────────────────────────────────────────────

/** Where in a folder path a `fo:` term matched, as the path from the deepest segment at which
 *  the term still matches: `external-workshops/York-July-2026/day-3` with `york` →
 *  `York-July-2026/day-3`. Null when the term is not in the path. */
export function folderFrom(folder: string, term: string): string | null {
  const t = foldText(term)
  if (!t || !foldText(folder).includes(t)) return null
  const segments = folder.split('/')
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const tail = segments.slice(i).join('/')
    if (foldText(tail).includes(t)) return tail
  }
  return folder
}
