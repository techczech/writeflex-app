/**
 * "Is this a document path the sidebar would show?" — the one rule the Markdown walker, the command
 * line and (from ticket 01) the app's accept path share. Electron-free.
 *
 * A path is judged twice: as typed, and where it really lives on disk once every link in it has been
 * resolved. A link inside the Collection may point at a folder the app keeps for itself (`notes` ->
 * `.bridle`), and reads and writes follow links, so the typed path alone says nothing about what would
 * be touched.
 *
 * THE REAL LOCATION IS JUDGED IN ITS ON-DISK SPELLING. The three tooling names match in exact case,
 * by decision: a writer's `Release` or `Out` folder is theirs. On a disk that ignores letter case
 * `Node_Modules/x.md` IS `node_modules/x.md`, so the path is resolved to the spelling the disk holds
 * and that spelling is judged: hidden there, and a document on a disk where the two are different
 * folders.
 */
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Build and tooling folders, hidden for tidiness. Exact case: a writer's `Release` or `Out` is theirs. */
const IGNORED_DIRS = new Set(['node_modules', 'out', 'release'])

/**
 * Whether a folder of this name is kept out of the sidebar. Every dot-folder is, and that is the rule
 * that protects anything private (`.writeflex`, `.bridle`, `.git`): a leading dot is a leading dot in
 * any letter case, so `.WriteFlex` on a disk that ignores case is refused like `.writeflex`. The
 * three tooling names hold nothing private and match in exact case only.
 */
export function isHiddenFolderName(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRS.has(name)
}

/**
 * Whether the sidebar's listing shows `rel` (a root-relative POSIX path, judged as typed): no folder on
 * the way is hidden. A `folder` is judged in every segment, a `file` in its containing folders only (a
 * dot-named file in a shown folder is listed). The rule the Markdown walker and the folder walk apply
 * (Workspace.isVisiblePath), and that a vault pin is held to.
 */
export function isListedPath(rel: string, kind: PathKind): boolean {
  const segments = rel.split('/').filter(Boolean)
  return !(kind === 'file' ? segments.slice(0, -1) : segments).some(isHiddenFolderName)
}

/** `outside`: not in the Collection (or its location cannot be established). `hidden`: in a folder the sidebar never shows. */
export type PathVerdict = 'document' | 'outside' | 'hidden'
/** A `file`'s own name is not judged (`.draft.md` is a document); every segment of a `folder` is. */
export type PathKind = 'file' | 'folder'

const leavesRoot = (rel: string): boolean => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)

function hasHiddenFolder(rel: string, kind: PathKind): boolean {
  const segments = rel.split(sep).filter(Boolean)
  return (kind === 'file' ? segments.slice(0, -1) : segments).some(isHiddenFolderName)
}

const entryExists = (path: string): boolean => {
  try { lstatSync(path); return true } catch { return false }
}

/**
 * The real location of `target`: links resolved for the deepest part that exists, the rest appended.
 * Null when a link in the path leads nowhere — what a write through it would create is then decided
 * by the link, not by the path, so it cannot be judged.
 */
export function realLocation(target: string): string | null {
  let existing = target
  const tail: string[] = []
  // lstat, not stat: a dangling link EXISTS as an entry and must not be mistaken for a free name.
  while (!entryExists(existing)) {
    const parent = dirname(existing)
    if (parent === existing) return null
    tail.unshift(basename(existing))
    existing = parent
  }
  try {
    // `.native` asks the system and so answers in the spelling ON DISK. The JavaScript one keeps the
    // spelling it was given, and `Node_Modules` on a disk that ignores case would then pass for a
    // folder of the writer's when it is `node_modules`.
    const real = realpathSync.native(existing)
    return tail.length ? join(real, ...tail) : real
  } catch {
    return null
  }
}

/** `path` in its on-disk spelling, links resolved; as given when it cannot be resolved. */
function onDisk(path: string): string {
  try { return realpathSync.native(path) } catch { return path }
}

/**
 * Judge a Collection-relative `path` against `root`. `realRoot` is the root's own real location, so a
 * Collection that itself sits under a dot-folder is not hidden from itself. The root itself ('' or
 * '.') is `outside`: it is not a path inside the Collection.
 */
export function classifyDocumentPath(root: string, realRoot: string, path: string, kind: PathKind = 'file'): PathVerdict {
  const typed = resolve(root, path)
  const typedRel = relative(root, typed)
  if (typedRel === '' || leavesRoot(typedRel)) return 'outside'
  const real = realLocation(typed)
  if (real === null) return 'outside'
  // Both sides in the on-disk spelling, or a root typed in another letter case would hold nothing.
  const realRel = relative(onDisk(realRoot), real)
  if (leavesRoot(realRel)) return 'outside'
  return hasHiddenFolder(typedRel, kind) || hasHiddenFolder(realRel, kind) ? 'hidden' : 'document'
}
