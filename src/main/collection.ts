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
import { DEFAULT_PATTERN, documentTitle, frontmatterKeys, parseFrontmatter } from './frontmatter'
import type { Frontmatter } from './frontmatter'
import type { Workspace } from './workspace'
import { readManifest, resolveManifestFilePath } from './folio'
import { REFERENCE_STATUS_ORDER, UNSORTED_STATUS, type BoardStatus } from '../shared/collection-status'
import { setFrontmatterKeys } from './capabilities'
import { frontmatterBlock } from '../shared/markdown/frontmatter'
import { stripFencedRegions } from '../shared/markdown/fences'
import { summariseTasks } from '../shared/markdown/task-lines'
import { isScrapsPath, scrapsInContent } from './scraps'

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
  bare: boolean
  provenance: { title: MetadataProvenance; purpose: MetadataProvenance; status: MetadataProvenance }
  /** Present only when this row represents one folder-shaped work in the parent Collection. */
  folderPath?: string
  /** The folder's current projection, including selectable folders currently expanded as many Pieces. */
  folderPieceMode?: FolderPieceMode
}

/** A Collection: the folder's display name, its cover (null when the folder declares none), its pieces. */
export type Collection = { name: string; cover: CollectionCover | null; rows: CollectionRow[] }

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
  if (!isUnderDir(path, dir)) throw new Error('Collection Piece is outside its Collection.')
  const source = await ws.readFile(path)
  const currentStatus = parseFrontmatter(source.content)?.status?.trim() || UNSORTED_STATUS
  if (currentStatus.toLowerCase() === status.trim().toLowerCase()) return source
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
  return ws.saveFile(path, setFrontmatterKeys(source.content, values, path))
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

function isUnderDir(path: string, dir: string): boolean {
  if (dir === '') return !posix.isAbsolute(path) && !path.split('/').includes('..')
  const relative = posix.relative(posix.normalize(dir), posix.normalize(path))
  return relative !== '' && relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative)
}

function isInsideFolder(path: string, folderPath: string): boolean {
  const relative = posix.relative(posix.normalize(folderPath), posix.normalize(path))
  return relative !== '' && relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative)
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
  const listedFolders = typeof (ws as Workspace & { listFolders?: () => Promise<string[]> }).listFolders === 'function'
    ? await ws.listFolders()
    : [...new Set(markdown.flatMap((file) => {
      const folders: string[] = []
      const directory = file.directory ?? (posix.dirname(file.path) === '.' ? '' : posix.dirname(file.path))
      for (let cursor = directory; cursor !== ''; cursor = posix.dirname(cursor) === '.' ? '' : posix.dirname(cursor)) folders.push(cursor)
      return folders
    }))]
  const folders = listedFolders
    .filter((folder) => directOnly ? directChildFolder(folder, dir) : isUnderDir(folder, dir))
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right))
  const recognised: FolderPiece[] = []
  for (const folderPath of folders) {
    if (recognised.some((piece) => isInsideFolder(folderPath, piece.folderPath))) continue
    const piece = await recognisedFolderPiece(ws, folderPath, files, includeMany)
    if (piece) recognised.push(piece)
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

async function pieceFromFile(ws: Workspace, file: Awaited<ReturnType<Workspace['listFiles']>>[number], folderPath?: string): Promise<Piece> {
  const { content } = await ws.readFile(file.path)
  const frontmatter = parseFrontmatter(content)
  const writtenDate = frontmatter?.date?.trim()
  const writtenStatus = frontmatter?.status?.trim()
  const agentNote = file.path.split('/').includes('agent-notes')
  const kind = typeof frontmatter?.extra.object_kind === 'string' ? frontmatter.extra.object_kind : ''
  const agentBody = bodyOf(content)
  const sourceHeading = agentBody.indexOf('## Object source')
  const agentSummaryRegion = agentNote ? (sourceHeading < 0 ? agentBody : agentBody.slice(0, sourceHeading)) : ''
  const agentSummary = /^#\s+(.+?)\s*$/m.exec(agentSummaryRegion)?.[1]?.trim() ?? ''
  const rawGist = frontmatter?.description?.trim()
    || (agentNote ? agentSummary || (kind ? `${kind} sketch` : firstAgentNoteProseLine(agentBody)) : firstProseLine(bodyOf(content)))
  const gist = rawGist.length <= 120 ? rawGist : `${rawGist.slice(0, 119)}…`
  return {
    path: file.path,
    frontmatter,
    metadata: {
      title: folderPath ? documentTitle(content, folderPath) : documentTitle(content, file.path),
      date: writtenDate || await creationDate(ws, file.path),
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
      words: countWords(bodyOf(content)),
      mtime: file.modifiedAt,
      gist,
      wikilinks: wikilinkTargets(bodyOf(content)),
      ...(isScrapsPath(file.path) ? { scraps: scrapsInContent(content) } : {}),
      ...pieceTasks(content),
    },
    ...(folderPath ? { folderPath } : {}),
  }
}

/** Read the current recursive Piece population of a Collection. Bare Pieces are retained. */
export async function collectionPieces(ws: Workspace, dir: string): Promise<Piece[]> {
  const markdown = await ws.listFiles()
  const files = markdown.filter((file) => isUnderDir(file.path, dir))
  const byPath = new Map(files.map((file) => [file.path, file]))
  const folderPieces = await recognisedFolderPieces(ws, dir, false, false, markdown)
  const mainDocuments = new Map(folderPieces.map((piece) => [piece.mainDocumentPath, piece.folderPath]))
  const hiddenFolders = folderPieces.map((piece) => piece.folderPath)
  const visible = files.filter((file) => {
    if (mainDocuments.has(file.path)) return true
    if (hiddenFolders.some((folderPath) => isInsideFolder(file.path, folderPath))) return false
    return true
  })
  const pieces = await Promise.all(visible.map(async (file) => {
    if (INDEX_NOTE.test(file.name) && machineStubIndexNote(file.name, (await ws.readFile(file.path)).content)) return null
    return pieceFromFile(ws, byPath.get(file.path)!, mainDocuments.get(file.path))
  }))
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
    unresolved.push({ folderPath, title: documentTitle(content, folderPath) })
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
  for (const file of files) {
    const { content } = await ws.readFile(file.path)
    const parsed = parseFrontmatter(content)
    if (parsed !== null) {
      frontmattered += 1
      for (const key of frontmatterKeys(content)) {
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
  const children = (await ws.listFiles()).filter((file) => file.directory === dir)
  const siblingStems = new Map(children.map((file) => [file.name.replace(/\.(?:md|markdown|mdx)$/i, '').toLowerCase(), file.name]))
  let frontmatterPieceCount = 0
  let indexSiblingLinkCount = 0
  let siblingWikilinkCount = 0

  for (const file of children) {
    const { content } = await ws.readFile(file.path)
    const frontmatter = parseFrontmatter(content)
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

/** The first prose paragraph after the H1 — the cover blurb. Null when there is no H1 or no paragraph. */
function firstParagraphAfterH1(text: string): string | null {
  const lines = bodyOf(text).split(/\r?\n/)
  let i = lines.findIndex((l) => /^#\s+\S/.test(l))
  if (i === -1) return null
  i += 1
  while (i < lines.length && lines[i].trim() === '') i += 1 // skip blank lines under the H1
  const paragraph: string[] = []
  while (i < lines.length && lines[i].trim() !== '') {
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
export async function listCollection(ws: Workspace, dir: string): Promise<Collection> {
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
  for (const file of children) {
    if (file.path === coverPath || INDEX_NOTE.test(file.name) || file.name === `_${name}.md`) continue
    const { content } = await ws.readFile(file.path)
    const fm = parseFrontmatter(content)
    rows.push({
      path: file.path,
      name: file.name,
      title: documentTitle(content, file.path),
      purpose: fm?.purpose ?? null,
      status: fm?.status?.trim() || UNSORTED_STATUS,
      modified: file.modifiedAt,
      words: countWords(bodyOf(content)),
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
    const piece = await pieceFromFile(ws, file, folderPiece.folderPath)
    rows.push({
      path: piece.path,
      name: basename(folderPiece.folderPath),
      title: piece.metadata.title,
      purpose: piece.metadata.purpose,
      status: piece.metadata.status,
      modified: piece.derived.mtime,
      words: piece.derived.words,
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
  return { name, cover, rows }
}

/**
 * Create the folder's Index Note — `_<name>_INDEX.md` holding just `# <name>\n\n` — and return its
 * workspace-relative path. THE one sanctioned Index-Note write: user-initiated, and only when absent
 * (Workspace.createFile throws if the file already exists, enforcing "only when absent" atomically).
 */
export async function createIndexNote(ws: Workspace, dir: string): Promise<string> {
  const name = displayName(ws, dir)
  const path = inDir(dir, `_${name}_INDEX.md`)
  const { file } = await ws.createFile(path, `# ${name}\n\n`)
  return file.path
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
