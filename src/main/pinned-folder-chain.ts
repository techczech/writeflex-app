/**
 * A chain of folders from a Collection's real root down to one folder inside it, each pinned by device
 * and inode, for the replica store and the sync reconciler (contract
 * docs/plans/2026-11-03-sync-replicas-and-duplicate-reconciliation.md rule 2: path containment).
 *
 * WHY. Those modules await between finding a folder and writing into it (a read, a hash, a test seam).
 * Something can move a folder aside in that time and put a link, or another folder, at its name. A
 * write by name would then land wherever the link leads, outside the Collection. So a writer pins the
 * chain first, and in the same synchronous step as the write (nothing else in this process runs
 * between the check and the write) confirms that every folder on the way is still physically the one
 * pinned: the same real path (no link anywhere), not a link itself, and the same device and inode.
 * The check is guarded-document-write.ts `standsAsPinnedFolder`, repeated here so the command line's
 * import graph stays small.
 *
 * Reads through a pinned chain are synchronous and bounded: the file is opened without following a link,
 * its size checked before anything is buffered, and a file that grows or shrinks while read is refused.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'

export type PinnedFolder = { real: string; dev: number; ino: number }
export type PinnedChain = { real: string; folders: PinnedFolder[] }

export class PinnedChainRefused extends Error {
  override readonly name = 'PinnedChainRefused'
}

/**
 * Pin `<root>/<rel>` one folder at a time from the root's real path ('' pins the root alone). With
 * `make`, a missing folder is made. Null when a folder is missing and `make` is false. A link or a
 * file anywhere on the way throws PinnedChainRefused.
 */
export function pinChain(root: string, rel: string, make: boolean): PinnedChain | null {
  const rootReal = realpathSync.native(root)
  const rootInfo = lstatSync(rootReal)
  if (!rootInfo.isDirectory()) throw new PinnedChainRefused('The Collection is not a folder.')
  const folders: PinnedFolder[] = [{ real: rootReal, dev: rootInfo.dev, ino: rootInfo.ino }]
  let current = rootReal
  for (const part of rel.split('/').filter(Boolean)) {
    if (part === '.' || part === '..') throw new PinnedChainRefused(`${rel} is not a folder inside the Collection.`)
    current = join(current, part)
    let info = lstatSync(current, { throwIfNoEntry: false })
    if (!info) {
      if (!make) return null
      try { mkdirSync(current) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      info = lstatSync(current)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new PinnedChainRefused(`${rel} is not an ordinary folder inside the Collection (a link or a file stands in its place).`)
    }
    folders.push({ real: current, dev: info.dev, ino: info.ino })
  }
  return { real: current, folders }
}

/** Whether every folder of `chain` is, at this instant, physically the one pinned. Synchronous. */
export function chainStands(chain: PinnedChain): boolean {
  for (const folder of chain.folders) {
    try {
      if (realpathSync.native(folder.real) !== folder.real) return false
      const now = lstatSync(folder.real)
      if (now.isSymbolicLink() || !now.isDirectory() || now.dev !== folder.dev || now.ino !== folder.ino) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Read exactly the `expected` bytes from an open descriptor, never more than `limit`: null when the file
 * holds more or fewer bytes than its size said (it changed while read). Synchronous.
 */
export function readBoundedSync(fd: number, expected: number, limit: number): Buffer | null {
  if (expected > limit) return null
  const buffer = Buffer.allocUnsafe(expected + 1)
  let total = 0
  while (total < buffer.length) {
    const n = readSync(fd, buffer, total, buffer.length - total, total)
    if (n === 0) break
    total += n
  }
  return total === expected ? buffer.subarray(0, total) : null
}

/**
 * The bytes of `name` in the pinned folder, only while the chain stands: opened without following a link,
 * an ordinary file of at most `limit` bytes, read whole and unchanged in size. Otherwise null. Synchronous.
 */
export function readPinnedSync(chain: PinnedChain, name: string, limit: number): Buffer | null {
  if (!chainStands(chain)) return null
  let fd: number
  try { fd = openSync(join(chain.real, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch { return null }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > limit) return null
    return readBoundedSync(fd, info.size, limit)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/**
 * The bytes of `name` in the pinned folder, read asynchronously (a cloud placeholder may take time to
 * deliver, and the app must not stop while it does). The chain is checked in the tick the file is
 * opened; after the open the descriptor holds that file whatever happens to the folders. Bounded like
 * readPinnedSync: size checked before buffering, and a file that changes size while read is refused.
 */
export async function readPinned(chain: PinnedChain, name: string, limit: number): Promise<Buffer | null> {
  if (!chainStands(chain)) return null
  let handle
  try { handle = await open(join(chain.real, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch { return null }
  try {
    const info = await handle.stat()
    // The file opened is the one in the pinned folder (not one reached through a folder swapped during the open).
    const standing = chainStands(chain) ? lstatSync(join(chain.real, name), { throwIfNoEntry: false }) : undefined
    if (!info.isFile() || !standing || standing.ino !== info.ino || standing.dev !== info.dev || info.size > limit) return null
    const buffer = Buffer.allocUnsafe(info.size + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    return total === info.size ? buffer.subarray(0, total) : null
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
}
