/**
 * The command line's own use of the app's history stores, for the things it does with them when no
 * app has the Collection open on this computer: SAVE a version (a write), READ version
 * text for a comparison (no write at all), and make the review ledger's undecided outside Changes
 * FOLLOW a move it made (a write: `followRenamesInLedger`).
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
 * the save refused before the version is recorded. There is no Collection lock: another program, or
 * another Mac through sync, may write meanwhile, and what it writes is never overwritten unseen (the
 * appends are whole lines; copies of the History journal made by sync are read, see
 * docs/plans/2026-11-03-sync-replicas-and-duplicate-reconciliation.md). Reads have no such window for content:
 * see the hash rule above.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ChangeStore } from '../changes'
import type { VersionSnapshotResult } from '../agent'
import { FOLIO_SAVE_COMMITS_JOURNAL_REL } from '../folio-save-commit'
import { FolioVersionStore } from '../folio-versions'
import { ObjectRepairRefused, repairCorruptObject } from '../history-object-repair'
import { saveFolioVersion, type FolioSaveInput, type SavedFolioVersion } from '../folio-version-save'
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
/** A copy of the History journal made by sync, inside the app's own `.bridle` folder. */
const JOURNAL_COPY = /^journal[- ].+\.jsonl$/
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
async function readHeld(folder: HeldFolder, dir: string, name: string, seams: HistorySeams, limit?: number): Promise<Buffer | null> {
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
      // With a limit, at most limit + 1 bytes are ever read, whatever the file grows to after it was looked at.
      const bytes = limit === undefined ? await handle.readFile() : await readAtMost(handle, limit + 1)
      if (limit !== undefined && bytes.length > limit) throw new OverLimit()
      await folder.verify()
      return bytes
    } finally {
      await handle.close().catch(() => {})
    }
  })
}

/** Thrown by a bounded read when the file holds more than the limit. */
class OverLimit extends Error {}

/** At most `max` bytes from the start of `handle`, read in chunks so a file that grows while it is read is never pulled in whole. */
async function readAtMost(handle: Awaited<ReturnType<typeof open>>, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  while (total < max) {
    const chunk = Buffer.allocUnsafe(Math.min(1 << 20, max - total))
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total)
    if (bytesRead === 0) break
    chunks.push(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead))
    total += bytesRead
  }
  return Buffer.concat(chunks, total)
}

/** The object named `name`, only if its bytes hash to that name; null when absent. `name` is a checked hash. */
async function readObject(objects: HeldFolder, name: string, seams: HistorySeams, limit?: number): Promise<Buffer | null> {
  const bytes = await readHeld(objects, OBJECTS_DIR, name, seams, limit)
  if (bytes !== null && sha256(bytes) !== name) throw damaged(`${OBJECTS_DIR}/${name} does not hold the text it is named for.`)
  return bytes
}

/** `author` is given only by the command line's own code, from the closed list of outside sources
 *  (agent-created-hook.ts): no argument and no request field reaches it. Default: the stores' author. */
export type VersionSaveInput = { path: string; name: string; note?: string; author?: AuthorIdentity }

/** The command line's guarded use of the app's history stores, once they are held: what a version save needs. */
export type CommandLineHistory = {
  workspace: Workspace
  author: AuthorIdentity
  confirmOwner: () => Promise<void>
  changes: Pick<ChangeStore, 'list'>
  versions: Pick<VersionStore, 'list' | 'append' | 'commitFolioSave'>
  /** One restore point and one snapshot of the document as it stands on disk (the object is written by the held folder, not by Bridle). */
  snapshot: (path: string) => Promise<VersionSnapshotResult>
  /** The SHA-256 of the bytes snapshot `snapshotId` holds; null when there is none or it recorded an absent file. */
  snapshotHash: (snapshotId: string) => Promise<string | null>
}

/**
 * Hold the history stores for the command line's own writes and run `use` over them. `confirmOwner`
 * is asked before the stores are opened and before each is written; it throws to stop the write (the
 * command line's own never does: there is no lock). Every check described at the top of this file is
 * made here, immediately before the use it guards.
 */
async function withCommandLineHistory<T>(workspace: Workspace, confirmOwner: () => Promise<void>, author: AuthorIdentity | undefined, seams: HistorySeams, use: (history: CommandLineHistory) => Promise<T>): Promise<T> {
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
    return await use({
      workspace, confirmOwner,
      // Asked of git (a bounded wait) only when the caller names no author itself.
      author: author ?? await humanAuthorForWorkspace(root),
      changes: { list: async (scope) => { await ordinaryFile(root, CHANGES_JOURNAL); return changes.list(scope) } },
      versions: {
        list: async (scope, opts) => { await ordinaryFile(root, versionsJournalPath()); return versions.list(scope, opts) },
        append: async (record) => { await versionsFile(); await seams.afterCheck?.(versionsJournalPath()); return versions.append(record) },
        commitFolioSave: async (saveId) => {
          await usable(() => privateFolder(root, '.writeflex', true))
          await ordinaryFile(root, FOLIO_SAVE_COMMITS_JOURNAL_REL, true)
          await seams.afterCheck?.(FOLIO_SAVE_COMMITS_JOURNAL_REL)
          return versions.commitFolioSave(saveId)
        },
      },
      snapshotHash: (snapshotId) => verifiedSnapshotHash(root, snapshotId, seams),
      snapshot: async (path) => {
        // Read as every command-line read of a document is: never through a final link.
        const bytes = await readBytes(workspace, path)
        const name = sha256(bytes)
        // The object is written here, not by Bridle: only if absent, into the held folder; what
        // already stands at its name must be exactly these bytes (readObject refuses anything else).
        // An object there that does not hold these bytes is put right when it is a plain one-name file (history-object-repair.ts);
        // a link, a folder or a second name is still refused.
        const standing = await usable(() => repairCorruptObject(objects, name, bytes, { beforeRename: () => seams.afterCheck?.(OBJECTS_DIR) ?? Promise.resolve() })).catch((error: unknown) => {
          if (error instanceof ObjectRepairRefused) throw damaged(error.message)
          throw error
        })
        if (standing === 'absent') {
          await usable(() => objects.write(name, bytes, { beforeRename: () => seams.afterCheck?.(OBJECTS_DIR) ?? Promise.resolve() }, 0o666))
        }
        const sound = async (): Promise<void> => {
          await journal()
          if (await readObject(objects, name, {}) === null) throw notUsable(`${OBJECTS_DIR}/${name} was removed while the version was being saved.`)
        }
        return snapshotVersionOfSavedText({
          // The object was put right above, by the held folder.
          workspace, sessionId: COMMAND_LINE_SESSION, path, repairObject: false,
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
    })
  } finally {
    await objects.close()
  }
}

/** Save a version with the app closed (see `withCommandLineHistory`). */
export async function saveVersionFromCommandLine(workspace: Workspace, confirmOwner: () => Promise<void>, input: VersionSaveInput, seams: HistorySeams = {}): Promise<SavedTextVersion> {
  return withCommandLineHistory(workspace, confirmOwner, input.author, seams, (history) => saveVersionOfSavedText(history, input))
}

/**
 * Save a Folio version with the app closed: the same guarded stores, the Folio journal beside them.
 * `author` is the command line's own (never from an argument). Never settles a change: a Folio with the
 * writer's own waiting changes is refused `version-unsettled` (folio-version-save.ts).
 */
export async function saveFolioVersionFromCommandLine(workspace: Workspace, confirmOwner: () => Promise<void>, input: FolioSaveInput, seams: HistorySeams = {}): Promise<SavedFolioVersion> {
  return withCommandLineHistory(workspace, confirmOwner, input.author, seams, (history) => saveFolioVersion({
    ...history,
    folioVersions: new FolioVersionStore(workspace),
    readBytes: (path) => readBytes(workspace, path),
  }, input))
}

type JournalLine = { id?: unknown; kind?: unknown; hash?: unknown }

/**
 * A reader of version text from the Collection's history store, as the app's agent is one for the
 * app's Compare. Reads the journal and the object itself (see the top of this file). Writes nothing
 * and makes nothing: a Collection with no history store yet is left without one.
 */
export function versionTextReader(root: string, seams: HistorySeams = {}): SnapshotContentReader {
  return {
    readSnapshotContent: async (entryId) => (await readSnapshotBytes(root, entryId, seams))?.toString('utf8') ?? null,
  }
}

/**
 * The exact bytes snapshot `entryId` holds (the object, checked against its name by `readObject`), or null when there is no
 * such snapshot or no object. Reads only, as `versionTextReader` does; Folio versions' shared reader uses it so a file that
 * is not valid UTF-8 comes back byte for byte, never through a text decode.
 */
export async function readSnapshotBytes(root: string, entryId: string, seams: HistorySeams = {}): Promise<Buffer | null> {
  const hash = await snapshotEntryHash(root, entryId, seams)
  if (hash === null) return null
  const objects = await usable(() => holdFolder(root, OBJECTS_DIR, false))
  if (objects === null) return null
  try {
    return await readObject(objects, hash, seams)
  } finally {
    await objects.close()
  }
}

/**
 * `readSnapshotBytes` that never reads more than `maxBytes` (plus one, to know): `'too-large'` when the object holds more, however it grew after any
 * earlier look at its size. Null when there is no such snapshot or object.
 */
export async function readSnapshotBytesBounded(root: string, entryId: string, maxBytes: number, seams: HistorySeams = {}): Promise<Buffer | 'too-large' | null> {
  const hash = await snapshotEntryHash(root, entryId, seams)
  if (hash === null) return null
  const objects = await usable(() => holdFolder(root, OBJECTS_DIR, false))
  if (objects === null) return null
  try {
    return await readObject(objects, hash, seams, maxBytes)
  } catch (error) {
    if (error instanceof OverLimit) return 'too-large'
    throw error
  } finally {
    await objects.close()
  }
}

/**
 * The hash the snapshot entry `entryId` names in the history journal, or null when there is no such
 * snapshot, no journal, or the entry recorded an absent file. Read as a comparison reads it (see the
 * top of this file); writes nothing. A hash that is not 64 hex digits is a damaged entry, never joined to a path.
 */
async function snapshotEntryHash(root: string, entryId: string, seams: HistorySeams): Promise<string | null> {
  const history = await usable(() => holdFolder(root, HISTORY_DIR, false))
  if (history === null) return null
  let hash: unknown
  try {
    // The journal first, then any copy of it sync made (`journal-Example-Mac.jsonl`): an entry
    // written on another Mac may be only in the copy (contract rule 7).
    const copies = (await readdir(history.path).catch(() => [] as string[])).filter((name) => JOURNAL_COPY.test(name)).sort()
    for (const name of [JOURNAL_NAME, ...copies]) {
      const journal = await readHeld(history, HISTORY_DIR, name, seams)
      if (journal === null) continue
      for (const line of journal.toString('utf8').split('\n')) {
        let entry: JournalLine | null
        // A line that is not JSON (the app may be part-way through writing the last one) is no entry.
        try { entry = JSON.parse(line) as JournalLine | null } catch { continue }
        if (entry !== null && typeof entry === 'object' && entry.id === entryId && entry.kind === 'snapshot') hash = entry.hash
      }
      if (hash !== undefined) break
    }
  } finally {
    await history.close()
  }
  if (hash === undefined || hash === ABSENT) return null
  // Before it is joined to anything: the journal is data, and a name with a path in it would read any file.
  if (typeof hash !== 'string' || !OBJECT_NAME.test(hash)) throw damaged(`${HISTORY_JOURNAL} names something that is not one of the history store's own objects.`)
  return hash
}

/**
 * The SHA-256 of the bytes snapshot `snapshotId` holds, ONLY IF that object is there and its bytes hash to
 * its name; null when the snapshot is unknown, recorded an absent file, or its object is missing or does
 * not match (the journal's word is not enough to reuse a snapshot: a Folio version that points at a
 * snapshot nobody can read is not saved). Reads only; an object that is a link or not an ordinary file is
 * still a damaged entry, as for a comparison.
 */
export async function verifiedSnapshotHash(root: string, snapshotId: string, seams: HistorySeams = {}): Promise<string | null> {
  const hash = await snapshotEntryHash(root, snapshotId, seams)
  if (hash === null) return null
  const objects = await usable(() => holdFolder(root, OBJECTS_DIR, false))
  if (objects === null) return null
  try {
    const bytes = await readHeld(objects, OBJECTS_DIR, hash, seams)
    return bytes !== null && sha256(bytes) === hash ? hash : null
  } finally {
    await objects.close()
  }
}

/**
 * The SHA-256 each of `entryIds` names, from ONE read of the journal (the change cues ask for a Folio's worth at once, and
 * `snapshotHashOf` reads the whole journal per id). An id that is unknown, recorded an absent file or names something that is
 * not one of the store's own objects is left out of the answer. Reads only; the objects are not looked at.
 */
export async function snapshotHashesOf(root: string, entryIds: readonly string[], seams: HistorySeams = {}): Promise<Map<string, string>> {
  const wanted = new Set(entryIds)
  const found = new Map<string, unknown>()
  if (wanted.size === 0) return new Map()
  const history = await usable(() => holdFolder(root, HISTORY_DIR, false))
  if (history === null) return new Map()
  try {
    const journal = await readHeld(history, HISTORY_DIR, JOURNAL_NAME, seams)
    if (journal === null) return new Map()
    for (const line of journal.toString('utf8').split('\n')) {
      let entry: JournalLine | null
      try { entry = JSON.parse(line) as JournalLine | null } catch { continue }
      if (entry !== null && typeof entry === 'object' && entry.kind === 'snapshot' && typeof entry.id === 'string' && wanted.has(entry.id)) found.set(entry.id, entry.hash)
    }
  } finally {
    await history.close()
  }
  const out = new Map<string, string>()
  for (const [id, hash] of found) if (typeof hash === 'string' && hash !== ABSENT && OBJECT_NAME.test(hash)) out.set(id, hash)
  return out
}

/** The SHA-256 of the bytes snapshot `snapshotId` holds, as the journal names it (see `snapshotEntryHash`); the object is not looked at (`verifiedSnapshotHash` does). Reads only. */
export function snapshotHashOf(root: string, snapshotId: string, seams: HistorySeams = {}): Promise<string | null> {
  return snapshotEntryHash(root, snapshotId, seams)
}

/**
 * The undecided outside Changes in the review ledger follow moves the command line made with the app
 * closed (specification section 5: "follows the rename if WriteFlex or the command line did it").
 * With no app on this computer having the Collection open, the command line writes the ledger through
 * the app's own `ChangeStore.followRename` (the format is the app's), with the same checks as a
 * version save: `confirmOwner` asked first, `.writeflex` an ordinary folder in
 * place, the journal absent or an ordinary file. An absent ledger has nothing to follow and is not
 * made. The store replaces the journal whole by rename, so a link planted at its name is replaced,
 * never written through. Returns how many Changes moved, over all `moves`, applied in the order made.
 */
export async function followRenamesInLedger(workspace: Workspace, confirmOwner: () => Promise<void>, moves: Array<{ from: string; to: string }>): Promise<number> {
  const { root } = workspace
  // The rewrite drops lines this build cannot parse, so the command line and the app must ship as one version.
  // Checked immediately before each write of the store: `confirmOwner`, and there is a ledger to follow.
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
