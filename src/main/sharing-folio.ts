// A Folio as it is published to a link (sharing ticket 09; spec sections 4.2, 6.1 rows "Folio part …",
// 8 "What is published").
//
// The running order is the Folio's own (folio.ts, the rule folio-place.ts and the export read): the
// manifest's entries in order, each resolved inside the Folio's folder; without a manifest, a folder
// whose Index Note declares a running order, in the fallback order. A part listed twice keeps its first
// place (folio-place.ts uniquePieces). An entry that is not on disk stays in its place as a missing
// part: the reader page shows its title (from its file name, as the app names a part with no heading)
// with "not available", and the rest is published (6.1 "Folio part missing on disk"). An entry the
// Folio never reads (outside its folder, agent instructions) and a file that is not a writer's piece
// (an Agent note, anything in a dot-folder: sharing-piece-ipc.ts isSharablePiece) are left out and
// never read.
//
// Each part is the piece rendering (sharing-render.ts renderPieceForSharing) and so keeps every rule a
// shared piece keeps: hidden comments gone (a byte-order mark included), widgets "Interactive part not
// shared", local links lose their destinations, pictures from other sites through the address guard.
// As in the export's Folio rendering (export.ts exportBundle), each part's ids carry a prefix and its
// headings sit one level under the part title. The prefix is the part's KEY: a short random name kept
// per link and per part file (ShareRecord.partKeys), never derived from the path, so it names nothing
// on this Mac, stays the same when the running order changes, and a note's block hint (`id:<key>-…`,
// the reader page's anchoring) says which part the note was written on (ticket 07 routes by it).
//
// The Folio's title and chips come from its Index Note (its title, and the Date, Status and Author of
// its frontmatter, read as the piece rendering reads a piece: hidden comments first). Without a title
// there, the title is "Folio": never a folder's name (spec section 8: not the file path, not the
// collection name; review round 1, finding 1). The Index Note is read only when where it really lives
// passes the rules a part passes: inside the Folio's folder once links are resolved, no dot-folder and
// no `agent-notes` on the way (review round 1, finding 2); otherwise the Folio publishes without it
// (the neutral title, no chips). Nothing else of the Index Note is published.
//
// The Folio's manifest, and the Index Note where it decides whether a folder without a manifest is a
// Folio, are read only when the one source rule allows it (sharing-source-eligibility.ts
// isEligibleFolioMetadata; Sol review round 4 of ticket 11, P1-2). One that is there but fails it (a link
// to `.bridle/…`, to `agent-notes/…`, or under a linked folder that leads into one) is never read: the
// folder is no Folio for sharing (isFolio), and publishing it stops as a Folio that cannot be read
// (renderFolioLink throws; the publisher's "could not read" problem, readers' copy kept), so nothing
// of it, not even the file names a manifest lists, reaches the page.
//
// No Electron import.
import { randomBytes } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, posix, relative, sep } from 'node:path'
import {
  fallbackFolioParts, indexNotePath, manifestEntryPointsOutsideFolio, manifestFilePathCandidates, readManifest, resolveManifestFilePath,
} from './folio'
import { normalisedFolioDir } from './folio-dir'
import { indexDeclaresPlan } from './folio-place'
import { parseFrontmatter } from './frontmatter'
import { isEligibleFolioMetadata, isEligiblePiece, isSharablePiece } from './sharing-source-eligibility'
import { chipsOf, oneLine, renderPieceForSharing, withoutHiddenComments, type RenderedPiece, type RemotePictureFetch, type SharedPicture } from './sharing-render'
import { Workspace } from './workspace'
import { isAgentInstructionsName } from '../shared/folio-agent-files'
import { MANIFEST_NAME } from '../shared/folio-constants'
import { firstBodyHeading, titleFromFileName } from '../shared/folio-part-title'
import { uniquePieces } from '../shared/folio-place'
import { SHARE_LIMITS } from '../../sharing-service/share-protocol.ts'

/** One place in the running order: a part on disk, or one the manifest lists that is not there. */
export type FolioEntry = { path: string; missing: boolean }

/** A part as published: its key (the id prefix), its title, and its text unless it is missing on disk. */
export type RenderedFolioPart = {
  path: string
  key: string
  title: string
  missing: boolean
  html: string | null
  headings: { id: string; text: string }[]
}

export type RenderedFolio = {
  title: string
  chips: { label: string; value: string }[]
  /** The latest save among the parts, the manifest and the Index Note (ms). */
  savedAt: number
  parts: RenderedFolioPart[]
  /** Every picture the parts show, by name, each once. */
  pictures: SharedPicture[]
  refusedPictures: number
}

/** A part key: a letter and five more, lower case (it starts every id in the part, so it starts with a letter). */
export const PART_KEY = /^[a-z][a-z0-9]{5}$/

function newPartKey(taken: ReadonlySet<string>): string {
  for (;;) {
    const bytes = randomBytes(6)
    const key = String.fromCharCode(97 + (bytes[0] % 26)) + [...bytes.subarray(1)].map((byte) => (byte % 36).toString(36)).join('')
    if (!taken.has(key)) return key
  }
}

/**
 * A Folio folder a window may name: relative, inside its Workspace, no dot-folder and no `agent-notes`
 * on the way, in the one spelling (folio-dir.ts). '' is the Workspace itself. Null otherwise.
 */
export function folioDirPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || isAbsolute(value)) return null
  const dir = normalisedFolioDir(value)
  if (dir === '..' || dir.startsWith('../') || posix.isAbsolute(dir)) return null
  if (dir !== '' && dir.split('/').some((segment) => segment.startsWith('.') || segment === 'agent-notes')) return null
  return dir
}

/** A path that could hold a writer's piece: nothing in a dot-folder or in `agent-notes` (sharing-source-eligibility.ts). */
const writersPlace = (path: string): boolean => !path.split('/').some((segment) => segment.startsWith('.') || segment === 'agent-notes')

/** A Folio metadata file that is there but that the source rule does not let sharing read. */
class FolioMetadataRefused extends Error {
  constructor() { super('WriteFlex could not read this Folio to publish it.') }
}

/** Whether the metadata file at `path` may be read: false when nothing is there, true when it may, throws when it may not. */
function metadataReadable(root: string, path: string): boolean {
  // lstat: a link at the path (dangling or not) is there, and is judged.
  try { lstatSync(join(root, path)) } catch { return false }
  if (!isEligibleFolioMetadata(root, path)) throw new FolioMetadataRefused()
  return true
}

/** The manifest (folio.ts readManifest), read only when the source rule allows it. Throws FolioMetadataRefused. */
async function sharedManifest(ws: Workspace, root: string, dir: string): ReturnType<typeof readManifest> {
  return metadataReadable(root, posix.join(dir, MANIFEST_NAME)) ? readManifest(ws, dir) : null
}

/** Whether the Index Note declares a running order (folio-place.ts), read only when the source rule allows it. Throws FolioMetadataRefused. */
async function sharedIndexDeclaresPlan(ws: Workspace, root: string, dir: string): Promise<boolean> {
  return metadataReadable(root, indexNotePath(ws, dir)) ? indexDeclaresPlan(ws, dir) : false
}

/** Whether `dir` is a Folio: it has a manifest, or its Index Note declares a running order (folio-place.ts). */
export async function isFolio(root: string, dir: string): Promise<boolean> {
  const ws = new Workspace(root)
  try {
    if (await sharedManifest(ws, root, dir)) return true
    return await sharedIndexDeclaresPlan(ws, root, dir)
  } catch {
    return false
  }
}

/**
 * The Folio's running order, with the parts missing on disk in their places. Null when `dir` is no Folio.
 * Throws when its manifest or Index Note is there but may not be read (FolioMetadataRefused).
 */
export async function folioRunningOrder(root: string, dir: string): Promise<FolioEntry[] | null> {
  const ws = new Workspace(root)
  const manifest = await sharedManifest(ws, root, dir)
  let entries: FolioEntry[]
  if (manifest) {
    const present = new Set((await ws.listFilesIn(dir)).map((file) => file.path))
    entries = manifest.files.flatMap((file): FolioEntry[] => {
      if (manifestEntryPointsOutsideFolio(dir, manifest, file)) return []
      const path = resolveManifestFilePath(dir, manifest, file, present)
      if (path) return isAgentInstructionsName(path) ? [] : [{ path, missing: false }]
      // Not on disk: its place, where the manifest's first reading of it would put it (content_root first).
      const place = manifestFilePathCandidates(dir, manifest, file)[0]
      if (!place || isAgentInstructionsName(place) || !writersPlace(place)) return []
      return [{ path: place, missing: true }]
    })
  } else if (await sharedIndexDeclaresPlan(ws, root, dir)) {
    entries = (await fallbackFolioParts(ws, dir)).map((path) => ({ path, missing: false }))
  } else {
    return null
  }
  const first = new Set(uniquePieces(entries.map((entry) => entry.path)))
  return entries.filter((entry) => {
    if (!first.delete(entry.path)) return false
    // Only a writer's piece is ever read (no Agent note, nothing in a dot-folder). A missing part is not read.
    return entry.missing || isSharablePiece(root, entry.path)
  })
}

/** The keys this link's parts publish under: the ones kept for each part file, a new one for a new part. */
export function partKeysFor(entries: readonly FolioEntry[], kept: Readonly<Record<string, string>>): Record<string, string> {
  const taken = new Set(Object.values(kept))
  const keys: Record<string, string> = {}
  for (const entry of entries) {
    const key = kept[entry.path]
    if (typeof key === 'string' && PART_KEY.test(key)) { keys[entry.path] = key; continue }
    const fresh = newPartKey(taken)
    taken.add(fresh)
    keys[entry.path] = fresh
  }
  return keys
}

/** The published title of a Folio whose Index Note gives none: never a folder's name (review round 1, finding 1). */
export const FOLIO_TITLE = 'Folio'

/** `rel` (a path from one real location to another) stays inside the first one. */
const staysInside = (rel: string): boolean => rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)

/**
 * Whether the Index Note at `path` may be read for publishing (review round 1, finding 2): the rules a
 * part keeps (isSharablePiece; no dot-folder or `agent-notes` in its path), and where it really lives,
 * every link resolved, is inside the Folio's own folder and has no dot-folder or `agent-notes` on the
 * way from the Workspace. A link to `../agent-notes/review.md` or `../.bridle/private.md` is refused.
 */
export function indexNoteReadable(root: string, dir: string, path: string): boolean {
  if (!writersPlace(path) || !isSharablePiece(root, path)) return false
  try {
    const realRoot = realpathSync.native(root)
    const realFolio = realpathSync.native(join(root, dir))
    const realNote = realpathSync.native(join(root, path))
    const fromRoot = relative(realRoot, realNote)
    if (!staysInside(fromRoot) || !writersPlace(fromRoot.split(sep).join('/'))) return false
    return staysInside(relative(realFolio, realNote))
  } catch {
    return false
  }
}

/** The Folio's title and chips, from its Index Note when it has one that may be read; else "Folio" and no chips. */
async function folioHead(ws: Workspace, root: string, dir: string): Promise<{ title: string; chips: RenderedFolio['chips']; savedAt: number }> {
  const neutral = { title: FOLIO_TITLE, chips: [], savedAt: 0 }
  const path = indexNotePath(ws, dir)
  if (!indexNoteReadable(root, dir, path)) return neutral
  try {
    const { content: raw, file } = await ws.readFile(path)
    const content = withoutHiddenComments(raw)
    const title = parseFrontmatter(content)?.title?.trim() || firstBodyHeading(content)?.text || FOLIO_TITLE
    return { title: oneLine(title, SHARE_LIMITS.titleChars) || FOLIO_TITLE, chips: chipsOf(content), savedAt: Math.round(file.modifiedAt) }
  } catch {
    return neutral
  }
}

async function savedTime(ws: Workspace, path: string): Promise<number> {
  try { return Math.round((await ws.readFile(path)).file.modifiedAt) } catch { return 0 }
}

export type RenderFolioPorts = {
  fetchRemote?: RemotePictureFetch
  /** Render one part (tests); renderPieceForSharing by default. */
  renderPart?: typeof renderPieceForSharing
}

/**
 * Render the Folio at `dir` for publishing at `imagePath`, its parts under `keys` (partKeysFor).
 * Throws when `dir` is not a Folio. A part that cannot be read is published as missing.
 */
export async function renderFolioForSharing(
  root: string,
  dir: string,
  imagePath: string,
  entries: readonly FolioEntry[],
  keys: Readonly<Record<string, string>>,
  ports: RenderFolioPorts = {},
): Promise<RenderedFolio> {
  const ws = new Workspace(root)
  const renderPart = ports.renderPart ?? renderPieceForSharing
  const head = await folioHead(ws, root, dir)
  const pictures = new Map<string, SharedPicture>()
  let refusedPictures = 0
  const manifestPath = posix.join(dir, MANIFEST_NAME)
  let savedAt = Math.max(head.savedAt, isEligibleFolioMetadata(root, manifestPath) ? await savedTime(ws, manifestPath) : 0)
  const parts: RenderedFolioPart[] = []
  for (const entry of entries) {
    const key = keys[entry.path]
    const fallbackTitle = oneLine(titleFromFileName(entry.path), SHARE_LIMITS.titleChars) || 'Untitled'
    let rendered: RenderedPiece | null = null
    // Each part is checked by the one source rule just before it is read (Sol review round 3 of ticket 11,
    // P1): a part replaced since the running order was read by a link (symlink) to a hidden or support
    // file, or one gone, is refused and stands in its place as missing; its content is never read.
    if (!entry.missing && isEligiblePiece(root, entry.path)) {
      rendered = await renderPart(root, entry.path, imagePath, { fetchRemote: ports.fetchRemote }, { idPrefix: `${key}-`, headingOffset: 1 }).catch(() => null)
    }
    if (!rendered) {
      parts.push({ path: entry.path, key, title: fallbackTitle, missing: true, html: null, headings: [] })
      continue
    }
    for (const picture of rendered.pictures) if (!pictures.has(picture.name)) pictures.set(picture.name, picture)
    refusedPictures += rendered.refusedPictures
    savedAt = Math.max(savedAt, rendered.savedAt)
    parts.push({ path: entry.path, key, title: rendered.title, missing: false, html: rendered.html, headings: rendered.headings })
  }
  const chips = [...head.chips, { label: 'Parts', value: String(parts.length) }].slice(0, SHARE_LIMITS.chips)
  return { title: head.title, chips, savedAt, parts, pictures: [...pictures.values()], refusedPictures }
}

/**
 * The publisher's port for a Folio link (sharing-publisher.ts `renderFolio`): the running order read
 * now, the keys for its parts (`kept` first), and the rendering. Null when `dir` is no longer a Folio.
 */
export async function renderFolioLink(
  root: string,
  dir: string,
  imagePath: string,
  kept: Readonly<Record<string, string>>,
  ports: RenderFolioPorts = {},
): Promise<{ folio: RenderedFolio; keys: Record<string, string> } | null> {
  const entries = await folioRunningOrder(root, dir)
  if (!entries) return null
  const keys = partKeysFor(entries, kept)
  return { folio: await renderFolioForSharing(root, dir, imagePath, entries, keys, ports), keys }
}
