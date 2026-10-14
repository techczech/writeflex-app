/**
 * `zotero://` deep links — the target a citation chip points at (ReadFlex ADR-0003).
 *
 * The chip's link must survive the document being copied, moved or edited elsewhere, so it targets the
 * item or the annotation itself and never a checksum of the quoted words. Which URL shape is correct
 * depends on the library: personal items use the user-library URL, while group-library items
 * use a numeric group id rather than the local library id.
 * Getting that wrong yields a link that silently selects nothing.
 */
import type { SqliteDriver } from '@readflex/sqlite-driver'
import { openZoteroReadOnly } from '@readflex/zotero-bridge'

/** libraryId → the URL segment identifying it: `library` for the user's own, `groups/<groupID>` else. */
export type LibrarySegments = Map<number, string>

interface LibraryRow { libraryID: number; type: string }
interface GroupRow { libraryID: number; groupID: number }

/**
 * Reads the library table once. Degrades to an empty map rather than throwing: a citation without a
 * working deep link is worth inserting, a crash on a paste is not.
 */
export function readLibrarySegments(
  databaseDriver: SqliteDriver,
  zoteroDatabasePath: string,
): LibrarySegments {
  const segments: LibrarySegments = new Map()
  let database
  try {
    database = openZoteroReadOnly(databaseDriver, zoteroDatabasePath)
    const libraries = database
      .prepare('SELECT libraryID, type FROM libraries')
      .all() as LibraryRow[]
    for (const library of libraries) {
      if (library.type === 'user') segments.set(library.libraryID, 'library')
    }
    const groups = database
      .prepare('SELECT libraryID, groupID FROM groups')
      .all() as GroupRow[]
    for (const group of groups) {
      segments.set(group.libraryID, `groups/${group.groupID}`)
    }
  } catch {
    return segments
  } finally {
    database?.close()
  }
  return segments
}

/** The user library is `libraryID` 1 in every Zotero profile; the fallback keeps a link usable when
 *  the table could not be read at all. */
function segmentFor(segments: LibrarySegments, libraryId: number): string {
  return segments.get(libraryId) ?? (libraryId === 1 ? 'library' : `groups/${libraryId}`)
}

/** Selects the bibliographic item in Zotero — the target for a reference with no page. */
export function itemSelectLink(
  segments: LibrarySegments,
  libraryId: number,
  itemKey: string,
): string {
  return `zotero://select/${segmentFor(segments, libraryId)}/items/${itemKey}`
}

/**
 * Opens the PDF at one annotation — the target for a pulled quote, so activating the chip lands on the
 * exact highlight rather than the top of the paper.
 */
export function annotationLink(
  segments: LibrarySegments,
  libraryId: number,
  attachmentKey: string,
  annotationKey: string,
): string {
  return `zotero://open-pdf/${segmentFor(segments, libraryId)}/items/${attachmentKey}?annotation=${annotationKey}`
}

/**
 * Opens the PDF at a page. The target for a quote copied out of the reader before any highlight exists
 * for it: the words came from a real page, so the link lands there rather than nowhere.
 */
export function pageLink(
  segments: LibrarySegments,
  libraryId: number,
  attachmentKey: string,
  page: number | null,
): string {
  const base = `zotero://open-pdf/${segmentFor(segments, libraryId)}/items/${attachmentKey}`
  return page === null ? base : `${base}?page=${page}`
}
