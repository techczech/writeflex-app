/**
 * What to tell a caller when Bridle's snapshot store did not put a restore point back
 * (`SnapshotStore.restoreTo`, reached through gated-snapshots.ts). Two failures carry facts the
 * writer needs and must never be swallowed:
 *
 *  - `RestoreRefusedError`: the restore point names a path the store will not write, so the WHOLE
 *    restore was refused before anything was changed. Nothing was put back.
 *  - `RestoreIncompleteError`: the restore passed its checks and then failed part-way. Some files
 *    were put back and some were not; the error lists both.
 *
 * Every caller of `restoreTo` in this app goes through `restoreFailure` and reports the sentence in
 * its own result shape. A rollback that half happened is said to have half happened.
 */
import { isAbsolute, relative, sep } from 'node:path'
import { RestoreIncompleteError, RestoreRefusedError } from '@bridle/core'

export type RestoreFailure = {
  kind: 'refused' | 'incomplete' | 'failed'
  /** For the writer: what was and was not put back. */
  message: string
  /** Paths put back before the failure, as the store shows them (empty unless `incomplete`). */
  restored: string[]
  /** Paths not put back, as the store shows them (the failing one first; the refused ones when `refused`). */
  notRestored: string[]
}

const listed = (paths: string[], shown: (path: string) => string): string => {
  const first = paths.slice(0, 5).map(shown).join(', ')
  return paths.length > 5 ? `${first} and ${paths.length - 5} more` : first
}

/**
 * `error`, thrown by `restoreTo`, as a sentence and the two lists. With `root` (the Collection's
 * folder), a path the store gives in full is shown relative to it; any other is shown as given.
 */
export function restoreFailure(error: unknown, root?: string): RestoreFailure {
  const shown = (path: string): string => {
    if (root === undefined || !isAbsolute(path)) return path
    const rel = relative(root, path)
    return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? path : rel.split(sep).join('/')
  }
  if (error instanceof RestoreRefusedError) {
    const notRestored = error.refusals.map((refusal) => refusal.path)
    const why = error.refusals.slice(0, 5).map((refusal) => `${shown(refusal.path)} (${refusal.reason})`).join('; ')
    const more = error.refusals.length > 5 ? `; and ${error.refusals.length - 5} more` : ''
    return { kind: 'refused', restored: [], notRestored, message: `The earlier state was not put back, and no file was changed by the attempt, because it includes a file WriteFlex will not write: ${why}${more}.` }
  }
  if (error instanceof RestoreIncompleteError) {
    const put = error.restored.length ? `Put back: ${listed(error.restored, shown)}.` : 'Nothing was put back.'
    const not = error.notRestored.length ? ` Not put back: ${listed(error.notRestored, shown)}.` : ''
    return { kind: 'incomplete', restored: [...error.restored], notRestored: [...error.notRestored], message: `Only part of the earlier state was put back (${error.reason}). ${put}${not}` }
  }
  return { kind: 'failed', restored: [], notRestored: [], message: `The earlier state could not be put back (${error instanceof Error ? error.message : String(error)}).` }
}

/** A restore that did not complete, thrown by a caller whose own result is a thrown error: the sentence is its message. */
export class RestoreNotCompletedError extends Error {
  override readonly name = 'RestoreNotCompletedError'
  constructor(prefix: string, readonly failure: RestoreFailure, cause: unknown) {
    super(`${prefix} ${failure.message}`, { cause })
  }
}
