/**
 * What makes a reply the app's: a secret the app keeps OUTSIDE every Collection.
 *
 * Nothing inside a Collection can prove a reply is the app's: anything that can write or sync the
 * Collection can write a file there. The proof is this key, kept on this computer only.
 *
 * The key is also how the command line knows that WriteFlex ON THIS COMPUTER has the Collection open
 * (`appHasCollectionOpen`), and so whether to pass a write to it as a request. Beside the key the app
 * records its own process (`<hash>.app.json`: process id and start time), so a key left by an app
 * that crashed is recognised and not routed to. Nothing synced decides the route: WriteFlex has no
 * Collection lock, and another computer's copy of the app never stops this one from writing
 * (docs/plans/2026-11-03-sync-replicas-and-duplicate-reconciliation.md).
 *
 * When the app opens a Collection it makes 32 random bytes and
 * keeps them in its own application-data folder (the folder that holds `settings.json`: on this
 * computer only, not synced, in no Collection), in `collection-keys/<SHA-256 of the canonical
 * root>.key`. The folder is 0700 and the file 0600, the file is created exclusively under a temporary
 * name, written whole and renamed in. The key is replaced each time the app opens the Collection and
 * removed when it closes it. Every reply carries an HMAC-SHA-256, made with the key, over a canonical
 * serialisation of the whole reply. The command line reads the key, recomputes the HMAC over what it
 * parsed, and compares in constant time.
 *
 * The command line uses a key only if the key folder is a real folder (no link) of this user's with no
 * access for anyone else, and the key file is a regular file (no link) of this user's, 0600 or
 * narrower, exactly 32 bytes. Anything else is no key.
 *
 * WHAT THE KEY STOPS: a reply written by something that can write or sync the Collection but cannot
 * read this user's application-data folder: another machine through a synced folder, another user
 * with access to a shared folder, a sandboxed program allowed into the Collection only.
 * WHAT IT DOES NOT STOP: a program running as this user outside a sandbox. It can read the key and
 * sign what it likes. Nothing kept in a file the user can read can stop that program; it could as
 * well edit the documents.
 *
 * Electron-free: the app passes its folder in; the command line derives the standard locations.
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { localProcess, processStartedAt, type LocalProcessSeams } from './local-process'

export const REPLY_KEY_FOLDER = 'collection-keys'
export const REPLY_KEY_BYTES = 32

const keyFileName = (root: string): string => `${createHash('sha256').update(root).digest('hex')}.key`
/** Where the key for the Collection at `root` (canonical) lives under the key folder `folder`. */
export const replyKeyPath = (folder: string, root: string): string => join(folder, keyFileName(root))

const ownedByThisUser = (uid: number): boolean => typeof process.getuid !== 'function' || uid === process.getuid()

/** Make (or replace) the key for `root` in `folder` and return it. The app's side; throws if it cannot. */
export async function createReplyKey(folder: string, root: string): Promise<Buffer> {
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const info = await lstat(folder)
  if (!info.isDirectory() || !ownedByThisUser(info.uid)) throw new Error(`${folder} is not a folder of this user's, so no reply key was made.`)
  if ((info.mode & 0o077) !== 0) await chmod(folder, 0o700)
  const key = randomBytes(REPLY_KEY_BYTES)
  const staged = join(folder, `.${keyFileName(root)}.${randomBytes(4).toString('hex')}.tmp`)
  const handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(key)
    await handle.sync().catch(() => {})
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(staged).catch(() => {})
    throw error
  }
  await handle.close()
  try {
    await rename(staged, replyKeyPath(folder, root))
  } catch (error) {
    await unlink(staged).catch(() => {})
    throw error
  }
  return key
}

/** Remove the key for `root` and the app's presence record beside it. The app's side, when it closes the Collection. */
export async function removeReplyKey(folder: string, root: string): Promise<void> {
  await unlink(replyKeyPath(folder, root)).catch(() => {})
  await unlink(presencePath(folder, root)).catch(() => {})
}

/** Where the app records which process of its holds the key for `root` (local application data, never synced). */
export const presencePath = (folder: string, root: string): string => join(folder, keyFileName(root).replace(/\.key$/, '.app.json'))

/**
 * Record that this process holds the key for `root`: its process id and start time. Written whole and
 * renamed in, beside the key. Best effort: without it the command line treats the key as live.
 */
export async function writeAppPresence(folder: string, root: string, pid = process.pid): Promise<void> {
  const record = JSON.stringify({ version: 1, pid, processStartedAt: await processStartedAt(pid) })
  const staged = join(folder, `.${keyFileName(root)}.${randomBytes(4).toString('hex')}.app.tmp`)
  await writeFile(staged, record, { mode: 0o600, flag: 'wx' })
  try { await rename(staged, presencePath(folder, root)) } catch (error) {
    await unlink(staged).catch(() => {})
    throw error
  }
}

/**
 * Whether the app that made the key for `root` in `folder` is still running on this computer: `gone`
 * when its recorded process has exited (a crash left the key), `there` or `unknown` otherwise. A key
 * without a presence record (made by an older WriteFlex) answers `unknown`.
 */
export async function appPresence(folder: string, root: string, seams: LocalProcessSeams = {}): Promise<'there' | 'gone' | 'unknown'> {
  let text: string
  try { text = await readFile(presencePath(folder, root), 'utf8') } catch { return 'unknown' }
  try {
    const value = JSON.parse(text) as { pid?: unknown; processStartedAt?: unknown }
    if (!Number.isInteger(value.pid)) return 'unknown'
    return await localProcess(value.pid as number, typeof value.processStartedAt === 'number' ? value.processStartedAt : null, seams)
  } catch {
    return 'unknown'
  }
}

/**
 * Whether WriteFlex on THIS computer has the Collection at `root` open: a usable reply key for it in
 * one of `folders` whose app is not known to have exited. The command line's only routing question.
 */
export async function appHasCollectionOpen(folders: string[], root: string, seams: LocalProcessSeams = {}): Promise<boolean> {
  for (const folder of folders) {
    if (!(await readReplyKey(folder, root))) continue
    if ((await appPresence(folder, root, seams)) !== 'gone') return true
  }
  return false
}

/** The key for `root` in `folder`, or null when there is none that may be used (see the top of this file). */
export async function readReplyKey(folder: string, root: string): Promise<Buffer | null> {
  const dir = await lstat(folder).catch(() => null)
  if (!dir?.isDirectory() || (dir.mode & 0o077) !== 0 || !ownedByThisUser(dir.uid)) return null
  let handle
  try {
    handle = await open(replyKeyPath(folder, root), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || (info.mode & 0o077) !== 0 || !ownedByThisUser(info.uid) || info.size !== REPLY_KEY_BYTES) return null
    const key = Buffer.alloc(REPLY_KEY_BYTES)
    const { bytesRead } = await handle.read(key, 0, REPLY_KEY_BYTES, 0)
    return bytesRead === REPLY_KEY_BYTES ? key : null
  } finally {
    await handle.close()
  }
}

/** Every usable key for `root` among `folders` (the release app's and the beta's: either may own it). */
export async function readReplyKeys(folders: string[], root: string): Promise<Buffer[]> {
  const keys: Buffer[] = []
  for (const folder of folders) {
    const key = await readReplyKey(folder, root)
    if (key) keys.push(key)
  }
  return keys
}

/** One serialisation of a JSON value whatever order its fields were written in: keys sorted at every level. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** The HMAC-SHA-256 (hex) of the whole reply but its own `mac` field: version, id, operation, outcome, result and the rest. */
export function replyMac(key: Buffer, reply: Record<string, unknown>): string {
  const { mac: _mac, ...signed } = reply
  return createHmac('sha256', key).update('writeflex-reply-v1\n').update(canonical(signed)).digest('hex')
}

/** Whether `reply.mac` is the HMAC of `reply` under one of `keys`. Constant-time in the comparison. */
export function replyIsSigned(keys: Buffer[], reply: Record<string, unknown>): boolean {
  if (typeof reply.mac !== 'string' || !/^[0-9a-f]{64}$/.test(reply.mac)) return false
  const given = Buffer.from(reply.mac, 'hex')
  let matched = false
  for (const key of keys) {
    if (timingSafeEqual(given, Buffer.from(replyMac(key, reply), 'hex'))) matched = true
  }
  return matched
}
