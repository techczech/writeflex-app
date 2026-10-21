/**
 * File handling for the request inbox and outbox, and the app's record of handled requests: the
 * folders under `.writeflex` that both sides write, and that neither side trusts.
 *
 * - A folder is used only if it is an ordinary folder at its own place: `.writeflex` and the folder
 *   inside it are checked one by one for a link or a file standing in their place, and the real
 *   location must be `<Collection>/.writeflex/<name>`.
 * - A folder is then HELD (`holdFolder`): opened once, and the opened folder's identity (device and
 *   file number) kept. Immediately before every read, every write, every removal and every listing,
 *   the name is looked at again: it must still be a folder, the very one that was opened, at the
 *   expected real location. A reply or record is written under a temporary name, the folder verified
 *   again together with the temporary file's own identity, and only then renamed to its name. A read
 *   is verified again after it, so text read while the folder was swapped is thrown away.
 * - A file is read through one open handle, opened so that a final link is not followed and a pipe
 *   cannot stall it; whether it is a regular file and whether it is within the size cap are both
 *   decided on that handle, before a byte is read.
 *
 * THE WINDOW THAT REMAINS. Node cannot act relative to an open folder (no `openat`, `renameat` or
 * `unlinkat`), so each system call still names its file by path. Between the verification and the
 * call that follows it, a program swapping the folder for a link redirects that one call: one open
 * for reading (what is read is then discarded if the swap is still in place afterwards, and is in any
 * case validated as a request before anything acts on it), one creation of a temporary file (seen and
 * removed at the next verification), one rename of a file this code just wrote or of a request to
 * or from its claimed name, or one removal of a file named `<id>.json`. A swap made and undone inside
 * that single call is not seen.
 */
import { randomBytes } from 'node:crypto'
import { constants, realpathSync, type Dirent, type Stats } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

export class FolderNotUsableError extends Error {
  override readonly name = 'FolderNotUsableError'
}

/** The verified folder `<root>/<dir>` (`dir` like `.writeflex/inbox`), or null when it is missing and `create` is false. */
export async function privateFolder(root: string, dir: string, create: boolean): Promise<string | null> {
  let current = root
  for (const segment of dir.split('/')) {
    current = join(current, segment)
    let info = await lstat(current).catch(() => null)
    if (!info) {
      if (!create) return null
      await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
      info = await lstat(current)
    }
    if (!info.isDirectory()) throw new FolderNotUsableError(`${dir} is not an ordinary folder (a link or a file stands in its place), so it is not used.`)
  }
  if (await realpath(current) !== join(realpathSync(root), ...dir.split('/'))) {
    throw new FolderNotUsableError(`${dir} does not lie inside this Collection, so it is not used.`)
  }
  return current
}

export type CappedRead =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  /** A link, a folder, a pipe, a device: never read. */
  | { kind: 'not-a-file' }
  | { kind: 'too-large'; size: number }

/**
 * Read `path` as UTF-8 if it is a regular file of at most `maxBytes`. One handle decides everything:
 * it is opened without following a final link (a link fails to open) and without waiting (a pipe
 * with no writer does not stall the caller), and the regular-file check and the size cap are applied
 * to the file that was actually opened, before reading. No more than the size seen is ever read.
 */
export async function readCapped(path: string, maxBytes: number): Promise<CappedRead> {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'not-a-file' }
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) return { kind: 'not-a-file' }
    if (opened.size > maxBytes) return { kind: 'too-large', size: opened.size }
    const buffer = Buffer.alloc(opened.size)
    let read = 0
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return { kind: 'text', text: buffer.subarray(0, read).toString('utf8') }
  } finally {
    await handle.close()
  }
}

/**
 * At most `max` entries of the folder at `path`, in the file system's order, and whether there were
 * more. The entries are taken from the open directory one at a time and the reading stops at `max`:
 * a folder of a million planted files costs `max` entries, not a million. The one way a folder that
 * anything can fill is listed, by the app and by the command line.
 */
export async function entriesUpTo(path: string, max: number): Promise<{ entries: Dirent[]; more: boolean }> {
  const entries: Dirent[] = []
  let more = false
  const directory = await opendir(path)
  try {
    for (;;) {
      const entry = await directory.read()
      if (entry === null) break
      if (entries.length >= max) { more = true; break }
      entries.push(entry)
    }
  } finally {
    try { await directory.close() } catch { /* already closed */ }
  }
  return { entries, more }
}

/** Add to a Set kept to at most `max` members: the oldest added is forgotten first. */
export function rememberUpTo<T>(set: Set<T>, value: T, max: number): void {
  set.delete(value)
  set.add(value)
  for (const oldest of set) {
    if (set.size <= max) break
    set.delete(oldest)
  }
}

/** The same for a Map: at most `max` keys, the oldest set forgotten first. */
export function keepUpTo<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key)
  map.set(key, value)
  for (const oldest of map.keys()) {
    if (map.size <= max) break
    map.delete(oldest)
  }
}

/** @internal Test seam: runs after the temporary file is written and before the folder is verified for the rename. */
export type HeldWriteSeams = { beforeRename?: () => Promise<void> }

/** One of the request folders, opened once and verified before each use (see the top of this file). */
export class HeldFolder {
  constructor(
    readonly path: string,
    private readonly dir: string,
    private readonly root: string,
    private readonly handle: FileHandle,
    private readonly identity: { ino: number; dev: number },
  ) {}

  /** Throws unless the name still leads to the folder that was opened, at its expected real location. */
  async verify(): Promise<void> {
    const gone = (): never => {
      throw new FolderNotUsableError(`${this.dir} changed while it was in use (it is no longer the ordinary folder that was opened), so it is not used.`)
    }
    const named = await lstat(this.path).catch(() => null)
    if (!named?.isDirectory() || named.ino !== this.identity.ino || named.dev !== this.identity.dev) gone()
    const real = await realpath(this.path).catch(() => null)
    if (real !== join(realpathSync(this.root), ...this.dir.split('/'))) gone()
  }

  /**
   * At most `max` of the folder's entry names, sorted, and whether there were more (`entriesUpTo`).
   * There is no unbounded listing: this is the only way a held folder is listed. Which entries a cut
   * listing holds is the file system's order, not oldest first.
   */
  async namesUpTo(max: number): Promise<{ names: string[]; more: boolean }> {
    await this.verify()
    const { entries, more } = await entriesUpTo(this.path, max)
    await this.verify()
    return { names: entries.map((entry) => entry.name).sort(), more }
  }

  /** Read `<folder>/<name>` under the cap. Text read while the folder was swapped is never returned. */
  async read(name: string, maxBytes: number): Promise<CappedRead> {
    await this.verify()
    const read = await readCapped(join(this.path, name), maxBytes)
    await this.verify()
    return read
  }

  /** What stands at `<folder>/<name>`, without following a link; null when nothing does. */
  async look(name: string): Promise<Stats | null> {
    await this.verify()
    return lstat(join(this.path, name)).catch(() => null)
  }

  /** Create or replace `<folder>/<name>` whole: a temporary name, flushed, the folder verified again, renamed in. */
  async write(name: string, text: string | Uint8Array, seams: HeldWriteSeams = {}, mode = 0o600): Promise<void> {
    await this.verify()
    const staged = join(this.path, `.${name}.${randomBytes(4).toString('hex')}.tmp`)
    const handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    let written: Stats
    try {
      await handle.writeFile(text)
      await handle.sync().catch(() => {})
      written = await handle.stat()
    } catch (error) {
      await handle.close().catch(() => {})
      await unlink(staged).catch(() => {})
      throw error
    }
    await handle.close()
    try {
      await seams.beforeRename?.()
      // The folder is still the one opened, and the temporary file in it is the one just written.
      await this.verify()
      const there = await lstat(staged).catch(() => null)
      if (!there?.isFile() || there.ino !== written.ino || there.dev !== written.dev) {
        throw new FolderNotUsableError(`${this.dir} changed while a file was being written into it, so the file was not put in place.`)
      }
      await rename(staged, join(this.path, name))
    } catch (error) {
      // Only if the name still leads to the held folder: never remove by a name that leads elsewhere.
      if (await this.verify().then(() => true, () => false)) await unlink(staged).catch(() => {})
      throw error
    }
  }

  /** Remove `<folder>/<name>`. Never follows a link; a folder standing at the name stays. Answers
   *  whether THIS call removed it: false when nothing was there to remove (another had taken it). */
  async remove(name: string): Promise<boolean> {
    await this.verify()
    return unlink(join(this.path, name)).then(() => true, () => false)
  }

  /**
   * Give `<folder>/<from>` the name `<folder>/<to>`, replacing a file already at that name. One
   * system call that only one caller can win for a given `from`: `missing` when nothing stood at
   * `from` (another renamed or removed it first), `failed` when the rename was refused (a folder
   * stands at `to`). Never follows a link: a link is renamed as the link it is.
   */
  async rename(from: string, to: string): Promise<'renamed' | 'missing' | 'failed'> {
    await this.verify()
    try {
      await rename(join(this.path, from), join(this.path, to))
      return 'renamed'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'failed'
    }
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => {})
  }
}

/**
 * Check `<root>/<dir>` as `privateFolder` does, then open it and keep it open. Null when it is
 * missing and `create` is false. The caller closes it.
 */
export async function holdFolder(root: string, dir: string, create: boolean): Promise<HeldFolder | null> {
  const path = await privateFolder(root, dir, create)
  if (path === null) return null
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  } catch {
    throw new FolderNotUsableError(`${dir} is not an ordinary folder (a link or a file stands in its place), so it is not used.`)
  }
  try {
    const opened = await handle.stat()
    const held = new HeldFolder(path, dir, root, handle, { ino: opened.ino, dev: opened.dev })
    await held.verify() // what was opened is what was checked
    return held
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}
