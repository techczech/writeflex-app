/**
 * The Highlights room view — the harvest posture (T7 of the Reading Room plan, locked mockup ADR-0007).
 *
 * Shaping only: `@readflex/zotero-bridge`'s `readAnnotations` owns the reading, `reading-room.ts` owns
 * the IPC. Nothing here writes, and the bridge reads `zotero.sqlite` immutably read-only.
 *
 * Zotero's own `sortIndex` ("00000|000601|00268" — page, offset, y) is the document order, so sorting
 * is a lexicographic compare on it rather than a parse of the page label, which is a display string and
 * is routinely roman, prefixed or absent.
 */
import type { ZoteroAnnotation, ZoteroAnnotationType } from '@readflex/zotero-bridge'
import type { OutboxEntry } from '@readflex/sidecar'
import type { ZoteroAnnotationPayload } from './zotero-annotation-writes'

/** How a row's body should be read, which is not the same question as Zotero's annotation type. */
export type HighlightBodyKind =
  /** Quoted words from the document — a highlight or an underline. */
  | 'quote'
  /** The reader's own words — a standalone note or a text annotation. */
  | 'note'
  /** A region or a drawing: there are no words to show, only a place to go back to. */
  | 'mark'

export type HighlightRow = {
  key: string
  type: ZoteroAnnotationType
  bodyKind: HighlightBodyKind
  /** The quote, the comment, or the placeholder naming what kind of mark it is. Never empty. */
  body: string
  /** Present when a quote ALSO carries the reader's comment; never duplicates `body`. */
  comment: string | null
  /** Zotero's display page label, which may be roman, prefixed or missing. */
  pageLabel: string | null
  colour: string | null
  tags: string[]
  /** The reader seam's jump target. Raw Zotero position JSON, so a jump needs nothing preloaded. */
  position: string
  sortIndex: string
  /** A colleague's annotation in a group library, not the reader's own. */
  isExternal: boolean
  /** The reader edited this mark here and the edit has not reached Zotero (there is no write path
   *  for edits yet). What is shown IS the edit. Said quietly in the row, never as a warning. */
  keptHere?: boolean
}

/** The annotation shape `@readflex/reader-embed` paints on the page. Kept structural rather than
 *  imported so the main process does not depend on the renderer-side embed package. */
export type ReaderPaintAnnotation = {
  key: string
  type: 'highlight' | 'note' | 'image' | 'ink' | 'underline' | 'text'
  text: string | null
  comment: string | null
  color: string | null
  pageLabel: string | null
  sortIndex: string
  position: string
  tags: string[]
  isExternal: boolean
}

export type HighlightsResult = {
  rows: HighlightRow[]
  /** The same marks in the reader's own shape, so they are VISIBLE on the page and not only listed. */
  forReader: ReaderPaintAnnotation[]
  /** Every colour present, in document order of first appearance — the mockup's swatch row. */
  colours: string[]
  /** Every tag present, alphabetical — the mockup's tag chips. */
  tags: string[]
  error: string | null
}

const BODY_KIND: Record<ZoteroAnnotationType, HighlightBodyKind> = {
  highlight: 'quote',
  underline: 'quote',
  note: 'note',
  text: 'note',
  image: 'mark',
  ink: 'mark',
  unknown: 'mark',
}

/** What a bodyless mark is called in the list. British, and never an apology. */
const MARK_LABEL: Partial<Record<ZoteroAnnotationType, string>> = {
  image: 'A marked region of the page',
  ink: 'A drawing on the page',
  unknown: 'A mark of a kind ReadFlex does not recognise',
}

/**
 * Zotero stores a note-link relation as a tag whose name is a `zotero://note/u/KEY/` URI. These relations
 * would render as unreadable filter chips, so they are dropped: they are Zotero's plumbing, not something a reader chose to call this highlight.
 */
function isReaderTag(tag: string): boolean {
  return tag.trim().length > 0 && !/^zotero:\/\//i.test(tag.trim())
}

function collapse(value: string | null): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * One annotation as the list shows it. Every annotation type produces a row: a document whose marks are
 * mostly regions would otherwise lose most of its
 * harvest, and a mark you cannot see is a mark you cannot get back to.
 */
export function highlightRow(annotation: ZoteroAnnotation): HighlightRow {
  const bodyKind = BODY_KIND[annotation.type] ?? 'mark'
  const quote = collapse(annotation.text)
  const comment = collapse(annotation.comment)
  // A quote with no words left — Zotero stores image annotations with an empty text — falls back to the
  // comment, then to naming the mark, so a row is never blank.
  const body = bodyKind === 'quote'
    ? (quote || comment || MARK_LABEL.unknown!)
    : bodyKind === 'note'
      ? (comment || quote || MARK_LABEL.unknown!)
      : (comment || MARK_LABEL[annotation.type] || MARK_LABEL.unknown!)
  return {
    bodyKind,
    body,
    colour: annotation.color,
    comment: bodyKind === 'quote' && comment && comment !== body ? comment : null,
    isExternal: annotation.isExternal,
    key: annotation.key,
    pageLabel: annotation.pageLabel,
    position: annotation.position,
    sortIndex: annotation.sortIndex,
    tags: annotation.tags.filter(isReaderTag).sort((left, right) => left.localeCompare(right, 'en')),
    type: annotation.type,
  }
}

/** Marks the reader can paint. `unknown` is dropped: the reader has no renderer for a type it does not
 *  know, and the list still shows it so nothing disappears from the harvest. */
function paintable(annotations: ZoteroAnnotation[]): ReaderPaintAnnotation[] {
  return annotations
    .filter((annotation) => annotation.type !== 'unknown')
    .map((annotation) => ({
      color: annotation.color,
      comment: annotation.comment,
      isExternal: annotation.isExternal,
      key: annotation.key,
      pageLabel: annotation.pageLabel,
      position: annotation.position,
      sortIndex: annotation.sortIndex,
      tags: annotation.tags.filter(isReaderTag),
      text: annotation.text,
      type: annotation.type as ReaderPaintAnnotation['type'],
    }))
}

/**
 * A queued write, read back as an annotation so it can be DRAWN and not merely owed (ADR-0029).
 *
 * A durable local queue the display ignores is a hiding place, not a queue: a highlight made offline
 * would paint once and then vanish on reopen, which reads as data loss at exactly the moment the writer
 * is least able to check. Returns null for anything unreadable rather than throwing — a broken queue row
 * must not take the whole harvest down with it.
 */
export function annotationFromOutbox(entry: OutboxEntry): ZoteroAnnotation | null {
  if (entry.operation === 'delete' || !entry.itemKey) return null
  let payload: ZoteroAnnotationPayload
  try {
    payload = JSON.parse(entry.payload) as ZoteroAnnotationPayload
  } catch {
    return null
  }
  // This retained update changes only the comment on an Area that is already painted from its create
  // or Zotero row. Repainting the create-shaped payload would duplicate the rectangle while waiting.
  if (payload.readflexAreaQuotation) return null
  if (typeof payload.annotationSortIndex !== 'string') return null
  return {
    authorName: null,
    color: payload.annotationColor || null,
    comment: payload.annotationComment || null,
    isExternal: false,
    key: entry.itemKey,
    pageLabel: payload.annotationPageLabel || null,
    parentItemKey: entry.parentItemKey,
    position: JSON.stringify(payload.annotationPosition ?? { pageIndex: 0, rects: [] }),
    sortIndex: payload.annotationSortIndex,
    tags: Array.isArray(payload.tags)
      ? payload.tags.map((tag) => tag.tag).filter((tag): tag is string => typeof tag === 'string')
      : [],
    text: payload.annotationText || null,
    type: (payload.annotationType ?? 'highlight') as ZoteroAnnotationType,
  }
}

/**
 * Zotero's annotations and the pending outbox as ONE set, keyed by annotation key (ADR-0029).
 *
 * **Why the dedupe exists, since it is not obvious from the code:** between a write being confirmed and
 * the next rebuild of the read index, the same mark is present in *both* places. Without this it paints
 * twice — and a doubled highlight reads as a rendering fault rather than a sync one, so the user would
 * report the wrong bug. The outbox wins because it is the newer intent: it holds an edit the local
 * database has not yet been told about.
 */
export function mergeWithOutbox(
  stored: ZoteroAnnotation[],
  pending: OutboxEntry[],
): ZoteroAnnotation[] {
  const byKey = new Map<string, ZoteroAnnotation>()
  for (const annotation of stored) byKey.set(annotation.key, annotation)
  for (const entry of pending) {
    const annotation = annotationFromOutbox(entry)
    if (annotation) byKey.set(annotation.key, annotation)
  }
  return [...byKey.values()]
}

/** Rows in document order, plus the colour and tag facets the filter row is built from. */
export function highlightsResult(annotations: ZoteroAnnotation[]): HighlightsResult {
  const rows = annotations
    .map(highlightRow)
    .sort((left, right) => left.sortIndex.localeCompare(right.sortIndex, 'en'))
  const colours: string[] = []
  const tags = new Set<string>()
  for (const row of rows) {
    if (row.colour && !colours.includes(row.colour)) colours.push(row.colour)
    for (const tag of row.tags) tags.add(tag)
  }
  return {
    colours,
    error: null,
    forReader: paintable(annotations),
    rows,
    tags: [...tags].sort((left, right) => left.localeCompare(right, 'en')),
  }
}

/** Flag the rows whose shown state is an edit kept here. Returns a new result; the input is untouched. */
export function withKeptEdits(result: HighlightsResult, keptKeys: ReadonlySet<string>): HighlightsResult {
  if (keptKeys.size === 0) return result
  return {
    ...result,
    rows: result.rows.map((row) => (keptKeys.has(row.key) ? { ...row, keptHere: true } : row)),
  }
}

/**
 * The filter the list applies, kept here so the renderer and the tests agree on what matching means.
 * Colours and tags are OR within themselves and AND across the two, which is what the mockup's
 * independent swatch row and chip row mean; the text query matches the body, the comment or a tag.
 */
export function matchesHighlightFilter(
  row: HighlightRow,
  filter: { query: string; colours: ReadonlySet<string>; tags: ReadonlySet<string> },
): boolean {
  if (filter.colours.size > 0 && (!row.colour || !filter.colours.has(row.colour))) return false
  if (filter.tags.size > 0 && !row.tags.some((tag) => filter.tags.has(tag))) return false
  const query = filter.query.trim().toLocaleLowerCase('en')
  if (!query) return true
  const haystack = [row.body, row.comment ?? '', row.tags.join(' '), row.pageLabel ?? '']
    .join(' ')
    .toLocaleLowerCase('en')
  return query.split(/\s+/).every((token) => haystack.includes(token))
}
