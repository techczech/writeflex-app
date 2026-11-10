/**
 * The write-once object area of Folio versions: `.writeflex/folio-objects/<sha256>` (ADR-0052 §
 * Files). Content-addressed bytes for an incoming revision only (her original `.docx`, her sections
 * converted to Markdown). Never rewritten, and checked against its name on every read.
 *
 * THE RULE, the sibling of checked-store-append.ts and checked-store-write.ts (it reuses their
 * `.writeflex` guard). `.writeflex` must be a real folder directly inside the Collection's real root;
 * `folio-objects` must be a real folder directly inside it (made with a non-recursive `mkdir`, which
 * never follows a link at the name). An object name must hold nothing, or an ordinary file with
 * exactly one name whose bytes hash to that name. Anything else (a link, a folder, a pipe, a second
 * name, bytes that do not match the name) is refused and nothing is written or replaced. The one
 * second name that is not refused is the store's own: a temporary file of this object's own
 * (`.<sha256>.<12 hex>.tmp`, in the same folder) that is the same file as the object. That is the
 * state between our `link` and our `unlink`, or what a crash between them leaves; a read accepts it,
 * and the next write of the same bytes removes the orphan. Any other second name (a link made by
 * something else, anywhere) still refuses.
 *
 * A new object goes to a fresh temporary file in the same folder (`O_EXCL|O_NOFOLLOW`), is flushed,
 * read back and re-hashed, and only then linked to its name. `link` fails when anything stands at the
 * name, so it can never replace a file another writer made in the meantime; the temporary name is then
 * removed, and only while it still names our own file. Writing bytes whose object already stands
 * there (and checks out) is a no-op: the existing file is not touched.
 *
 * What it does not do: order writers (content addressing makes two writers of one object harmless).
 * What it cannot stop, because Node has no `openat`: another program changing the disk in the instant
 * between a check and the next step; that is the guarantee of the other two helpers too.
 */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sameFile, storeFolder, StoreAppendRefused } from './checked-store-append'
import { assertCollectionWritable } from './collection-write-gate'
import { isSha256 } from '../shared/folio-version-records'
import { folioObjectTestHooks, onlyOwnNames, ownTemps } from '../shared/folio-object-names'

export { folioObjectTestHooks }

export const FOLIO_OBJECT_FOLDER = 'folio-objects'
const STORE_FOLDER = '.writeflex'

/**
 * The most one object may hold. Equal to the backup projection's per-object limit
 * (`DEFAULT_HISTORY_LIMITS.maxObjectBytes`, history-projection.ts): an object above it would make the
 * whole backup projection unavailable, so none is written.
 */
export const FOLIO_OBJECT_MAX_BYTES = 100 * 1024 * 1024

/** Refused by the rule above; nothing was written. `message` is a plain sentence naming the object. */
export class FolioObjectRefused extends Error {
  override readonly name = 'FolioObjectRefused'
  constructor(readonly rel: string, reason: string) {
    super(`${rel} ${reason}`)
  }
}

const NOT_ORDINARY = 'is not an ordinary file (a link, a folder or something else stands at that name).'
const TWO_NAMES = 'is also known by another name somewhere on this disk.'
const NOT_IN_STORE = `is not inside the Collection's own ${STORE_FOLDER}/${FOLIO_OBJECT_FOLDER} folder (a link stands in that place, or the folder was replaced while the object was being written).`
const WRONG_BYTES = 'does not hold the bytes its name says it holds, so it is not used or replaced.'
const TEMP_REPLACED = 'was not written: its temporary file was replaced or changed while it was being written.'
const TOO_LARGE = `is larger than the ${FOLIO_OBJECT_MAX_BYTES / (1024 * 1024)} MiB a Folio version object may be.`

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code
const NOT_A_FILE = new Set(['ELOOP', 'EMLINK', 'EFTYPE', 'ENXIO', 'EISDIR', 'ENOTDIR', 'EOPNOTSUPP'])
const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const relOf = (sha256: string): string => `${STORE_FOLDER}/${FOLIO_OBJECT_FOLDER}/${sha256}`

type Identity = { dev: number; ino: number }

type Folders = { store: Identity & { path: string }; objects: Identity & { path: string } }

/** `.writeflex` and `folio-objects` are still the real folders judged: same identity, real folders, reached by the root's own name too. */
async function assertFolders(root: string, folders: Folders, rel: string): Promise<void> {
  const store = await storeFolder(root, rel).catch((error: unknown) => {
    if (error instanceof StoreAppendRefused) throw new FolioObjectRefused(rel, NOT_IN_STORE)
    throw error
  })
  if (!sameFile(store, folders.store)) throw new FolioObjectRefused(rel, NOT_IN_STORE)
  const objects = await lstat(folders.objects.path).catch(() => null)
  if (!objects || !objects.isDirectory() || !sameFile(objects, folders.objects)) throw new FolioObjectRefused(rel, NOT_IN_STORE)
}

/** The objects folder as it stands, or null when `.writeflex` or the folder is not there. A link or non-folder refuses. */
async function judgeFolders(root: string, rel: string, create: boolean): Promise<Folders | null> {
  const realRoot = await realpath(root)
  if (create) {
    // Non-recursive: a link at either name fails EEXIST and the guard below refuses it.
    await mkdir(join(realRoot, STORE_FOLDER)).catch((error: unknown) => {
      if (code(error) !== 'EEXIST') throw error
    })
  } else if (!(await lstat(join(realRoot, STORE_FOLDER)).catch(() => null))) {
    return null
  }
  const storeGuard = await storeFolder(root, rel).catch((error: unknown) => {
    if (error instanceof StoreAppendRefused) throw new FolioObjectRefused(rel, NOT_IN_STORE)
    throw error
  })
  const objectsPath = join(storeGuard.path, FOLIO_OBJECT_FOLDER)
  if (create) {
    await mkdir(objectsPath).catch((error: unknown) => {
      if (code(error) !== 'EEXIST') throw error
    })
  }
  const objects = await lstat(objectsPath).catch((error: unknown) => {
    if (code(error) === 'ENOENT') return null
    throw error
  })
  if (!objects) return null
  if (!objects.isDirectory()) throw new FolioObjectRefused(rel, NOT_IN_STORE)
  return { store: storeGuard, objects: { path: objectsPath, dev: objects.dev, ino: objects.ino } }
}

/**
 * The bytes at an object name, by the rule: absent -> null; present -> they hash to `sha256`, else
 * refused. Opened without following a link, judged on the handle, and size-bounded before the read.
 */
async function readObject(path: string, sha256: string, rel: string): Promise<Buffer | null> {
  const entry = await lstat(path).catch((error: unknown) => {
    if (code(error) === 'ENOENT') return null
    throw error
  })
  if (!entry) return null
  if (!entry.isFile()) throw new FolioObjectRefused(rel, NOT_ORDINARY)
  const dir = dirname(path)
  if (!(await onlyOwnNames(dir, sha256, entry))) throw new FolioObjectRefused(rel, TWO_NAMES)
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (code(error) === 'ENOENT') return null
    if (NOT_A_FILE.has(code(error) ?? '')) throw new FolioObjectRefused(rel, NOT_ORDINARY)
    throw error
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFile(opened, entry)) throw new FolioObjectRefused(rel, NOT_ORDINARY)
    // Judged again on the opened file, whatever its link count: an unchanged count proves nothing about who owns the names.
    if (!(await onlyOwnNames(dir, sha256, opened))) throw new FolioObjectRefused(rel, TWO_NAMES)
    if (opened.size > FOLIO_OBJECT_MAX_BYTES) throw new FolioObjectRefused(rel, TOO_LARGE)
    const bytes = await handle.readFile()
    if (sha256Of(bytes) !== sha256) throw new FolioObjectRefused(rel, WRONG_BYTES)
    return bytes
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Read an object by its sha256; null when there is none. Refused (throws `FolioObjectRefused`) when what stands there is not the object its name says. */
export async function getFolioObject(root: string, sha256: string): Promise<Buffer | null> {
  if (!isSha256(sha256)) throw new Error('A Folio version object is named by a lower-case SHA-256 (64 hexadecimal digits).')
  const rel = relOf(sha256)
  const folders = await judgeFolders(root, rel, false)
  if (!folders) return null
  const bytes = await readObject(join(folders.objects.path, sha256), sha256, rel)
  await assertFolders(root, folders, rel)
  return bytes
}

/**
 * Keep `bytes` as an object named by their SHA-256. Writing bytes whose object already stands there is
 * a no-op (`created: false`; the file is not opened for writing). Throws `WritesPausedError` while the
 * Collection is paused and `FolioObjectRefused` by the rule above; nothing has been written then.
 */
export async function putFolioObject(root: string, bytes: Uint8Array): Promise<{ sha256: string; created: boolean }> {
  const sha256 = sha256Of(bytes)
  const rel = relOf(sha256)
  if (bytes.length > FOLIO_OBJECT_MAX_BYTES) throw new FolioObjectRefused(rel, TOO_LARGE)
  assertCollectionWritable(root)
  const folders = (await judgeFolders(root, rel, true))!
  const target = join(folders.objects.path, sha256)
  if (await readObject(target, sha256, rel)) {
    await assertFolders(root, folders, rel)
    await removeOrphanTemps(folders.objects.path, sha256, target)
    return { sha256, created: false }
  }

  const temp = join(folders.objects.path, `.${sha256}.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644)
  let ours: Identity | null = null
  try {
    const opened = await handle.stat()
    ours = { dev: opened.dev, ino: opened.ino }
    // Where did the open land? Judged before a byte is written: a folder swapped for a link is seen here.
    await assertFolders(root, folders, rel)
    await assertTemp(temp, ours, rel)
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await removeIfOurs(temp, ours)
    throw error
  }
  await handle.close()
  let created = true
  try {
    // The last look: place, then the temporary file's bytes read back and re-hashed, then the link.
    await assertFolders(root, folders, rel)
    await assertTemp(temp, ours, rel, sha256)
    try {
      await link(temp, target)
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error
      // Another writer made this object between our look and our link: keep theirs if it checks out.
      if (!(await readObject(target, sha256, rel))) throw error
      created = false
    }
  } finally {
    await removeIfOurs(temp, ours)
  }
  await syncFolder(folders.objects.path)
  return { sha256, created }
}

/**
 * A crash between our `link` and our `unlink` leaves the object with a second name, one of the
 * store's own temporary names. The object has just been read and its bytes checked, so each such name
 * that is the same file as the object is removed. Another writer's temporary name removed here is
 * harmless: that writer only removes its name while it still names its own file.
 */
async function removeOrphanTemps(dir: string, sha256: string, target: string): Promise<void> {
  const entry = await lstat(target).catch(() => null)
  if (!entry || !entry.isFile() || entry.nlink === 1) return
  const temps = await ownTemps(dir, sha256, entry)
  await folioObjectTestHooks.afterOrphanScan?.(temps)
  // Only while the name still names the file that was judged; a substitute put there since stays.
  for (const temp of temps) await removeIfOurs(temp, entry)
}

/** The temporary name still holds our own file (an ordinary one-named file); with `sha256`, also the bytes we wrote. */
async function assertTemp(temp: string, ours: Identity, rel: string, sha256?: string): Promise<void> {
  const entry = await lstat(temp).catch(() => null)
  if (!entry || !entry.isFile() || entry.nlink !== 1 || !sameFile(entry, ours)) throw new FolioObjectRefused(rel, TEMP_REPLACED)
  if (sha256 === undefined) return
  let handle
  try {
    handle = await open(temp, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    throw new FolioObjectRefused(rel, TEMP_REPLACED)
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFile(opened, ours)) throw new FolioObjectRefused(rel, TEMP_REPLACED)
    if (sha256Of(await handle.readFile()) !== sha256) throw new FolioObjectRefused(rel, TEMP_REPLACED)
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

/** Best effort: make the new name itself durable. */
async function syncFolder(path: string): Promise<void> {
  try {
    const handle = await open(path, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close().catch(() => {})
    }
  } catch {
    // Some file systems refuse fsync on a folder; the object's own bytes were already flushed.
  }
}
