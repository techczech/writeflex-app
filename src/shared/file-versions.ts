/**
 * Versions of an inserted file (Folio versions ticket 19, ADR-0052 § How members reference per-file versions): the plain shapes the file-versions
 * panel, the IPC doors and the command line share, and the pure parts (what a comparison of two tables says, the sentences).
 *
 * A "file version" is an ordinary per-file version (`.writeflex/versions.jsonl`, with its snapshot in `.bridle/objects/<sha256>`): a saved copy of a
 * table, widget page, image or other file that is not Markdown. Nothing here is a new record: the Folio versions that used a file version are
 * DERIVED by reverse lookup over the Folio journal's `members[].versionId`, never stored on the per-file record.
 *
 * Pure and Electron-free: the main-process side is src/main/file-versions.ts.
 */
import { cellsDiffering, insertedKind, tableCells, type InsertedKind } from './folio-version-changes'

export type FileKind = InsertedKind

/** Above this a file is not given file versions: a Folio version lists it as a reference and keeps its hash only (ADR-0052 § Storage). */
export const FILE_VERSION_CAP_BYTES = 25 * 1024 * 1024
export const FILE_VERSION_CAP_LABEL = '25 MiB'

/** A file name is a Markdown document: its versions are the editor's, with their waiting changes, not these. */
export const isMarkdownDocument = (path: string): boolean => /\.(md|markdown|mdx)$/i.test(path)

export const fileKindOf = (path: string): FileKind => insertedKind(path)
export const FILE_KIND_LABEL: Record<FileKind, string> = { table: 'Table', widget: 'Widget', image: 'Image', file: 'File' }

/** A Folio version that used a file version. Withdrawn co-author revisions are not listed: they were taken back. */
export type FileVersionUse = { id: string; name: string; ts: number }

export type FileVersionRow = {
  id: string
  /** 1 for the oldest version that holds a copy of the file, as the cursor panel numbers them ("v2"). */
  number: number
  name: string
  ts: number
  author: string
  note?: string
  /** Taken by a Folio save ("Folio version: …"), not by the writer asking for a version of this file. */
  automatic: boolean
  /** The SHA-256 of the saved copy; what a restore or a copy of this version is bound to. Null when the copy cannot be found. */
  sha256: string | null
  /** The Folio versions that used this version, newest first. Derived, never stored. */
  usedBy: FileVersionUse[]
  /** The working copy holds exactly this version's bytes. */
  isWorking: boolean
}

/** What the file on disk is now, against its versions. */
export type FileWorking =
  | { state: 'missing' }
  | { state: 'unreadable'; why: string }
  | { state: 'too-large'; bytes: number }
  /** No version holds a copy of this file yet. */
  | { state: 'unversioned' }
  /** The working copy is byte for byte the version `as` (the newest that matches). */
  | { state: 'same'; as: { id: string; number: number; name: string } }
  /** Different from every version; `since` is the newest. `cellsChanged` for a table, null when it cannot be counted. */
  | { state: 'changed'; since: { id: string; number: number; name: string }; cellsChanged: number | null }

export type FileVersionsListing = {
  path: string
  kind: FileKind
  working: FileWorking
  /** The SHA-256 of the working copy: a restore is bound to it. Null when there is no readable working copy within the cap. */
  workingSha256: string | null
  /** Newest first. */
  versions: FileVersionRow[]
}

/** Why an operation did nothing. `message` is a sentence for the writer; nothing was written. */
export type FileVersionRefusal = 'refused' | 'markdown' | 'unchanged' | 'too-large' | 'changed' | 'exists' | 'not-found' | 'same' | 'unavailable' | 'needs-writer'
export type FileVersionFailure = { ok: false; code: FileVersionRefusal; message: string }
export type FileVersionAnswer<T> = ({ ok: true } & T) | FileVersionFailure

/** A file the text of a Folio inserts (a table, widget page, image), with how many versions hold a copy of it. For the Inspector's list. */
export type FolioInsertedFile = { path: string; kind: FileKind; versions: number }

export type SaveFileVersionInput = { path: string; name: string; note?: string }
export type SaveFileVersionResult = { version: { id: string; name: string; ts: number; number: number } }

/** Restore is bound to the two things the writer saw: the saved copy (its hash) and the working copy (its hash, or null for none). */
export type RestoreFileVersionInput = { path: string; versionId: string; expectVersionSha256: string; expectWorkingSha256: string | null }
export type RestoreFileVersionResult = {
  /** The new file version the restore appended. */
  restored: { id: string; name: string; number: number }
  /** The version taken first so the working copy that was replaced is kept, when it was not already held by a version. */
  safety: { id: string; name: string } | null
}

export type SaveFileCopyInput = { path: string; versionId: string; expectVersionSha256: string; name: string }
export type SaveFileCopyResult = { path: string }

/** What a version or the working copy is called in a comparison. */
export type FileCompareEnd = { label: string; bytes: number }
export type TableCell = { before: string | null; after: string | null }
export type FileCompare =
  | { kind: 'table'; from: FileCompareEnd; to: FileCompareEnd; header: TableCell[]; rows: TableCell[][]; cellsDiffering: number; /** Rows left off the end of the list; the count above is still of all of them. */ rowsNotShown: number }
  | { kind: 'other'; fileKind: FileKind; from: FileCompareEnd; to: FileCompareEnd; same: boolean; /** Lines that differ, for a file that reads as text; null for one that does not. */ linesChanged: number | null }

export const COMPARE_ROWS_SHOWN = 200
export const COMPARE_COLUMNS_SHOWN = 40
export const WORKING_COPY = 'working'

const same = (a: string | undefined, b: string | undefined): boolean => a === b
const cellOf = (row: readonly string[] | undefined, at: number): string | null => (row !== undefined && at < row.length ? row[at]! : null)

/**
 * Two versions of a table, cell by cell: the first row is the header; a cell counts once when it differs, as does each cell of a row or column
 * added or removed (the same count the cursor panel gives, `cellsDiffering`). The grid keeps what the table holds at its first
 * `COMPARE_ROWS_SHOWN` rows and `COMPARE_COLUMNS_SHOWN` columns; the count is of all of it.
 */
export function compareTables(path: string, before: string, after: string, from: FileCompareEnd, to: FileCompareEnd): Extract<FileCompare, { kind: 'table' }> {
  const delimiter = /\.tsv$/i.test(path) ? '\t' : ','
  const a = tableCells(before, delimiter)
  const b = tableCells(after, delimiter)
  const width = Math.min(COMPARE_COLUMNS_SHOWN, Math.max(0, ...a.map((row) => row.length), ...b.map((row) => row.length)))
  const total = Math.max(a.length, b.length)
  const grid: TableCell[][] = []
  for (let r = 0; r < Math.min(total, COMPARE_ROWS_SHOWN + 1); r += 1) {
    const x = a[r]
    const y = b[r]
    const row: TableCell[] = []
    for (let c = 0; c < width; c += 1) row.push({ before: cellOf(x, c), after: cellOf(y, c) })
    grid.push(row)
  }
  const [header = [], ...rows] = grid
  return { kind: 'table', from, to, header, rows, cellsDiffering: cellsDiffering(before, after, path), rowsNotShown: Math.max(0, total - 1 - rows.length) }
}

/** How many lines differ between two texts: lines of the longer run that are not the same at the same place after the shared head and tail are dropped. */
export function linesChangedBetween(before: string, after: string): number {
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && same(a[head], b[head])) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && same(a[a.length - 1 - tail], b[b.length - 1 - tail])) tail += 1
  return Math.max(a.length - head - tail, b.length - head - tail)
}

/** Whether bytes read as text (no NUL, and a UTF-8 reading that gives the same bytes back): only then are lines counted. */
export function readsAsText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true } catch { return false }
}

/** Two versions of any file: a table cell by cell; anything else, whether the bytes are the same and, for text, how many lines differ. */
export function compareFileBytes(path: string, before: Uint8Array, after: Uint8Array, from: string, to: string): FileCompare {
  const ends = { from: { label: from, bytes: before.length }, to: { label: to, bytes: after.length } }
  const kind = fileKindOf(path)
  const text = readsAsText(before) && readsAsText(after)
  if (kind === 'table' && text) return compareTables(path, new TextDecoder().decode(before), new TextDecoder().decode(after), ends.from, ends.to)
  const identical = before.length === after.length && before.every((byte, at) => byte === after[at])
  return { kind: 'other', fileKind: kind, ...ends, same: identical, linesChanged: identical ? 0 : text ? linesChangedBetween(new TextDecoder().decode(before), new TextDecoder().decode(after)) : null }
}

// ---- Words ------------------------------------------------------------------------------------

const noun = (count: number, one: string, many: string): string => `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`

/** "used by Folio “After pilot numbers”", "used by 3 Folio versions, the last “Draft for Sam Rowe”", or "not used by any Folio version". */
export function usedBySentence(usedBy: readonly FileVersionUse[]): string {
  if (usedBy.length === 0) return 'not used by any Folio version'
  if (usedBy.length === 1) return `used by Folio “${usedBy[0]!.name}”`
  return `used by ${noun(usedBy.length, 'Folio version', 'Folio versions')}, the last “${usedBy[0]!.name}”`
}

/** The line under "Working copy": what the file on disk is against its versions. */
export function workingSentence(working: FileWorking, kind: FileKind): string {
  switch (working.state) {
    case 'missing': return 'There is no file at this name now.'
    case 'unreadable': return working.why
    case 'too-large': return `Over ${FILE_VERSION_CAP_LABEL}, so a Folio version lists this file as a reference and keeps no copy of it.`
    case 'unversioned': return 'No version holds a copy of this file yet.'
    case 'same': return `saved · the same as v${working.as.number}`
    case 'changed': return kind === 'table' && working.cellsChanged !== null
      ? `unsaved · ${noun(working.cellsChanged, 'cell', 'cells')} changed since v${working.since.number}`
      : `unsaved · changed since v${working.since.number}`
  }
}

/** The name a Folio save gave the per-file versions it took. */
export const FOLIO_SAVE_PREFIX = 'Folio version: '

/** A version a Folio save took has no name of its own; it is told by the Folio version that took it ("Saved with “First full draft”"). */
export function versionTitle(row: Pick<FileVersionRow, 'name' | 'automatic'>): string {
  return row.automatic ? `Saved with “${row.name.startsWith(FOLIO_SAVE_PREFIX) ? row.name.slice(FOLIO_SAVE_PREFIX.length) : row.name}”` : row.name
}

/** What a restore of a version names the version it appends: "Restored: Pilot run", or "Restored v1" when the version had no name of its own. */
export const restoredName = (row: Pick<FileVersionRow, 'name' | 'automatic' | 'number'>): string => (row.automatic ? `Restored v${row.number}` : `Restored: ${row.name}`).slice(0, 300)

/** A name for a copy of version `number` of `path`'s file: "scores-3 (v1).csv". Offered, never imposed. */
export function suggestedCopyName(path: string, number: number): string {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (v${number})${name.slice(dot)}` : `${name} (v${number})`
}
