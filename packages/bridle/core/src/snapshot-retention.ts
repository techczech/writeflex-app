import { readdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { NotTheCheckedFile, SnapshotStoreError, isMissing, openLastName, realFolderAt, sameFile } from './checked-files.ts'

/** What a sweep did. `refused` means the store's folder, its objects folder or its journal is not
 *  what a store may work through (a link, a second name, not where it should be); nothing was
 *  read through it, rewritten or deleted, and `reason` says which. */
export type SnapshotSweepResult = {
  status: 'swept' | 'nothing-to-prune' | 'no-store' | 'refused'
  reason?: string
  /** Journal lines dropped. */
  prunedEntries: number
  /** Names removed from the objects folder. */
  removedObjects: number
}

/**
 * Snapshot retention (Task 17, the Settings window's "Keep for" select): prune journal entries
 * older than `retentionDays` from a Bridle snapshot store (`<workspace>/.bridle`) and delete
 * content objects no kept entry references any more.
 *
 * Runs ONCE per bind, BEFORE the WorkspaceAgent opens the store — the one moment this process is
 * the store's single writer with no appends in flight, which is why a rewrite of the append-only
 * journal is safe here (ADR-0008's no-rewrite rule protects live snapshot operation, not an
 * at-rest compaction). The journal is chronological, so pruning only ever drops a prefix; the
 * restore points Undo turn uses are the newest entries and always survive.
 *
 * The store folder sits inside a workspace that file sync can write, so the sweep establishes the
 * store as `SnapshotStore.open` does before it reads anything: the folder that holds the store is
 * resolved to its real path, the store folder and `objects` must be real folders at exactly that
 * place, and the journal is opened by its own name as a regular file with one name and rewritten
 * through that handle. When any of that does not hold the sweep does nothing and says so.
 */
export async function sweepSnapshots(storeDir: string, retentionDays: number): Promise<SnapshotSweepResult> {
  const none = (status: SnapshotSweepResult['status'], reason?: string): SnapshotSweepResult =>
    ({ status, ...(reason ? { reason } : {}), prunedEntries: 0, removedObjects: 0 })
  const asGiven = resolve(storeDir)
  let holder: string
  try {
    holder = await realpath(dirname(asGiven))
  } catch (error) {
    return isMissing(error) ? none('no-store') : none('refused', 'The snapshot store cannot be used: the folder that holds it cannot be read.')
  }
  const dir = join(holder, basename(asGiven))
  const objectsDir = join(dir, 'objects')
  const journalPath = join(dir, 'journal.jsonl')
  let journal
  let folder
  let objectsFolder
  try {
    folder = await realFolderAt(dir, 'its folder')
    if (folder === null) return none('no-store')
    objectsFolder = await realFolderAt(objectsDir, 'its objects folder')
    journal = await openLastName(journalPath, 'read', { oneName: true })
  } catch (error) {
    if (isMissing(error)) return none('no-store')
    if (error instanceof SnapshotStoreError) return none('refused', error.message)
    if (error instanceof NotTheCheckedFile) {
      return none('refused', 'The snapshot store cannot be used: its journal is a link, is not a regular file, or has more than one name.')
    }
    throw error
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000

  let raw: string
  try {
    raw = await journal.handle.readFile('utf8')
  } finally {
    await journal.handle.close()
  }
  const lines = raw.split('\n').filter(Boolean)
  const kept: string[] = []
  const referencedHashes = new Set<string>()
  for (const line of lines) {
    let entry: { ts?: number; kind?: string; hash?: string }
    try {
      entry = JSON.parse(line) as typeof entry
    } catch {
      kept.push(line) // never discard a line the sweep cannot read
      continue
    }
    if (typeof entry.ts === 'number' && entry.ts < cutoff) continue
    kept.push(line)
    if (entry.kind === 'snapshot' && typeof entry.hash === 'string') referencedHashes.add(entry.hash)
  }
  if (kept.length === lines.length) return none('nothing-to-prune') // nothing aged out; leave the store untouched

  // Rewrite the journal that was read, through a handle: the same regular file, still with one name.
  let rewrite
  try {
    rewrite = await openLastName(journalPath, 'rewrite', { oneName: true })
  } catch (error) {
    if (!(error instanceof NotTheCheckedFile)) throw error
    return none('refused', 'The snapshot store cannot be used: its journal is a link, is not a regular file, or has more than one name.')
  }
  try {
    if (rewrite.created || !sameFile(rewrite.identity, journal.identity)) {
      if (rewrite.created) await rm(journalPath, { force: true }).catch(() => {})
      return none('refused', 'The snapshot store cannot be used: its journal is not the file that was read.')
    }
    await rewrite.handle.truncate(0)
    await rewrite.handle.writeFile(kept.length ? kept.join('\n') + '\n' : '', 'utf8')
  } finally {
    await rewrite.handle.close()
  }
  const result: SnapshotSweepResult = { status: 'swept', prunedEntries: lines.length - kept.length, removedObjects: 0 }

  // Delete objects orphaned by the prune. Objects are content-addressed and shared, so only those
  // referenced by NO kept snapshot go; an unreadable objects dir just leaves them for a later sweep.
  // The folder must still be the real one looked at above; a name is unlinked, never followed.
  if (objectsFolder === null) return result
  let objects: string[]
  try {
    const now = await realFolderAt(objectsDir, 'its objects folder')
    if (now === null || !sameFile(now, objectsFolder)) return result
    objects = await readdir(objectsDir)
  } catch {
    return result
  }
  for (const name of objects) {
    if (referencedHashes.has(name)) continue
    await rm(join(objectsDir, name), { force: true }).then(() => { result.removedObjects += 1 }, () => {})
  }
  return result
}
