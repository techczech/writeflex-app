/**
 * The one way the app adds a line to a store file of its own inside a Collection (today
 * `.writeflex/versions.jsonl` alone; the change ledger and the scraps write by rename into place).
 *
 * THE RULE. It opens `<root>/<rel>` for appending without following a link (`O_NOFOLLOW`), creating
 * it only when nothing stands at that name (`O_CREAT|O_EXCL`, which never follows a link either).
 * On the open handle it checks that the file is an ordinary file with exactly one name, and that this
 * one name lies directly inside the Collection's real `.writeflex` folder, itself a real folder
 * directly inside the Collection's real root. Anything else (a link, a dangling link, a folder, a
 * pipe, a file with a second name anywhere on the disk, a `.writeflex` that is itself a link) is
 * refused before a byte is written, with a sentence that names the file.
 *
 * Why the checks are on the handle: the name can be replaced between any check made by name and the
 * write. Opening without following and then judging what was opened leaves only one way in, and the
 * bytes go through that same handle. `O_NONBLOCK` keeps a pipe planted at the name from holding the
 * open for ever (it fails with ENXIO and is refused); it has no effect on an ordinary file.
 *
 * What it does not do: decide whether the Collection may be written (the caller asks the write gate
 * first) or order writers (the caller's own queue, and the Collection's write turn where it applies).
 * What it does not stop, because Node has no `openat`: another program changing the disk in the
 * instant between a check and the next step. Between the check and the write, the journal's one name
 * renamed away or given a second name: the line still goes into the journal file the handle holds,
 * which is no other document's bytes. Between the folder's check and the open, `.writeflex` replaced
 * by a link: a first append may create an EMPTY file in the link's target; the check on the handle
 * then refuses and no byte is written.
 */
import { constants, closeSync, fsyncSync, fstatSync, lstatSync, openSync, realpathSync, readSync, statSync, writeSync } from 'node:fs'
import { lstat, open, stat, realpath, type FileHandle } from 'node:fs/promises'
import { join, posix } from 'node:path'

const STORE_FOLDER = '.writeflex'

/** Refused by the rule above. `message` is a plain sentence naming the file; `rel` is that file. */
export class StoreAppendRefused extends Error {
  override readonly name = 'StoreAppendRefused'
  constructor(readonly rel: string, reason: string) {
    super(`${rel} ${reason}`)
  }
}

const NOT_ORDINARY = 'is not an ordinary file (a link, a folder or something else stands at that name).'
const TWO_NAMES = 'is also known by another name somewhere on this disk, so adding to it would change that file too.'
const NOT_IN_STORE = `is not inside the Collection's own ${STORE_FOLDER} folder (that folder is a link, or the file was moved while it was being opened).`

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

export const sameFile = (a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean => a.dev === b.dev && a.ino === b.ino

/** Errors of an open that mean something other than an ordinary file stands at the name. */
const NOT_A_FILE = new Set(['ELOOP', 'EMLINK', 'EFTYPE', 'ENXIO', 'EISDIR', 'ENOTDIR', 'EOPNOTSUPP'])

/** Open for appending: the existing file, or a new one when nothing stands at the name. */
async function openForAppend(abs: string, rel: string): Promise<FileHandle> {
  const append = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK
  const refused = (error: unknown): unknown => (NOT_A_FILE.has(code(error) ?? '') ? new StoreAppendRefused(rel, NOT_ORDINARY) : error)
  // Twice at most: a first append made by another writer of this process between our two opens
  // (EEXIST on the create) is then appended to like any existing journal.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await open(abs, append)
    } catch (error) {
      if (code(error) !== 'ENOENT') throw refused(error)
    }
    try {
      return await open(abs, append | constants.O_CREAT | constants.O_EXCL, 0o644)
    } catch (error) {
      if (code(error) !== 'EEXIST') throw refused(error)
    }
  }
  throw new StoreAppendRefused(rel, NOT_ORDINARY)
}

/** The Collection's real `.writeflex`: a real folder directly inside the real root, which the root's own name also reaches.
 *  Also the folder guard of the checked whole-file write (checked-store-write.ts). */
export async function storeFolder(root: string, rel: string): Promise<{ path: string; dev: number; ino: number }> {
  const realRoot = await realpath(root)
  const path = join(realRoot, STORE_FOLDER)
  const folder = await lstat(path).catch(() => null)
  if (!folder || !folder.isDirectory()) throw new StoreAppendRefused(rel, NOT_IN_STORE)
  const named = await stat(join(root, STORE_FOLDER)).catch(() => null)
  if (!named || !sameFile(named, folder)) throw new StoreAppendRefused(rel, NOT_IN_STORE)
  return { path, dev: folder.dev, ino: folder.ino }
}

/** The handle's file is ordinary, has one name, and that name is in the real `.writeflex` judged before the open. */
async function assertChecked(handle: FileHandle, root: string, rel: string, name: string, before: { dev: number; ino: number }): Promise<void> {
  const opened = await handle.stat()
  if (!opened.isFile()) throw new StoreAppendRefused(rel, NOT_ORDINARY)
  if (opened.nlink !== 1) throw new StoreAppendRefused(rel, TWO_NAMES)
  const folder = await storeFolder(root, rel)
  if (!sameFile(folder, before)) throw new StoreAppendRefused(rel, NOT_IN_STORE)
  const entry = await lstat(join(folder.path, name)).catch(() => null)
  if (!entry || !sameFile(entry, opened)) throw new StoreAppendRefused(rel, NOT_IN_STORE)
}

/**
 * Add `text` to the end of `<root>/<rel>`, by the rule in this file's header. `rel` is a store file
 * directly inside `.writeflex` (`.writeflex/<name>`); anything else is a programming error and throws.
 * Throws `StoreAppendRefused` when the rule refuses; nothing has been written then.
 */
export async function appendStoreLine(root: string, rel: string, text: string): Promise<void> {
  const parts = posix.normalize(rel).split('/')
  const name = parts[1]
  if (parts.length !== 2 || parts[0] !== STORE_FOLDER || !name || name === '.' || name === '..' || rel.includes('\\')) {
    throw new Error(`appendStoreLine: ${rel} is not a file directly inside ${STORE_FOLDER}.`)
  }
  // The folder is judged before the open too, so a `.writeflex` that is a link never has a file made in its target.
  const folder = await storeFolder(root, rel)
  const handle = await openForAppend(join(folder.path, name), rel)
  try {
    await assertChecked(handle, root, rel, name, folder)
    const opened = await handle.stat()
    const tail = Buffer.alloc(1)
    const needsBreak = opened.size > 0 && (await handle.read(tail, 0, 1, opened.size - 1)).bytesRead === 1 && tail[0] !== 10
    await handle.writeFile(`${needsBreak ? '\n' : ''}${text}`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Synchronous counterpart for moves whose pinned commit and rollback cannot yield. */
export function appendStoreLineSync(root: string, rel: string, text: string): void {
  const parts = rel.split('/')
  if (parts.length !== 2 || parts[0] !== STORE_FOLDER || !parts[1] || parts[1] === '.' || parts[1] === '..' || rel.includes('\\')) throw new Error('Invalid store path.')
  const folderPath = join(realpathSync(root), STORE_FOLDER)
  const folder = lstatSync(folderPath)
  if (!folder.isDirectory() || !sameFile(folder, statSync(join(root, STORE_FOLDER)))) throw new StoreAppendRefused(rel, NOT_IN_STORE)
  const path = join(folderPath, parts[1])
  const flags = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK
  let fd: number
  try { fd = openSync(path, flags) } catch (error) {
    if (code(error) !== 'ENOENT') throw error
    fd = openSync(path, flags | constants.O_CREAT | constants.O_EXCL, 0o644)
  }
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile()) throw new StoreAppendRefused(rel, NOT_ORDINARY)
    if (opened.nlink !== 1) throw new StoreAppendRefused(rel, TWO_NAMES)
    if (!sameFile(folder, lstatSync(folderPath)) || !sameFile(folder, statSync(join(root, STORE_FOLDER))) || !sameFile(opened, lstatSync(path))) throw new StoreAppendRefused(rel, NOT_IN_STORE)
    const tail = Buffer.alloc(1)
    const needsBreak = opened.size > 0 && readSync(fd, tail, 0, 1, opened.size - 1) === 1 && tail[0] !== 10
    const bytes = Buffer.from(`${needsBreak ? '\n' : ''}${text}`)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset)
    fsyncSync(fd)
  } finally { closeSync(fd) }
}
