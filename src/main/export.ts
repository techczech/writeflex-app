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
import { loadExportWidgets } from './widget-export'
import { writeFile } from 'node:fs/promises'
import { listCollection, documentWordCount, type CollectionRow } from './collection'
import { documentTitle, parseFrontmatter } from './frontmatter'
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
  type HtmlDocumentData,
  type HtmlDocumentDesign,
  type HtmlFrontmatterValue,
} from '../shared/markdown/html-document'
import { htmlOutline, toHtml } from '../shared/markdown/to-html'
import { docxBundleContent, docxContent, docxFile } from '../shared/markdown/to-docx'
import { readDocument, type MarkdownDocument } from '../shared/markdown/model'
import { externalLinksOnly } from '../shared/markdown/external-links'
import { frontmatterBlock } from '../shared/markdown/frontmatter'
import type { Workspace } from './workspace'

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
}

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

// What a piece is CALLED is answered by the frontmatter organ (documentTitle), because the Export
// sheet asks the same question on screen — and a title that disagrees with the file name offered in
// the save dialog is the writer noticing the app cannot keep its story straight.

/** A file name the save dialog can open with: the title, made safe for a file system. */
export function exportFileName(title: string, format: ExportFormat): string {
  const stem = title.replace(/[/\\:*?"<>|\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'export'
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
  idPrefix?: string
  frontmatterFields: readonly string[]
  metadata: HtmlDocumentData['metadata']
}): HtmlDocumentData {
  return {
    frontmatter: selectedFrontmatter(input.source, input.frontmatterFields),
    outline: htmlOutline(input.document, input.idPrefix),
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
  input: { path: string; format: ExportFormat; target: string; html?: HtmlExportOptions },
): Promise<ExportOutcome> {
  const { content, file } = await workspace.readFile(input.path)
  const document = readDocument(content)
  const title = documentTitle(content, input.path)
  const pictures = await loadPictures(workspace, document, input.path)
  if (input.format === 'html') {
    const options = input.html ?? {}
    const parsed = parseFrontmatter(content)
    const data = documentData({
      source: content,
      document,
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
    const { html, missingImages } = toHtml(content, {
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
      design: options.design,
      titleBlock: options.titleBlock,
      summaryTiles: options.summaryTiles,
      frontPage: options.frontPage,
      ...(options.readerNotes ? { readerNotes: { documentId: stableReaderDocumentId(input.path, title) } } : {}),
      ...(options.readerEdits ? { readerEdits: { documentId: stableReaderDocumentId(input.path, title) } } : {}),
    })
    await write(input.target, html)
    return { target: input.target, format: 'html', ...pictureReport(missingImages, pictures), pieces: 1, listed: 1 }
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

type BundlePiece = {
  path: string
  title: string
  source: string
  document: MarkdownDocument
  anchor: string
  data: HtmlDocumentData
}

/** The anchor a piece's section carries, and the id prefix its own headings and notes are namespaced
 *  with, so nine pieces in one file cannot collide. */
function sectionPrefix(index: number): string {
  return `p${index + 1}-`
}

/**
 * Export a whole Collection to `target`. The pieces are the Collection organ's own rows, in its own
 * order (ADR-0008), so the bundle matches what the Board and the Collection view show. A bundle of
 * one piece works and skips the contents list.
 */
export async function exportBundle(
  workspace: Workspace,
  input: { dir: string; format: ExportFormat; target: string; html?: HtmlExportOptions },
): Promise<ExportOutcome> {
  const collection = await listCollection(workspace, input.dir)
  const options = input.html ?? {}
  const pieces: BundlePiece[] = []
  // A Folio's HTML follows its manifest: the listed pieces inside its folder, in order. Entries that
  // are missing or point outside the folder are left out by folio.ts and never read here.
  const folio = input.format === 'html' ? await folioPieces(workspace, input.dir) : null
  const paths = folio ? folio.pieces : collection.rows.map(row => row.path)
  const listed = folio ? folio.pieces.length + folio.leftOut.length : paths.length
  const files = new Map((await workspace.listFiles()).map(file => [file.path, file]))
  for (const [index, path] of paths.entries()) {
    const row = collection.rows.find(row => row.path === path)
    const { content } = await workspace.readFile(path)
    const document = readDocument(content)
    const prefix = sectionPrefix(index)
    const title = row?.title?.trim() || documentTitle(content, path)
    const fm = parseFrontmatter(content)
    pieces.push({
      path,
      title,
      source: content,
      document,
      anchor: `${prefix}section`,
      data: documentData({
        source: content,
        document,
        idPrefix: prefix,
        frontmatterFields: options.frontmatterFields ?? DEFAULT_HTML_FRONTMATTER_FIELDS,
        metadata: rowMetadata(row ?? { purpose: fm?.purpose ?? null, status: fm?.status ?? 'unsorted', modified: files.get(path)!.modifiedAt, words: documentWordCount(content) }, title),
      }),
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
    await write(input.target, await docxFile(children, collection.name))
    return { target: input.target, format: 'docx', ...pictureReport(missed, pictures), pieces: pieces.length, listed }
  }

  // The link law. Targets are matched by the app's OWN rule (title → file name → alias), so a
  // wikilink resolves in the bundle exactly as it resolves in the editor.
  const candidates = await collectionCandidates(workspace, input.dir)
  const candidateIndex = buildWikilinkCandidateIndex(candidates)
  const anchors = new Map(pieces.map((piece) => [piece.path, piece.anchor]))
  const sections = await Promise.all(pieces.map(async (piece, index) => {
    const { html, missingImages: missed, interactionTargets } = toHtml(piece.source, {
      idPrefix: sectionPrefix(index),
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
    return { anchor: piece.anchor, title: piece.title, body: html, interactionTargets }
  }))
  await write(input.target, assembleDocument({
    title: collection.name,
    sections,
    documents: pieces.map((piece) => piece.data),
    sidebar: options.sidebar,
    design: options.design,
    titleBlock: options.titleBlock,
    summaryTiles: options.summaryTiles,
    frontPage: options.frontPage,
    ...(options.readerNotes ? {
      readerNotes: {
        documentId: stableReaderDocumentId(input.dir, collection.name),
        targets: sections.flatMap((section) => section.interactionTargets),
      },
    } : {}),
    ...(options.readerEdits ? {
      readerEdits: {
        documentId: stableReaderDocumentId(input.dir, collection.name),
        targets: sections.flatMap((section) => section.interactionTargets),
      },
    } : {}),
  }))
  return { target: input.target, format: 'html', ...pictureReport(missingImages, pictures), pieces: pieces.length, listed }
}

/** The name to open the save dialog with, for either scope. */
export async function suggestedName(
  workspace: Workspace,
  input: { scope: 'piece'; path: string; format: ExportFormat } | { scope: 'collection'; dir: string; format: ExportFormat },
): Promise<string> {
  if (input.scope === 'collection') {
    const collection = await listCollection(workspace, input.dir)
    return exportFileName(collection.name, input.format)
  }
  const { content } = await workspace.readFile(input.path)
  return exportFileName(documentTitle(content, input.path), input.format)
}
