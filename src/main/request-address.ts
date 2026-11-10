/**
 * THIS COMPUTER'S REQUEST ADDRESS: which computer a command-line request is for.
 *
 * The request inbox (`.writeflex/inbox`) lives inside the Collection, so it syncs. With no Collection
 * lock, WriteFlex may have the same Collection open on two Macs at once, and both watch the inbox. A
 * request the command line on one Mac sends to the app on that Mac must never be carried out (or
 * claimed, answered, removed or added for review) by the app on the other Mac when the file syncs
 * there. So every request names the computer it is for (`to`), and an app acts only on a request
 * that names its own computer; it leaves every other request exactly as it found it.
 *
 * The address is 16 random bytes (hex) kept in each app-data folder on this computer
 * (`this-computer.address`, 0600), never in a Collection and never synced. The command line selects one live local variant, preferring its own, and puts only its address
 * in `to`. With no app open it selects its own variant. Each app answers only its own address. Another Mac has its own addresses and cannot match one by chance.
 *
 * This is an address, not an authentication: the reply key (reply-key.ts) is what proves a reply is
 * the app's. It stops replicas acting on each other's requests; nothing more.
 *
 * Electron-free; shared by the app and the command line.
 */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { appHasCollectionOpen, REPLY_KEY_FOLDER } from './reply-key'

export const REQUEST_ADDRESS_FILE = 'this-computer.address'
const ADDRESS = /^[0-9a-f]{32}$/
/** How many addresses a request may name (one per WriteFlex variant on the sending computer). */
export const MAX_REQUEST_ADDRESSES = 4

export const isRequestAddress = (value: unknown): value is string => typeof value === 'string' && ADDRESS.test(value)

const ownedByThisUser = (uid: number): boolean => typeof process.getuid !== 'function' || uid === process.getuid()

/** The address kept in `folder` (an app-data folder), or null when there is none that may be used. */
export async function readRequestAddress(folder: string): Promise<string | null> {
  const path = join(folder, REQUEST_ADDRESS_FILE)
  const info = await lstat(path).catch(() => null)
  if (!info?.isFile() || !ownedByThisUser(info.uid) || info.size > 64) return null
  const text = (await readFile(path, 'utf8').catch(() => '')).trim()
  return isRequestAddress(text) ? text : null
}

/** The address kept in `folder`, made (whole, exclusively, 0600) if there is none yet. */
export async function ensureRequestAddress(folder: string): Promise<string> {
  const existing = await readRequestAddress(folder)
  if (existing) return existing
  await mkdir(folder, { recursive: true })
  const address = randomBytes(16).toString('hex')
  const staged = join(folder, `.${REQUEST_ADDRESS_FILE}.${randomBytes(4).toString('hex')}.tmp`)
  const handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(`${address}\n`) } finally { await handle.close() }
  try {
    // A link never replaces: when another process made the address meanwhile, theirs stands.
    await link(staged, join(folder, REQUEST_ADDRESS_FILE))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      // A volume without hard links: rename (the race this loses is only between two first runs).
      await rename(staged, join(folder, REQUEST_ADDRESS_FILE)).catch(() => {})
    }
  } finally {
    await unlink(staged).catch(() => {})
  }
  const made = await readRequestAddress(folder)
  if (!made) throw new Error(`WriteFlex could not keep this computer's request address in ${folder}.`)
  return made
}

/**
 * The addresses a request from this computer names: every WriteFlex variant's here, `own` (this
 * process's app-data folder) made if it has none. `others` are only read.
 */
export async function thisComputerAddresses(own: string, others: string[], root?: string): Promise<string[]> {
  if (root) {
    for (const folder of [own, ...others]) {
      if (await appHasCollectionOpen([join(folder, REPLY_KEY_FOLDER)], root)) {
        return [await ensureRequestAddress(folder)]
      }
    }
  }
  // With no app open, a shown-first request waits for this variant alone.
  return [await ensureRequestAddress(own)]
}

/** Each app variant answers only its own address, so release and beta cannot both execute a request. */
export async function answerableAddresses(own: string, _others: string[]): Promise<string[]> {
  return [await ensureRequestAddress(own)]
}

/**
 * Whether the request text `text` is addressed to one of `addresses`, read without acting on anything:
 * `ours`, `not-ours` (it names other computers only), or `unknown` (not readable that far; whoever
 * reads it judges it as a request, and a request without a valid `to` is refused by every app).
 */
export function addressedTo(text: string, addresses: string[]): 'ours' | 'not-ours' | 'unknown' {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return 'unknown' }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'unknown'
  const to = (raw as Record<string, unknown>).to
  if (!Array.isArray(to) || to.length === 0 || to.length > MAX_REQUEST_ADDRESSES || !to.every(isRequestAddress)) return 'unknown'
  return to.some((entry) => addresses.includes(entry)) ? 'ours' : 'not-ours'
}
