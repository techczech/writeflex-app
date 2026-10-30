/**
 * Resolve which Folio a file belongs to and where it sits in it (the line above the text and the
 * title-bar button). Read-only. Every ancestor uses the shared declaration and conflict rule,
 * including Index-Note-only Folios. The outermost declaration wins when old data overlaps.
 * Order comes from `folioPieces` (manifest) or the fallback order (no manifest).
 */
import { folioDeclaration } from './folio-declaration'
import { open } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { fallbackFolioParts, folioPieces, indexNotePath } from './folio'
import { documentTitle } from './frontmatter'
import { folioOrderFacts } from './folio-order-facts'
import { readFolioFrontMatter } from './plan'
import { assertRelativeWorkspacePath, type Workspace } from './workspace'
import { folioPlaceFacts, type FolioPlace } from '../shared/folio-place'

/** How much of a neighbour's file is read to find its title (the first heading). */
const TITLE_PREFIX_BYTES = 16 * 1024

function parentDir(dir: string): string {
  const parent = posix.dirname(dir)
  return parent === '.' ? '' : parent
}

/** The Folio of a folder: where it is, its pieces in running order and its front-matter parts
 *  (shared/folio-front-matter.ts). Null when the folder is in none. */
type FolioOfFolder = { dir: string; pieces: string[]; frontMatter: ReadonlySet<string>; manifest: boolean } | null

/** A failed read of the front matter names none: the heading checks then stay on, as before. */
const frontMatterOf = (ws: Workspace, dir: string, listing?: ReadonlySet<string>): Promise<ReadonlySet<string>> => readFolioFrontMatter(ws, dir, listing).catch(() => new Set<string>())

/**
 * Answers per workspace root and file folder. A tab switch inside one unchanged Folio finds its Folio
 * here and touches the disk only for the two neighbours' titles. Dropped by `invalidateFolioPlaces`,
 * which main calls whenever it pushes `collection:changed` or `file:changed-on-disk` (the same events
 * that tell the renderer a collection or manifest changed).
 */
const cache = new Map<string, Map<string, Promise<FolioOfFolder>>>()

export function invalidateFolioPlaces(root: string): void {
  cache.delete(root)
}

/**
 * The Plan's own conditions (`readPlan`): the Index Note is a file the workspace lists (visible, not a
 * symlink, not beneath one) and has the Running order heading by the Plan's rule. A heading with no
 * parts under it still declares a Plan, as it does for `readPlan`. Reads the Index Note first, and
 * lists its folder only when the heading is there.
 */
export async function indexDeclaresPlan(ws: Workspace, dir: string): Promise<boolean> {
  try { const state = folioDeclaration(ws, dir); return state.isFolio && state.runningOrder && !state.repairNeeded } catch { return false }
}

/**
 * The same Folio rule, synchronously, for a check made in the tick of a write (folio-workspace.ts): `dir` has a
 * manifest (anything at `_report-structure.json`), or its Index Note is a plain file (no link, as the listing
 * `indexDeclaresPlan` asks for) whose text declares a running order (`declaresRunningOrder`). An Index Note with no
 * running order is a folder's cover, not a Folio. A read that fails for any reason but "not there" throws: the
 * caller decides what that means.
 */
export function isFolioFolderNow(root: string, dir: string): boolean {
  return folioDeclaration({ root, absolute: path => join(root, path) }, dir).isFolio
}

async function findFolio(ws: Workspace, own: string): Promise<FolioOfFolder> {
  for (let cursor = own; ; cursor = parentDir(cursor)) {
    const declaration = folioDeclaration(ws, cursor)
    if (declaration.isFolio) {
      // One listing of the Folio's folder serves the order and the front matter.
      const listing = new Set((await ws.listFilesIn(cursor)).map((file) => file.path))
      return { dir: cursor, pieces: declaration.manifest ? (await folioPieces(ws, cursor, listing))?.pieces ?? [] : await fallbackFolioParts(ws, cursor), frontMatter: await frontMatterOf(ws, cursor, listing), manifest: declaration.manifest }
    }
    if (cursor === '') break
  }
  return null
}

function folioOfFolder(ws: Workspace, own: string): Promise<FolioOfFolder> {
  let byFolder = cache.get(ws.root)
  if (!byFolder) cache.set(ws.root, (byFolder = new Map()))
  let found = byFolder.get(own)
  if (!found) {
    found = findFolio(ws, own)
    byFolder.set(own, found)
    // A failed lookup is not remembered; and an answer that raced an invalidation is not kept.
    const map = byFolder
    found.catch(() => { if (map.get(own) === found) map.delete(own) })
  }
  return found
}

/** A file's title from its first 16 KiB only; the whole file when it is shorter. */
async function titleOf(ws: Workspace, path: string): Promise<string> {
  let handle
  try {
    handle = await open(ws.absolute(path), 'r')
    const buffer = Buffer.alloc(TITLE_PREFIX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, TITLE_PREFIX_BYTES, 0)
    let text = buffer.subarray(0, bytesRead).toString('utf8')
    if (bytesRead === TITLE_PREFIX_BYTES) text = text.slice(0, Math.max(0, text.lastIndexOf('\n'))) // never a half line
    return documentTitle(text, path)
  } catch {
    return documentTitle('', path)
  } finally {
    await handle?.close()
  }
}

async function neighbour(ws: Workspace, path: string | null): Promise<{ path: string; title: string } | null> {
  return path ? { path, title: await titleOf(ws, path) } : null
}

/**
 * The Folio a workspace path belongs to (same rule and same cache as `folioPlace`): its folder and the
 * pieces in running order, or null. Throws for a path that is not a workspace-relative path.
 */
export async function folioContaining(ws: Workspace, path: string): Promise<{ dir: string; pieces: string[]; frontMatter: ReadonlySet<string> } | null> {
  if (path.includes('://')) return null
  assertRelativeWorkspacePath(path)
  return folioOfFolder(ws, parentDir(path))
}

/**
 * The Folio that owns a workspace path, by `folioContaining`'s rule but read fresh from disk, never from the
 * cache: for a write's authority check (the title-conflict fixes, plan-ipc.ts), where a stale answer must not
 * decide which Folio's front matter is exempt. Throws for a path that is not a workspace-relative path.
 */
export async function folioOwning(ws: Workspace, path: string): Promise<{ dir: string; pieces: string[]; frontMatter: ReadonlySet<string> } | null> {
  if (path.includes('://')) return null
  assertRelativeWorkspacePath(path)
  return findFolio(ws, parentDir(path))
}

/**
 * The Folio folder a folder belongs to, by `folioContaining`'s rule and cache: the folder itself or the nearest
 * ancestor with a manifest, else the folder itself when its Index Note declares a Plan; null when it is in no Folio.
 * The Folio page opens on this folder whatever was open (the Index Note, a part, a part in `content_root`, a nested
 * part, a sub-folder of the Folio), so it finds the Folio and the Index Note the Outline finds. Throws for a folder
 * that is not workspace-relative.
 */
export async function folioDirOf(ws: Workspace, dir: string): Promise<string | null> {
  if (dir !== '') assertRelativeWorkspacePath(dir)
  return (await folioOfFolder(ws, dir))?.dir ?? null
}

/** `folioDirOf` read fresh from disk, never from the cache: for a write's authority check (folio-index-note.ts). */
export async function folioDirOwning(ws: Workspace, dir: string): Promise<string | null> {
  if (dir !== '') assertRelativeWorkspacePath(dir)
  return (await findFolio(ws, dir))?.dir ?? null
}

/**
 * Null when the path is not a workspace file or not in a Folio. Throws for a path that is not a
 * workspace-relative path (empty or blank, absolute, or leaving the workspace), like the other channels.
 */
export async function folioPlace(ws: Workspace, path: string): Promise<FolioPlace | null> {
  if (path.includes('://')) return null
  assertRelativeWorkspacePath(path)
  const folio = await folioOfFolder(ws, parentDir(path))
  if (!folio) return null
  // A manifest Folio whose Index Note declares a running order takes the Plan's order (what the Plan and the Outline show).
  // A Plan folder with no manifest keeps its fallback order: its Plan names no file paths to read. Manifest-only Folios are unchanged.
  const planned = folio.manifest && (await indexDeclaresPlan(ws, folio.dir)) ? (await folioOrderFacts(ws, folio.dir)).order : null
  const pieces = planned ?? folio.pieces
  const facts = folioPlaceFacts(path, pieces, indexNotePath(ws, folio.dir))
  return {
    dir: folio.dir,
    name: folio.dir === '' ? posix.basename(ws.root) : posix.basename(folio.dir),
    kind: facts.kind,
    position: facts.position,
    total: facts.total,
    previous: await neighbour(ws, facts.previous),
    next: await neighbour(ws, facts.next),
    ...(folio.frontMatter.has(path) ? { frontMatter: true as const } : {}),
  }
}
