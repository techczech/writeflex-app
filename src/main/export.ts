/**
 * The export organ (Round B T6/T7, ADR-0029) — a finished piece as a FILE.
 *
 * Copy hands bytes to another application; export writes a file someone else will open, possibly
 * offline, possibly years later. So an exported file is SELF-CONTAINED: the HTML carries its styles
 * and its pictures inside it, and the Word document embeds the pictures too. Nothing here decides
 * what may leave the app — the emitters do that over one shared reading of the document (frontmatter
 * and comments are gone before a model exists), which is why export cannot drift from copy.
 *
 * This module is the only part of the export path that touches a disk. It reads the pieces through
 * the Workspace guard, reads pictures through the same containment check the asset protocol uses,
 * and writes exactly one file to the place the writer chose in the system save dialog.
 */
import { posix } from 'node:path'
import { folioPieces } from './folio'
import { folioTocDepth, saveExportTocDepth, type TocDepthWriteResult } from './export-toc-depth'
import { tocDepthOf } from '../shared/toc-depth'
import { folioFrontMatter, frontMatterExportOrder } from './folio-front-matter'
import { loadExportWidgets } from './widget-export'
import { writeFile } from 'node:fs/promises'
import { listCollection, documentWordCount, type CollectionRow } from './collection'
import { documentTitle, parseFrontmatter } from './frontmatter'
import { exportCollectionTitle, exportDocumentTitle } from './export-title'
import { folioPartPaths } from './folio-part-set'
import { headingPlainText, partTitleWithHeading, type PartHeadingMode, sameTitle, withoutOwnHeading } from '../shared/folio-part-title'
import {
  docxImages,
  docxSvgFences,
  htmlImages,
  loadPictures,
  loadSvgFences,
  mergePictures,
  type DrawnFences,
  type LoadedPictures,
} from './pictures'
import { buildWikilinkCandidateIndex, collectionCandidates, resolveWikilinkTargetFromIndex } from './wikilinks'
import {
  assembleDocument,
  TITLE_PAGE_ANCHOR,
  type HtmlContentsRow,
  type HtmlDocumentData,
  type HtmlDocumentDesign,
  type HtmlFrontmatterValue,
  type HtmlOutlineHeading,
} from '../shared/markdown/html-document'
import { folioHeadingFlow } from '../shared/folio-heading-flow'
import { htmlOutline, toHtml } from '../shared/markdown/to-html'
import { docxBundleContent, docxContent, docxFile } from '../shared/markdown/to-docx'
import { readDocument, type MarkdownDocument } from '../shared/markdown/model'
import { externalLinksOnly } from '../shared/markdown/external-links'
import { frontmatterBlock } from '../shared/markdown/frontmatter'
import { coverWithDetails, folioHeaderDetails } from '../shared/folio-cover-details'
import { folioCoverDetails } from './folio-details'
import type { Workspace } from './workspace'
import { assertCollectionWritable } from './collection-write-gate'

// `imageSize` lives with the pictures now (both a copy and an export need it); re-exported here so
// the export's own public surface has not moved under anyone.
export { imageSize } from './pictures'

/** The two targets, named for where they are going rather than by extension (ADR-0029). */
export type ExportFormat = 'html' | 'docx'
export const EXPORT_FORMATS: ExportFormat[] = ['html', 'docx']
export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = { html: 'HTML', docx: 'Word' }
export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = { html: 'html', docx: 'docx' }

/** Renderer-agnostic HTML document options. The contents sidebar and title block default on, summary
 * tiles default off, and the shipped frontmatter field selection is date, status and author. */
export type HtmlExportOptions = {
  stableHeadingIds?: boolean
  stableBlockIds?: boolean
  frontmatterFields?: readonly string[]
  sidebar?: boolean
  /** Heading levels the contents lists, 1-6; absent keeps the default. */
  tocDepth?: number
  design?: HtmlDocumentDesign
  titleBlock?: boolean
  summaryTiles?: boolean
  frontPage?: boolean
  readerNotes?: boolean
  readerEdits?: boolean
}

export const DEFAULT_HTML_FRONTMATTER_FIELDS = ['date', 'status', 'author'] as const

/**
 * What an export did. Neither picture list is ever silent and neither is ever fatal (the PRD's
 * states table). They are two different facts and the sheet says them differently: `missingImages`
 * is nothing at that address, `unreadableImages` is a file that IS there and could not be read or
 * converted into a picture — "was not found" would be a lie about the second.
 */
export type ExportOutcome = {
  target: string
  format: ExportFormat
  missingImages: string[]
  unreadableImages: string[]
  pieces: number
  /** How many pieces were listed for this export. More than `pieces` only for a Folio whose manifest
   *  lists entries that were left out (file not found, or outside the Folio's folder). */
  listed: number
  /** Only for an HTML export asked to keep its Contents depth: what saving it with the file did (the
   *  file as written or found, or the refusal and its sentence). Never fatal: the export is written. */
  tocDepthSave?: TocDepthWriteResult
}

/** The export request's own fields (export-ipc.ts). `keepTocDepth`: the writer chose the Contents depth
 *  in the sheet, so an HTML export uses exactly `html.tocDepth` (absent: Default) and then saves it into
 *  the file of the scope it exported (absent: removes the key). */
type KeepTocDepth = { keepTocDepth?: boolean }

/** Split what an emitter could not draw into the two things it can mean. */
function pictureReport(missed: string[], pictures: LoadedPictures): { missingImages: string[]; unreadableImages: string[] } {
  return {
    missingImages: missed.filter((source) => !pictures.unreadable.has(source)),
    unreadableImages: missed.filter((source) => pictures.unreadable.has(source)),
  }
}

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && (EXPORT_FORMATS as string[]).includes(value)
}

// ---- Titles and file names -----------------------------------------------------------------------

// The Export sheet, save suggestion and exported file use the same declared-title resolver,
// so the writer sees the same title at each step.

/** A file name the save dialog can open with: the title, made safe for a file system. */
export function exportFileName(title: string, format: ExportFormat): string {
  const stem = title.replace(/\0/g, '').replace(/[/\\:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'export'
  return `${stem}.${EXPORT_EXTENSIONS[format]}`
}

// ---- Where the save dialog opens -----------------------------------------------------------------
// Remember the last export folder so subsequent exports start there. Only the FOLDER is remembered: the file name always comes from the piece's own
// title, so remembering it would offer to overwrite a different piece's export.

/** The setting the last-used folder is kept under. Live-surface state, so it is set with
 *  `{ log: false }` — it is not a change the writer made in Settings. */
export const LAST_EXPORT_FOLDER_KEY = 'export.lastFolder'

/** Where the save dialog opens: the folder of the last export, or the writer's Documents the first
 *  time (and whenever what was remembered is no longer a usable path). */
export function exportStartFolder(remembered: unknown, documents: string): string {
  return typeof remembered === 'string' && remembered.trim() !== '' ? remembered : documents
}

/** The folder to remember from a chosen target, or null when there is nothing to remember. */
export function exportFolderToRemember(target: string | null): string | null {
  if (!target) return null
  const folder = target.slice(0, target.lastIndexOf('/'))
  return folder === '' ? null : folder
}

/** Everything the system save sheet is opened with. Built here so it can be checked without an
 *  Electron window — a native sheet is not drivable by Playwright either. */
export function exportSaveDialogOptions(input: {
  name: string
  format: ExportFormat
  remembered: unknown
  documents: string
}): { title: string; defaultPath: string; filters: Array<{ name: string; extensions: string[] }>; properties: Array<'createDirectory' | 'showOverwriteConfirmation'> } {
  return {
    title: 'Export',
    defaultPath: `${exportStartFolder(input.remembered, input.documents)}/${input.name}`,
    filters: [{ name: EXPORT_FORMAT_LABELS[input.format], extensions: [EXPORT_EXTENSIONS[input.format]] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  }
}

// ---- Writing -------------------------------------------------------------------------------------

/** A failed write, said as the writer should read it: what happened, and the way forward. Never an
 *  errno, never an exception string (ADR-0029's error state). */
function writeFailure(error: unknown, target: string): Error {
  const code = (error as { code?: string } | null)?.code
  const folder = target.split('/').slice(0, -1).join('/') || target
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new Error('WriteFlex could not write to that folder — it is read-only. Choose somewhere else, or check the folder’s permissions.')
  }
  if (code === 'ENOENT') return new Error(`That folder is no longer there (${folder}). Choose somewhere else.`)
  if (code === 'ENOSPC') return new Error('The disk is full, so nothing was written. Free some space, or choose another disk.')
  if (code === 'EISDIR') return new Error('That name belongs to a folder. Choose a file name instead.')
  return new Error(`WriteFlex could not write the file (${(error as Error)?.message ?? 'unknown reason'}). Choose somewhere else, or try again.`)
}

async function write(target: string, content: string | Uint8Array): Promise<void> {
  try {
    // An export into a Collection is a write to it; anywhere else is never gated.
    assertCollectionWritable(target)
    await writeFile(target, content)
  } catch (error) {
    throw writeFailure(error, target)
  }
}

// ---- One piece -------------------------------------------------------------------------------------

function isHtmlFrontmatterValue(value: unknown): value is HtmlFrontmatterValue {
  return typeof value === 'string'
    || typeof value === 'number'
    || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
}

function selectedFrontmatter(source: string, fields: readonly string[]): Record<string, HtmlFrontmatterValue> {
  const parsed = parseFrontmatter(source)
  if (!parsed) return {}
  const entries: Array<[string, HtmlFrontmatterValue]> = []
  for (const field of fields) {
    let value: unknown
    switch (field) {
      case 'title': value = parsed.title; break
      case 'date': value = parsed.date; break
      case 'status': value = parsed.status; break
      case 'author': value = parsed.author; break
      case 'description': value = parsed.description; break
      case 'purpose': value = parsed.purpose; break
      case 'related': value = parsed.related; break
      case 'tags': value = parsed.tags; break
      case 'series': value = parsed.series; break
      case 'series-order': case 'seriesOrder': value = parsed.seriesOrder; break
      default: value = field === '_raw' || !Object.hasOwn(parsed.extra, field) ? undefined : parsed.extra[field]
    }
    if (isHtmlFrontmatterValue(value)) entries.push([field, value])
  }
  return Object.fromEntries(entries)
}

function wordCount(source: string): number {
  const frontmatter = frontmatterBlock(source)
  const body = frontmatter ? source.slice(frontmatter.end) : source.replace(/^﻿/, '')
  const trimmed = body.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length
}

function stableReaderDocumentId(locator: string, title: string): string {
  let hash = 0x811c9dc5
  for (const character of locator) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  const stem = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'document'
  return `writeflex-${stem}-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function documentData(input: {
  source: string
  document: MarkdownDocument
  /** The document's first heading is its title, kept in the body: its row is left out of the contents. */
  dropFirstOutlineRow?: boolean
  idPrefix?: string
  frontmatterFields: readonly string[]
  metadata: HtmlDocumentData['metadata']
}): HtmlDocumentData {
  return {
    frontmatter: selectedFrontmatter(input.source, input.frontmatterFields),
    outline: input.dropFirstOutlineRow ? htmlOutline(input.document, input.idPrefix).slice(1) : htmlOutline(input.document, input.idPrefix),
    metadata: input.metadata,
  }
}

function rowMetadata(
  row: Pick<CollectionRow, 'purpose' | 'status' | 'modified' | 'words'>,
  title: string,
): HtmlDocumentData['metadata'] {
  return {
    title,
    description: null,
    purpose: row.purpose,
    status: row.status,
    modified: row.modified,
    words: row.words,
  }
}

/**
 * Export ONE piece to `target`. The buffer is the writer's business: whoever calls this has already
 * flushed it, so what is exported is what is on screen.
 */
export async function exportDocument(
  workspace: Workspace,
  input: { path: string; format: ExportFormat; target: string; html?: HtmlExportOptions } & KeepTocDepth,
): Promise<ExportOutcome> {
  const { content, file } = await workspace.readFile(input.path)
  const document = readDocument(content)
  const title = exportDocumentTitle(content)
  const pictures = await loadPictures(workspace, document, input.path)
  if (input.format === 'html') {
    const options = input.html ?? {}
    const parsed = parseFrontmatter(content)
    // The title is never a contents entry, and is not printed again in the body when the page already carries it
    // above the text (the masthead title block, or the cover). An opening `#` heading that is not the title stays.
    const ownTitle = partTitleWithHeading(content, input.path).heading
    const titleHeading = ownTitle && ownTitle.level === 1 && sameTitle(ownTitle.text, headingPlainText(title)) ? ownTitle : null
    const titleAbove = (options.titleBlock ?? true) || (options.frontPage ?? false)
    const body = titleHeading && titleAbove ? withoutOwnHeading(content, input.path) : content
    const bodyDocument = body === content ? document : readDocument(body)
    // With the heading kept in the body its anchors are unchanged: the outline is the full one minus the title's own row.
    const outlineDocument = titleHeading && !titleAbove ? null : bodyDocument
    const data = documentData({
      source: content,
      document: outlineDocument ?? document,
      dropFirstOutlineRow: outlineDocument === null,
      frontmatterFields: options.frontmatterFields ?? DEFAULT_HTML_FRONTMATTER_FIELDS,
      metadata: {
        title,
        description: parsed?.description?.trim() || null,
        purpose: parsed?.purpose ?? null,
        status: parsed?.status?.trim() || null,
        modified: file.modifiedAt,
        words: wordCount(content),
      },
    })
    const { html, missingImages } = toHtml(body, {
      standalone: true,
      links: 'external-only',
      title,
      images: htmlImages(pictures),
      widgets: await loadExportWidgets(workspace, content, input.path),
      tableRegions: true,
      stableHeadingIds: options.stableHeadingIds,
      stableBlockIds: options.stableBlockIds,
      documentData: data,
      sidebar: options.sidebar,
      // A depth the writer chose to keep is used exactly (absent: Default). Otherwise the request's depth
      // wins; with none, the document's own `toc_depth` (an export from a command or an agent still
      // follows it); with neither, the default.
      tocDepth: input.keepTocDepth ? options.tocDepth : options.tocDepth ?? tocDepthOf(content) ?? undefined,
      design: options.design,
      titleBlock: options.titleBlock,
      summaryTiles: options.summaryTiles,
      frontPage: options.frontPage,
      ...(options.readerNotes ? { readerNotes: { documentId: stableReaderDocumentId(input.path, documentTitle(content, input.path)) } } : {}),
      ...(options.readerEdits ? { readerEdits: { documentId: stableReaderDocumentId(input.path, documentTitle(content, input.path)) } } : {}),
    })
    await write(input.target, html)
    // Saved after the export is written, into the document the export read, over the text it read.
    const tocDepthSave = input.keepTocDepth
      ? await saveExportTocDepth(workspace, { kind: 'document', path: input.path }, options.tocDepth ?? null, content)
      : undefined
    return { target: input.target, format: 'html', ...pictureReport(missingImages, pictures), pieces: 1, listed: 1, ...(tocDepthSave ? { tocDepthSave } : {}) }
  }
  const fences = await loadSvgFences(document)
  const { children, missingImages } = docxContent(externalLinksOnly(document), { images: docxImages(pictures), svgFences: docxSvgFences(fences) })
  await write(input.target, await docxFile(children, title))
  return { target: input.target, format: 'docx', ...pictureReport(missingImages, pictures), pieces: 1, listed: 1 }
}

// ---- A whole Collection ------------------------------------------------------------------------------
// The case the review identified: pieces that reference each other, exported as ONE file whose internal links
// work. A wikilink to a piece INSIDE the bundle becomes an anchor; a wikilink to anything else
// degrades to its label text, exactly as it does in a copy. Never a dead anchor, in either direction.

/** Where a piece goes in the exported file (ADR-0046): the cover (the title page), the front matter before the
 *  contents, or the contents (the only pieces the contents sidebar and the summary tiles list). */
type BundlePlace = 'cover' | 'front' | 'contents'

type BundlePiece = {
  path: string
  title: string
  source: string
  document: MarkdownDocument
  /** The id prefix of the piece's headings and notes; its section's anchor is `${prefix}section`. */
  prefix: string
  anchor: string
  place: BundlePlace
  data: HtmlDocumentData
  /** The inputs of the Folio heading flow (folio-heading-flow.ts), kept for a contents piece. */
  flow: { mode: PartHeadingMode; headings: HtmlOutlineHeading[] }
}

/** The Folio's contents rows (shared/folio-heading-flow.ts): chapters, the parts that continue them, and their headings. */
function folioContentsRows(contents: readonly BundlePiece[]): HtmlContentsRow[] {
  const flow = folioHeadingFlow<HtmlOutlineHeading>(contents.map((piece) => ({
    path: piece.path, title: piece.title, mode: piece.flow.mode, headings: piece.flow.headings,
  })))
  return flow.rows.flatMap((row): HtmlContentsRow[] => {
    if (row.kind === 'mark') return []
    if (row.kind === 'part') return [{ anchor: contents[row.partIndex].anchor, text: row.text, depth: row.depth, chapter: row.depth === 0 }]
    return [{ anchor: row.heading.anchor, text: row.text, depth: row.depth, chapter: false }]
  })
}

/** The anchor a contents piece's section carries, and the id prefix its own headings and notes are namespaced
 *  with, so nine pieces in one file cannot collide. The contents sidebar links `p<n>-section`. */
function sectionPrefix(index: number): string {
  return `p${index + 1}-`
}

/** The same for a front-matter piece (`f<n>-`, never in the contents) and for the cover. */
function placePrefix(place: BundlePlace, index: number): string {
  return place === 'cover' ? 'cover-' : place === 'front' ? `f${index + 1}-` : sectionPrefix(index)
}

/**
 * Export a whole Collection to `target`. The pieces are the Collection organ's own rows, in its own
 * order (ADR-0008), so the bundle matches what the Board and the Collection view show. A bundle of
 * one piece works and skips the contents list.
 */
export async function exportBundle(
  workspace: Workspace,
  input: { dir: string; format: ExportFormat; target: string; html?: HtmlExportOptions } & KeepTocDepth,
): Promise<ExportOutcome> {
  const collection = await listCollection(workspace, input.dir)
  const options = input.html ?? {}
  const title = await exportCollectionTitle(workspace, input.dir)
  const exportTitle = title
  const pieces: BundlePiece[] = []
  // A Folio's export (HTML and Word alike) follows its manifest: the listed pieces inside its folder, in order. Entries that
  // are missing or point outside the folder are left out by folio.ts and never read here.
  const folio = await folioPieces(workspace, input.dir)
  const listedPaths = folio ? folio.pieces : collection.rows.map(row => row.path)
  const listed = folio ? folio.pieces.length + folio.leftOut.length : listedPaths.length
  // Front matter first (ADR-0046): the title page first of all, then the other front matter, then the contents.
  const order = frontMatterExportOrder(listedPaths, await folioFrontMatter(workspace, input.dir))
  const placed: Array<{ path: string; place: BundlePlace; index: number }> = [
    ...(order.titlePage !== null ? [{ path: order.titlePage, place: 'cover' as const, index: 0 }] : []),
    ...order.front.map((path, index) => ({ path, place: 'front' as const, index })),
    ...order.contents.map((path, index) => ({ path, place: 'contents' as const, index })),
  ]
  const paths = placed.map((item) => item.path)
  const files = new Map((await workspace.listFiles()).map(file => [file.path, file]))
  const folioParts = await folioPartPaths(workspace, paths)
  for (const { path, place, index } of placed) {
    const row = collection.rows.find(row => row.path === path)
    const { content } = await workspace.readFile(path)
    const prefix = placePrefix(place, index)
    // The export section uses the declared title; a Folio part's own title heading is still
    // omitted from its body so the section prints it once.
    const isPart = folioParts.has(path)
    const title = exportDocumentTitle(content, isPart ? path : undefined)
    const ownHeading = isPart ? partTitleWithHeading(content, path).heading : null
    // A differing heading is still authored content, even when metadata names the section.
    const body = ownHeading && sameTitle(ownHeading.text, headingPlainText(title))
      ? withoutOwnHeading(content, path)
      : content
    const document = readDocument(body)
    const fm = parseFrontmatter(content)
    const data = documentData({
      source: content,
      document,
      idPrefix: prefix,
      frontmatterFields: options.frontmatterFields ?? DEFAULT_HTML_FRONTMATTER_FIELDS,
      metadata: rowMetadata(row ?? { purpose: fm?.purpose ?? null, status: fm?.status ?? 'unsorted', modified: files.get(path)!.modifiedAt, words: documentWordCount(content) }, title),
    })
    // The flow reads the part as the sidebar does: its own title heading is a heading of the part, though the body
    // printed it once as the section title and left it out, so it comes back here with the section's anchor.
    const named = partTitleWithHeading(content, path)
    const flowHeadings = body !== content && named.heading
      ? [{ level: named.heading.level, text: named.heading.text, anchor: `${prefix}section` }, ...data.outline]
      : [...data.outline]
    pieces.push({
      path,
      // The title page shows the export's one title (export-title.ts: Details, then its own frontmatter title, then the
      // manifest's), as Word's first section, HTML's cover and HTML's title-page section alike, so the visible title,
      // the document properties and the file name never disagree (Sol round 3).
      title: place === 'cover' ? exportTitle : title,
      source: body,
      document,
      prefix,
      anchor: `${prefix}section`,
      place,
      data,
      flow: { mode: named.named.mode, headings: flowHeadings },
    })
  }
  if (!pieces.length) {
    throw new Error(`There are no pieces in ${collection.name} to export. Add a piece, or export this document on its own.`)
  }
  const missingImages: string[] = []
  const pictures: LoadedPictures = { bySource: new Map(), unreadable: new Set() }
  for (const piece of pieces) mergePictures(pictures, await loadPictures(workspace, piece.document, piece.path))

  if (input.format === 'docx') {
    // Word gets the same ordering, minus the anchors (ADR-0029): its navigation is the heading styles.
    const fences: DrawnFences = new Map()
    for (const piece of pieces) for (const [source, drawn] of await loadSvgFences(piece.document)) fences.set(source, drawn)
    const { children, missingImages: missed } = docxBundleContent(
      pieces.map((piece) => ({ title: piece.title, document: externalLinksOnly(piece.document) })),
      { images: docxImages(pictures), svgFences: docxSvgFences(fences) },
    )
    await write(input.target, await docxFile(children, title))
    return { target: input.target, format: 'docx', ...pictureReport(missed, pictures), pieces: pieces.length, listed }
  }

  // The link law. Targets are matched by the app's OWN rule (title → file name → alias), so a
  // wikilink resolves in the bundle exactly as it resolves in the editor.
  const candidates = await collectionCandidates(workspace, input.dir)
  const candidateIndex = buildWikilinkCandidateIndex(candidates)
  // A link to the title page lands on it: the cover, or with the cover off its section, both `TITLE_PAGE_ANCHOR`.
  const anchors = new Map(pieces.map((piece) => [piece.path, piece.place === 'cover' ? TITLE_PAGE_ANCHOR : piece.anchor] as const))
  const sections = await Promise.all(pieces.map(async (piece) => {
    const { html, missingImages: missed, interactionTargets } = toHtml(piece.source, {
      idPrefix: piece.prefix,
      headingOffset: 1,
      links: 'external-only',
      stableHeadingIds: (options.readerNotes || options.readerEdits) ? true : options.stableHeadingIds,
      stableBlockIds: (options.readerNotes || options.readerEdits) ? true : options.stableBlockIds,
      images: htmlImages(pictures),
      widgets: await loadExportWidgets(workspace, piece.source, piece.path),
      tableRegions: true,
      linkTarget: (href) => {
        if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return href
        try {
          const local = posix.normalize(posix.join(posix.dirname(piece.path), decodeURIComponent(href.split('#')[0])))
          const anchor = anchors.get(local)
          return anchor ? `#${anchor}` : null
        } catch { return null }
      },
      wikilinks: {
        resolve: (target) => {
          const to = resolveWikilinkTargetFromIndex(piece.path, target, candidateIndex).to
          return to === null ? null : anchors.get(to) ?? null
        },
      },
    })
    for (const missing of missed) missingImages.push(missing) // no spread: one argument per missing picture
    return { anchor: piece.anchor, title: piece.title, body: html, interactionTargets, place: piece.place, data: piece.data }
  }))
  // A Folio's contents is the Outline's tree: the heading flow over the contents parts in running order.
  const contentsRows = folio ? folioContentsRows(pieces.filter((piece) => piece.place === 'contents')) : undefined
  const cover = sections.find((section) => section.place === 'cover')
  const contents = sections.filter((section) => section.place === 'contents')
  // The Details card's values (the Index Note's header) are the cover's: laid over the title page's own, field by field.
  const details = folio ? await folioCoverDetails(workspace, input.dir) : null
  const chipFields = options.frontmatterFields ?? DEFAULT_HTML_FRONTMATTER_FIELDS
  // A title page that is the cover (the front page is on) takes the Details; as a plain front-matter section it keeps its own title.
  const coverShown = Boolean(cover && options.frontPage)
  const base = cover ? { title: cover.title, body: cover.body, data: cover.data } : undefined
  // A cover's title is the export's one title (export-title.ts: Details, then title page, then manifest), so the
  // cover, the browser title and the file name never disagree.
  const coverParts = base ? (coverShown ? { ...coverWithDetails(base, details, chipFields), title } : base) : undefined
  // A cover drawn on the front page is outside the article the reader surfaces read; as a section it is inside.
  const readable = sections.filter((section) => section.place !== 'cover' || !options.frontPage)
  await write(input.target, assembleDocument({
    title,
    sections: contents,
    frontMatter: sections.filter((section) => section.place === 'front'),
    ...(coverParts ? { cover: coverParts } : {}),
    ...(!coverShown && folio ? (() => { const header = folioHeaderDetails(details, chipFields); return header ? { folioDetails: header } : {} })() : {}),
    // The contents sidebar and the summary tiles list the contents only.
    documents: contents.map((section) => section.data),
    ...(contentsRows ? { contentsRows } : {}),
    sidebar: options.sidebar,
    // A depth the writer chose to keep is used exactly (absent: Default). Otherwise the request's depth
    // wins; with none, the Folio's own (its Index Note's `toc_depth`).
    tocDepth: input.keepTocDepth ? options.tocDepth : options.tocDepth ?? (await folioTocDepth(workspace, input.dir)) ?? undefined,
    design: options.design,
    titleBlock: options.titleBlock,
    summaryTiles: options.summaryTiles,
    frontPage: options.frontPage,
    ...(options.readerNotes ? {
      readerNotes: {
        documentId: stableReaderDocumentId(input.dir, collection.name),
        targets: readable.flatMap((section) => section.interactionTargets),
      },
    } : {}),
    ...(options.readerEdits ? {
      readerEdits: {
        documentId: stableReaderDocumentId(input.dir, collection.name),
        targets: readable.flatMap((section) => section.interactionTargets),
      },
    } : {}),
  }))
  // Saved after the export is written, into the Index Note of the folder the export bundled.
  const tocDepthSave = input.keepTocDepth
    ? await saveExportTocDepth(workspace, { kind: 'folio', dir: input.dir }, options.tocDepth ?? null)
    : undefined
  return { target: input.target, format: 'html', ...pictureReport(missingImages, pictures), pieces: pieces.length, listed, ...(tocDepthSave ? { tocDepthSave } : {}) }
}

/** The name to open the save dialog with, for either scope. */
export async function suggestedName(
  workspace: Workspace,
  input: { scope: 'piece'; path: string; format: ExportFormat } | { scope: 'collection'; dir: string; format: ExportFormat },
): Promise<string> {
  if (input.scope === 'collection') {
    return exportFileName(await exportCollectionTitle(workspace, input.dir), input.format)
  }
  const { content } = await workspace.readFile(input.path)
  return exportFileName(exportDocumentTitle(content), input.format)
}
