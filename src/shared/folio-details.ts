/**
 * The Folio outline's Details card (0.26 ticket 4): the seven fields a Folio's cover, export and Board read, kept in
 * the Index Note's header (its frontmatter). Shared by main (folio-details.ts, the one write) and the renderer
 * (FolioDetailsCard.tsx). Pure: no IO.
 *
 * Each field is shown from the Index Note's header; a field the Index Note leaves empty shows the title page's
 * header value instead (`from: 'title-page'`), the rule the cover follows (Details wins per field). A change is
 * always written to the Index Note.
 */
import { isIsoDate } from './calendar-grid'
import { REFERENCE_STATUS_ORDER, normaliseCollectionStatus } from './collection-status'

/** The frontmatter keys, in the card's order. Title and standfirst are typed; the rest get pickers (ticket 5). */
export const FOLIO_DETAIL_FIELDS = ['title', 'standfirst', 'author', 'date', 'status', 'audience', 'language'] as const
export type FolioDetailField = typeof FOLIO_DETAIL_FIELDS[number]

/** The fields typed into the card. */
export const TYPED_FOLIO_DETAILS: readonly FolioDetailField[] = ['title', 'standfirst']

/** The fields picked (a list, or a calendar for the date): each also accepts a new value typed into its list. */
export const PICKED_FOLIO_DETAILS: readonly FolioDetailField[] = ['author', 'date', 'status', 'audience', 'language']

export const FOLIO_DETAIL_LABEL: Record<FolioDetailField, string> = {
  title: 'Title',
  standfirst: 'Standfirst',
  author: 'Author',
  date: 'Date',
  status: 'Status',
  audience: 'Audience',
  language: 'Language',
}

/** The longest value the card writes (a standfirst is one or two sentences; this is generous). */
export const FOLIO_DETAIL_MAX_LENGTH = 2000

export const isFolioDetailField = (value: unknown): value is FolioDetailField =>
  typeof value === 'string' && (FOLIO_DETAIL_FIELDS as readonly string[]).includes(value)

/** One field as shown: its value and where it was read (null value: neither file says it). */
export type FolioDetailValue = { value: string | null; from: 'index' | 'title-page' | null }

/**
 * THE per-field rule of the Details (0.26, decision of 2026-10-19), for the card and the export alike: each field is
 * the Index Note's value, else the title page's, else empty. `own` and `page` are the two headers' values (null:
 * absent or empty; `page` null: no title page).
 */
export function folioDetailsWithFallback(
  own: Readonly<Record<FolioDetailField, string | null>>,
  page: Readonly<Record<FolioDetailField, string | null>> | null,
): Record<FolioDetailField, FolioDetailValue> {
  const fields = {} as Record<FolioDetailField, FolioDetailValue>
  for (const field of FOLIO_DETAIL_FIELDS) {
    const mine = own[field]
    const theirs = page?.[field] ?? null
    fields[field] = mine !== null ? { value: mine, from: 'index' } : theirs !== null ? { value: theirs, from: 'title-page' } : { value: null, from: null }
  }
  return fields
}

/** What the card shows, and the Index Note text it was read from: the basis of the next write. */
export type FolioDetails = {
  indexPath: string
  /** The Index Note exactly as read (the write's basis). */
  text: string
  /** The title page whose header fills the fields the Index Note leaves empty; null when the Folio has none. */
  titlePagePath: string | null
  fields: Record<FolioDetailField, FolioDetailValue>
}

/** Why the card cannot be shown or a change was not written. `message` is a plain sentence. */
export type FolioDetailsRefusal = {
  ok: false
  refused: 'invalid' | 'outside' | 'no-index-note' | 'disk-changed' | 'unwritable' | 'stale'
  message: string
  /** On `disk-changed`: the Index Note as it is now, so the card can show it. */
  text?: string
}

export type FolioDetailsRead = ({ ok: true } & FolioDetails) | FolioDetailsRefusal

/** A change written (`changed: true`, with its Undo token) or one that was already so (nothing written, no token). */
export type FolioDetailWritten = { ok: true; changed: boolean; undoToken: string | null; indexPath: string; text: string }
export type FolioDetailAnswer = FolioDetailWritten | FolioDetailsRefusal

export type FolioDetailUndone = { ok: true; indexPath: string; text: string }
export type FolioDetailUndoAnswer = FolioDetailUndone | FolioDetailsRefusal

export const FOLIO_DETAIL_STALE_UNDO = 'Could not undo: the Index Note has changed since that change. Nothing was changed.'

/**
 * The value as written: line breaks of any kind become `\n`, other control characters go, and the ends are trimmed.
 * An empty value is null (the key is removed). Kept on one line in the file: the frontmatter writer quotes a value
 * with a line break as a double-quoted scalar with `\n` escapes.
 */
export function normaliseFolioDetailValue(value: string | null): string | null {
  if (value === null) return null
  const cleaned = value
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()
  return cleaned === '' ? null : cleaned
}

/** `2026-10-14` as `14 Oct 2026`; anything else as it is. */
export function folioDetailDateLabel(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return value
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (month < 1 || month > 12 || day < 1 || day > 31) return value
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${day} ${months[month - 1]} ${year}`
}

/** A value another file in the Workspace uses for a field, and how many files use it. */
export type FolioDetailUsedValue = { value: string; count: number }

/** What the pickers offer from the Workspace (read-only; `you` is the writer's name, offered first for Author). */
export type FolioDetailValues = {
  you: string | null
  author: FolioDetailUsedValue[]
  audience: FolioDetailUsedValue[]
  language: FolioDetailUsedValue[]
}

export type FolioDetailValuesAnswer = ({ ok: true } & FolioDetailValues) | FolioDetailsRefusal

/** The Board's lanes the Status picker lists first, in the Board's order (collection-status.ts). */
export const STATUS_PICKER_LANES: readonly string[] = REFERENCE_STATUS_ORDER

/**
 * The Status picker's lanes: the Board's, then this Folio's own lane when it is none of them (compared without
 * regard to letter case). `own` is null when the Folio has no status or one the Board already lists.
 */
export function statusPickerLanes(current: string | null): { board: readonly string[]; own: string | null } {
  const own = current !== null && !REFERENCE_STATUS_ORDER.some((lane) => lane.toLocaleLowerCase() === current.toLocaleLowerCase()) ? current : null
  return { board: STATUS_PICKER_LANES, own }
}

/** The longest name an Author, Audience or Language picker writes. */
export const FOLIO_DETAIL_NAME_MAX_LENGTH = 200

/**
 * Why `value` (already normalised; null removes the key) cannot be written into `field`, as a plain sentence, or
 * null when it can. A date is a real calendar date `YYYY-MM-DD` (what the calendar writes); a status is a lane name
 * the Board can read back (collection-status.ts); a name is one line of reasonable length.
 */
export function folioDetailValueRefusal(field: FolioDetailField, value: string | null): string | null {
  if (value === null) return null
  const label = FOLIO_DETAIL_LABEL[field].toLocaleLowerCase()
  if (field === 'date' && !isIsoDate(value)) return 'The date must be a real calendar date, so nothing was changed.'
  if (field === 'status') {
    try { normaliseCollectionStatus(value) } catch { return 'A status is a short lane name without a colon or quotation marks at its ends, so nothing was changed.' }
  }
  if ((field === 'author' || field === 'audience' || field === 'language') && (value.includes('\n') || value.length > FOLIO_DETAIL_NAME_MAX_LENGTH)) {
    return `The ${label} must be one line of at most ${FOLIO_DETAIL_NAME_MAX_LENGTH} characters, so nothing was changed.`
  }
  return null
}
