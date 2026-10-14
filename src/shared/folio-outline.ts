/**
 * The Outline's Folio part, as plain facts the main process gathers (`folio:outline`) and the renderer
 * draws. Pure, so main and the tests share one rule for the switch, the grouping into the running order
 * and "Also in this folder", and the open-piece marking. Read-only: nothing here writes a file.
 */

import type { FolioPlace } from './folio-place'

export type FolioOutlineHeading = { level: number; text: string; line: number }

/** One file of the Folio's folder with its title and ATX headings, read from disk. */
export type FolioOutlineFile = {
  path: string
  title: string
  headings: FolioOutlineHeading[]
  /** The file is over the outline's size bound: it was not read and lists no headings. */
  tooLarge?: boolean
  /** Only on "Also in this folder" files: whether Add will accept it. True only for a file the Plan lists as
   *  unlisted and not already in the manifest, in a Folio the Outline may change. The Index Note, a cover,
   *  an underscore-prefixed file and a backup are listed but never admitted; nor is a file outside the
   *  folder a `content_root` Folio takes its pieces from. */
  addable?: boolean
  /** Only on "Also in this folder" files that are not directly in the Folio's folder: the folder they are in,
   *  relative to it ("contents"). The row shows it before the title ("contents/Notes"). */
  under?: string
}

export type FolioOutline = {
  /** The Folio's folder, workspace-relative ('' = the workspace root). */
  dir: string
  name: string
  /** The running order as the manifest lists it (a piece listed twice appears twice). */
  pieces: FolioOutlineFile[]
  /** Markdown files of the Folio's folder that the running order does not list: its direct children in file-name
   *  order, then the unlisted files of the folder a `content_root` Folio takes its pieces from. */
  also: FolioOutlineFile[]
  /**
   * The Outline cannot change this Folio's running order exactly (no manifest, an entry
   * listed twice, missing or outside the folder, a part with no file, or an Index Note and a manifest
   * that disagree). The Outline then shows no grip, Move, Add or Add all, and one line that sends the
   * owner to the Plan. Main refuses the same Folios (folio-order-assessment.ts).
   */
  orderInPlanOnly?: true
}

export type OutlineSwitch = {
  second: 'Folder' | 'Folio'
  /** Folder is disabled while no file is open: there is no folder to list. */
  secondDisabled: boolean
}

/** `Document | Folio` when the open file belongs to a Folio (including a file of its folder that is not
 *  in the running order), `Document | Folder` otherwise. With no file open the second segment is Folder, disabled. */
export function outlineSwitch(hasFile: boolean, place: Pick<FolioPlace, 'dir'> | null): OutlineSwitch {
  if (!hasFile) return { second: 'Folder', secondDisabled: true }
  return { second: place ? 'Folio' : 'Folder', secondDisabled: false }
}

/** The folder a file is in, relative to the Folio's folder; null when it is directly in it (or not inside it). */
export function subFolderOf(dir: string, path: string): string | null {
  const inside = dir === '' ? path : path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : null
  if (inside === null) return null
  const cut = inside.lastIndexOf('/')
  return cut < 0 ? null : inside.slice(0, cut)
}

/**
 * "Also in this folder": the files directly in the Folio's folder that the running order does not list,
 * and the files in `unlisted` (those the Plan reports as not in the running order; for a `content_root`
 * Folio they sit in that folder). Only files of `files`, the Folio folder's own listing, are ever given.
 * Direct children come first, in file-name order; the others follow by path. Each carries whether Add
 * accepts it: `admissible` is the set the Plan would accept.
 */
export function groupAlsoInFolder(
  files: ReadonlyArray<{ path: string; name: string; directory: string }>,
  pieces: readonly string[],
  dir: string,
  admissible: ReadonlySet<string>,
  unlisted: ReadonlySet<string> = new Set(),
): Array<{ path: string; addable: boolean }> {
  const listed = new Set(pieces)
  const direct = files.filter((file) => file.directory === dir && !listed.has(file.path)).sort((a, b) => a.name.localeCompare(b.name))
  const deeper = files
    .filter((file) => file.directory !== dir && unlisted.has(file.path) && !listed.has(file.path) && subFolderOf(dir, file.path) !== null)
    .sort((a, b) => a.path.localeCompare(b.path))
  return [...direct, ...deeper].map((file) => ({ path: file.path, addable: admissible.has(file.path) }))
}

/** The headings a file's rows show: its leading level-1 heading is the piece's own name (the row itself),
 *  so it is not repeated as a heading. */
export function shownHeadings<T extends { level: number }>(headings: readonly T[]): T[] {
  return headings.length > 0 && headings[0].level === 1 ? headings.slice(1) : [...headings]
}

/** The Levels limit applied to a file's headings (null = all). */
export function limitLevels<T extends { level: number }>(headings: readonly T[], limit: number | null): T[] {
  return limit === null ? [...headings] : headings.filter((heading) => heading.level <= limit)
}

/** Which row of the Folio part is the open file: every running-order row of that path, or the one
 *  "Also in this folder" file. Neither when the open file is the Index Note of a piece-less folder, etc. */
export function openRows(outline: Pick<FolioOutline, 'pieces' | 'also'>, openPath: string | null): { pieces: number[]; also: number | null } {
  if (openPath === null) return { pieces: [], also: null }
  const pieces = outline.pieces.flatMap((piece, index) => (piece.path === openPath ? [index] : []))
  const also = outline.also.findIndex((file) => file.path === openPath)
  return { pieces, also: also >= 0 ? also : null }
}

/**
 * The Filter box over the Folio part: a file stays when its title or any of its headings contains the
 * text; `headings` are then only the matching ones (all of them when the title itself matches).
 */
export function filterFolioFile(file: FolioOutlineFile, needle: string): { keep: boolean; headings: FolioOutlineHeading[] } {
  const own = shownHeadings(file.headings)
  if (!needle) return { keep: true, headings: own }
  const matching = own.filter((heading) => heading.text.toLowerCase().includes(needle))
  if (file.title.toLowerCase().includes(needle)) return { keep: true, headings: own }
  return { keep: matching.length > 0, headings: matching }
}

/** "In Example guide, not in the running order." / the line for an empty group. */
export function alsoLine(name: string, count: number): string {
  return count === 0 ? `Every piece in ${name} is in the running order.` : `In ${name}, not in the running order.`
}

/** The Folder part's foot line for a folder that is not a Folio, and for a file loose in the collection. */
export function folderFootLine(folderName: string | null, fileCount: number, fileName: string): string {
  if (folderName === null) {
    return `${fileName} is not in a folder, so this lists the whole collection. A Folio is made from the pieces of one folder.`
  }
  return `${folderName} is a folder of ${fileCount} ${fileCount === 1 ? 'file' : 'files'}, shown in file-name order.`
}

/** One keyboard-reachable row of the Folio part, as the list shows it. A heading row names its file row in `parent`. */
export type FolioKeyRow = { key: string; file: boolean; /** undefined when the file row cannot expand */ expanded?: boolean; parent?: string }

/** The one tab stop: the stored row while it is still shown, else the open file's row if shown, else the first shown row. */
export function folioTabStop(visible: readonly string[], stored: string | null, openKey: string | null): string | null {
  if (stored !== null && visible.includes(stored)) return stored
  if (openKey !== null && visible.includes(openKey)) return openKey
  return visible[0] ?? null
}

/**
 * What a key does on a row of the Folio part: ↑ ↓ Home End move; → on a collapsed file expands it, on an expanded
 * file goes to its first heading; ← on an expanded file collapses it, on a heading goes to its file row.
 * Toggling is off while a filter is on (every file with matches is open). Null = the key is not handled here.
 */
export function folioKeyAction(rows: readonly FolioKeyRow[], key: string, pressed: string, filtering: boolean): { focus?: string; toggle?: { key: string; open: boolean } } | null {
  const at = rows.findIndex((row) => row.key === key)
  if (at < 0 || rows.length === 0) return null
  const row = rows[at]
  switch (pressed) {
    case 'ArrowDown': return { focus: rows[Math.min(at + 1, rows.length - 1)].key }
    case 'ArrowUp': return { focus: rows[Math.max(at - 1, 0)].key }
    case 'Home': return { focus: rows[0].key }
    case 'End': return { focus: rows[rows.length - 1].key }
    case 'ArrowRight': {
      if (!row.file || row.expanded === undefined) return {}
      if (!row.expanded) return filtering ? {} : { toggle: { key, open: true } }
      const next = rows[at + 1]
      return next && !next.file && next.parent === key ? { focus: next.key } : {}
    }
    case 'ArrowLeft': {
      if (!row.file) return row.parent !== undefined && rows.some((r) => r.key === row.parent) ? { focus: row.parent } : {}
      return row.expanded === true && !filtering ? { toggle: { key, open: false } } : {}
    }
    default: return null
  }
}

/** An editor offset kept inside the document, so a jump from stale data cannot throw. */
export const clampOffset = (offset: number, length: number): number => Math.max(0, Math.min(offset, length))
