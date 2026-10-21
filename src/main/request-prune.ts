/**
 * What a look at the inbox clears away afterwards: replies nobody collected and temporary files
 * nobody renamed in the outbox, and in the app's records (application data) the handled-request
 * receipts and undelivered answers past their keep.
 *
 * BOUNDED LIKE EVERY LISTING. Each folder is listed up to `MAX_ENTRIES_LISTED` entries
 * (cli/review-format.ts) and no further, so a folder that sync or a program has filled costs one
 * look that many entries. A cut listing still removes what is stale among the entries it holds, so a
 * folder over the limit is worked down look by look. `pruneRequestFolders` names the folders whose
 * listing was cut.
 */
import { HANDLED_KIND, UNDELIVERED_KIND } from './collection-records'
import type { HeldFolder } from './cli/request-files'
import { idOfFileName } from './cli/request-format'
import { MAX_ENTRIES_LISTED } from './cli/review-format'

export const HANDLED_KEEP_MS = 7 * 24 * 60 * 60_000
/** A reply nobody collected, and a temporary file nobody renamed, are removed after this long. */
export const STALE_FILE_MS = 60 * 60_000

/** A folder one look lists: the two request folders in the Collection, and the app's two record folders. */
export type ListedFolder = 'inbox' | 'outbox' | typeof HANDLED_KIND | typeof UNDELIVERED_KIND

/** Remove a regular file last written more than `keepMs` ago. Never a folder, never through a link. */
export async function removeIfStale(folder: HeldFolder, name: string, nowMs: number, keepMs = STALE_FILE_MS): Promise<void> {
  const info = await folder.look(name)
  if (!info || info.isDirectory() || nowMs - info.mtimeMs <= keepMs) return
  await folder.remove(name)
}

/** One folder: what is ours by name and stale goes. Returns whether the listing was cut. */
async function prune(folder: HeldFolder, nowMs: number, keepMs: number): Promise<boolean> {
  const { names, more } = await folder.namesUpTo(MAX_ENTRIES_LISTED)
  for (const name of names) {
    if (name.endsWith('.tmp')) await removeIfStale(folder, name, nowMs, STALE_FILE_MS)
    else if (idOfFileName(name) !== null) await removeIfStale(folder, name, nowMs, keepMs)
  }
  return more
}

/** `undelivered` opens the undelivered-answers folder if there is one; this closes it. */
export async function pruneRequestFolders(folders: { outbox: HeldFolder; records: HeldFolder; undelivered: () => Promise<HeldFolder | null> }, nowMs: number): Promise<ListedFolder[]> {
  const cut: ListedFolder[] = []
  if (await prune(folders.outbox, nowMs, STALE_FILE_MS)) cut.push('outbox')
  if (await prune(folders.records, nowMs, HANDLED_KEEP_MS)) cut.push(HANDLED_KIND)
  // Answers that could not be delivered are kept as long as a handled-request record is.
  const undelivered = await folders.undelivered().catch(() => null)
  if (!undelivered) return cut
  try {
    if (await prune(undelivered, nowMs, HANDLED_KEEP_MS)) cut.push(UNDELIVERED_KIND)
  } finally {
    await undelivered.close()
  }
  return cut
}
