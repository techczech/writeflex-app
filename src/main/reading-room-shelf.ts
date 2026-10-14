/**
 * The Shelf — the Reading Room's Zotero search-and-open entry state (ReadFlex ADR-0007 mockup,
 * ADR-0009 item-first rows, ADR-0011 the citeable library items).
 *
 * This module holds only the shaping: `@readflex/zotero-bridge` owns the index and the search, and
 * `reading-room.ts` owns the IPC and the sidecar. Nothing here opens a file, and nothing here writes
 * anywhere — the bridge reads `zotero.sqlite` immutably read-only (ADR-0010/0012).
 */
import type {
  AttachmentResolution,
  ShelfAttachment,
  ShelfItem,
} from '@readflex/zotero-bridge'
import type { ReadingRoomDocument } from '@readflex/sidecar'

/** How many rows cross the IPC boundary for one query. Browsing a large library needs no more than a
 *  scrollable page of them, and the count line always states the full match total. */
export const SHELF_ROW_LIMIT = 80

export type ShelfRowKind = 'pdf' | 'snapshot' | 'other' | 'none'

export type ShelfAttachmentRow = {
  key: string
  title: string
  kind: ShelfRowKind
  badge: string
  state: AttachmentResolution['state']
  openable: boolean
  /** Why this attachment cannot be read, in the locked mockup's words. Null when it can. */
  notice: string | null
}

export type ShelfRow = {
  libraryId: number
  itemKey: string
  /** The mockup's short scan line: `Lakoff 1987`. */
  authorYear: string
  /** The reading line beneath it. */
  title: string
  citationKey: string
  /** The `zotero://` target a reference inserted from this row points at (ADR-0003). */
  citationLink: string
  kind: ShelfRowKind
  badge: string
  openable: boolean
  /** The attachment ↵ opens when the row is not expanded; null when nothing here is readable. */
  attachmentKey: string | null
  notice: string | null
  attachments: ShelfAttachmentRow[]
}

export type ShelfSearchResult = {
  query: string
  rows: ShelfRow[]
  /** Items the query matched, before the row limit. */
  matched: number
  /** Citeable bibliographic items in the library (ADR-0011). */
  total: number
  /** Set when the library could not be read at all; the Shelf degrades, never throws. */
  error: string | null
  diagnostics: string[]
  zoteroDataDirectory: string
}

const KIND_LABEL: Record<'pdf' | 'snapshot', string> = {
  pdf: 'PDF',
  snapshot: 'HTML snapshot',
}

/** Locked-mockup copy (`docs/design/2026-07-26-reading-room/CONTENT.md`), British throughout. */
function notDownloadedNotice(kind: 'pdf' | 'snapshot'): string {
  return kind === 'pdf'
    ? "This PDF isn't on this machine yet. Zotero hasn't downloaded it."
    : "This snapshot isn't on this machine yet. Zotero hasn't downloaded it."
}

export const NO_FILE_NOTICE = 'No readable file for this item. It can still be cited.'

/** An author-year scan line. Editors and translators stand in only when there is no author. */
export function shelfAuthorYear(item: ShelfItem): string {
  const authors = item.creators.filter((creator) => creator.creatorType === 'author')
  const names = (authors.length ? authors : item.creators)
    .map((creator) => creator.lastName.trim() || creator.firstName.trim())
    .filter((name) => name.length > 0)
  const who =
    names.length === 0
      ? ''
      : names.length === 1
        ? names[0]!
        : names.length === 2
          ? `${names[0]!} and ${names[1]!}`
          : `${names[0]!} et al.`
  return [who, item.year].filter((part) => !!part).join(' ')
}

function attachmentTitle(attachment: ShelfAttachment, fallback: string): string {
  return attachment.title.trim() || attachment.filename?.trim() || fallback
}

/** One attachment as the UI sees it: readable or visibly not, never a click that fails. */
export function shelfAttachmentRow(attachment: ShelfAttachment): ShelfAttachmentRow {
  const resolution = attachment.resolution
  const base = { key: attachment.key, state: resolution.state }
  switch (resolution.state) {
    case 'stored':
      return {
        ...base,
        badge: KIND_LABEL[resolution.kind],
        kind: resolution.kind,
        notice: null,
        openable: true,
        title: attachmentTitle(attachment, KIND_LABEL[resolution.kind]),
      }
    case 'linked-file':
      return {
        ...base,
        badge: resolution.available
          ? `${KIND_LABEL[resolution.kind]} · linked`
          : `${KIND_LABEL[resolution.kind]} · file not found`,
        kind: resolution.kind,
        notice: resolution.available
          ? null
          : 'Zotero links this file from outside its storage, and it is not at that location now.',
        openable: resolution.available,
        title: attachmentTitle(attachment, KIND_LABEL[resolution.kind]),
      }
    case 'missing':
      return {
        ...base,
        badge: `${KIND_LABEL[resolution.expectedKind]} · not downloaded`,
        kind: resolution.expectedKind,
        notice: notDownloadedNotice(resolution.expectedKind),
        openable: false,
        title: attachmentTitle(attachment, KIND_LABEL[resolution.expectedKind]),
      }
    case 'link':
      return {
        ...base,
        badge: 'Web link',
        kind: 'other',
        notice: 'This item is a web link rather than a stored file.',
        openable: false,
        title: attachmentTitle(attachment, 'Web link'),
      }
    case 'unsupported':
      return {
        ...base,
        badge: 'Unsupported file',
        kind: 'other',
        notice: 'The Reading Room reads PDFs and HTML snapshots. This attachment is neither.',
        openable: false,
        title: attachmentTitle(attachment, 'Attachment'),
      }
  }
}

/** A Shelf row is an item; its attachments are a property of the row (ADR-0009). */
export function shelfRow(item: ShelfItem, citationLink = ''): ShelfRow {
  const attachments = item.attachments.map(shelfAttachmentRow)
  const openable = attachments.filter((attachment) => attachment.openable)
  const primary = openable[0] ?? attachments[0] ?? null
  const readableCount = openable.length
  const badge =
    primary === null
      ? 'No file'
      : readableCount > 1
        ? `${KIND_LABEL[openable[0]!.kind === 'snapshot' ? 'snapshot' : 'pdf']} · ${readableCount} files`
        : primary.badge
  return {
    attachmentKey: openable[0]?.key ?? null,
    attachments,
    authorYear: shelfAuthorYear(item),
    badge,
    citationKey: item.citationKey,
    citationLink,
    itemKey: item.itemKey,
    kind: primary?.kind ?? 'none',
    libraryId: item.libraryId,
    notice: readableCount > 0 ? null : (primary?.notice ?? NO_FILE_NOTICE),
    openable: readableCount > 0,
    title: item.title,
  }
}

/** The path the reader opens, or null when this attachment is not a readable local file. */
function readablePath(resolution: AttachmentResolution): { kind: 'pdf' | 'snapshot'; path: string } | null {
  if (resolution.state === 'stored') return { kind: resolution.kind, path: resolution.path }
  if (resolution.state === 'linked-file' && resolution.available && resolution.path) {
    return { kind: resolution.kind, path: resolution.path }
  }
  return null
}

/**
 * The sidecar record for a Shelf selection — the same `ReadingRoomDocument` the remembered-document
 * path already carries, so opening from the Shelf and restoring on launch are one seam.
 * Throws with the row's own notice when the selection is not readable, which the UI prevents.
 */
export function readingRoomDocumentFor(
  item: ShelfItem,
  attachmentKey: string | null,
): ReadingRoomDocument {
  const candidates = attachmentKey
    ? item.attachments.filter((attachment) => attachment.key === attachmentKey)
    : item.attachments
  for (const attachment of candidates) {
    const readable = readablePath(attachment.resolution)
    if (readable) {
      return {
        attachmentKey: attachment.key,
        authorYear: shelfAuthorYear(item),
        itemKey: item.itemKey,
        kind: readable.kind,
        libraryId: item.libraryId,
        path: readable.path,
        shortTitle: item.title,
      }
    }
  }
  const row = shelfRow(item)
  throw new Error(row.notice ?? NO_FILE_NOTICE)
}
