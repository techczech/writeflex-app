import { lstatSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { LIBRARY_MARKER_DIR, normaliseRoot } from '../root-resolution'
import { CliError } from './operation'

/** How the root came to be this folder: named with `--root`, or found by climbing to a marker. */
export type RootSource = 'given' | 'discovered'
export type CollectionRoot = { root: string; source: RootSource }

/** Test seams; production callers pass nothing. */
export type RootSurroundings = {
  home?: string
  /** Whether `dir` (a real path) is the top folder of a disk or other mounted volume. */
  isVolumeRoot?: (dir: string) => boolean
}

const isFolder = (path: string): boolean => {
  try { return statSync(path).isDirectory() } catch { return false }
}

/** The marker is a real folder standing in `dir` itself: a link named `.writeflex` is never followed, so it marks nothing. */
const hasMarker = (dir: string): boolean => {
  try { return lstatSync(join(dir, LIBRARY_MARKER_DIR)).isDirectory() } catch { return false }
}

/** A mount point sits on a different device from its parent; `/Volumes/<name>` is one by convention even when the device cannot be read. */
function isVolumeRoot(dir: string): boolean {
  if (/^\/Volumes\/[^/]+$/.test(dir)) return true
  try {
    return statSync(dir).dev !== statSync(dirname(dir)).dev
  } catch {
    return false
  }
}

/**
 * Why `dir` (a real path) is too wide to be a Collection, or null. Everything the user owns sits
 * under these folders, so treating one as "the Collection" would put all of it in scope.
 */
function tooWide(dir: string, home: string, volumeRoot: (dir: string) => boolean): string | null {
  if (dirname(dir) === dir) return 'the top of the filesystem'
  if (dir === home) return 'your home folder'
  const fromDir = relative(dir, home)
  if (fromDir !== '' && fromDir !== '..' && !fromDir.startsWith(`..${sep}`)) return 'a folder that contains your home folder'
  if (volumeRoot(dir)) return 'the root of a disk'
  return null
}

/**
 * The Collection an invocation acts on. Never creates a marker: finding the root writes nothing.
 *
 * - `--root` names it outright: any existing folder, marker or not, except one that is too wide (the
 *   home folder, a folder containing it, a disk's root, the filesystem root), refused with the reason.
 * - Otherwise the nearest folder at or above `cwd` holding WriteFlex's own marker folder, `.writeflex`.
 *   A link or a file of that name does not count, and `.bridle` does not: other tools leave one, in repositories too. The climb ends, without
 *   looking, at the first folder that is too wide, so a marker planted in the home folder or at a
 *   disk's root never turns everything beneath it into "the Collection".
 *
 * `source` says which: a `discovered` root is one nobody chose (the marker may have arrived inside an
 * unpacked download or a cloned repository), so an operation that writes can insist on `given`.
 */
export function resolveCollectionRoot(cwd: string, explicit?: string, surroundings: RootSurroundings = {}): CollectionRoot {
  const home = normaliseRoot(surroundings.home ?? homedir())
  const volumeRoot = surroundings.isVolumeRoot ?? isVolumeRoot
  if (explicit !== undefined) {
    if (!isFolder(resolve(cwd, explicit))) throw new CliError(`--root ${explicit} is not a folder.`)
    const root = normaliseRoot(resolve(cwd, explicit))
    const reason = tooWide(root, home, volumeRoot)
    if (reason) throw new CliError(`--root ${explicit} is ${reason}, which is too wide to be a Collection. Name the folder that holds the documents.`)
    return { root, source: 'given' }
  }
  for (let dir = normaliseRoot(cwd); tooWide(dir, home, volumeRoot) === null; dir = dirname(dir)) {
    if (hasMarker(dir)) return { root: dir, source: 'discovered' }
  }
  throw new CliError(`No Collection found from ${cwd}: no ${LIBRARY_MARKER_DIR} folder in it or above it, up to your home folder or the disk's root. Open the folder in WriteFlex once, or pass --root <folder>.`)
}

/** The root alone, for callers that do not need to know how it was found. */
export function findCollectionRoot(cwd: string, explicit?: string, surroundings: RootSurroundings = {}): string {
  return resolveCollectionRoot(cwd, explicit, surroundings).root
}
