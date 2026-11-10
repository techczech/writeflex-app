/**
 * "May this Collection be written now?" — the one question every writer under a Collection asks
 * before it writes: the Workspace (documents, folders, images), the version, scrap and review stores
 * under `.writeflex`, this app's calls into the history store under `.bridle` (gated-snapshots.ts),
 * export when its target lies inside the Collection, and the delete and trash paths.
 *
 * SINCE 2026-11-03 NOTHING IN PRODUCTION CLOSES THIS GATE. It was closed by the Collection owner lock,
 * which was removed: another Mac or program having the Collection open must never pause saving here
 * (docs/plans/2026-11-03-sync-replicas-and-duplicate-reconciliation.md). The gate stays as a seam the
 * tests use to prove each writer asks before it writes; do not wire it to anything synced, remote or
 * lease-like. Removing it entirely is a separate cleanup.
 *
 * Electron-free and dependency-free, so any main-process module can ask.
 */
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** Thrown by a write refused while the gate is closed; the message is for the user. */
export class WritesPausedError extends Error {
  override readonly name = 'WritesPausedError'
}

/** Collection root as paused -> its canonical form and why its writes are paused. */
const paused = new Map<string, { canonical: string; reason: string }>()

/**
 * The one form a path is compared in: absolute, every link resolved and, on a file system that
 * ignores case, the stored spelling. A target that does not exist yet (a file about to be created)
 * is canonical up to its deepest existing folder, with the rest appended as given.
 */
function canonical(path: string): string {
  let existing = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...tail)
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return resolve(path)
      tail.unshift(basename(existing))
      existing = parent
    }
  }
}

/** @internal Tests only (see above). */
export function pauseCollectionWrites(root: string, reason: string): void {
  paused.set(root, { canonical: canonical(root), reason })
}

/** @internal Tests only (see above). */
export function resumeCollectionWrites(root: string): void {
  paused.delete(root)
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)

/**
 * Why `path` may not be written now, or null. The match is a prefix match on the canonical root, so
 * the target is made canonical first: a path that reaches the Collection through a link, by another
 * spelling of its name, or with `..` in it is the same place and gets the same answer.
 */
function pausedReasonFor(path: string): string | null {
  if (paused.size === 0) return null
  let real: string | undefined
  for (const [root, held] of paused) {
    if (within(path, root) || within(path, held.canonical)) return held.reason
    real ??= canonical(path)
    if (within(real, root) || within(real, held.canonical)) return held.reason
  }
  return null
}

/** Whether `path` (absolute: a Collection root or anything inside one) lies in a paused Collection. */
export function collectionWritesPaused(path: string): boolean {
  return pausedReasonFor(path) !== null
}

/**
 * Call before writing `path` (absolute: a Collection root or anything inside one). Throws
 * `WritesPausedError` when that Collection's writes are paused; a path in no paused Collection passes.
 */
export function assertCollectionWritable(path: string): void {
  const reason = pausedReasonFor(path)
  if (reason !== null) throw new WritesPausedError(reason)
}

/** Why `path` may not be written now, in the words shown to the user, or null when it may. For a
 *  writer that reports a refusal as a result and not as a thrown error. */
export function pausedMessage(path: string): string | null {
  return pausedReasonFor(path)
}
