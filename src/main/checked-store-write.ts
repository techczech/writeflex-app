/**
 * The one way the app reads and writes a WHOLE store file of its own inside a Collection's
 * `.writeflex` folder (today `.writeflex/vault.json`). The sibling of checked-store-append.ts, which
 * adds lines; this one replaces the file.
 *
 * THREAT MODEL. In scope: sync software (file-sync services, git) and a second WriteFlex window or Mac changing
 * these files concurrently, and links made by accident. Out of scope: a hostile process of the same
 * user, which can already write the folder directly. Even so, this helper never knowingly promotes a
 * file it did not write, and never reports success for bytes it did not write.
 *
 * THE RULE. The folder is judged by the same guard the append uses (`storeFolder`): `.writeflex` must
 * be a real folder directly inside the Collection's real root, never a link, and its identity (device
 * and inode) is kept. The target name must hold nothing, or an ordinary file with exactly one name (a
 * link, a folder or a second name is refused). The new bytes go to a fresh temporary file inside
 * `.writeflex`, opened `O_EXCL|O_NOFOLLOW`. Before a byte is written, after the bytes are flushed, and
 * again just before the file takes its name, the helper checks that the folder is still the one
 * judged (same identity, still a real folder) and that the temporary name still holds the very file
 * the open handle wrote (an ordinary file with one name, same identity). In the last of those checks
 * the temporary file's bytes are also read back (no-follow open, identity equal to the writing
 * handle's) and compared with the content: a temporary file rewritten in place by another program
 * keeps its identity, and is refused by its bytes. A folder swapped for a link
 * before the open is therefore seen before any byte lands outside (at most an empty file is made
 * there, and removed); a temporary file replaced by a link, a second name or another file is never
 * promoted. Then:
 *   - `replace`: renamed over the target. `rename` replaces the name, never follows it.
 *   - `create`: linked to the target name, which fails when anything stands there, so a create can
 *     never replace a file another writer made in the meantime; the temporary name is then removed.
 * When the caller says what the target must still hold (`expect`, the version it read through
 * `readStoreFile`), the target is compared immediately before promotion: its bytes through one
 * no-follow handle, and its identity (device, inode, size, modification and status-change times in
 * nanoseconds; see `StoreFileStamp`) as recorded when the caller read it. After that comparison, the
 * target's identity is looked at once more (one `lstat`) together with the folder and the temporary
 * file, and only then renamed. A difference throws
 * `StoreFileChanged` and nothing is written; any refusal removes the temporary file only while it is
 * still ours.
 *
 * What it does not do: ask the write gate (the caller does) or order writers (the caller's queue).
 * What it cannot stop, because Node has no `openat` and no compare-and-swap rename: another program
 * replacing the target in the instant between that last `lstat` and the `rename`. That is the same
 * guarantee as the app's document saves (guarded-document-write.ts, "writes only over the version it
 * read", 0.23.1), which compare identity and bytes once before the rename; this helper additionally
 * compares against the identity from the caller's own read and repeats the identity check after the
 * byte comparison, so the window is one `lstat` wide.
 */
import { constants, type BigIntStats } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join, posix } from 'node:path'
import { sameFile, storeFolder, StoreAppendRefused } from './checked-store-append'

const STORE_FOLDER = '.writeflex'

/** Refused by the rule above; nothing was written. `message` names the file. */
export class StoreWriteRefused extends Error {
  override readonly name = 'StoreWriteRefused'
  constructor(readonly rel: string, reason: string) {
    super(`${rel} ${reason}`)
  }
}

/** A create found the file already there; nothing was written. */
export class StoreFileExists extends Error {
  override readonly name = 'StoreFileExists'
  constructor(readonly rel: string) {
    super(`${rel} already exists.`)
  }
}

/** The file no longer holds what the caller read; nothing was written. */
export class StoreFileChanged extends Error {
  override readonly name = 'StoreFileChanged'
  constructor(readonly rel: string) {
    super(`${rel} was changed by another program while it was being written.`)
  }
}

const NOT_ORDINARY = 'is not an ordinary file (a link, a folder or something else stands at that name).'
const TWO_NAMES = 'is also known by another name somewhere on this disk, so replacing it would split that file in two.'
const NOT_IN_STORE = `is not inside the Collection's own ${STORE_FOLDER} folder (that folder is a link, or it was replaced while the file was being written).`
const TEMP_REPLACED = 'was not written: its temporary file was replaced by something else while it was being written.'
const TEMP_CHANGED = 'was not written: its temporary file was changed by another program while it was being written.'

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code
const NOT_A_FILE = new Set(['ELOOP', 'EMLINK', 'EFTYPE', 'ENXIO', 'EISDIR', 'ENOTDIR', 'EOPNOTSUPP'])

/** `<name>` for `.writeflex/<name>`; anything else is a programming error. */
function storeName(rel: string): string {
  const parts = posix.normalize(rel).split('/')
  const name = parts[1]
  if (parts.length !== 2 || parts[0] !== STORE_FOLDER || !name || name === '.' || name === '..' || rel.includes('\\')) {
    throw new Error(`checked store write: ${rel} is not a file directly inside ${STORE_FOLDER}.`)
  }
  return name
}

/** The folder guard, with the append's refusal turned into this file's. */
async function folderOf(root: string, rel: string): Promise<{ path: string; dev: number; ino: number }> {
  try {
    return await storeFolder(root, rel)
  } catch (error) {
    if (error instanceof StoreAppendRefused) throw new StoreWriteRefused(rel, NOT_IN_STORE)
    throw error
  }
}

/** The target as it stands: absent, or an ordinary single-named file (anything else refuses). */
async function judgeTarget(path: string, rel: string): Promise<{ dev: number; ino: number } | null> {
  const entry = await lstat(path).catch((error: unknown) => {
    if (code(error) === 'ENOENT') return null
    throw error
  })
  if (!entry) return null
  if (!entry.isFile()) throw new StoreWriteRefused(rel, NOT_ORDINARY)
  if (entry.nlink !== 1) throw new StoreWriteRefused(rel, TWO_NAMES)
  return entry
}

/**
 * What identifies one version of a file on disk: which file it is (device, inode), its size, and its
 * modification and status-change times in nanoseconds. Nanoseconds, because millisecond times (bun
 * reports whole milliseconds) let two writes within one millisecond look alike; the status-change
 * time too, because sync software sets the modification time to the remote one, while the kernel
 * sets the status-change time on every write and nobody can set it back.
 */
export type StoreFileStamp = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }

/** A version of a store file as a caller read it: its bytes and its stamp at the moment of reading. */
export type StoreFileVersion = { bytes: Buffer; stamp: StoreFileStamp }

const stampOf = (entry: BigIntStats): StoreFileStamp => ({ dev: entry.dev, ino: entry.ino, size: entry.size, mtimeNs: entry.mtimeNs, ctimeNs: entry.ctimeNs })
const sameStamp = (a: StoreFileStamp, b: StoreFileStamp): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs

/** The file at `path` read without following a link, with the stamp of what was opened; null when nothing is there. */
async function readNoFollow(path: string, rel: string): Promise<StoreFileVersion | null> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (code(error) === 'ENOENT') return null
    if (NOT_A_FILE.has(code(error) ?? '')) throw new StoreWriteRefused(rel, NOT_ORDINARY)
    throw error
  }
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile()) throw new StoreWriteRefused(rel, NOT_ORDINARY)
    return { bytes: await handle.readFile(), stamp: stampOf(opened) }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** `refused.where`: `folder` when `.writeflex` itself failed the guard, `file` when the file did. */
export type StoreFileRead =
  | { state: 'absent' }
  | { state: 'present'; bytes: Buffer; stamp: StoreFileStamp }
  | { state: 'refused'; where: 'folder' | 'file'; message: string }

/**
 * Read `<root>/<rel>` (`.writeflex/<name>`) by the rule's folder guard, without following a link and
 * without creating anything. No `.writeflex` or no file: `absent`. A `.writeflex` or file that is a
 * link, or not an ordinary file: `refused`. `present` carries the stamp a later `expect` is held to.
 */
export async function readStoreFile(root: string, rel: string): Promise<StoreFileRead> {
  const name = storeName(rel)
  const realRoot = await realpath(root)
  const folderEntry = await lstat(join(realRoot, STORE_FOLDER)).catch(() => null)
  if (!folderEntry) return { state: 'absent' }
  let folder
  try {
    folder = await folderOf(root, rel)
  } catch (error) {
    if (error instanceof StoreWriteRefused) return { state: 'refused', where: 'folder', message: error.message }
    throw error
  }
  try {
    const read = await readNoFollow(join(folder.path, name), rel)
    return read === null ? { state: 'absent' } : { state: 'present', bytes: read.bytes, stamp: read.stamp }
  } catch (error) {
    if (error instanceof StoreWriteRefused) return { state: 'refused', where: 'file', message: error.message }
    throw error
  }
}

export type StoreWriteOptions = {
  /** `create` refuses when anything stands at the name (and makes `.writeflex` when it is missing);
   *  `replace` writes over the file (or makes it). */
  mode: 'create' | 'replace'
  /** What the target must still be just before promotion: the version the caller read (bytes and
   *  stamp, from `readStoreFile`), or null for "absent". */
  expect?: StoreFileVersion | null
}

/**
 * @internal Test seams: each runs inside a write at the named point, never in production. They let a
 * test change the disk at exactly the instant a concurrent writer could.
 */
export type StoreWriteSeams = {
  /** After the folder and target were judged, before the temporary file is opened. */
  beforeTempOpen?: (temp: string) => Promise<void> | void
  /** After the bytes were written and flushed through the open handle, before they are checked. */
  afterTempWrite?: (temp: string) => Promise<void> | void
  /** After the temporary file is closed, before the checks that precede promotion. */
  beforePromote?: (temp: string, target: string) => Promise<void> | void
  /** After the target's bytes were compared with `expect`, before the last look and the rename. */
  afterContentCheck?: (target: string) => Promise<void> | void
}

/** @internal */
export const storeWriteSeams: StoreWriteSeams = {}

type Identity = { dev: number; ino: number }

/** The folder is still the real one judged, and the temporary name still holds the file our handle wrote. */
async function assertInPlace(folder: { path: string } & Identity, temp: string, ours: Identity, rel: string): Promise<void> {
  const now = await lstat(folder.path).catch(() => null)
  if (!now || !now.isDirectory() || !sameFile(now, folder)) throw new StoreWriteRefused(rel, NOT_IN_STORE)
  const entry = await lstat(temp).catch(() => null)
  if (!entry || !entry.isFile() || entry.nlink !== 1 || !sameFile(entry, ours)) throw new StoreWriteRefused(rel, TEMP_REPLACED)
}

/**
 * The temporary file still holds exactly `content`: re-opened without following a link, the opened
 * file is our own (same identity as the handle that wrote it), and its bytes equal what we wrote. Sync
 * software rewriting the same file in place passes every identity check; only the bytes tell.
 */
async function assertTempBytes(temp: string, ours: Identity, content: Buffer, rel: string): Promise<void> {
  let handle
  try {
    handle = await open(temp, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    throw new StoreWriteRefused(rel, TEMP_REPLACED)
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFile(opened, ours)) throw new StoreWriteRefused(rel, TEMP_REPLACED)
    if (!(await handle.readFile()).equals(content)) throw new StoreWriteRefused(rel, TEMP_CHANGED)
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Remove the temporary name only while it still names our own file (never someone's substitute). */
async function removeIfOurs(temp: string, ours: Identity | null): Promise<void> {
  if (!ours) return
  const entry = await lstat(temp).catch(() => null)
  if (entry && entry.isFile() && sameFile(entry, ours)) await unlink(temp).catch(() => {})
}

/** The target is still the version `expect` names: absent, or an ordinary one-named file with those bytes and that stamp. */
async function assertExpected(target: string, expected: StoreFileVersion | null, rel: string): Promise<void> {
  const judged = await judgeTarget(target, rel)
  if (expected === null) {
    if (judged) throw new StoreFileChanged(rel)
    return
  }
  if (!judged) throw new StoreFileChanged(rel)
  const current = await readNoFollow(target, rel)
  if (!current || !sameStamp(current.stamp, expected.stamp) || !current.bytes.equals(expected.bytes)) throw new StoreFileChanged(rel)
}

/** The last look before the rename, by `lstat` only: the target's stamp is still the expected one. */
async function assertStampStill(target: string, expected: StoreFileVersion | null, rel: string): Promise<void> {
  const entry = await lstat(target, { bigint: true }).catch((error: unknown) => {
    if (code(error) === 'ENOENT') return null
    throw error
  })
  if (expected === null) {
    if (entry) throw new StoreFileChanged(rel)
    return
  }
  if (!entry || !entry.isFile() || entry.nlink !== 1n || !sameStamp(stampOf(entry), expected.stamp)) throw new StoreFileChanged(rel)
}

/**
 * Write `content` as the whole of `<root>/<rel>` by the rule in this file's header. Throws
 * `StoreWriteRefused`, `StoreFileExists` or `StoreFileChanged`; nothing has been written then. Returns
 * only once the new bytes stand at the name.
 */
export async function writeStoreFile(root: string, rel: string, content: string, options: StoreWriteOptions): Promise<void> {
  const name = storeName(rel)
  const seams = storeWriteSeams
  if (options.mode === 'create') {
    const realRoot = await realpath(root)
    // `mkdir` never follows a link at the last name: a link there fails EEXIST and the guard refuses it.
    await mkdir(join(realRoot, STORE_FOLDER)).catch((error: unknown) => {
      if (code(error) !== 'EEXIST') throw error
    })
  }
  const folder = await folderOf(root, rel)
  const target = join(folder.path, name)
  const before = await judgeTarget(target, rel)
  if (options.mode === 'create' && before) throw new StoreFileExists(rel)
  // Early and cheap: a target already different from the caller's read is not worth a temporary file.
  if (options.expect !== undefined) await assertExpected(target, options.expect, rel)

  const temp = join(folder.path, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
  await seams.beforeTempOpen?.(temp)
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
  let ours: Identity | null = null
  try {
    const opened = await handle.stat()
    ours = { dev: opened.dev, ino: opened.ino }
    // Where did the open land? Judged before a byte is written: a folder swapped for a link is refused here.
    await assertInPlace(folder, temp, ours, rel)
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await seams.afterTempWrite?.(temp)
    await assertInPlace(folder, temp, ours, rel)
  } catch (error) {
    await handle.close().catch(() => {})
    await removeIfOurs(temp, ours)
    throw error
  }
  await handle.close()

  const bytes = Buffer.from(content, 'utf8')
  let promoted = false
  try {
    await seams.beforePromote?.(temp, target)
    await assertInPlace(folder, temp, ours, rel)
    if (options.mode === 'create') {
      // The last look: the temporary file's bytes, then its place, then the link.
      await assertTempBytes(temp, ours, bytes, rel)
      await assertInPlace(folder, temp, ours, rel)
      await link(temp, target).catch((error: unknown) => {
        if (code(error) === 'EEXIST') throw new StoreFileExists(rel)
        throw error
      })
      promoted = true
      await unlink(temp).catch(() => {})
    } else {
      if (options.expect !== undefined) await assertExpected(target, options.expect, rel)
      else await judgeTarget(target, rel)
      await seams.afterContentCheck?.(target)
      // The last look: the temporary file's bytes read back, one lstat each, then the rename.
      await assertTempBytes(temp, ours, bytes, rel)
      await assertInPlace(folder, temp, ours, rel)
      if (options.expect !== undefined) await assertStampStill(target, options.expect, rel)
      await rename(temp, target)
      promoted = true
    }
  } finally {
    if (!promoted) await removeIfOurs(temp, ours)
  }
  await syncFolder(folder.path)
}

/** Best effort: make the rename itself durable. */
async function syncFolder(path: string): Promise<void> {
  try {
    const handle = await open(path, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close().catch(() => {})
    }
  } catch {
    // Some file systems refuse fsync on a folder; the file's own bytes were already flushed.
  }
}
