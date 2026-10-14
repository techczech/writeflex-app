/**
 * Tab groups (direction D, "the strip follows the open file"). A tab's group is DERIVED from its
 * path, never stored: the nearest ancestor folder (its own included) that is a Folio wins; else the
 * nearest ancestor folder carrying an Index Note in any recognised cover form; else the file's own
 * folder. So `talk/parts/01.md` and `talk/research/x.md` share one group when `talk` is a Folio.
 *
 * The workspace root takes part in the Folio step only. A root cover (README.md, `_<root>_INDEX.md`)
 * is common in a whole-archive workspace and would otherwise fold every ungrouped folder into one
 * root group; a root manifest is a deliberate declaration that the whole workspace compiles as one.
 */

import { stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { collectionCoverPaths, readManifest } from './folio'
import type { Workspace } from './workspace'

/** Most paths one call resolves; the renderer asks for its open tabs, never the whole tree. */
export const TAB_GROUP_PATH_LIMIT = 1000

type GroupWorkspace = Pick<Workspace, 'root' | 'readFile' | 'absolute'>

function parentDir(dir: string): string {
  const parent = posix.dirname(dir)
  return parent === '.' ? '' : parent
}

/** The folder chain from `dir` up to and including the root (''). */
function ancestors(dir: string): string[] {
  const chain = [dir]
  while (chain[chain.length - 1] !== '') chain.push(parentDir(chain[chain.length - 1]))
  return chain
}

async function isFile(ws: GroupWorkspace, path: string): Promise<boolean> {
  try {
    return (await stat(ws.absolute(path))).isFile()
  } catch {
    return false
  }
}

/** Validate the renderer's argument: an array of workspace-relative path strings. */
export function tabGroupPaths(input: unknown): string[] {
  const paths = (input as { paths?: unknown } | null)?.paths
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string')) throw new Error('Invalid tab group paths.')
  if (paths.length > TAB_GROUP_PATH_LIMIT) throw new Error('Too many tab group paths.')
  return paths as string[]
}

/**
 * Resolve each workspace-relative path to its group key (a workspace-relative folder, '' = root).
 * A path ending in `/` names a folder (the Board's Collection) and resolves as a file inside it would.
 * Non-file ids (a `scheme://` tab such as the Board) and paths outside the workspace are skipped.
 * Folder facts are cached for the call, so tabs in one Folio cost one manifest read.
 */
export async function resolveTabGroups(ws: GroupWorkspace, paths: readonly string[]): Promise<Record<string, string>> {
  const folio = new Map<string, Promise<boolean>>()
  const cover = new Map<string, Promise<boolean>>()
  const isFolio = (dir: string): Promise<boolean> => {
    let known = folio.get(dir)
    if (!known) folio.set(dir, known = readManifest(ws, dir).then((manifest) => manifest !== null, () => false))
    return known
  }
  const hasCover = (dir: string): Promise<boolean> => {
    let known = cover.get(dir)
    if (!known) {
      known = (async () => {
        for (const candidate of collectionCoverPaths(ws, dir)) if (await isFile(ws, candidate)) return true
        return false
      })()
      cover.set(dir, known)
    }
    return known
  }

  const groups: Record<string, string> = {}
  for (const path of new Set(paths)) {
    if (path === '' || path.includes('://') || path.startsWith('/') || path.split('/').includes('..')) continue
    const own = path.endsWith('/') ? path.slice(0, -1) : parentDir(path)
    const chain = ancestors(own)
    let group: string | null = null
    for (const dir of chain) {
      if (await isFolio(dir)) {
        group = dir
        break
      }
    }
    if (group === null) {
      for (const dir of chain) {
        if (dir === '') break
        if (await hasCover(dir)) {
          group = dir
          break
        }
      }
    }
    groups[path] = group ?? own
  }
  return groups
}
