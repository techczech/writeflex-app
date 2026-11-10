/**
 * Guarded repair of one history object (`.bridle/objects/<sha256>`) that no longer holds the bytes its name says.
 *
 * Why. A version save writes the saved text as an object named for its SHA-256, and writes nothing if an
 * object already stands at that name. When what stands there is damaged (a disk fault, a half-written copy
 * restored by hand), every later save of that text refused, for ever. This replaces the damaged file with the
 * bytes that hash to the name, and only that.
 *
 * The rule. The caller hands in the bytes it is about to save and the name they hash to; nothing here ever
 * writes bytes that do not hash to the name. The existing file is replaced only when ALL hold:
 *   - it is a regular file reached without following a link, with exactly one name (a second name means
 *     other documents' paths share it: replacing the name would not change them, and nothing here should touch them);
 *   - read through the handle it was opened by, its digest does not match its name (a sound object is left alone);
 *   - the replacement is written to a new temporary file in the same folder, flushed, read back and checked
 *     against the name;
 *   - immediately before the rename the folder is still the one held, the temporary file is still the file
 *     written (same device, inode, size, change times and one name: bytes changed in place after the read-back
 *     show up as a new change time), and the damaged file is still the very file judged (same device, inode,
 *     size, change time and one name);
 *   - immediately after the rename the file now standing at the name is read again and must hash to the name.
 *     When it does not, the repair reports failure (`ObjectRepairRefused`), the object is left as it is, and
 *     the next save finds it damaged and repairs it again. "Repaired" is only ever said of an object that was read back.
 * Anything else is refused with a sentence and nothing is changed.
 *
 * WHAT IS LEFT, because Node has no `openat`, `renameat` or `linkat`: each step names its file by path, so a
 * program that acts in the instant between the last look and the rename can still:
 *   - swap the damaged file for another file at the name: the rename replaces the directory entry, never the
 *     other file's bytes (a second name for some other file keeps that file untouched), so what is lost is a
 *     name that held a file this code had not judged; the name then holds bytes that hash to it;
 *   - swap the held folder for a link to another folder: the rename then lands in that folder, which is a folder
 *     the swapping program already controls. It gains a file named for a hash whose bytes hash to it, and takes
 *     nothing it could not already write; this Collection's object stays damaged, the folder is verified again
 *     after the rename so a swap that stays in place is reported as a failure (a swap made and undone inside that
 *     one call is not seen), and the next save repairs it. This is accepted and not defended further.
 * What this code never does is write bytes that do not hash to the name, or write through a link.
 *
 * Electron-free.
 */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readBytes } from './cli/guarded-fs'
import { holdFolder, type HeldFolder } from './cli/request-files'
import type { Workspace } from './workspace'

const OBJECTS_DIR = '.bridle/objects'
const OBJECT_NAME = /^[0-9a-f]{64}$/

/** Refused: the standing object is not one this repair may replace. `message` names it in plain words. */
export class ObjectRepairRefused extends Error {
  override readonly name = 'ObjectRepairRefused'
}

/** @internal Test seam: runs after the damaged file was judged and the replacement written, before the final look and the rename. */
export type ObjectRepairSeams = { beforeRename?: () => Promise<void>; /** @internal Runs right after the rename, before the object is read again. */ afterRename?: () => Promise<void> }

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

/** The bytes of the ordinary file at `path`, read through one handle opened without following a link; null for anything else. */
async function readStanding(path: string): Promise<Buffer | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      return (await handle.stat()).isFile() ? await handle.readFile() : null
    } finally {
      await handle.close().catch(() => {})
    }
  } catch {
    return null
  }
}

/**
 * What stands at `<objects>/<name>`: `absent` (nothing: the caller writes it), `sound` (the bytes hash to the name:
 * nothing to do), `repaired`. Throws `ObjectRepairRefused` for anything it may not replace.
 */
export async function repairCorruptObject(objects: HeldFolder, name: string, bytes: Uint8Array, seams: ObjectRepairSeams = {}): Promise<'absent' | 'sound' | 'repaired'> {
  if (!OBJECT_NAME.test(name) || sha256(bytes) !== name) throw new ObjectRepairRefused(`${OBJECTS_DIR}/${name} cannot be repaired from bytes that are not the ones it is named for.`)
  const rel = `${OBJECTS_DIR}/${name}`
  const path = join(objects.path, name)
  const notOrdinary = new ObjectRepairRefused(`${rel} is not an ordinary file (a link or a folder stands in its place), so it was not replaced.`)
  await objects.verify()
  const named = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if (code(error) === 'ENOENT') return null
    throw error
  })
  if (named === null) return 'absent'
  if (!named.isFile()) throw notOrdinary
  // Judged on the handle it was opened by, never following a link.
  let judged
  let standing: Buffer
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      judged = await handle.stat({ bigint: true })
      if (!judged.isFile() || judged.dev !== named.dev || judged.ino !== named.ino) throw notOrdinary
      standing = await handle.readFile()
      const after = await handle.stat({ bigint: true })
      if (after.size !== judged.size || after.mtimeNs !== judged.mtimeNs || after.ctimeNs !== judged.ctimeNs) throw new ObjectRepairRefused(`${rel} changed while it was being checked, so it was not replaced.`)
    } finally {
      await handle.close().catch(() => {})
    }
  } catch (error) {
    if (error instanceof ObjectRepairRefused) throw error
    throw notOrdinary
  }
  if (sha256(standing) === name) return 'sound'
  if (judged.nlink !== 1n) throw new ObjectRepairRefused(`${rel} does not hold the text it is named for and is also known by another name on this disk, so it was not replaced.`)

  // The replacement: a new file, flushed, read back, checked against the name.
  const staged = join(objects.path, `.${name}.${randomBytes(4).toString('hex')}.tmp`)
  const handle = await open(staged, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666)
  let written
  try {
    try {
      await handle.writeFile(bytes)
      await handle.sync().catch(() => {})
      written = await handle.stat({ bigint: true })
      const back = Buffer.alloc(bytes.length)
      const { bytesRead } = await handle.read(back, 0, back.length, 0)
      if (written.nlink !== 1n || written.size !== BigInt(bytes.length) || bytesRead !== bytes.length || sha256(back) !== name) {
        throw new ObjectRepairRefused(`${rel} could not be rewritten correctly, so it was not replaced.`)
      }
    } finally {
      await handle.close().catch(() => {})
    }
    await seams.beforeRename?.()
    // Last look: the folder is the one held, our file is the one written, and the damaged file is still the one judged.
    await objects.verify()
    const mine = await lstat(staged, { bigint: true })
    const now = await lstat(path, { bigint: true }).catch(() => null)
    if (!mine.isFile() || mine.dev !== written.dev || mine.ino !== written.ino || mine.nlink !== 1n || mine.size !== written.size || mine.mtimeNs !== written.mtimeNs || mine.ctimeNs !== written.ctimeNs) throw new ObjectRepairRefused(`${OBJECTS_DIR} changed while ${rel} was being rewritten, so it was not replaced.`)
    if (!now || !now.isFile() || now.nlink !== 1n || now.dev !== judged.dev || now.ino !== judged.ino || now.size !== judged.size || now.mtimeNs !== judged.mtimeNs || now.ctimeNs !== judged.ctimeNs) {
      throw new ObjectRepairRefused(`${rel} changed while it was being rewritten, so it was not replaced.`)
    }
    await rename(staged, path)
    await seams.afterRename?.()
    // What stands at the name now must be what was verified: the folder is still the one held, and the file is read again.
    await objects.verify().catch(() => { throw new ObjectRepairRefused(`${OBJECTS_DIR} changed while ${rel} was being replaced, so it is not reported as repaired. The next save will check it again.`) })
    const after = await readStanding(path)
    if (after === null || sha256(after) !== name) {
      throw new ObjectRepairRefused(`${rel} did not hold the right text after it was replaced, so it is not reported as repaired. It is left as it is and the next save will repair it again.`)
    }
  } catch (error) {
    // Only the temporary file we made, by its own name, and only while the held folder is still where it was.
    if (await objects.verify().then(() => true, () => false)) await unlink(staged).catch(() => {})
    throw error
  }
  return 'repaired'
}

/**
 * The app's side. Before a version snapshot of `path` reads the file again and stores it (`snapshotVersionOfSavedText`,
 * the one boundary every app snapshot goes through), put right an object already standing at the name those bytes hash
 * to if it is damaged (Bridle's store refuses to save over it). A Collection with no history objects folder, no object
 * at that name, a sound one, or a file that cannot be read here is left to the snapshot as it was. Throws
 * `ObjectRepairRefused` (in words for the person) when the standing object may not be replaced.
 */
export async function repairStandingObjectOf(workspace: Workspace, path: string): Promise<void> {
  const bytes = await readBytes(workspace, path).catch(() => null)
  if (bytes === null) return
  await repairStandingObjectOfBytes(workspace, bytes)
}

/** `repairStandingObjectOf` for bytes already in hand (a snapshot of bytes, snapshot-bytes.ts): the file is not read. */
export async function repairStandingObjectOfBytes(workspace: Workspace, bytes: Uint8Array): Promise<void> {
  const objects = await holdFolder(workspace.root, OBJECTS_DIR, false).catch(() => null)
  if (objects === null) return
  try {
    await repairCorruptObject(objects, sha256(bytes), bytes)
  } finally {
    await objects.close()
  }
}
