/**
 * The command line's own use of the app's history stores, for the things it does with them when no
 * app has the Collection open: SAVE a version (a write, made only under the owner lock), READ version
 * text for a comparison (no write at all), and make the review ledger's undecided outside Changes
 * FOLLOW a move it made (a write under the owner lock: `followRenamesInLedger`).
 *
 * A Collection can arrive from somewhere else (a download, a synced folder another machine writes),
 * so everything under `.bridle` and `.writeflex` is data, not something to be trusted: a name there
 * can be a link, and the journal can name anything. The rule here is that WHAT IS CHECKED IS WHAT IS
 * USED, and each check is made immediately before the use it guards.
 *
 * READING VERSION TEXT (compare) does not go through Bridle at all. Bridle's store opens the journal
 * and the object by name and joins the journal's `hash` to a path as it finds it. The command line
 * reads both itself:
 *   .bridle/journal.jsonl   `.bridle` is held (opened once, its identity kept, verified before and
 *                           after the read); the journal is opened without following a link and must
 *                           be a regular file. Lines that are not JSON objects are skipped.
 *   the entry's `hash`      must be 64 lower-case hex digits BEFORE it is joined to any path.
 *   .bridle/objects/<hash>  `.bridle/objects` is held and verified before and after; the object is
 *                           opened without following a link and must be a regular file; and its
 *                           bytes must hash to its name. Anything else is a damaged history entry,
 *                           reported as such and never returned as a version's text.
 * The last check is what makes the rest safe: whatever a swapped folder or a planted file leads to,
 * the only bytes that can come back are bytes whose SHA-256 is the name the journal gave.
 *   .writeflex/versions.jsonl, .writeflex/changes.jsonl   read by the app's VersionStore and
 *                           ChangeStore (their parsing is the format). Each is checked immediately
 *                           before the store reads it: absent, or a regular file, not a link.
 *
 * SAVING A VERSION uses the app's code for every byte of FORMAT (Bridle's SnapshotStore for the two
 * journal lines, VersionStore for the version record), and does itself the one thing whose format is
 * trivial and whose safety is not: the object.
 *   the object              the document is read without following a final link; the command line
 *                           writes `.bridle/objects/<sha256>` itself, into the held objects folder,
 *                           under a temporary name that is verified and renamed in. If something
 *                           already stands at that name it must be a regular file holding exactly
 *                           these bytes, or the save is refused. Bridle then finds the object there
 *                           and does not write it.
 *   .bridle/journal.jsonl   appended by Bridle (restore point, then snapshot). Immediately before
 *                           each append: absent or a regular file with one name, the folders still
 *                           the ones held, the object still sound. Immediately after: the folders
 *                           again, and the snapshot Bridle recorded must name the object written
 *                           here; if not (the document changed in between), no version is recorded.
 *   .writeflex/versions.jsonl   appended by VersionStore. Immediately before: `.writeflex` an
 *                           ordinary folder in place, the file absent or regular with one name.
 *   .writeflex/changes.jsonl    read by ChangeStore, checked immediately before as for a comparison.
 *
 * THE WINDOW THAT REMAINS. Bridle and the two stores open by name. Between a check here and their
 * call, a program that swaps the journal, the versions file or a folder for a link redirects that one
 * call: one appended line, or (Bridle's `existsSync` then `writeFile`, if the object is removed in
 * that instant) one write of the document's own bytes. A swap still in place afterwards is seen and
 * the save refused before the version is recorded. The owner lock keeps the app and other `writeflex`
 * commands out; it does not stop a program that ignores it. Reads have no such window for content:
 * see the hash rule above.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { ChangeStore } from '../changes'
import { saveVersionOfSavedText, snapshotVersionOfSavedText, VersionSaveRefused, type SavedTextVersion } from '../saved-text-version'
import type { SnapshotContentReader } from '../version-content'
import { humanAuthorForWorkspace, versionsJournalPath, VersionStore, type AuthorIdentity } from '../versions'
import type { Workspace } from '../workspace'
import { readBytes } from './guarded-fs'
import { CliError } from './operation'
import { FolderNotUsableError, holdFolder, privateFolder, type HeldFolder } from './request-files'

const HISTORY_DIR = '.bridle'
const OBJECTS_DIR = `${HISTORY_DIR}/objects`
const JOURNAL_NAME = 'journal.jsonl'
const HISTORY_JOURNAL = `${HISTORY_DIR}/${JOURNAL_NAME}`
const CHANGES_JOURNAL = '.writeflex/changes.jsonl'
/** A SHA-256 as Bridle writes it. Checked before a hash from the journal is joined to any path. */
const OBJECT_NAME = /^[0-9a-f]{64}$/
/** Bridle's marker for "the file did not exist when snapshotted". */
const ABSENT = 'ABSENT'

/**
 * The session a snapshot is recorded under. The app records its agent session's id; the command line
 * has no session, and says who it is. Nothing reads this field to decide anything.
 */
export const COMMAND_LINE_SESSION = 'writeflex-command-line'

/** @internal Test seam: runs after the named file or folder was checked and before it is opened or handed to Bridle. */
export type HistorySeams = { afterCheck?: (rel: string) => Promise<void> }

const notUsable = (what: string): CliError => new CliError(`This Collection's version history cannot be used: ${what} Nothing was written.`)
const damaged = (what: string): CliError => new CliError(`A history entry is damaged: ${what} It was not used.`, 'failed')

/** Run `work`; a held folder that is no longer the folder that was opened is a refusal in plain words. */
async function usable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof FolderNotUsableError) throw notUsable(error.message)
    throw error
  }
}

/** `rel` is absent (false) or an ordinary file (true); a link, a folder or anything else is refused.
 *  `appended`: it must also have one name only, since a line is about to be added to it. */
async function ordinaryFile(root: string, rel: string, appended = false): Promise<boolean> {
  const info = await lstat(join(root, rel)).catch(() => null)
  if (!info) return false
  if (!info.isFile()) throw notUsable(`${rel} is not an ordinary file (a link or a folder stands in its place).`)
  if (appended && info.nlink > 1) throw notUsable(`${rel} is also known by another name somewhere else on this disk, so writing it would change that file too.`)
  return true
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * The bytes of `<held folder>/<name>`, or null when nothing stands there. The folder is verified
 * immediately before the open and again after the read; the file is opened without following a link
 * and must be a regular file (decided on the open handle).
 */
async function readHeld(folder: HeldFolder, dir: string, name: string, seams: HistorySeams): Promise<Buffer | null> {
  return usable(async () => {
    await folder.verify()
    await seams.afterCheck?.(`${dir}/${name}`)
    let handle
    try {
      handle = await open(join(folder.path, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await folder.verify()
        return null
      }
      throw damaged(`${dir}/${name} is not an ordinary file (a link stands in its place).`)
    }
    try {
      if (!(await handle.stat()).isFile()) throw damaged(`${dir}/${name} is not an ordinary file.`)
      const bytes = await handle.readFile()
      await folder.verify()
      return bytes
    } finally {
      await handle.close().catch(() => {})
    }
  })
}

/** The object named `name`, only if its bytes hash to that name; null when absent. `name` is a checked hash. */
async function readObject(objects: HeldFolder, name: string, seams: HistorySeams): Promise<Buffer | null> {
  const bytes = await readHeld(objects, OBJECTS_DIR, name, seams)
  if (bytes !== null && sha256(bytes) !== name) throw damaged(`${OBJECTS_DIR}/${name} does not hold the text it is named for.`)
  return bytes
}

/** `author` is given only by the command line's own code, from the closed list of outside sources
 *  (agent-created-hook.ts): no argument and no request field reaches it. Default: the stores' author. */
export type VersionSaveInput = { path: string; name: string; note?: string; author?: AuthorIdentity }

/**
 * Save a version with the app closed. `confirmOwner` throws when this process no longer holds the
 * Collection's owner lock; it is asked before the stores are opened and before each is written.
 */
export async function saveVersionFromCommandLine(workspace: Workspace, confirmOwner: () => Promise<void>, input: VersionSaveInput, seams: HistorySeams = {}): Promise<SavedTextVersion> {
  const { root } = workspace
  await confirmOwner()
  const versionsFile = async (): Promise<void> => {
    await usable(() => privateFolder(root, '.writeflex', true))
    await ordinaryFile(root, versionsJournalPath(), true)
  }
  await versionsFile()
  const objects = (await usable(() => holdFolder(root, OBJECTS_DIR, true)))!
  try {
    const journal = async (): Promise<void> => {
      await usable(() => objects.verify())
      await ordinaryFile(root, HISTORY_JOURNAL, true)
    }
    await journal()
    const { SnapshotStore } = await import('@bridle/core')
    await journal()
    // Makes the objects folder when it is missing; it was just verified to be there.
    const bridle = await SnapshotStore.open({ dir: join(root, HISTORY_DIR) })
    const versions = new VersionStore(workspace)
    const changes = new ChangeStore(workspace)
    return await saveVersionOfSavedText({
      workspace,
      // Asked of git (a bounded wait) only when the caller names no author itself.
      author: input.author ?? await humanAuthorForWorkspace(root),
      confirmOwner,
      changes: { list: async (scope) => { await ordinaryFile(root, CHANGES_JOURNAL); return changes.list(scope) } },
      versions: { append: async (record) => { await versionsFile(); await seams.afterCheck?.(versionsJournalPath()); return versions.append(record) } },
      snapshot: async (path) => {
        // Read as every command-line read of a document is: never through a final link.
        const bytes = await readBytes(workspace, path)
        const name = sha256(bytes)
        // The object is written here, not by Bridle: only if absent, into the held folder; what
        // already stands at its name must be exactly these bytes (readObject refuses anything else).
        if (await readObject(objects, name, seams) === null) {
          await usable(() => objects.write(name, bytes, { beforeRename: () => seams.afterCheck?.(OBJECTS_DIR) ?? Promise.resolve() }, 0o666))
        }
        const sound = async (): Promise<void> => {
          await journal()
          if (await readObject(objects, name, {}) === null) throw notUsable(`${OBJECTS_DIR}/${name} was removed while the version was being saved.`)
        }
        return snapshotVersionOfSavedText({
          workspace, sessionId: COMMAND_LINE_SESSION, path,
          snapshots: {
            beginRestorePoint: async (label, sessionId) => {
              await sound()
              await seams.afterCheck?.(HISTORY_JOURNAL)
              const id = await bridle.beginRestorePoint(label, sessionId)
              await journal()
              return id
            },
            snapshotFile: async (absPath, meta) => {
              await sound()
              await seams.afterCheck?.(HISTORY_JOURNAL)
              const entry = await bridle.snapshotFile(absPath, meta)
              await journal()
              // Bridle read the document again, by name. It must have recorded the object written here.
              if (entry.kind !== 'snapshot' || entry.hash !== name) {
                throw new VersionSaveRefused(`${path} changed while its version was being saved, so no version was recorded. Run the command again.`)
              }
              return entry
            },
          },
        })
      },
    }, input)
  } finally {
    await objects.close()
  }
}

type JournalLine = { id?: unknown; kind?: unknown; hash?: unknown }

/**
 * A reader of version text from the Collection's history store, as the app's agent is one for the
 * app's Compare. Reads the journal and the object itself (see the top of this file). Writes nothing
 * and makes nothing: a Collection with no history store yet is left without one.
 */
export function versionTextReader(root: string, seams: HistorySeams = {}): SnapshotContentReader {
  return {
    readSnapshotContent: async (entryId) => {
      const history = await usable(() => holdFolder(root, HISTORY_DIR, false))
      if (history === null) return null
      let hash: unknown
      try {
        const journal = await readHeld(history, HISTORY_DIR, JOURNAL_NAME, seams)
        if (journal === null) return null
        for (const line of journal.toString('utf8').split('\n')) {
          let entry: JournalLine | null
          // A line that is not JSON (the app may be part-way through writing the last one) is no entry.
          try { entry = JSON.parse(line) as JournalLine | null } catch { continue }
          if (entry !== null && typeof entry === 'object' && entry.id === entryId && entry.kind === 'snapshot') hash = entry.hash
        }
      } finally {
        await history.close()
      }
      if (hash === undefined || hash === ABSENT) return null
      // Before it is joined to anything: the journal is data, and a name with a path in it would read any file.
      if (typeof hash !== 'string' || !OBJECT_NAME.test(hash)) throw damaged(`${HISTORY_JOURNAL} names something that is not one of the history store's own objects.`)
      const objects = await usable(() => holdFolder(root, OBJECTS_DIR, false))
      if (objects === null) return null
      try {
        return (await readObject(objects, hash, seams))?.toString('utf8') ?? null
      } finally {
        await objects.close()
      }
    },
  }
}

/**
 * The undecided outside Changes in the review ledger follow moves the command line made with the app
 * closed (specification section 5: "follows the rename if WriteFlex or the command line did it").
 * The ledger is the lock owner's store; under its own lock the command line is that owner, so it
 * writes the ledger through the app's own `ChangeStore.followRename` (the format is the app's), with
 * the same checks as a version save: the lock confirmed first, `.writeflex` an ordinary folder in
 * place, the journal absent or an ordinary file. An absent ledger has nothing to follow and is not
 * made. The store replaces the journal whole by rename, so a link planted at its name is replaced,
 * never written through. Returns how many Changes moved, over all `moves`, applied in the order made.
 */
export async function followRenamesInLedger(workspace: Workspace, confirmOwner: () => Promise<void>, moves: Array<{ from: string; to: string }>): Promise<number> {
  const { root } = workspace
  // The rewrite drops lines this build cannot parse, so the command line and the app must ship as one version.
  // Checked immediately before each write of the store: the lock is still this command's, and there is a ledger to follow.
  const ledgerHere = async (): Promise<boolean> => {
    await confirmOwner()
    return await usable(() => privateFolder(root, '.writeflex', false)) !== null && await ordinaryFile(root, CHANGES_JOURNAL)
  }
  const changes = new ChangeStore(workspace)
  let moved = 0
  for (const { from, to } of moves) {
    if (!(await ledgerHere())) break
    moved += await changes.followRename(from, to)
  }
  return moved
}

/** The app's version and review stores for a comparison, each file checked immediately before the store reads it. */
export function checkedStoresForReading(workspace: Workspace): { versions: Pick<VersionStore, 'list'>; changes: Pick<ChangeStore, 'list'> } {
  const versions = new VersionStore(workspace)
  const changes = new ChangeStore(workspace)
  return {
    versions: { list: async (scope) => { await ordinaryFile(workspace.root, versionsJournalPath()); return versions.list(scope) } },
    changes: { list: async (scope) => { await ordinaryFile(workspace.root, CHANGES_JOURNAL); return changes.list(scope) } },
  }
}
