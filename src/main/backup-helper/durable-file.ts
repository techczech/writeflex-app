/**
 * Durable writes and reads for the editor receipts lane (locked plan §10, §13).
 *
 * - `writeFileDurable`: a fresh temporary file in the target's folder, written, synced and closed, then
 *   renamed over the target, then the folder synced. Any failure before the rename removes the temporary
 *   file and leaves the target as it was. A failure of the rename itself or of the folder sync after it is
 *   thrown as WriteOutcomeUnknown (same message, `cause` the original error): the new bytes may already
 *   be what readers see, and the caller may not treat the replacement as durable either. Its `renamed`
 *   says which: true when the rename returned and only the folder sync failed (readers in this boot see
 *   the new bytes; a power loss may still bring back the old ones), false when the rename call itself
 *   failed (POSIX rename is atomic, but the caller cannot be sure without reading the target back). Used for
 *   app-private files only (userData), never for documents. An optional `admit` is asked synchronously
 *   immediately before the rename, after every wait: false refuses the write (WriteRefused), the
 *   temporary file is removed and the target is left as it was.
 * - `readDurableBytes`: the bytes of a document as the disk holds them after a sync of the file and of its
 *   folder. This is the A1 barrier a completed save needs before main may say its bytes are durable: the
 *   bytes are those read back through the synced handle, never what the caller believes it wrote.
 * - `gitBlobOid`: the Git blob id of bytes in either object format (no filters, as the helper's capture
 *   computes it), so a flush names the very bytes the helper will read.
 */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** @internal Test seams: a failure injected at a named step of a durable write. */
export const durableSeams: {
  beforeRename?: (target: string) => void | Promise<void>
  beforeDirSync?: (dir: string) => void | Promise<void>
  /** Synchronous, inside the rename's own failure handling: before it (`renamed` false) or after it took effect (true). */
  atRename?: (target: string, renamed: boolean) => void
} = {}

/** Syncs a folder, so a rename in it survives a power loss. Throws when the folder cannot be synced. */
export async function syncDirectory(dir: string): Promise<void> {
  await durableSeams.beforeDirSync?.(dir)
  const handle = await open(dir, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close().catch(() => {})
  }
}

/** A private folder for app-owned receipt files (0700), made with its parents. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
}

/** A write whose `admit` said no immediately before its rename: nothing was replaced. */
export class WriteRefused extends Error {
  constructor(target: string) {
    super(`${basename(target)} was not replaced: the change it belongs to was withdrawn`)
    this.name = 'WriteRefused'
  }
}

/** The rename was attempted: the target may hold the new bytes (or not), durably or not. */
export class WriteOutcomeUnknown extends Error {
  constructor(readonly target: string, cause: unknown, readonly renamed: boolean) {
    super((cause as Error)?.message ?? String(cause), { cause })
    this.name = 'WriteOutcomeUnknown'
  }
}

/** Replaces `target` with `content`: temporary file synced and closed, renamed, folder synced. */
export async function writeFileDurable(target: string, content: string | Uint8Array, admit?: () => boolean): Promise<void> {
  const dir = dirname(target)
  const temp = join(dir, `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let renamed = false
  try {
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await durableSeams.beforeRename?.(target)
    // No wait between this answer and the rename starting.
    if (admit && !admit()) throw new WriteRefused(target)
    try {
      durableSeams.atRename?.(target, false)
      await rename(temp, target)
      renamed = true
      durableSeams.atRename?.(target, true)
    } catch (error) {
      throw new WriteOutcomeUnknown(target, error, false)
    }
  } finally {
    if (!renamed) await unlink(temp).catch(() => {})
  }
  try {
    await syncDirectory(dir)
  } catch (error) {
    throw new WriteOutcomeUnknown(target, error, true)
  }
}

/** The file's bytes after its data and its folder were synced: what survives a power loss now. */
export async function readDurableBytes(absolute: string): Promise<Buffer> {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    await handle.sync()
    bytes = await handle.readFile()
  } finally {
    await handle.close().catch(() => {})
  }
  await syncDirectory(dirname(absolute))
  return bytes
}

export type ObjectFormat = 'sha1' | 'sha256'
export type BlobOids = { sha1: string; sha256: string }

/** Git's blob id of `bytes`: hash("blob <length>\0" + bytes). */
export function gitBlobOid(bytes: Uint8Array, format: ObjectFormat): string {
  return createHash(format).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}

/** Both formats at once: a save may be made before the helper has said which one its checkout uses. */
export function gitBlobOids(bytes: Uint8Array): BlobOids {
  return { sha1: gitBlobOid(bytes, 'sha1'), sha256: gitBlobOid(bytes, 'sha256') }
}
