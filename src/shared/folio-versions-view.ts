/**
 * What the Folio workspace's Versions tab shows (ADR-0052 § Decision 1; Folio versions ticket 05). Pure: main builds
 * these plain records from the Folio journal (`folio-versions-tab.ts`) and the renderer draws them. Nothing here reads
 * or writes a file.
 */

/** One row of the timeline: the version as the writer knows it, newest first. */
export type FolioVersionRow = {
  id: string
  name: string
  ts: number
  /** The author's name as recorded. */
  author: string
  note?: string
  /** "sent to <name>" mark. */
  sentTo?: string
  /** A co-author's revision recorded as a version: who it came from. */
  incomingFrom?: string
  withdrawn?: true
}

/** A Folio version the backup leaves out, with the plain reason the backup gave (ticket 02's `folioLeftOut`). */
export type FolioVersionLeftOut = { id: string; name: string; file: string; reason: string; withdrawn?: true }

export type FolioBackupNotice = { state: 'ok'; leftOut: FolioVersionLeftOut[] } | { state: 'unavailable'; reason: string }

export type FolioVersionsListing = {
  dir: string
  versions: FolioVersionRow[]
  backup: FolioBackupNotice
}

/** A part (or file not in the outline) as the version held it. `words` is null when its saved text cannot be read. */
export type FolioVersionPart = { path: string; title: string; order?: number; words: number | null }

/** A file a version inserted, and the per-file version it used (null when that version is no longer in the history). */
export type FolioVersionInserted = { path: string; fileVersion: { name: string; ts: number } | null }

export type FolioVersionContents = FolioVersionRow & {
  indexPath: string
  /** Words in the Index Note as the version held it; null when its saved text cannot be read. */
  indexWords: number | null
  /** Parts in running order. */
  parts: FolioVersionPart[]
  /** Markdown files that were in the Folio folder but not in the outline. */
  unlisted: FolioVersionPart[]
  inserted: FolioVersionInserted[]
  /** Files that were only linked or too large: listed with their kind, never kept. */
  references: Array<{ path: string; why: 'linked' | 'too-large' }>
  /** Words in the parts that could be counted. */
  words: number
}

/**
 * A Folio version opened for reading (ticket 07): what it holds, and the text of the Index Note, every part and every file not
 * in the outline exactly as saved. `texts` is keyed by the label (path) the version recorded; null where the saved text cannot be read.
 */
export type FolioVersionReading = {
  contents: FolioVersionContents
  index: string | null
  texts: Record<string, string | null>
}

// ---- The actions on a selected version ------------------------------------------------------

export type VersionActionId = 'open-read-only' | 'compare' | 'restore' | 'export' | 'mark-sent'

/**
 * The buttons on a selected version, in the drawn order. Each opens a later ticket's surface, so each is disabled with a
 * plain reason until that ticket lands (the reason is a tooltip, never resident copy). A ticket that builds one passes a handler
 * to the tab (ticket 07 did for Open read-only: the reason is shown only where no handler is wired).
 */
export const VERSION_ACTIONS: ReadonlyArray<{ id: VersionActionId; label: string; icon: string; reason: string }> = [
  { id: 'open-read-only', label: 'Open read-only', icon: 'eye', reason: 'Reading an earlier version in the workspace is not built yet.' },
  { id: 'compare', label: 'Compare with working draft', icon: 'git-compare', reason: 'Comparing two Folio versions is not built yet.' },
  { id: 'restore', label: 'Restore…', icon: 'rotate-ccw', reason: 'Restoring a whole Folio is not built yet.' },
  { id: 'export', label: 'Export this version…', icon: 'upload', reason: 'Exporting a saved version is not built yet.' },
  { id: 'mark-sent', label: 'Mark as sent…', icon: 'send', reason: 'Marking a version as sent comes with exporting it, which is not built yet.' },
]

/** The reason Save Folio version… is off when no save sheet is wired to the tab. */
export const SAVE_SHEET_REASON = 'The save sheet is not built yet.'

// ---- Words ----------------------------------------------------------------------------------

/** "1 word", "1,228 words". */
export function wordsText(words: number): string {
  return `${words.toLocaleString('en-GB')} ${words === 1 ? 'word' : 'words'}`
}

export function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`
}

// ---- Dates ----------------------------------------------------------------------------------

/**
 * "19 Oct, 16:40"; with the year when it is not the year of `now` ("19 Oct 2025, 16:40"). British order, 24-hour clock.
 * `timeZone` is for tests; the app passes none and the writer's own zone applies.
 */
export function versionWhen(ts: number, now: number = Date.now(), timeZone?: string): string {
  const zone = timeZone ? { timeZone } : {}
  const year = (value: number): number => Number(new Intl.DateTimeFormat('en-GB', { year: 'numeric', ...zone }).format(value))
  const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(year(ts) === year(now) ? {} : { year: 'numeric' }), ...zone }).format(ts)
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...zone }).format(ts)
  return `${day}, ${time}`
}

/** The second line of a timeline row: "19 Oct, 16:40 · Dominik Lukes · Outliers removed from the scores table". */
export function versionMeta(row: Pick<FolioVersionRow, 'ts' | 'author' | 'note'>, now: number = Date.now(), timeZone?: string): string {
  return [versionWhen(row.ts, now, timeZone), row.author, row.note?.trim() ? row.note.trim() : null].filter((part): part is string => part !== null && part !== '').join(' · ')
}

// ---- The left-out notice --------------------------------------------------------------------

/** The backup's plain reasons for the versions it leaves out, for this list (each with its own sentence), in the list's order. */
export function leftOutReasons(listing: Pick<FolioVersionsListing, 'versions' | 'backup'>): Array<{ id: string; name: string; reason: string }> {
  if (listing.backup.state !== 'ok') return []
  const byId = new Map(listing.backup.leftOut.map((entry) => [entry.id, entry]))
  return listing.versions.flatMap((version) => {
    const entry = byId.get(version.id)
    return entry ? [{ id: version.id, name: version.name, reason: entry.reason }] : []
  })
}

/** The one sentence shown when the backup could not say what it leaves out. Never an empty list (ticket 03). */
export const BACKUP_UNKNOWN = 'WriteFlex could not check what the backup keeps of these versions.'

// ---- Keyboard: the timeline is a listbox ----------------------------------------------------

/** The id a list key moves the choice to: arrows by one, Home and End to the ends; null for any other key or an empty list. */
export function listKeyTarget(ids: readonly string[], current: string | null, key: string): string | null {
  if (ids.length === 0) return null
  const at = current === null ? -1 : ids.indexOf(current)
  if (key === 'ArrowDown') return ids[Math.min(ids.length - 1, at + 1)] ?? null
  if (key === 'ArrowUp') return ids[Math.max(0, at === -1 ? 0 : at - 1)] ?? null
  if (key === 'Home') return ids[0] ?? null
  if (key === 'End') return ids[ids.length - 1] ?? null
  return null
}

/** The version the tab shows: the chosen one if it is still in the list, else the newest. Null when there are none. */
export function shownVersionId(ids: readonly string[], chosen: string | null): string | null {
  if (ids.length === 0) return null
  return chosen !== null && ids.includes(chosen) ? chosen : ids[0] ?? null
}

// ---- The read-only view (ticket 07) -----------------------------------------------------------

/** What the room keeps while a version is open: enough to come back to the working draft exactly where the writer left it. */
export type ReadingVersion = { id: string; name: string; ts: number; author: string }

/** The banner sentence: "Reading <name> · 15 Oct · read-only. Nothing here can be edited." The name is bold in the interface. */
export const READ_ONLY_BANNER_TAIL = 'Nothing here can be edited.'

/** The status-bar chip: `Reading “Draft for Sam Rowe” · read-only`. */
export function readingChip(name: string): string {
  return `Reading “${name}” · read-only`
}

/** Why a control that would write is not offered while reading. A tooltip, never resident copy. */
export const READ_ONLY_REFUSAL = 'This is a saved version: nothing in it can be changed. Go back to the working draft to edit.'

/** What a part's saved text opens with, for its card: the first prose line of the body (front matter and headings skipped), cut to `max` characters. */
export function partLead(text: string | null, max = 180): string {
  if (text === null) return ''
  let fence = false
  let line = ''
  for (const entry of bodyForReading(text).split(/\r?\n/).map((value) => value.trim())) {
    if (/^(```|~~~)/.test(entry)) { fence = !fence; continue }
    if (fence || entry === '' || entry === '---' || /^#{1,6}\s/.test(entry)) continue
    line = entry
    break
  }
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

/** The text of a part with its leading front matter removed, as the reader shows it. */
export function bodyForReading(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
}
