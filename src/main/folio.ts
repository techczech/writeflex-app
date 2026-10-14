/**
 * The Folio organ (Task 24, ADR-0008). A Folio is a folder DECLARED to compile to one output via a
 * manifest — the existing `_report-structure.json` shape (ordered parts, roles, render modes, output).
 * Folio-ness is declared, NEVER inferred: a numeric-prefixed folder is only a hint that may prompt a
 * "Make Folio" suggestion. This module READS the manifest, resolves the piece ORDER (manifest order,
 * else numeric-prefix-then-alpha as the manifest-less fallback), and DRAFTS a manifest proposal from
 * what a folder already contains. Writing the draft to disk is the agent/user's explicit act (the
 * folio.create_manifest capability / Make Folio), never something this reader does.
 */

import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import type { Workspace } from './workspace'
import { MANIFEST_NAME } from '../shared/folio-constants'

export { MANIFEST_NAME } from '../shared/folio-constants'

/** One declared part of a Folio. Real manifests use paths both relative to and including content_root. */
export type FolioFile = { path: string; role?: string; render?: string; toc?: boolean }
/** A parsed Folio manifest. `contentRoot` is relative to the Folio folder ('' when the parts sit in it). */
export type Folio = {
  contentRoot: string
  output?: string
  titleMatter?: string
  files: FolioFile[]
  /** Set when the manifest's `content_root` is absolute or leaves the Folio's folder. No entry of such a
   *  manifest resolves (they are not re-read relative to the folder: the author did not list those
   *  files), and the Plan refuses to write it. `contentRoot` is then '' so that a reader which joins
   *  it to the folder cannot be pointed outside the folder. */
  contentRootRefused?: true
  /** Set when `files` holds an element that is not an entry with a `path` (a bare string, an object without
   *  one). `files` above leaves such elements out, so a writer that rebuilds the array from `files` would
   *  delete them: the Outline refuses to change such a Folio, and the Plan keeps them as authored. */
  unreadableEntries?: true
}
/** A listed entry that will not be read or exported, with its path exactly as the manifest wrote it. */
export type FolioLeftOut = { path: string; reason: 'not-found' | 'outside-folio' }
/** A Folio's listed entries, resolved: the pieces in manifest order, and the entries left out. */
export type FolioPieces = { pieces: string[]; leftOut: FolioLeftOut[] }

/** A leading numeric part order: `01-intro.md`, `02_method.md`, `10-appendix.md`. */
const NUMERIC_PREFIX = /^(\d+)[-_]/

/** A workspace-relative path inside `dir` (or at the root when `dir` is ''). */
function inDir(dir: string, ...parts: string[]): string {
  const joined = parts.filter((p) => p !== '' && p !== '.').join('/')
  return dir === '' ? joined : joined === '' ? dir : posix.join(dir, joined)
}

/** The canonical Index Note path for a folder, including the workspace-root name at the root. */
export function indexNotePath(ws: Pick<Workspace, 'root'>, dir: string): string {
  const name = dir === '' ? posix.basename(ws.root) : posix.basename(dir)
  return inDir(dir, `_${name}_INDEX.md`)
}

/** Every recognised cover path for a folder, anchored to the same name as indexNotePath. */
export function collectionCoverPaths(ws: Pick<Workspace, 'root'>, dir: string): string[] {
  const name = dir === '' ? posix.basename(ws.root) : posix.basename(dir)
  return [
    indexNotePath(ws, dir),
    inDir(dir, `_${name}.md`),
    inDir(dir, 'README.md'),
    inDir(dir, 'index.md'),
  ]
}

/** An authored path that names a filesystem root or a drive rather than a place relative to the Folio. */
function isAbsoluteAuthored(authored: string): boolean {
  return /^[\\/]/.test(authored) || /^[a-zA-Z]:[\\/]/.test(authored)
}

/**
 * THE containment rule (owner's decision, 2026-10-13): a Folio may only contain pieces inside its own
 * folder. True when the authored segments, joined below `dir` and normalised, name a place strictly
 * inside `dir` at any depth (inside the workspace root when `dir` is ''). An absolute segment is never
 * inside. A backslash counts as a separator here, so a manifest written on Windows cannot step out.
 * Every manifest path and every `content_root` is checked here and nowhere else.
 */
function staysInsideFolio(dir: string, ...authored: string[]): boolean {
  if (authored.some(isAbsoluteAuthored)) return false
  const segments = authored.map((part) => part.replace(/\\/g, '/')).filter((part) => part !== '')
  const base = dir === '' ? '' : posix.normalize(dir).replace(/\/+$/, '')
  const full = posix.normalize(posix.join(base || '.', ...segments))
  if (full === '.' || full === '..' || full.startsWith('../') || posix.isAbsolute(full)) return false
  return base === '' || full.startsWith(`${base}/`)
}

/** The manifest's `content_root` when it stays inside the Folio's folder, else '' (the folder itself). */
function safeContentRoot(dir: string, contentRoot: string): string {
  const empty = contentRoot === '' || contentRoot === '.' || contentRoot === './'
  return empty || staysInsideFolio(dir, contentRoot) ? contentRoot : ''
}

/** Whether the manifest's `content_root` was refused: flagged by `readManifest`, or still carrying a
 *  root that leaves the folder when the manifest was built by hand. */
export function manifestContentRootRefused(dir: string, manifest: Pick<Folio, 'contentRoot' | 'contentRootRefused'>): boolean {
  return manifest.contentRootRefused === true || safeContentRoot(dir, manifest.contentRoot) !== manifest.contentRoot
}

/**
 * The workspace-relative locations accepted for an authored manifest path, at most two. Existing report
 * generators disagree about whether `files[].path` includes `content_root`, so readers try the
 * content-root-relative interpretation first and the manifest-folder-relative interpretation second.
 * A location outside the Folio's folder is never a candidate: this is the single place manifest paths
 * become workspace paths, and every reader (order, export, Plan, rename repair, folder pieces) asks here.
 * A manifest whose `content_root` was refused has no candidates at all: reading its entries relative
 * to the folder instead would export files the author did not list.
 */
export function manifestFilePathCandidates(dir: string, manifest: Folio, file: Pick<FolioFile, 'path'>): string[] {
  if (manifestContentRootRefused(dir, manifest)) return []
  const contentRoot = manifest.contentRoot
  const candidates: string[] = []
  if (staysInsideFolio(dir, contentRoot, file.path)) candidates.push(inDir(dir, contentRoot, file.path))
  if (staysInsideFolio(dir, file.path)) {
    const fallback = inDir(dir, file.path)
    if (!candidates.includes(fallback)) candidates.push(fallback)
  }
  return candidates
}

/** Resolve an authored manifest path without changing its original string. Null when the file is not
 *  in the listing, or when the path leaves the Folio's folder. */
export function resolveManifestFilePath(
  dir: string,
  manifest: Folio,
  file: Pick<FolioFile, 'path'>,
  present: ReadonlySet<string>,
): string | null {
  return manifestFilePathCandidates(dir, manifest, file).find((path) => present.has(path)) ?? null
}

/** Whether an entry has no place inside the Folio's folder under either path convention, or belongs to
 *  a manifest whose `content_root` was refused. An unresolved entry that has a place inside is simply a
 *  file that is not there. The Plan keeps such entries exactly as authored when it writes the manifest. */
export function manifestEntryPointsOutsideFolio(dir: string, manifest: Folio, file: Pick<FolioFile, 'path'>): boolean {
  return manifestFilePathCandidates(dir, manifest, file).length === 0
}

/** A stable sort key for the manifest-less fallback: numbered files first in numeric order, then the
 *  rest alphabetically. Two files sharing a prefix fall back to alpha — which is exactly the ambiguity
 *  an explicit manifest exists to resolve. */
function prefixOrderKey(name: string): [number, number, string] {
  const m = NUMERIC_PREFIX.exec(name)
  return m ? [0, Number(m[1]), name] : [1, 0, name]
}

function compareKeys(a: [number, number, string], b: [number, number, string]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2])
}

/** Direct-child Markdown files that may become Folio parts, in the manifest-less fallback order. */
export async function fallbackFolioParts(ws: Workspace, dir: string): Promise<string[]> {
  const covers = new Set(collectionCoverPaths(ws, dir))
  return (await ws.listFilesIn(dir, { recursive: false }))
    .filter((file) => file.directory === dir && !file.name.startsWith('_') && !covers.has(file.path) && !file.path.endsWith('.writeflex-backup'))
    .sort((a, b) => compareKeys(prefixOrderKey(a.name), prefixOrderKey(b.name)))
    .map((file) => file.path)
}

/**
 * Read a folder's Folio manifest into a typed shape, or null when the folder declares none (no
 * `_report-structure.json`) or the file is unreadable/malformed — a Folio is never inferred, so a
 * missing or broken manifest simply means "not a Folio", never a throw. Superset-tolerant: unknown
 * top-level and per-file keys are ignored so a richer real-world manifest still parses.
 */
export async function readManifest(ws: Pick<Workspace, 'readFile'>, dir: string): Promise<Folio | null> {
  const path = inDir(dir, MANIFEST_NAME)
  let raw: string
  try {
    raw = (await ws.readFile(path)).content
  } catch {
    return null // no manifest → not a Folio
  }
  return parseManifest(dir, raw)
}

/** The manifest a text declares, by `readManifest`'s rule (null when it is not a JSON object). For a caller
 *  that must judge the parsed manifest and the bytes it was parsed from as one read. */
export function parseManifest(dir: string, raw: string): Folio | null {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null // malformed manifest → treat as not-a-Folio rather than throwing
  }
  if (typeof json !== 'object' || json === null) return null
  const obj = json as Record<string, unknown>
  const rawFiles = Array.isArray(obj.files) ? obj.files : []
  const files: FolioFile[] = []
  let unreadableEntries = false
  for (const entry of rawFiles) {
    if (!(typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).path === 'string')) unreadableEntries = true
    if (typeof entry === 'object' && entry !== null && typeof (entry as Record<string, unknown>).path === 'string') {
      const e = entry as Record<string, unknown>
      files.push({
        path: e.path as string,
        ...(typeof e.role === 'string' ? { role: e.role } : {}),
        ...(typeof e.render === 'string' ? { render: e.render } : {}),
        ...(typeof e.toc === 'boolean' ? { toc: e.toc } : {}),
      })
    }
  }
  const authoredRoot = typeof obj.content_root === 'string' ? obj.content_root : ''
  const contentRoot = safeContentRoot(dir, authoredRoot)
  return {
    contentRoot,
    ...(contentRoot !== authoredRoot ? { contentRootRefused: true as const } : {}),
    ...(typeof obj.output === 'string' ? { output: obj.output } : {}),
    ...(typeof obj.title_matter === 'string' ? { titleMatter: obj.title_matter } : {}),
    files,
    ...(unreadableEntries ? { unreadableEntries: true as const } : {}),
  }
}

/** Refuse every destructive Folio-create path when a manifest already exists, including malformed
 *  JSON that readManifest deliberately treats as a non-Folio for read-only projection purposes. */
export async function assertManifestAbsent(ws: Workspace, dir: string): Promise<void> {
  const path = inDir(dir, MANIFEST_NAME)
  if (!existsSync(ws.absolute(path))) return
  if (await readManifest(ws, dir)) {
    throw new Error(`A Folio manifest already exists in ${dir || 'the workspace root'}.`)
  }
  throw new Error(`The existing ${MANIFEST_NAME} in ${dir || 'the workspace root'} could not be parsed as valid JSON. Fix or move it before making this folder a Folio.`)
}

/**
 * A Folio's listed entries, resolved: the pieces that exist inside its folder, in the manifest's exact
 * `files` order, and the entries left out with the reason. An entry is left out when no file is at its
 * place (`not-found`), or when it has no place inside the Folio's folder or the manifest's `content_root` leaves
 * the folder (`outside-folio`: it is never read).
 * An entry listed twice resolves twice, in both positions, as it always has. Null when the folder
 * declares no manifest.
 */
export async function folioPieces(ws: Workspace, dir: string): Promise<FolioPieces | null> {
  const manifest = await readManifest(ws, dir)
  if (!manifest) return null
  // Containment: no candidate lies outside `dir`, so the Folio's own folder is the whole listing needed.
  const present = new Set((await ws.listFilesIn(dir)).map((f) => f.path))
  const pieces: string[] = []
  const leftOut: FolioLeftOut[] = []
  for (const file of manifest.files) {
    const path = resolveManifestFilePath(dir, manifest, file, present)
    if (path) pieces.push(path)
    else leftOut.push({ path: file.path, reason: manifestEntryPointsOutsideFolio(dir, manifest, file) ? 'outside-folio' : 'not-found' })
  }
  return { pieces, leftOut }
}

/**
 * The ordered workspace-relative paths of a folder's pieces. With a manifest: its exact `files` order,
 * resolved against content_root and filtered to those that exist on disk inside the Folio's folder (an
 * entry for a deleted file, or one that points outside the folder, is skipped; `folioPieces` names
 * them). Without one: the folder's direct-child Markdown files by numeric prefix then alpha — the
 * manifest-less fallback.
 */
export async function orderFor(ws: Workspace, dir: string): Promise<string[]> {
  return (await folioPieces(ws, dir))?.pieces ?? fallbackFolioParts(ws, dir)
}

/**
 * Draft a Folio manifest for a folder from every direct-child Markdown part in fallback order, each
 * proposed as a `section` (role guessing beyond that is the writer's call). The shared fallback-part
 * policy excludes covers, Index Notes, backups and every underscore-prefixed file. A populated top
 * level always wins when it has numbered parts. Otherwise numbered `contents/` parts win over
 * unnumbered top-level notes; an otherwise empty top level uses `contents/`. Returns pretty-printed
 * JSON text; writing it is the caller's explicit act.
 */
/** The parent folder of a workspace-relative dir ('' for a top-level folder or the root itself). */
function parentDir(dir: string): string {
  const p = posix.dirname(dir)
  return p === '.' ? '' : p
}

/**
 * The compile order that GOVERNS a folder: the folder's own manifest if it is a flat Folio, OR an
 * ancestor manifest whose `content_root` resolves exactly to this folder (the canonical report shape —
 * `report/_report-structure.json` with `content_root: contents` governs `report/contents`). Null when
 * no manifest governs the folder.
 */
async function governingOrder(ws: Workspace, dir: string): Promise<string[] | null> {
  if (await readManifest(ws, dir)) return orderFor(ws, dir)
  for (let ancestor = parentDir(dir); ; ancestor = parentDir(ancestor)) {
    const m = await readManifest(ws, ancestor)
    if (m) {
      const contentDir = m.contentRoot ? inDir(ancestor, m.contentRoot) : ancestor
      if (contentDir === dir) return orderFor(ws, ancestor)
    }
    if (ancestor === '') return null // checked every ancestor up to and including the root
  }
}

/**
 * Reorder per-file scan entries so a Folio folder's file-groups follow the manifest's compile order —
 * declared pieces first (in manifest order), everything undeclared trailing in its original (path)
 * order. A stable sort preserves each file's intra-file entry order. A folder no manifest governs
 * (checking the folder AND ancestors whose content_root points at it) returns the entries untouched.
 * Lives here (main-only) so the pure jumps scanner the renderer imports stays Node-free; the ipc
 * jumps:scan handler applies it to a folder scan.
 */
export async function orderEntriesByFolio<T extends { file: string }>(ws: Workspace, dir: string, entries: T[]): Promise<T[]> {
  const order = await governingOrder(ws, dir)
  if (!order) return entries
  const rank = new Map(order.map((p, i) => [p, i]))
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (rank.get(a.e.file) ?? Infinity) - (rank.get(b.e.file) ?? Infinity) || a.i - b.i)
    .map((x) => x.e)
}

export async function draftManifest(ws: Workspace, dir: string): Promise<string> {
  const direct = await fallbackFolioParts(ws, dir)
  const contentsSub = await fallbackFolioParts(ws, inDir(dir, 'contents'))
  const directHasNumberedParts = direct.some((path) => NUMERIC_PREFIX.test(posix.basename(path)))
  const contentsHasNumberedParts = contentsSub.some((path) => NUMERIC_PREFIX.test(posix.basename(path)))
  const useContents = contentsSub.length > 0 && (
    direct.length === 0 || (!directHasNumberedParts && contentsHasNumberedParts)
  )
  const contentRoot = useContents ? 'contents' : ''
  const parts = useContents ? contentsSub : direct
  if (parts.length === 0) throw new Error('This folder has no Markdown files to include in a Folio.')
  const manifest = {
    schema_version: 1,
    content_root: contentRoot,
    files: parts.map((path) => ({ path: posix.basename(path), role: 'section' })),
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}
