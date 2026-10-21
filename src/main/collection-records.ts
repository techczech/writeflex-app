/**
 * Where the records that can authorise a later write are kept: OUTSIDE every Collection.
 *
 * Three kinds of record say "this was done" or "this may be put back": the command line's undo
 * journal with its intents, the app's receipts for requests it has handled, and the answers it could
 * not deliver. Each used to sit under the Collection's own `.writeflex` folder, which a sync client
 * and any program allowed into the Collection can write; a planted journal entry was then document
 * content waiting to be written, and a planted receipt was an answer waiting to be signed. They now
 * live in the application-data folder (the folder that holds `settings.json`: on this Mac only, not
 * synced, in no Collection), in two places, split by WHO WRITES:
 *
 *   <application data>/command-line-undo/<SHA-256 of the canonical root>/   the command line's own undo journal
 *   <application data>/collections/<the same hash>/app-undo/                the app's undo journal, for changes made on request
 *                                                  requests-handled/        the app's receipts
 *                                                  requests-undelivered/    the app's answers it could not deliver
 *
 * `command-line-undo` is the ONE folder the command line's own process ever writes, and so the one
 * folder a sandboxed agent is told to allow. Nothing the app trusts is in it: the app never reads it,
 * nothing in it is a receipt, and nothing in it is ever signed. Everything under `collections` is
 * written by the app alone.
 *
 * WHAT AN AGENT ALLOWED TO WRITE `command-line-undo` CAN DO: plant or alter the command line's undo
 * entries. `writeflex undo` run DIRECTLY (the app closed) acts on those entries, so that agent can
 * make a direct undo write content of its choosing into a document path of the Collection. That is no
 * gain to it: the same permission that lets the command line write the Collection with the app closed
 * lets the agent write those documents itself. What it must NOT gain is the app's hand: so an undo
 * REQUEST carried out by the app acts only on the entries the app itself wrote, in `app-undo`, which
 * the command line's process is never told to allow and never writes. Each route undoes its own
 * changes; `writeflex undo --list` shows both and says which is which.
 *
 * The same hash names the Collection's reply key (reply-key.ts). The folders of that name that an
 * earlier build made inside a Collection are never read, written or removed: nothing is carried over.
 *
 * A FOLDER IS USED ONLY IF it is a real folder (no link) of this user's at exactly that place, every
 * level from `collections` down. Made with mode 0700; one found open to others is closed again by
 * whoever is about to write it, and is not read by anyone until then.
 *
 * WHICH VARIANT. The release app and the beta each have an application-data folder. A record is
 * WRITTEN only to the folder of the process that writes it: the app knows its own; the command line
 * run from an app bundle is that bundle's variant (the bundle's `package.json` says; writeflex-cli.ts),
 * and the release one when it cannot tell (run from source). Records are READ from both, since either
 * may have made them.
 *
 * WHEN IT CANNOT BE WRITTEN. An agent's sandbox may allow the Collection and deny application data.
 * The failure is `AppDataNotWritableError`, which names the folder to allow.
 *
 * Electron-free: the app passes its folder in; the command line derives the standard locations.
 */
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { AppVariant } from './app-variant'
import { FolderNotUsableError, holdFolder, type HeldFolder } from './cli/request-files'

export const RECORDS_FOLDER = 'collections'
/** The command line's own folder: the only one its process writes, and the only one a sandbox is asked to allow. */
export const UNDO_FOLDER = 'command-line-undo'
export const JOURNAL_KIND = 'command-line-undo'
export const APP_UNDO_KIND = 'app-undo'
export const HANDLED_KIND = 'requests-handled'
export const UNDELIVERED_KIND = 'requests-undelivered'
export type RecordKind = typeof JOURNAL_KIND | typeof APP_UNDO_KIND | typeof HANDLED_KIND | typeof UNDELIVERED_KIND

export type VariantFolder = AppVariant['userDataDirectoryName']
const VARIANT_FOLDERS: VariantFolder[] = ['writeflex-desktop', 'writeflex-desktop-beta']
const DENIED = new Set(['EACCES', 'EPERM', 'EROFS'])

/** The application-data folders records are kept under: `own` is written and read, `others` only read. */
export type RecordsPlace = { own: string; others: string[] }

/** The standard application-data folders under `home`, for a process of the variant `own`. */
export function standardRecordsPlace(home: string = homedir(), own: VariantFolder = 'writeflex-desktop'): RecordsPlace {
  const folder = (variant: VariantFolder): string => join(home, 'Library', 'Application Support', variant)
  return { own: folder(own), others: VARIANT_FOLDERS.filter((variant) => variant !== own).map(folder) }
}

/**
 * For the app, which knows its own folder: the other variant's folder is the one beside it. An app
 * whose folder is not a standard one (a test run given its own) has no other variant to read.
 */
export function recordsPlaceBeside(own: string): RecordsPlace {
  if (!(VARIANT_FOLDERS as string[]).includes(basename(own))) return { own, others: [] }
  return { own, others: VARIANT_FOLDERS.filter((variant) => variant !== basename(own)).map((variant) => join(dirname(own), variant)) }
}

const collectionFolderName = (root: string): string => createHash('sha256').update(root).digest('hex')
/** `command-line-undo/<hash>` for the command line's journal, `collections/<hash>/<kind>` for everything of the app's; relative to an application-data folder. */
const relativeDir = (root: string, kind: RecordKind): string =>
  kind === JOURNAL_KIND ? `${UNDO_FOLDER}/${collectionFolderName(root)}` : `${RECORDS_FOLDER}/${collectionFolderName(root)}/${kind}`
/** Where records of `kind` for the Collection at `root` (canonical) live under `appData`. */
export const recordsDir = (appData: string, root: string, kind: RecordKind): string => join(appData, ...relativeDir(root, kind).split('/'))

/** Application data could not be written. `allow` is the folder a sandbox must be told to allow. */
export class AppDataNotWritableError extends Error {
  override readonly name = 'AppDataNotWritableError'
  constructor(readonly allow: string, readonly errno: string) {
    super(`WriteFlex's application data cannot be written (${errno}): ${allow}`)
  }
}

/** A records folder is not a private folder of this user's at its own place, so it is not used. */
export class RecordsNotUsableError extends FolderNotUsableError {}

/** The folder that must be writable for records of `kind`: for the command line's journal, its own folder and nothing wider. */
export const folderToAllow = (appData: string, kind: RecordKind): string => join(appData, kind === JOURNAL_KIND ? UNDO_FOLDER : RECORDS_FOLDER)

/** A denied write of a record of `kind` under `appData`, as the error that names the folder to allow; anything else as it is. */
export function asNotWritable(error: unknown, appData: string, kind: RecordKind): unknown {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code && DENIED.has(code) ? new AppDataNotWritableError(folderToAllow(appData, kind), code) : error
}

const ownedByThisUser = (uid: number): boolean => typeof process.getuid !== 'function' || uid === process.getuid()

/**
 * The verified records folder of `kind` for `root` under `appData`, or null when it is missing and
 * `create` is false. With `create`, each missing level is made 0700 and a level open to others is
 * closed. Throws `AppDataNotWritableError` when a level cannot be made, and `RecordsNotUsableError`
 * when a link, a file, another user's folder or (reading) a folder open to others stands in the way.
 */
export async function recordsFolder(appData: string, root: string, kind: RecordKind, create: boolean): Promise<string | null> {
  const dir = relativeDir(root, kind)
  const unusable = (why: string): never => {
    throw new RecordsNotUsableError(`${join(appData, ...dir.split('/'))} ${why}, so it is not used.`)
  }
  try {
    if (create) await mkdir(appData, { recursive: true, mode: 0o700 })
    let current = appData
    for (const segment of dir.split('/')) {
      current = join(current, segment)
      let info = await lstat(current).catch(() => null)
      if (!info) {
        if (!create) return null
        await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
        info = await lstat(current)
      }
      if (!info.isDirectory()) unusable('is not an ordinary folder (a link or a file stands in its place)')
      if (!ownedByThisUser(info.uid)) unusable('is not a folder of this user\'s')
      if ((info.mode & 0o077) !== 0) {
        if (!create) unusable('is open to other users')
        await chmod(current, 0o700)
      }
    }
    if (await realpath(current) !== join(await realpath(appData), ...dir.split('/'))) unusable('does not lie in WriteFlex\'s application data')
    return current
  } catch (error) {
    throw asNotWritable(error, appData, kind)
  }
}

/** `recordsFolder`, then opened and held as the request folders are (cli/request-files.ts). The caller closes it. */
export async function holdRecords(appData: string, root: string, kind: RecordKind, create: boolean): Promise<HeldFolder | null> {
  if (await recordsFolder(appData, root, kind, create) === null) return null
  return holdFolder(appData, relativeDir(root, kind), false)
}

/** The other variants' folders of `kind` that exist and are usable, held for reading. One that is not usable is no record at all. */
export async function holdOtherRecords(place: RecordsPlace, root: string, kind: RecordKind): Promise<HeldFolder[]> {
  const held: HeldFolder[] = []
  for (const appData of place.others) {
    const folder = await holdRecords(appData, root, kind, false).catch(() => null)
    if (folder) held.push(folder)
  }
  return held
}
