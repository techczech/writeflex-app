/**
 * Save a Folio version (ADR-0052; Folio versions ticket 03): the one operation the app and the agent
 * both call, with no window and no model turn. It gathers a Folio's files (folio-version-members.ts),
 * gives each a per-file version, and writes ONE record in the Folio journal that points at them.
 *
 * What it writes, in this order, and nothing else:
 *   1. for each file whose saved bytes differ from its latest per-file version's snapshot (or whose
 *      snapshot object is missing or does not match), one restore point and one snapshot in Bridle's
 *      store and one record in `.writeflex/versions.jsonl`, named `Folio version: <name>` and carrying
 *      `folioSave: <the save's id>` (the same code as the per-file save: `snapshotVersionOfSavedText`);
 *      a file whose bytes equal a sound snapshot REUSES the version and writes nothing;
 *   2. one `folio-version` record in `.writeflex/folio-versions.jsonl` (FolioVersionStore.append), with
 *      that same id, then one commit line `{kind: 'folio-save-committed', id}` in `.writeflex/folio-save-commits.jsonl`
 *      (VersionStore.commitFolioSave). THIS IS THE COMMIT, and either line makes the save complete: the
 *      stores are append-only and nothing is deleted if a save stops after step 1 began, so a per-file
 *      version of a save with neither line is an orphan. It is left in the journal, never reused, and
 *      hidden from per-file history (folio-save-commit.ts); the backup projection carries it like any
 *      per-file version, marker included, and a restored copy hides it too. A completed save's commit
 *      line travels with the backup even when its Folio record is left out.
 *
 * BEFORE ANY OF THAT, every refusal is decided with nothing written:
 *   - the name is blank; the Folio has no Index Note file; a file cannot be read as an ordinary file;
 *   - a file has the writer's own waiting changes and no approval to settle them was given
 *     (`version-unsettled`, the headless answer: the writer must save in WriteFlex);
 *   - a file is outside what backup sends, or too large for a backup (`canProjectFolioMembers`, the
 *     rule ticket 02 gave): a Folio version a backup would hold back is not created
 *     (`out-of-backup-scope`). The Index Note, parts and files not in the outline are judged by the ordinary scope
 *     (Markdown). An INSERTED file (under the size cap) is not: it is carried as a frozen copy, so only a place the backup
 *     never sends from (the bin, `.bridle`, `node_modules`, `.writeflex`) refuses it (ADR-0052 amendment, option A).
 *
 * Settling. With the writer's approval (`settle`, given only by the app's own code, never from a
 * request) the writer's own pending changes in a file are accepted into the file first, the way the
 * per-file save does (save-version.ts), and the per-file version is stamped with them. Without it, the
 * save refuses. An agent's pending proposals and held pairs are never touched: they stay pending, are
 * not in the saved bytes, and are listed in the result (`waiting`).
 *
 * Inserted files over the size cap, and files that are only linked, are `reference` members: their
 * sha256 is kept, their bytes are not. Inserted files under the cap get a per-file version like any member, and the backup
 * carries that saved copy with the Folio version (never the working file).
 *
 * Electron-free, and imports nothing from Bridle at run time.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { canProjectFolioMembers, DEFAULT_HISTORY_LIMITS, type FolioMemberFile, type HistoryLimits } from '../backup-helper/history-projection'
import { WRITEFLEX_SCOPE } from '../shared/backup-scope'
import type { FolioMember, FolioVersion } from '../shared/folio-version-records'
import type { VersionSnapshotResult } from './agent'
import { assertCollectionWritable } from './collection-write-gate'
import { documentPathRefusal, type Change, type ChangeStore } from './changes'
import { newFolioVersionId, type FolioVersionStore } from './folio-versions'
import { FolioGatherRefused, gatherFolio, type FolioFileRef } from './folio-version-members'
import { agentWaitingKind, FOLIO_INSERTED_FILE_CAP_BYTES, insertedFileHandling, previewFolio } from './folio-version-preview'
import { changesAVersionWouldSettle, VersionSaveRefused } from './saved-text-version'
import type { AuthorIdentity, Version, VersionStore } from './versions'
import type { Workspace } from './workspace'

export { FOLIO_INSERTED_FILE_CAP_BYTES }
const MARKDOWN = /\.(md|markdown)$/i

export type FolioSaveStores = {
  workspace: Workspace
  versions: Pick<VersionStore, 'list' | 'append' | 'commitFolioSave'>
  folioVersions: Pick<FolioVersionStore, 'append'>
  changes: Pick<ChangeStore, 'list'>
  /** Take a per-file version's snapshot of the saved bytes (`snapshotVersionOfSavedText`, or the agent's method that calls it). */
  snapshot: (path: string) => Promise<VersionSnapshotResult>
  /** The SHA-256 of the bytes a snapshot holds; null when the snapshot is not known or holds no file. */
  snapshotHash: (snapshotId: string) => Promise<string | null>
  /** The file's bytes as the command line or the app reads a document: through one handle that follows no final link. */
  readBytes: (path: string) => Promise<Buffer>
  author: AuthorIdentity
  /** Throws when this process does not hold the Collection now. Asked before each store is written. */
  confirmOwner: () => Promise<void>
  /** The vault's ordinary backup scope. Default: `ordinaryScopeTest(WRITEFLEX_SCOPE)`, the one the backup helper uses. */
  isDocument?: (path: string) => boolean
  /** Where a frozen copy of an inserted file may be carried from. Default: `insertedFileScopeTest(WRITEFLEX_SCOPE)`, the one the backup helper uses. */
  isInsertedFile?: (path: string) => boolean
  limits?: HistoryLimits
  /** Default `FOLIO_INSERTED_FILE_CAP_BYTES`. */
  insertedFileCap?: number
  /**
   * The writer's approval to settle (the save sheet's go-ahead). Present only when the app itself asks,
   * never from the command line or a request. `run` accepts the given changes into the file and takes
   * its per-file version named `versionName`, as `saveNamedVersion` does; the file is then read again.
   */
  settle?: { run: (input: { path: string; changeIds: string[]; versionName: string; /** The save's id: the per-file version it takes carries it (`saveNamedVersion`'s `folioSave`). */ folioSave: string }) => Promise<void> }
}

export type FolioSaveInput = {
  /** The Folio's folder (Collection-relative; '' is the Collection root). */
  dir: string
  name: string
  note?: string
  /** Default true. False only from the save sheet's tick box: the files not in the outline are left out of this version. Never from a request or the command line, which always include them (owner choice 3). */
  includeUnlisted?: boolean
  /** In place of the stores' author: set only by the app's own code, never from a request. */
  author?: AuthorIdentity
  /**
   * The fingerprint the save sheet showed (`FolioSheetFacts.fingerprint`, for the same `includeUnlisted`), sent back with
   * the go-ahead. Under the Folio's lock the save reads the Folio again the same way (`previewFolio`); if the fingerprint
   * differs (a file added meanwhile, an inserted file changed, changes newly waiting) it writes nothing and throws
   * `FolioSaveChanged`, so the writer sees what moved and gives another go-ahead. Absent: no such check (the command line, the agent).
   */
  expectFingerprint?: string
}

/** The Folio is not what the sheet showed. Nothing was written. The app's door turns this into a "changed" answer and refreshes the sheet. */
export class FolioSaveChanged extends Error {
  override readonly name = 'FolioSaveChanged'
  constructor() { super('The Folio changed while the Save Folio version sheet was open, so no Folio version was saved.') }
}

export type FolioWaiting = { path: string; /** An agent's pending proposals. */ pending: number; /** Held pairs. */ held: number }
export type FolioNotSaved = { path: string; why: string }

export type SavedFolioVersion = {
  record: FolioVersion
  /** Files that got a new per-file version in this save (named `Folio version: <name>`). */
  created: string[]
  /** Files whose latest per-file version already held these bytes. */
  reused: string[]
  /** Files whose writer's own waiting changes were accepted first (only with the writer's approval). */
  settled: Array<{ path: string; changes: number }>
  /** An agent's pending proposals and held pairs, left pending and out of the saved text. */
  waiting: FolioWaiting[]
  /** Things named in the Folio that have no file to keep (an unwritten part, an embed whose file is missing). */
  notSaved: FolioNotSaved[]
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

async function sha256OfFile(absolute: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** The backup's ordinary scope, built lazily so importing this module does not load the helper host. */
async function defaultScope(): Promise<(path: string) => boolean> {
  const { ordinaryScopeTest } = await import('@app-patterns/vault-sync/helper/host')
  return ordinaryScopeTest(WRITEFLEX_SCOPE)
}
async function defaultInsertedScope(): Promise<(path: string) => boolean> {
  const { insertedFileScopeTest } = await import('../backup-helper/inserted-scope')
  return insertedFileScopeTest(WRITEFLEX_SCOPE)
}

type Planned = FolioFileRef & { bytes: number; reference?: 'linked' | 'too-large'; sha256?: string }

/** Save a Folio version. Refuses, writing nothing, as described at the top of this file. */
export async function saveFolioVersion(stores: FolioSaveStores, input: FolioSaveInput): Promise<SavedFolioVersion> {
  const { workspace } = stores
  return workspace.exclusive(input.dir, async () => {
    const name = input.name.trim()
    if (name === '') throw new VersionSaveRefused('Version name is required.')
    const note = input.note?.trim()
    const cap = stores.insertedFileCap ?? FOLIO_INSERTED_FILE_CAP_BYTES

    let gathered
    try { gathered = await gatherFolio(workspace, input.dir, { includeUnlisted: input.includeUnlisted }) } catch (error) {
      if (error instanceof FolioGatherRefused) throw new VersionSaveRefused(error.message)
      throw error
    }
    // The sheet's facts are a preview. If the Folio has moved on since the writer read them, this save is not the one they approved.
    if (input.expectFingerprint !== undefined && (await previewFolio(stores, gathered, cap)).fingerprint !== input.expectFingerprint) throw new FolioSaveChanged()
    const notSaved: FolioNotSaved[] = gathered.notWritten.map((part) => ({ path: part.title, why: `Part "${part.title}" is in the running order but ${part.why}, so it is not in this version.` }))

    // What stands at each name. Nothing is written yet.
    const planned: Planned[] = []
    for (const file of gathered.files) {
      const text = file.role === 'index' || file.role === 'part' || file.role === 'unlisted'
      const absolute = workspace.absolute(file.path)
      const info = await lstat(absolute).catch(() => null)
      const refusal = documentPathRefusal(workspace, file.path)
      if (!info || !info.isFile() || refusal) {
        const why = !info ? `${file.path} does not exist` : refusal ? refusal : `${file.path} is not an ordinary file (a link or a folder stands at that name)`
        if (text) throw new VersionSaveRefused(`A Folio version cannot be saved: ${why.endsWith('.') ? why : `${why}.`} Nothing was saved.`)
        notSaved.push({ path: file.path, why: `${why}, so it is not in this version.` })
        continue
      }
      if (file.role === 'linked') planned.push({ ...file, bytes: info.size, reference: 'linked', sha256: await sha256OfFile(absolute) })
      else if (file.role === 'inserted' && insertedFileHandling(info.size, cap) === 'too-large') planned.push({ ...file, bytes: info.size, reference: 'too-large', sha256: await sha256OfFile(absolute) })
      else planned.push({ ...file, bytes: info.size })
    }

    // Waiting changes, per Markdown file: the writer's own (settle or refuse), an agent's (left, listed).
    const waiting: FolioWaiting[] = []
    const toSettle: Array<{ path: string; changes: Change[] }> = []
    for (const file of planned) {
      if (file.reference || !MARKDOWN.test(file.path)) continue
      const all = await stores.changes.list({ path: file.path })
      const own = changesAVersionWouldSettle(all)
      if (own.length > 0) {
        // Rejected, not-yet-stamped changes are stamped with the version too, as the per-file save does.
        toSettle.push({ path: file.path, changes: [...own, ...all.filter((change) => !change.snapshotId && change.status === 'rejected')] })
      }
      const pending = all.filter((change) => agentWaitingKind(change) === 'pending').length
      const held = all.filter((change) => agentWaitingKind(change) === 'held').length
      if (pending + held > 0) waiting.push({ path: file.path, pending, held })
    }
    if (toSettle.length > 0 && !stores.settle) {
      const parts = toSettle.map((entry) => `${entry.path} (${changesAVersionWouldSettle(entry.changes).length})`).join(', ')
      throw new VersionSaveRefused(
        `These files have the writer's own changes waiting, which saving a Folio version in WriteFlex would gather into it: ${parts}. `
        + 'This command saves the text as it stands on disk and settles no changes, so it saved nothing. Save this Folio version in WriteFlex.',
        'version-unsettled',
      )
    }

    // A Folio version a backup would hold back is not created.
    // An inserted file is carried as the frozen copy of its per-file version, so it is judged by the frozen-copy scope, not the Markdown scope.
    const isDocument = stores.isDocument ?? await defaultScope()
    const isInsertedFile = stores.isInsertedFile ?? await defaultInsertedScope()
    const contentFiles: FolioMemberFile[] = planned.filter((file) => !file.reference).map((file) => ({ path: file.path, bytes: file.bytes, ...(file.role === 'inserted' ? { inserted: true as const } : {}) }))
    const projectable = canProjectFolioMembers(contentFiles, isDocument, stores.limits ?? DEFAULT_HISTORY_LIMITS, isInsertedFile)
    if (!projectable.ok) throw new VersionSaveRefused(`${projectable.message} Nothing was saved.`, 'out-of-backup-scope')

    if (!planned.some((file) => file.role === 'index')) throw new VersionSaveRefused('The Folio has no Index Note file to keep a version under. Nothing was saved.')

    // What each file's version will be, decided with nothing written: its bytes as they stand, and the
    // per-file version that already holds them, if there is one. A file the writer's approval settles is
    // decided after the settle step, which changes it. Every refusal that can be known now is known now.
    const saveId = newFolioVersionId()
    const versionName = `Folio version: ${name}`
    type Decision = { hash: string; reuse?: Version }
    const decide = async (file: Planned): Promise<Decision> => {
      const hash = sha256(await stores.readBytes(file.path))
      // Orphans of saves that never finished are not listed, so they are never reused (folio-save-commit.ts).
      const latest = (await stores.versions.list({ path: file.path }, { includingFolioSave: saveId })).find((version) => version.snapshotId !== undefined)
      // The snapshot's object must be there and match: the journal's word alone would "save" text nobody can read.
      const reuse = latest && (await stores.snapshotHash(latest.snapshotId!)) === hash ? latest : undefined
      return { hash, ...(reuse ? { reuse } : {}) }
    }
    const settling = new Set(toSettle.map((entry) => entry.path))
    const decisions = new Map<string, Decision>()
    for (const file of planned) if (!file.reference && !settling.has(file.path)) decisions.set(file.path, await decide(file))
    await stores.confirmOwner()
    assertCollectionWritable(workspace.root)

    // ---- From here on the stores are written. ----
    // THE COMMIT BOUNDARY. Nothing written below is deleted if this stops part-way (an error, a crash): each
    // per-file version carries `folioSave: saveId`, and counts only once the Folio version record with that
    // id has been appended, last (folio-save-commit.ts). Until then it is an orphan: hidden, never reused.
    const settled: SavedFolioVersion['settled'] = []
    for (const entry of toSettle) {
      await stores.confirmOwner()
      assertCollectionWritable(workspace.root)
      await stores.settle!.run({ path: entry.path, changeIds: entry.changes.map((change) => change.id), versionName, folioSave: saveId })
      settled.push({ path: entry.path, changes: changesAVersionWouldSettle(entry.changes).length })
    }
    for (const file of planned) if (settling.has(file.path)) decisions.set(file.path, await decide(file))

    const created: string[] = []
    const reused: string[] = []
    const members: FolioMember[] = []
    let index: { path: string; versionId: string } | null = null
    for (const file of planned) {
      if (file.reference) {
        members.push({ role: 'reference', path: file.path, sha256: file.sha256!, why: file.reference })
        continue
      }
      const { hash, reuse } = decisions.get(file.path)!
      let version: Version
      if (reuse) {
        version = reuse
        // A file settled just now got its version from the settle step: that is a new version, not a reuse.
        if (settling.has(file.path)) created.push(file.path)
        else reused.push(file.path)
      } else {
        await stores.confirmOwner()
        assertCollectionWritable(workspace.root)
        const snapshot = await stores.snapshot(file.path)
        // The snapshot read the file again, by name: it must hold the bytes this version was judged on.
        if ((await stores.snapshotHash(snapshot.snapshotId)) !== hash) throw new VersionSaveRefused(`${file.path} changed while its version was being saved, so no Folio version was recorded. Run the command again.`)
        await stores.confirmOwner()
        version = await stores.versions.append({
          path: file.path, name: versionName, author: input.author ?? stores.author,
          snapshotId: snapshot.snapshotId, versionId: snapshot.versionId, folioSave: saveId,
        })
        created.push(file.path)
      }
      if (file.role === 'index') index = { path: file.path, versionId: version.id }
      members.push({
        role: file.role as 'index' | 'part' | 'unlisted' | 'inserted', path: file.path, versionId: version.id,
        ...(file.title !== undefined ? { title: file.title } : {}),
        ...(file.order !== undefined ? { order: file.order } : {}),
      })
    }
    if (!index) throw new VersionSaveRefused('The Folio has no Index Note file to keep a version under.')

    await stores.confirmOwner()
    assertCollectionWritable(workspace.root)
    const author = input.author ?? stores.author
    const record = await stores.folioVersions.append({
      id: saveId, name, author, index, members,
      ...(note ? { note } : {}),
    })
    // The save's second commit mark, in its own journal (folio-save-commit.ts; not versions.jsonl, whose unknown kinds an older backup helper rejects), so a backup that leaves the Folio record out
    // still keeps these per-file versions visible. The Folio record above is already the commit: a failure to append this line
    // (or a crash before it) leaves the save complete, and the record alone makes the versions count.
    await stores.versions.commitFolioSave(saveId).catch(() => undefined)
    return { record, created, reused, settled, waiting, notSaved }
  })
}
