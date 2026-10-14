/**
 * Resolve which Folio a file belongs to and where it sits in it (the line above the text and the
 * title-bar button). Read-only. The Folio is the nearest ancestor folder with a manifest (the answer
 * `resolveTabGroups` gives); failing that, the file's own folder when its Index Note declares a Plan.
 * Order comes from `folioPieces` (manifest) or the fallback order (no manifest).
 */

import { open } from 'node:fs/promises'
import { posix } from 'node:path'
import { fallbackFolioParts, folioPieces, indexNotePath, readManifest } from './folio'
import { documentTitle } from './frontmatter'
import { declaresRunningOrder } from './plan'
import { assertRelativeWorkspacePath, type Workspace } from './workspace'
import { folioPlaceFacts, type FolioPlace } from '../shared/folio-place'

/** How much of a neighbour's file is read to find its title (the first heading). */
const TITLE_PREFIX_BYTES = 16 * 1024

function parentDir(dir: string): string {
  const parent = posix.dirname(dir)
  return parent === '.' ? '' : parent
}

/** The Folio of a folder: where it is and its pieces in running order. Null when the folder is in none. */
type FolioOfFolder = { dir: string; pieces: string[] } | null

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
async function indexDeclaresPlan(ws: Workspace, dir: string): Promise<boolean> {
  try {
    const path = indexNotePath(ws, dir)
    if (!declaresRunningOrder((await ws.readFile(path)).content)) return false
    return (await ws.listFilesIn(dir, { recursive: false })).some((file) => file.path === path)
  } catch {
    return false
  }
}

async function findFolio(ws: Workspace, own: string): Promise<FolioOfFolder> {
  for (let cursor = own; ; cursor = parentDir(cursor)) {
    if (await readManifest(ws, cursor)) return { dir: cursor, pieces: (await folioPieces(ws, cursor))?.pieces ?? [] }
    if (cursor === '') break
  }
  if (!(await indexDeclaresPlan(ws, own))) return null
  return { dir: own, pieces: await fallbackFolioParts(ws, own) }
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
export async function folioContaining(ws: Workspace, path: string): Promise<{ dir: string; pieces: string[] } | null> {
  if (path.includes('://')) return null
  assertRelativeWorkspacePath(path)
  return folioOfFolder(ws, parentDir(path))
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
  const facts = folioPlaceFacts(path, folio.pieces, indexNotePath(ws, folio.dir))
  return {
    dir: folio.dir,
    name: folio.dir === '' ? posix.basename(ws.root) : posix.basename(folio.dir),
    kind: facts.kind,
    position: facts.position,
    total: facts.total,
    previous: await neighbour(ws, facts.previous),
    next: await neighbour(ws, facts.next),
  }
}
