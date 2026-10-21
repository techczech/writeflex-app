/**
 * Which of a list of files are Folio parts (listed in the running order of the Folio that governs their
 * folder), so a Collection list can name them by the part-title rule (shared/folio-part-title.ts) while
 * every other file keeps its ordinary title. A Folio is the nearest ancestor folder with a manifest; its
 * parts are `folioPieces`. Reads each manifest once per call. Read-only.
 */

import { posix } from 'node:path'
import { folioPieces, readManifest } from './folio'
import type { Workspace } from './workspace'

function parentOf(dir: string): string | null {
  if (dir === '') return null
  const parent = posix.dirname(dir)
  return parent === '.' ? '' : parent
}

export async function folioPartPaths(ws: Workspace, paths: readonly string[]): Promise<Set<string>> {
  const governing = new Map<string, Promise<Set<string> | null>>()
  const partsOf = (dir: string): Promise<Set<string> | null> => {
    let found = governing.get(dir)
    if (!found) {
      found = (async () => {
        if (await readManifest(ws, dir)) return new Set((await folioPieces(ws, dir))?.pieces ?? [])
        const parent = parentOf(dir)
        return parent === null ? null : partsOf(parent)
      })()
      governing.set(dir, found)
    }
    return found
  }
  const result = new Set<string>()
  for (const path of paths) {
    const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path)
    if ((await partsOf(dir))?.has(path)) result.add(path)
  }
  return result
}
