/**
 * One spelling for one Folio folder. A folder can be named many ways (`guide`, `guide/`, `guide/.`,
 * `x/../guide`, and on a volume that ignores case or Unicode form, `Guide`). The lock (plan-lock.ts) and
 * the Outline's kept answer (folio-order-cache.ts) are keyed by folder, so every spelling of one folder
 * must give one key; the IPC boundary (plan-ipc.ts) passes the same spelling on to the Plan writes.
 *
 * The rule: normalise the path (no `.`, no `..`, no doubled or trailing slash), then, when the folder
 * exists, take the spelling the filesystem itself holds for it. That second step is used only when it
 * differs from the normalised path in letter case or Unicode form alone; a folder reached through a
 * symbolic link keeps its normalised name, so no request is moved to another folder.
 *
 * Imports nothing of the app, so the cache and the lock can use it without an import cycle.
 */

import { realpathSync } from 'node:fs'
import { posix, relative, resolve, sep } from 'node:path'

const fold = (text: string): string => text.normalize('NFC').toLocaleLowerCase()

function realOrNull(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

/** A workspace-relative folder with no `.`/`..` segment and no trailing slash ('' = the workspace root). */
export function normalisedFolioDir(dir: string): string {
  const normalised = posix.normalize(dir.split('\\').join('/')).replace(/\/+$/, '')
  return normalised === '.' ? '' : normalised
}

/** The one spelling of a Folio folder under `root`. A path that leaves the root is returned normalised; the callers' own containment checks refuse it. */
export function canonicalFolioDir(root: string, dir: string): string {
  const normalised = normalisedFolioDir(dir)
  if (normalised === '' || normalised === '..' || normalised.startsWith('../') || posix.isAbsolute(normalised)) return normalised
  const realRoot = realOrNull(root)
  const real = realRoot === null ? null : realOrNull(resolve(root, normalised))
  if (realRoot === null || real === null) return normalised
  const onDisk = relative(realRoot, real).split(sep).join('/')
  return fold(onDisk) === fold(normalised) ? onDisk : normalised
}

/** The key the lock and the cache hold a Folio under: the root as the filesystem spells it, and the folder's one spelling. */
export function folioKey(root: string, dir: string): { root: string; dir: string } {
  return { root: realOrNull(root) ?? root, dir: canonicalFolioDir(root, dir) }
}
