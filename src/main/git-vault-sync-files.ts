import { readFileSync, lstatSync } from 'node:fs'
import { fileIdentityOf, type FileIdentity } from './workspace-watcher'
/** Checked, atomic file replacement and compensating rollback. No checkout/reset/stash of the real tree. */
import { open, lstat, readFile, rename, unlink, mkdir, rmdir, chmod, utimes, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { refuse, siblingBlocked, type GitVaultSyncOptions } from './git-vault-sync-types'
import { internalKind } from './git-vault-sync-internals'
import { safePath, machineState, excludedSyncPath, type SyncGit, type TreeEntry } from './git-vault-sync-git'
export type FileImage = { bytes: Buffer; mode: number; atime: Date; mtime: Date; identity?: FileIdentity } | null
export type FileChange = { path: string; before: FileImage; after: { bytes: Buffer; mode: number } | null }
export async function image(path: string): Promise<FileImage> {
  try {
    const st = await lstat(path)
    if (!st.isFile() || st.isSymbolicLink()) refuse('unsupported', 'A symbolic link or folder blocks a document update.')
    if (st.size > 32 * 1024 * 1024) refuse('unsupported', 'A document is too large for a safe automatic update.')
    return { bytes: await readFile(path), mode: st.mode & 0o777, atime: st.atime, mtime: st.mtime, identity: fileIdentityOf(await lstat(path, {bigint:true})) }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
function equal(a: FileImage, b: FileImage): boolean { return a === null || b === null ? a === b : a.mode === b.mode && a.bytes.equals(b.bytes) && (!a.identity || !b.identity || (a.identity.dev === b.identity.dev && a.identity.ino === b.identity.ino && a.identity.mtimeNs === b.identity.mtimeNs)) }
async function parents(root: string, path: string, created?: string[]): Promise<void> {
  const parts = path.split('/').slice(0, -1); let folder = root
  for (const part of parts) {
    folder = join(folder, part)
    try { const st = await lstat(folder); if (!st.isDirectory() || st.isSymbolicLink()) refuse('unsupported', 'A symbolic link or file blocks a document folder.') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!created) continue
      await mkdir(folder); created.push(folder)
    }
  }
}
/** Observe the saved versions used to prepare a commit; saves during a network/scan wait must win. */
export async function observeFiles(root: string, paths: Iterable<string>, observed: Map<string, FileImage>): Promise<void> {
  for (const path of paths) if (!observed.has(path)) { await parents(root, path); observed.set(path, await image(join(root, path))) }
}
export async function checkObserved(root: string, observed: Map<string, FileImage>, prefix = ''): Promise<void> {
  for (const [path, before] of observed) {
    if (internalKind(path)) continue
    await parents(root, path)
    if (!equal(await image(join(root, path)), before)) refuse('local-changes', 'A document was saved while sync was preparing. Its latest writing was kept; try again.', path.slice(prefix.length))
  }
}
export async function planFiles(git: SyncGit, root: string, prefix: string, oldTree: Map<string, TreeEntry>, newTree: Map<string, TreeEntry>, dirty: Set<string>, observed: Map<string, FileImage> = new Map()): Promise<FileChange[]> {
  const plan: FileChange[] = []
  for (const path of new Set([...oldTree.keys(), ...newTree.keys()])) {
    const beforeEntry = oldTree.get(path), afterEntry = newTree.get(path)
    if (beforeEntry?.oid === afterEntry?.oid && beforeEntry?.mode === afterEntry?.mode) continue
    if (path.startsWith(prefix) && (internalKind(path) === 'local' || excludedSyncPath(path))) continue
    if (!safePath(path) || (afterEntry && !['100644', '100755'].includes(afterEntry.mode))) refuse('unsupported', 'An internal history file or unsupported file type needs an update outside WriteFlex.')
    await parents(root, path)
    const current = await image(join(root, path))
    const before = path.startsWith(prefix) && internalKind(path) && observed.has(path) ? observed.get(path)! : current
    const after = afterEntry ? { bytes: await git.ok(['cat-file', 'blob', afterEntry.oid]), mode: before ? (before.mode & 0o666) | (afterEntry.mode === '100755' ? 0o111 : 0) : afterEntry.mode === '100755' ? 0o755 : 0o644 } : null
    const changesDisk = before === null || after === null ? before !== after : !before.bytes.equals(after.bytes) || (before.mode & 0o111) !== (after.mode & 0o111)
    if (!changesDisk) continue
    // Incoming changes may update siblings, but never overwrite ANY staged, unstaged or untracked sibling work.
    if (!path.startsWith(prefix) && (dirty.has(path) || (!beforeEntry && before))) siblingBlocked()
    if (!internalKind(path) && !beforeEntry && before && !dirty.has(path)) refuse('local-changes', 'A local file blocks an incoming document.', relative(join(root, prefix), join(root, path)))
    plan.push({ path, before, after })
  }
  const folded = plan.map(p => p.path.toLowerCase())
  if (new Set(folded).size !== folded.length) refuse('unsupported', 'Two document names differ only in letter case. Update them outside WriteFlex.')
  return plan
}
async function replace(path: string, bytes: Buffer, mode: number, beforeRename?: (identity: FileIdentity) => void): Promise<FileIdentity> {
  const temp = join(dirname(path), `.writeflex-sync-${randomUUID()}.tmp`)
  try {
    const fd = await open(temp, 'wx', mode)
    let identity: FileIdentity
    try { await fd.writeFile(bytes); await fd.sync(); identity = fileIdentityOf(await fd.stat({ bigint: true })) } finally { await fd.close() }
    await chmod(temp, mode); beforeRename?.(identity!); await rename(temp, path); return identity!
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
export async function applyFiles(root: string, plan: FileChange[], checkpoint: GitVaultSyncOptions['checkpoint'], prefix = '', preserved?: (path: string) => void, ownWrite?: GitVaultSyncOptions['ownWrite'], withFileLock: NonNullable<GitVaultSyncOptions['withFileLock']> = async (_path, work) => work()): Promise<{ rollback: () => Promise<void>; deferred: string[] }> {
  const written: FileChange[] = [], created: string[] = [], deferred = new Set<string>()
  const rollback = async () => {
    for (const change of [...written].reverse()) {
      const path = join(root, change.path)
      await withFileLock(path, async () => {
      const current = await image(path)
      const stillOurs = change.after === null ? current === null : current !== null && current.mode === change.after.mode && current.bytes.equals(change.after.bytes)
      // Compensate only our write. A newer app save/ledger append must never be rolled back over.
      if (!stillOurs) { preserved?.(change.path.startsWith(prefix) ? change.path.slice(prefix.length) : change.path); return }
      if (change.before) { await replace(path, change.before.bytes, change.before.mode); await utimes(path, change.before.atime, change.before.mtime) }
      else await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error })
      })
    }
    for (const dir of created.reverse()) await rmdir(dir).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error })
  }
  try {
    // Recheck after the network wait, before any document is changed.
    for (const change of plan) {
      await parents(root, change.path)
      if (!equal(await image(join(root, change.path)), change.before)) {
        if (change.path.startsWith(prefix) && internalKind(change.path)) deferred.add(change.path)
        else refuse('local-changes', 'A document changed while sync was preparing. Try again.', change.path.slice(prefix.length))
      }
    }
    for (const change of plan) {
      if (deferred.has(change.path)) continue
      await parents(root, change.path, created)
      const path = join(root, change.path)
      await withFileLock(path, async () => {
      if (!equal(await image(path), change.before)) {
        if (change.path.startsWith(prefix) && internalKind(change.path)) { deferred.add(change.path); return }
        refuse('local-changes', 'A document changed while sync was applying. Its latest writing was kept.', change.path.slice(prefix.length))
      }
      const check = () => {
        let current: FileImage = null
        try { const st = lstatSync(path,{bigint:true}); if (!st.isFile() || st.isSymbolicLink()) refuse('local-changes','The document changed before sync could apply.',change.path.slice(prefix.length)); current = {bytes:readFileSync(path),mode:Number(st.mode)&0o777,atime:new Date(),mtime:new Date(),identity:fileIdentityOf(st)} }
        catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        if (!equal(current,change.before)) refuse('local-changes','A newer save was kept instead of the incoming writing.',change.path.slice(prefix.length))
      }
      if (change.after) { const identity = await replace(path, change.after.bytes, change.after.mode, expected => { ownWrite?.(path, expected); check(); written.push(change) }) }
      else { ownWrite?.(path, 'absent'); check(); written.push(change); await unlink(path) }
      })
      await checkpoint?.('after-write')
    }
    return { rollback, deferred: [...deferred] }
  } catch (error) {
    try { await rollback() } catch { refuse('rollback-failed', 'Sync stopped while restoring an update. Keep this folder here and try again.') }
    throw error
  }
}

/** A dead apply can leave a staged replacement. Only our exact UUID names, never links. */
export async function cleanSyncTemps(vault: string): Promise<void> {
  for (const entry of await readdir(vault,{withFileTypes:true})) {
    if (entry.name === '.git' || entry.isSymbolicLink()) continue
    const path=join(vault,entry.name)
    if (entry.isDirectory()) await cleanSyncTemps(path)
    else if (entry.isFile() && /^\.writeflex-sync-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(entry.name)) await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error})
  }
}
