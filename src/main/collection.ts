/**
 * The Collection organ (Task 23, ADR-0008). A folder is a Collection: its markdown pieces rendered as
 * a browsable, sortable metadata table under an optional Index-Note cover. READS the folder's pieces
 * (written and derived metadata, word count, modified time) and resolves the cover note. Writes remain
 * explicit: creating an Index Note, creating a Piece, or changing one Piece's status. Merely opening,
 * browsing, querying, or summoning a Collection never changes a file (ADR-0034).
 *
 * A Collection is a folder's OWN pieces — the direct children of `dir`, not a recursive subtree. `dir`
 * is a workspace-relative directory, `''` for the workspace root.
 */

import { basename, posix } from 'node:path'
import { stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { DEFAULT_PATTERN, frontmatterKeys, parseFrontmatter } from './frontmatter'
import type { Frontmatter } from './frontmatter'
import type { FileReadResult, Workspace } from './workspace'
import { isFolioAgentInstructionsFile, readManifest, resolveManifestFilePath } from './folio'
import { folioPartPaths } from './folio-part-set'
import { INDEX_NOTE_EXISTS, indexNoteCreationRefusal } from './folio-index-note'
import { partTitle } from '../shared/folio-part-title'
import { REFERENCE_STATUS_ORDER, UNSORTED_STATUS, type BoardStatus } from '../shared/collection-status'
import { setFrontmatterKeys } from './capabilities'
import type { VaultIndex, VaultWorkKind } from '../shared/vault-index'
import { FRONTMATTER_KEY_VALUE, frontmatterBlock } from '../shared/markdown/frontmatter'
import { stripFencedRegions } from '../shared/markdown/fences'
import { summariseTasks } from '../shared/markdown/task-lines'
import { isScrapsPath, scrapsInContent } from './scraps'
import { listingTitle } from '../shared/markdown/listing-title'
import { FACTS_READ_CONCURRENCY, factsReader, mapBounded, type FactsReader } from './file-facts'

export { REFERENCE_STATUS_ORDER } from '../shared/collection-status'

/** The cover derived from a folder's Index Note (or a README/index fallback). `path` opens it on Edit. */
export type CollectionCover = { text: string | null; source: string; path: string }

/** One piece in a Collection. `bare` = the file carries no frontmatter (bare files are welcome). */
export type CollectionRow = {
  path: string
  name: string
  title: string | null
  purpose: string | null
  status: string | null
  modified: number
  words: number
  /** Read-only view snapshot derived through the shared search-index facts cache. */
  searchText?: string
  tags?: string[]
  bare: boolean
  provenance: { title: MetadataProvenance; purpose: MetadataProvenance; status: MetadataProvenance }
  /** Present only when this row represents one folder-shaped work in the parent Collection. */
  folderPath?: string
  /** The folder's current projection, including selectable folders currently expanded as many Pieces. */
  folderPieceMode?: FolderPieceMode
}

/**
 * A direct subfolder of a Collection, listed in the Folder dashboard beside the pieces. `title` and `status` come
 * from the vault's work for that folder (null for a plain folder); `pieces` counts the Markdown files inside it
 * at any depth; `modified` is the newest of them (0 when empty).
 */
export type CollectionSubfolder = {
  path: string
  name: string
  title: string | null
  status: string | null
  work: VaultWorkKind | null
  pieces: number
  modified: number
}

/** A Collection: the folder's display name, its cover (null when the folder declares none), its pieces and subfolders. */
export type Collection = { name: string; cover: CollectionCover | null; rows: CollectionRow[]; subfolders: CollectionSubfolder[] }

/** What a vault tells the dashboard: its works (title, status) and its Writing only hidden set. */
export type CollectionVaultView = Pick<VaultIndex, 'works'> & { hidden: Pick<VaultIndex['hidden'], 'paths'> }

/**
 * The direct subfolders of `dir` the Folder dashboard lists. Pure: the caller hands in the folder list and the
 * Markdown files. Folders that already show as a piece row (`pieceFolders`) are left out; in a vault the Writing
 * only hidden set (housekeeping, agent and support folders) is left out, with everything under it.
 */
export function collectionSubfolders(
  dir: string,
  folders: readonly string[],
  files: ReadonlyArray<Pick<MarkdownFileLike, 'path' | 'name' | 'modifiedAt'>>,
  pieceFolders: ReadonlySet<string>,
  vault: CollectionVaultView | null,
): CollectionSubfolder[] {
  const hidden = vault ? vault.hidden.paths : []
  const works = new Map((vault?.works ?? []).map((work) => [work.path, work]))
  const hiddenPath = (path: string): boolean => hidden.some((h) => path === h || path.startsWith(`${h}/`))
  const direct = folders.filter((folder) => posix.dirname(folder) === (dir === '' ? '.' : dir) && !pieceFolders.has(folder) && !hiddenPath(folder))
  return direct.map((folder): CollectionSubfolder => {
    const inside = files.filter((file) => file.path.startsWith(`${folder}/`) && !INDEX_NOTE.test(file.name) && !hiddenPath(file.path))
    const work = works.get(folder)
    return {
      path: folder,
      name: basename(folder),
      title: work?.title ?? null,
      status: work ? work.status : null,
      work: work?.kind ?? null,
      pieces: inside.length,
      modified: inside.reduce((newest, file) => Math.max(newest, file.modifiedAt), 0),
    }
  }).sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name, undefined, { sensitivity: 'base', numeric: true }))
}

type MarkdownFileLike = { path: string; name: string; modifiedAt: number }

/** Auditable structural signals behind Collection detection (0.6 W1a). */
export type CollectionSignals = {
  frontmatterPattern: boolean
  frontmatterPieceCount: number
  indexNote: boolean
  indexSiblingLinkCount: number
  siblingWikilinks: boolean
  siblingWikilinkCount: number
}

/** Whether this folder's shape activates Collection affordances. */
export type CollectionStatus = { collection: boolean; signals: CollectionSignals; pieceCount: number }

export type MetadataProvenance = 'written' | 'derived'
export type PieceMetadata = {
  title: string
  date: string | null
  status: string
  purpose: string | null
  related: string[]
}

/** One Markdown Piece, its resolved metadata, per-field provenance, and file-derived facts. */
export type Piece = {
  path: string
  frontmatter: Frontmatter | null
  metadata: PieceMetadata
  provenance: Record<keyof PieceMetadata, MetadataProvenance>
  /** `scraps` is present only on a store-shaped `scraps/<origin>-SCRAPS.md` file: the scraps it holds,
   *  parsed from the bytes this read already has, so the Board's material needs no second read. */
  /** `tasks` is present only when the piece holds boxes: its open and ticked task items (the Board
   *  card's progress chip), counted from the same bytes. */
  derived: { words: number; mtime: number; gist: string; wikilinks: string[]; scraps?: Array<{ id: string; text: string; done: boolean }>; tasks?: { open: number; done: number } }
  /** Present only when this Piece represents one folder-shaped work in the parent Collection. */
  folderPath?: string
}

export type FolderPieceMode = 'one' | 'many'
type FolderPiece = { folderPath: string; mainDocumentPath: string; mode: FolderPieceMode }
export type UnresolvedFolderPiece = { folderPath: string; title: string }

/** The folder's observed Frontmatter Pattern, used by later capture paths and every projection. */
export type CollectionPattern = { keys: string[]; statuses: string[] }

/** Writer-owned Board move: one guarded workspace write, using the canonical metadata serialiser. */
export async function setCollectionPieceStatus(
  ws: Workspace,
  dir: string,
  path: string,
  status: BoardStatus,
) {
  const planned = await planCollectionPieceStatus(ws, dir, path, status)
  return planned.next === null ? planned.source : ws.saveFile(path, planned.next)
}

/** The piece as read and its text with the new status (`next` null when it already has it). Writes nothing. */
export async function planCollectionPieceStatus(
  ws: Workspace,
  dir: string,
  path: string,
  status: BoardStatus,
): Promise<{ source: FileReadResult; next: string | null }> {
  if (!isUnderDir(path, dir)) throw new Error('Collection Piece is outside its Collection.')
  const source = await ws.readFile(path)
  const currentStatus = parseFrontmatter(source.content)?.status?.trim() || UNSORTED_STATUS
  if (currentStatus.toLowerCase() === status.trim().toLowerCase()) return { source, next: null }
  const keys = await resolvedCollectionPattern(ws, dir, path)
  const frontmatter = parseFrontmatter(source.content)
  const existing = new Set(frontmatterKeys(source.content))
  const values: Record<string, string | string[]> = {}

  for (const key of keys) {
    if (key === 'title' || existing.has(key)) continue
    if (key === 'date') values.date = await creationDate(ws, path, true) ?? localCalendarDate()
    else if (key === 'related' || key === 'tags') values[key] = []
    else values[key] = ''
  }
  values.status = status === UNSORTED_STATUS ? '' : status
  return { source, next: setFrontmatterKeys(source.content, values, path) }
}

/** An Index Note filename: `_<name>_INDEX.md` (ADR-0008 — the explicit, third-party-legible marker). */
const INDEX_NOTE = /^_.+_INDEX\.md$/
const WIKILINK = /\[\[([^\]]+)\]\]/g

/** The folder's display name — its basename, or the workspace folder's name at the root. */
function displayName(ws: Workspace, dir: string): string {
  return dir === '' ? basename(ws.root) : basename(dir)
}

/** A workspace-relative path inside `dir` (or at the root when `dir` is ''). */
function inDir(dir: string, name: string): string {
  return dir === '' ? name : posix.join(dir, name)
}

/** Strip a leading UTF-8 BOM + a leading `---` fenced frontmatter block, leaving the prose body. Mirrors
 *  the frontmatter organ's fence rule so word counts and cover text ignore the metadata block. */
function bodyOf(text: string): string {
  const block = frontmatterBlock(text)
  return block ? text.slice(block.end) : text.replace(/^﻿/, '')
}

/** Approximate prose word count (whitespace-delimited tokens of the body). Good enough for the footer. */
function countWords(body: string): number {
  const trimmed = body.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length
}

/** A document's word count by the Digest's rule (frontmatter excluded), so every agent-facing count agrees. */
export function documentWordCount(content: string): number {
  return countWords(bodyOf(content))
}

/** Word count of a passage of body text by the same rule. */
export function passageWordCount(text: string): number {
  return countWords(text)
}

/** The Digest's fallback is the first prose line, not a heading or machine fence. */
function firstProseLine(body: string): string {
  return stripFencedRegions(body).split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && !/^#{1,6}\s/.test(line) && line !== '---') ?? ''
}

function firstAgentNoteProseLine(body: string): string {
  const lines = body.split(/\r?\n/)
  const settlement = lines.findIndex((line) => line.trim() === '## Settlement history')
  return firstProseLine((settlement < 0 ? lines : lines.slice(0, settlement)).join('\n'))
}

function wikilinkTargets(body: string): string[] {
  return [...stripFencedRegions(body).matchAll(/\[\[([^\]\n]+)\]\]/g)]
    .map((match) => match[1].split('|', 1)[0].split('#', 1)[0].trim())
    .filter(Boolean)
}

/** A structural tracker/index filename. Its links count only towards the stricter three-sibling
 *  index signal, not the ordinary sibling-to-sibling signal. */
function isTrackerName(name: string): boolean {
  const stem = name.replace(/\.(?:md|markdown|mdx)$/i, '')
  return stem.toLowerCase() === 'index' || /^0\s/.test(stem)
}

function linkedSiblingNames(text: string, siblingStems: Map<string, string>): string[] {
  const linked: string[] = []
  for (const match of text.matchAll(WIKILINK)) {
    const target = match[1].split('|', 1)[0].split('#', 1)[0].trim()
    if (target === '') continue
    const stem = posix.basename(target).replace(/\.(?:md|markdown|mdx)$/i, '').toLowerCase()
    const sibling = siblingStems.get(stem)
    if (sibling) linked.push(sibling)
  }
  return linked
}

/** Every folder of the workspace; a workspace without `listFolders` (a test double) is read off the file paths. */
async function listedFolderPaths(ws: Workspace, markdown: Awaited<ReturnType<Workspace['listFiles']>>): Promise<string[]> {
  if (typeof (ws as Workspace & { listFolders?: () => Promise<string[]> }).listFolders === 'function') return ws.listFolders()
  return [...new Set(markdown.flatMap((file) => {
    const folders: string[] = []
    const directory = file.directory ?? (posix.dirname(file.path) === '.' ? '' : posix.dirname(file.path))
    for (let cursor = directory; cursor !== ''; cursor = posix.dirname(cursor) === '.' ? '' : posix.dirname(cursor)) folders.push(cursor)
    return folders
  }))]
}

function isUnderDir(path: string, dir: string): boolean {
  if (dir === '') return !posix.isAbsolute(path) && !path.split('/').includes('..')
  const relative = posix.relative(posix.normalize(dir), posix.normalize(path))
  return relative !== '' && relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative)
}

/**
 * Whether `path` lies strictly inside one of `folders` (the folder itself is not inside it): the
 * `posix.relative(folder, path)` rule, answered by walking up the path's own ancestors and looking
 * each one up. A file × folder scan with `path.relative` was 12% of opening a large folder.
 */
function insideAnyFolder(path: string, folders: ReadonlySet<string>): boolean {
  if (folders.size === 0) return false
  const normalised = posix.normalize(path)
  if (normalised.startsWith('/') || normalised === '..' || normalised.startsWith('../')) {
    // Never a listing path; keep the one-by-one rule for it.
    for (const folder of folders) {
      const relative = posix.relative(posix.normalize(folder), normalised)
      if (relative !== '' && relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative)) return true
    }
    return false
  }
  for (let cut = normalised.lastIndexOf('/'); cut > 0; cut = normalised.lastIndexOf('/', cut - 1)) {
    if (folders.has(normalised.slice(0, cut))) return true
  }
  return false
}

/** The folder set `insideAnyFolder` looks up, each folder normalised as the relative rule normalises it. */
function folderSet(folders: Iterable<string>): Set<string> {
  const set = new Set<string>()
  for (const folder of folders) set.add(posix.normalize(folder).replace(/\/+$/, ''))
  return set
}

function directChildFolder(folderPath: string, dir: string): boolean {
  const parent = posix.dirname(folderPath)
  return (parent === '.' ? '' : parent) === dir
}

function indexNotePath(dir: string): string {
  return inDir(dir, `_${basename(dir)}_INDEX.md`)
}

async function folderPieceMode(ws: Workspace, folderPath: string, files: Set<string>): Promise<FolderPieceMode | null> {
  const path = indexNotePath(folderPath)
  if (!files.has(path)) return null
  const value = parseFrontmatter((await ws.readFile(path)).content)?.extra.piece
  const normalised = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return normalised === 'one' || normalised === 'many' ? normalised : null
}

function machineStubIndexNote(name: string, content: string): boolean {
  if (!INDEX_NOTE.test(name)) return false
  const pieceMode = parseFrontmatter(content)?.extra.piece
  if (typeof pieceMode !== 'string' || !['one', 'many'].includes(pieceMode.trim().toLowerCase())) return false
  const bodyLines = bodyOf(content).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return bodyLines.length === 0 || (bodyLines.length === 1 && /^#{1,6}\s+\S/.test(bodyLines[0]))
}

async function folderPieceMainDocument(
  ws: Workspace,
  folderPath: string,
  files: Set<string>,
  declaredCover: boolean,
): Promise<string | null> {
  const name = basename(folderPath)
  const folderNamed = inDir(folderPath, `${name}.md`)
  if (files.has(folderNamed)) return folderNamed

  const manifest = await readManifest(ws, folderPath)
  if (manifest) {
    // Manifest paths become workspace paths in one place (folio.ts), which refuses any that leave the folder.
    for (const entry of manifest.files) {
      const manifestMain = resolveManifestFilePath(folderPath, manifest, entry, files)
      if (manifestMain) return manifestMain
    }
  }

  const fallbacks = ['README.md', 'index.md'].map((candidate) => inDir(folderPath, candidate))
  const fallback = fallbacks.find((candidate) => files.has(candidate))
  if (fallback) return fallback

  // The two folder-cover conventions describe Collections by default. They become the main
  // document of one work only when the Index Note records an explicit one/many choice.
  if (!declaredCover) return null
  const shortCover = inDir(folderPath, `_${name}.md`)
  if (files.has(shortCover)) return shortCover

  const canonicalIndex = inDir(folderPath, `_${name}_INDEX.md`)
  if (files.has(canonicalIndex)) {
    const content = (await ws.readFile(canonicalIndex)).content
    if (!machineStubIndexNote(basename(canonicalIndex), content)) return canonicalIndex
  }
  return null
}

async function recognisedFolderPiece(
  ws: Workspace,
  folderPath: string,
  files: Set<string>,
  includeMany: boolean,
): Promise<FolderPiece | null> {
  const declaredMode = await folderPieceMode(ws, folderPath, files)
  const mainDocumentPath = await folderPieceMainDocument(ws, folderPath, files, declaredMode !== null)
  if (!mainDocumentPath) return null
  const mode = declaredMode ?? 'one'
  return mode === 'many' && !includeMany ? null : { folderPath, mainDocumentPath, mode }
}

async function recognisedFolderPieces(
  ws: Workspace,
  dir: string,
  directOnly = false,
  includeMany = false,
  listedMarkdown?: Awaited<ReturnType<Workspace['listFiles']>>,
): Promise<FolderPiece[]> {
  const markdown = listedMarkdown ?? await ws.listFiles()
  const files = new Set(markdown.map((file) => file.path))
  const listedFolders = await listedFolderPaths(ws, markdown)
  const folders = listedFolders
    .filter((folder) => directOnly ? directChildFolder(folder, dir) : isUnderDir(folder, dir))
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right))
  const recognised: FolderPiece[] = []
  const recognisedFolders = new Set<string>()
  for (const folderPath of folders) {
    if (insideAnyFolder(folderPath, recognisedFolders)) continue
    const piece = await recognisedFolderPiece(ws, folderPath, files, includeMany)
    if (piece) {
      recognised.push(piece)
      for (const folder of folderSet([piece.folderPath])) recognisedFolders.add(folder)
    }
  }
  return recognised
}

export function localCalendarDate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

async function creationDate(ws: Workspace, path: string, fallbackToday = false): Promise<string | null> {
  try {
    const facts = await stat(ws.absolute(path))
    const timestamp = facts.birthtimeMs > 0 ? facts.birthtimeMs : facts.mtimeMs > 0 ? facts.mtimeMs : Date.now()
    return localCalendarDate(new Date(timestamp))
  } catch {
    return fallbackToday ? localCalendarDate() : null
  }
}

/** The piece's boxes for its Board card, from bytes already read; nothing when it has none. */
function pieceTasks(content: string): { tasks?: { open: number; done: number } } {
  const { open, done } = summariseTasks(content)
  return open + done > 0 ? { tasks: { open, done } } : {}
}

/** What a Piece derives from its own text alone — memoised per (path, mtime, size) by the facts
 *  cache, so a rebuild after one save re-derives one file. */
type PieceTextFacts = {
  frontmatter: Frontmatter | null
  title: string
  gist: string
  words: number
  wikilinks: string[]
  scraps?: Array<{ id: string; text: string; done: boolean }>
  tasks?: { open: number; done: number }
}

function pieceTextFacts(content: string, path: string): PieceTextFacts {
  const frontmatter = parseFrontmatter(content)
  const agentNote = path.split('/').includes('agent-notes')
  const kind = typeof frontmatter?.extra.object_kind === 'string' ? frontmatter.extra.object_kind : ''
  const agentBody = bodyOf(content)
  const sourceHeading = agentBody.indexOf('## Object source')
  const agentSummaryRegion = agentNote ? (sourceHeading < 0 ? agentBody : agentBody.slice(0, sourceHeading)) : ''
  const agentSummary = /^#\s+(.+?)\s*$/m.exec(agentSummaryRegion)?.[1]?.trim() ?? ''
  const rawGist = frontmatter?.description?.trim()
    || (agentNote ? agentSummary || (kind ? `${kind} sketch` : firstAgentNoteProseLine(agentBody)) : firstProseLine(bodyOf(content)))
  const gist = rawGist.length <= 120 ? rawGist : `${rawGist.slice(0, 119)}…`
  return {
    frontmatter,
    title: listingTitle(content, path),
    gist,
    words: countWords(bodyOf(content)),
    wikilinks: wikilinkTargets(bodyOf(content)),
    ...(isScrapsPath(path) ? { scraps: scrapsInContent(content) } : {}),
    ...pieceTasks(content),
  }
}

async function pieceFromFile(
  ws: Workspace,
  file: Awaited<ReturnType<Workspace['listFiles']>>[number],
  folderPath?: string,
  folioPart = false,
  reader?: FactsReader,
): Promise<Piece> {
  const facts = await (reader ?? await factsReader(ws, [file])).read(file)
  const text = facts.derive('piece:text', (content) => pieceTextFacts(content, file.path))
  const { frontmatter } = text
  const writtenDate = frontmatter?.date?.trim()
  const writtenStatus = frontmatter?.status?.trim()
  const title = folioPart && !folderPath
    ? facts.derive('piece:part-title', (content) => partTitle(content, file.path).title)
    : folderPath ? facts.derive(`piece:title:${folderPath}`, (content) => listingTitle(content, folderPath)) : text.title
  return {
    path: file.path,
    frontmatter,
    metadata: {
      title,
      // The file's creation date is asked of the disk only when the piece writes no date, and once
      // per (path, mtime, size): a rename keeps it, a rewrite asks again.
      date: writtenDate || await facts.derive('piece:creation-date', () => creationDate(ws, file.path)),
      status: writtenStatus || UNSORTED_STATUS,
      purpose: frontmatter?.purpose ?? null,
      related: frontmatter?.related ?? [],
    },
    provenance: {
      title: 'derived',
      date: writtenDate ? 'written' : 'derived',
      status: writtenStatus ? 'written' : 'derived',
      purpose: frontmatter?.purpose?.trim() ? 'written' : 'derived',
      related: frontmatter?.related?.some((value) => value.trim()) ? 'written' : 'derived',
    },
    derived: {
      words: text.words,
      mtime: file.modifiedAt,
      gist: text.gist,
      wikilinks: [...text.wikilinks],
      ...(text.scraps ? { scraps: text.scraps.map((scrap) => ({ ...scrap })) } : {}),
      ...(text.tasks ? { tasks: { ...text.tasks } } : {}),
    },
    ...(folderPath ? { folderPath } : {}),
  }
}

/** Read the current recursive Piece population of a Collection. Bare Pieces are retained. */
export async function collectionPieces(ws: Workspace, dir: string): Promise<Piece[]> {
  const markdown = await ws.listFiles()
  // A Folio's agent instructions are never a piece: not on the Board, in a digest or in a word count.
  const files = markdown.filter((file) => isUnderDir(file.path, dir) && !isFolioAgentInstructionsFile(ws, file.path))
  const byPath = new Map(files.map((file) => [file.path, file]))
  const folderPieces = await recognisedFolderPieces(ws, dir, false, false, markdown)
  const mainDocuments = new Map(folderPieces.map((piece) => [piece.mainDocumentPath, piece.folderPath]))
  const hiddenFolders = folderSet(folderPieces.map((piece) => piece.folderPath))
  const visible = files.filter((file) => {
    if (mainDocuments.has(file.path)) return true
    if (insideAnyFolder(file.path, hiddenFolders)) return false
    return true
  })
  const parts = await folioPartPaths(ws, visible.map((file) => file.path))
  const reader = await factsReader(ws, visible, markdown)
  const pieces = await mapBounded(visible, FACTS_READ_CONCURRENCY, async (file) => {
    if (INDEX_NOTE.test(file.name)) {
      const facts = await reader.read(file)
      if (facts.derive('collection:machine-stub', (content) => machineStubIndexNote(file.name, content))) return null
    }
    return pieceFromFile(ws, byPath.get(file.path)!, mainDocuments.get(file.path), parts.has(file.path), reader)
  })
  return pieces.filter((piece): piece is Piece => piece !== null)
}

/** Declared one-work folders whose main document has vanished. They project as ordinary files again,
 * but the Rail keeps the broken structural promise visible until the writer repairs or flips it. */
export async function unresolvedFolderPieces(ws: Workspace, dir: string): Promise<UnresolvedFolderPiece[]> {
  const markdown = await ws.listFiles()
  const files = new Set(markdown.map((file) => file.path))
  const folders = (await ws.listFolders()).filter((folder) => isUnderDir(folder, dir)).sort()
  const unresolved: UnresolvedFolderPiece[] = []
  for (const folderPath of folders) {
    const indexPath = indexNotePath(folderPath)
    if (!files.has(indexPath)) continue
    const content = (await ws.readFile(indexPath)).content
    const mode = parseFrontmatter(content)?.extra.piece
    if (typeof mode !== 'string' || mode.trim().toLowerCase() !== 'one') continue
    if (await folderPieceMainDocument(ws, folderPath, files, true)) continue
    unresolved.push({ folderPath, title: listingTitle(content, folderPath) })
  }
  return unresolved
}

/** A Stub is a Piece whose stage-truth is `status: idea`. */
export function isStub(piece: Piece): boolean {
  return piece.frontmatter?.status?.trim().toLowerCase() === 'idea'
}

/** Derive the observed key/status vocabulary without writing or normalising any Piece. */
export async function collectionPattern(ws: Workspace, dir: string): Promise<CollectionPattern> {
  const name = displayName(ws, dir)
  const covers = new Set([`_${name}_INDEX.md`, `_${name}.md`, 'README.md', 'index.md'].map((candidate) => inDir(dir, candidate)))
  const markdown = await ws.listFiles()
  const folderPieces = await recognisedFolderPieces(ws, dir, true)
  const byPath = new Map(markdown.map((file) => [file.path, file]))
  const files = [
    ...markdown.filter((file) => file.directory === dir && !covers.has(file.path)),
    ...folderPieces.map((piece) => byPath.get(piece.mainDocumentPath)).filter((file): file is NonNullable<typeof file> => Boolean(file)),
  ]
  const keyCounts = new Map<string, number>()
  const keyOrder: string[] = []
  let frontmattered = 0
  const observedStatuses: string[] = []
  const reader = await factsReader(ws, files, markdown)
  for (const file of files) {
    const facts = await reader.read(file)
    const parsed = facts.derive('frontmatter', parseFrontmatter)
    if (parsed !== null) {
      frontmattered += 1
      for (const key of facts.derive('frontmatter:keys', frontmatterKeys)) {
        if (key === 'title') continue
        if (!keyCounts.has(key)) keyOrder.push(key)
        keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1)
      }
    }
    const status = parsed?.status?.trim()
    if (status && !observedStatuses.includes(status)) observedStatuses.push(status)
  }
  const keys = keyOrder.filter((key) => (keyCounts.get(key) ?? 0) > frontmattered / 2)
  const reference = new Map<string, number>(REFERENCE_STATUS_ORDER.map((status, index) => [status, index]))
  const statuses = observedStatuses
    .map((status, index) => ({ status, index, rank: reference.get(status.toLowerCase()) }))
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
    .map(({ status }) => status)
  return { keys, statuses }
}

/** Resolve the pattern used by a deliberate metadata write (ADR-0034). */
export async function resolvedCollectionPattern(ws: Workspace, dir: string, piecePath?: string): Promise<string[]> {
  const markdown = await ws.listFiles()
  const folderPiece = piecePath
    ? (await recognisedFolderPieces(ws, dir, false, false, markdown)).find((piece) => piece.mainDocumentPath === piecePath)
    : undefined
  const ownDir = folderPiece
    ? dir
    : piecePath ? (posix.dirname(piecePath) === '.' ? '' : posix.dirname(piecePath)) : dir
  const name = displayName(ws, ownDir)
  const candidates = [`_${name}_INDEX.md`, `_${name}.md`, 'README.md', 'index.md'].map((candidate) => inDir(ownDir, candidate))
  const files = new Set(markdown.map((file) => file.path))
  for (const path of candidates) {
    if (!files.has(path)) continue
    const declared = parseFrontmatter((await ws.readFile(path)).content)?.extra.pattern
    const columns = Array.isArray(declared)
      ? declared.map((column) => String(column).trim()).filter(Boolean)
      : typeof declared === 'string' && declared.trim() ? [declared.trim()] : []
    const withoutTitle = [...new Set(columns.filter((column) => column !== 'title'))]
    if (withoutTitle.length) return withoutTitle
  }

  const detected = (await collectionPattern(ws, ownDir)).keys
  return detected.length ? detected : [...DEFAULT_PATTERN].map(String)
}

/** Detect a Collection from direct-child Markdown structure. Detection is cheap and stateless: every
 *  call reads current Workspace bytes, while the main-process change channel tells consumers when to
 *  call again. A bare folder remains bare until one of the three documented signals crosses its
 *  threshold. */
export async function collectionStatus(ws: Workspace, dir: string): Promise<CollectionStatus> {
  const markdown = await ws.listFiles()
  const children = markdown.filter((file) => file.directory === dir)
  const siblingStems = new Map(children.map((file) => [file.name.replace(/\.(?:md|markdown|mdx)$/i, '').toLowerCase(), file.name]))
  let frontmatterPieceCount = 0
  let indexSiblingLinkCount = 0
  let siblingWikilinkCount = 0

  const reader = await factsReader(ws, children, markdown)
  for (const file of children) {
    const facts = await reader.read(file)
    const content = facts.content
    const frontmatter = facts.derive('frontmatter', parseFrontmatter)
    if (frontmatter && (
      frontmatter.status !== undefined
      || frontmatter.date !== undefined
      || frontmatter.tags !== undefined
      || frontmatter.description !== undefined
    )) frontmatterPieceCount += 1

    const siblings = linkedSiblingNames(content, siblingStems).filter((name) => name !== file.name)
    if (isTrackerName(file.name)) {
      indexSiblingLinkCount = Math.max(indexSiblingLinkCount, new Set(siblings).size)
    } else {
      siblingWikilinkCount += siblings.length
    }
  }

  const signals: CollectionSignals = {
    frontmatterPattern: frontmatterPieceCount >= 2,
    frontmatterPieceCount,
    indexNote: indexSiblingLinkCount >= 3,
    indexSiblingLinkCount,
    siblingWikilinks: siblingWikilinkCount > 0,
    siblingWikilinkCount,
  }
  return {
    collection: signals.frontmatterPattern || signals.indexNote || signals.siblingWikilinks,
    signals,
    pieceCount: children.length,
  }
}

/** A Markdown heading line (`## Running order`, a bare `#`): never part of the cover blurb. */
const HEADING_LINE = /^ {0,3}#{1,6}(?:\s|$)/
/** A setext heading's underline (CommonMark): `===` or `---`, up to three spaces in, nothing else on the line. */
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/

/**
 * The first prose paragraph after the H1 — the cover blurb. Null when there is no H1 or no paragraph. A heading
 * is not prose: one straight under the H1 (an Index Note whose next line is `## Running order`, or a setext
 * `Running order` over a `---` or `===` underline) gives no blurb, and an ATX heading ends the paragraph. Lines
 * that an underline turns into a setext heading are that heading, never the blurb.
 */
export function firstParagraphAfterH1(text: string): string | null {
  const lines = bodyOf(text).split(/\r?\n/)
  let i = lines.findIndex((l) => /^#\s+\S/.test(l))
  if (i === -1) return null
  i += 1
  while (i < lines.length && lines[i].trim() === '') i += 1 // skip blank lines under the H1
  const paragraph: string[] = []
  while (i < lines.length && lines[i].trim() !== '' && !HEADING_LINE.test(lines[i])) {
    // An underline straight under paragraph lines makes them a setext heading (CommonMark): no blurb.
    if (paragraph.length > 0 && SETEXT_UNDERLINE.test(lines[i])) return null
    paragraph.push(lines[i].trim())
    i += 1
  }
  return paragraph.length ? paragraph.join(' ') : null
}

/**
 * Read a folder as a Collection: resolve its cover Index Note and build a metadata row per piece.
 * Cover resolution order (ADR-0008): `_<name>_INDEX.md` → `_<name>.md` → `README.md` → `index.md`.
 * The resolved cover file and every Index-Note-named file are excluded from the rows (they are chrome,
 * not pieces). Bare files (no frontmatter) appear with null columns and `bare: true`.
 */
export async function listCollection(ws: Workspace, dir: string, vault: CollectionVaultView | null = null, options: { includeSearchText?: boolean } = {}): Promise<Collection> {
  const name = displayName(ws, dir)
  const markdown = await ws.listFiles()
  const children = markdown.filter((f) => f.directory === dir)
  const byPath = new Map(markdown.map((f) => [f.path, f]))

  const candidates = [`_${name}_INDEX.md`, `_${name}.md`, 'README.md', 'index.md'].map((n) => inDir(dir, n))
  let cover: CollectionCover | null = null
  let coverPath: string | null = null
  for (const path of candidates) {
    const file = byPath.get(path)
    if (!file) continue
    const { content } = await ws.readFile(path)
    cover = { text: firstParagraphAfterH1(content), source: file.name, path }
    coverPath = path
    break
  }

  const rows: CollectionRow[] = []
  const folioParts = await folioPartPaths(ws, children.map((file) => file.path))
  const reader = await factsReader(ws, children, markdown)
  for (const file of children) {
    if (file.path === coverPath || INDEX_NOTE.test(file.name) || file.name === `_${name}.md`) continue
    if (isFolioAgentInstructionsFile(ws, file.path)) continue // a Folio's agent instructions are never a piece
    const facts = await reader.read(file)
    const text = facts.derive('piece:text', (content) => pieceTextFacts(content, file.path))
    const fm = text.frontmatter
    rows.push({
      path: file.path,
      name: file.name,
      title: folioParts.has(file.path) ? facts.derive('piece:part-title', (content) => partTitle(content, file.path).title) : text.title,
      purpose: fm?.purpose ?? null,
      status: fm?.status?.trim() || UNSORTED_STATUS,
      modified: file.modifiedAt,
      words: text.words,
      ...(options.includeSearchText ? { searchText: facts.derive('collection:search-text', bodyOf) } : {}),
      tags: fm?.tags ?? [],
      bare: fm === null,
      provenance: {
        title: 'derived',
        purpose: fm?.purpose?.trim() ? 'written' : 'derived',
        status: fm?.status?.trim() ? 'written' : 'derived',
      },
    })
  }
  for (const folderPiece of await recognisedFolderPieces(ws, dir, true, true, markdown)) {
    const file = byPath.get(folderPiece.mainDocumentPath)
    if (!file) continue
    const piece = await pieceFromFile(ws, file, folderPiece.folderPath, false, reader)
    rows.push({
      path: piece.path,
      name: basename(folderPiece.folderPath),
      title: piece.metadata.title,
      purpose: piece.metadata.purpose,
      status: piece.metadata.status,
      modified: piece.derived.mtime,
      words: piece.derived.words,
      ...(options.includeSearchText ? { searchText: (await reader.read(file)).derive('collection:search-text', bodyOf) } : {}),
      tags: piece.frontmatter?.tags ?? [],
      bare: piece.frontmatter === null,
      provenance: {
        title: piece.provenance.title,
        purpose: piece.provenance.purpose,
        status: piece.provenance.status,
      },
      folderPath: folderPiece.folderPath,
      folderPieceMode: folderPiece.mode,
    })
  }
  const pieceFolders = new Set(rows.flatMap((row) => (row.folderPath ? [row.folderPath] : [])))
  const folders = await listedFolderPaths(ws, markdown)
  const subfolders = collectionSubfolders(dir, folders, markdown.filter((file) => !isFolioAgentInstructionsFile(ws, file.path)), pieceFolders, vault)
  return { name, cover, rows, subfolders }
}

/**
 * Create the folder's Index Note — `_<name>_INDEX.md` holding just `# <name>\n\n` — and return its
 * workspace-relative path. THE one sanctioned creation of an Index Note file, for every caller (the Folio page's
 * Start, `collection:create-index`, an agent's running-order proposal, a counted diary, a Folder Piece's mode):
 * the ownership rule (folio-index-note.ts `indexNoteCreationRefusal`) is applied here, so no caller can skip it.
 * Refused, with nothing written, when the folder's Index Note is there or the folder is inside another Folio.
 * Only when absent: Workspace.createFile throws if the file already exists, enforcing it atomically.
 * (A Folio page edit on a Folio with no Index Note writes the file through the Plan write instead, after the same
 * refusal: plan.ts `commitPlanDocuments`.)
 */
export async function createIndexNote(ws: Workspace, dir: string): Promise<string> {
  const refusal = await indexNoteCreationRefusal(ws, dir)
  if (refusal) throw new Error(refusal)
  const name = displayName(ws, dir)
  const path = inDir(dir, `_${name}_INDEX.md`)
  try {
    const { file } = await ws.createFile(path, indexNoteStarterText(ws, dir))
    return file.path
  } catch (error) {
    // Created by someone else between the check and the exclusive create: still the same refusal, nothing written.
    if (existsSync(ws.absolute(path))) throw new Error(INDEX_NOTE_EXISTS(basename(path)))
    throw error
  }
}

/** What `createIndexNote` writes: `# <name>` and a blank line. The Folio page reads a Folio with no Index Note yet as this text (plan.ts `readFolioPlan`). */
export function indexNoteStarterText(ws: Pick<Workspace, 'root'>, dir: string): string {
  return `# ${dir === '' ? basename(ws.root) : basename(dir)}\n\n`
}

/** Persist a writer's one-work/many-files decision in the folder's canonical Index Note. */
export async function setCollectionPieceMode(
  ws: Workspace,
  dir: string,
  folderPath: string,
  mode: FolderPieceMode,
) {
  if (!isUnderDir(folderPath, dir) || !(await ws.listFolders()).includes(folderPath)) {
    throw new Error('Folder Piece is outside its Collection.')
  }
  const path = indexNotePath(folderPath)
  const files = new Set((await ws.listFiles()).map((file) => file.path))
  if (!files.has(path)) await createIndexNote(ws, folderPath)
  const source = await ws.readFile(path)
  return ws.saveFile(path, setFrontmatterKeys(source.content, { piece: mode }, path))
}

/**
 * Create a new blank piece INSIDE the collection folder (`file:create` slugifies paths to the root, so
 * it cannot place a piece in a subfolder — this is the folder-aware creator). Picks the first free
 * `untitled`, `untitled-2`, … name and returns its workspace-relative path.
 */
export async function createPiece(ws: Workspace, dir: string): Promise<string> {
  const taken = new Set((await ws.listFiles()).filter((f) => f.directory === dir).map((f) => f.name))
  let candidate = 'untitled.md'
  for (let n = 2; taken.has(candidate); n += 1) candidate = `untitled-${n}.md`
  const keys = await resolvedCollectionPattern(ws, dir)
  const values: Record<string, string | string[]> = {}
  for (const key of keys) {
    if (key === 'title') continue
    if (key === 'date') values.date = localCalendarDate()
    else if (key === 'status') values.status = ''
    else if (key === 'related' || key === 'tags') values[key] = []
    else values[key] = ''
  }
  if (!Object.hasOwn(values, 'status')) values.status = ''
  const content = setFrontmatterKeys('# untitled\n\n', values, inDir(dir, candidate))
  const { file } = await ws.createFile(inDir(dir, candidate), content)
  return file.path
}

/** Explicit user tag action; browsing and filtering never call this writer. */
export async function addCollectionPieceTags(ws: Workspace, dir: string, path: string, tags: string[]) {
  if (!isUnderDir(path, dir)) throw new Error('Collection Piece is outside its Collection.')
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 128 || /[\r\n]/.test(tag))) throw new Error('Use short tags without line breaks.')
  const source = await ws.readFile(path)
  const parsedTags = parseFrontmatter(source.content)?.tags ?? []
  // The typed reader promotes scalars to lists. Inspect only the tags key's authored shape,
  // then split its already-unquoted value; other frontmatter may contain block lists.
  const lines = frontmatterBlock(source.content)?.lines ?? []
  let rawTags: string | undefined
  for (let index = 0; index < lines.length; index++) {
    const match = FRONTMATTER_KEY_VALUE.exec(lines[index])
    if (match?.[1] !== 'tags') continue
    // Empty duplicate list keys do not replace the typed parser's previous value.
    let end = index + 1
    while (end < lines.length && /^\s+-\s/.test(lines[end])) end++
    if (parseFrontmatter(`---\n${lines.slice(index, end).join('\n')}\n---\n`)?.tags) rawTags = match[2].trim()
  }
  const scalarTags = Boolean(rawTags && !(rawTags.startsWith('[') && rawTags.endsWith(']')))
  const existing = scalarTags
    ? parsedTags.flatMap(value => value.split(',')).map(tag => tag.trim()).filter(Boolean)
    : parsedTags
  const next = [...new Set([...existing, ...tags.map(tag => tag.trim())])]
  if (next.length === new Set(existing).size) return source
  return ws.saveFile(path, setFrontmatterKeys(source.content, { tags: next }, path))
}

/** Discover once for a bulk move, shared by both preflight and the exclusive rename turn. */
export async function collectionMoveFolderPieces(ws: Workspace, dir: string): Promise<ReadonlySet<string>> {
  return new Set((await recognisedFolderPieces(ws, dir, true, true)).map(piece => piece.mainDocumentPath))
}

/** Collection bulk moves never create folders or detach a folder piece's main document. */
export async function assertCollectionMove(ws: Workspace, dir: string, path: string, newPath: string,
  folderPieces: () => Promise<ReadonlySet<string>> = () => collectionMoveFolderPieces(ws, dir),
): Promise<void> {
  if (!isUnderDir(path, dir)) throw new Error('The selected document is outside this collection.')
  const destination = posix.dirname(newPath)
  const folder = destination === '.' ? '' : destination
  if ((folder && ws.classifyPath(folder, 'folder') !== 'document')
    || ws.classifyPath(newPath) !== 'document'
    || !(await stat(folder ? ws.absolute(folder) : ws.root).catch(() => null))?.isDirectory()) {
    throw new Error('Choose an existing visible folder inside this workspace.')
  }
  const pieces = await folderPieces()
  if (pieces.has(path)) {
    throw new Error('Move folder pieces from Files so all their documents move together.')
  }
}
