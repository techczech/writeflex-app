/**
 * Save a named version of a document's SAVED text, with no window and no agent turn: the version
 * save the command line asks for (specification sections 3 and 4). One function serves both routes:
 * the app carrying out a request (request-executor.ts, over the app's own stores and its agent's
 * snapshot store) and the command line with the app not having the Collection open on this computer (cli/history-store.ts).
 *
 * What it writes is what the app's own "Save version" writes for a document with nothing to settle,
 * in the same order and through the same store code:
 *   1. one restore point and one file snapshot in Bridle's snapshot store (`.bridle/journal.jsonl`,
 *      `.bridle/objects/<sha256>`), labelled and stamped exactly as the app's (`snapshotVersionOfSavedText`,
 *      which the app's agent also calls);
 *   2. one record in the version journal (`.writeflex/versions.jsonl`, VersionStore.append).
 *
 * WHAT IT DOES NOT DO. The app's save also settles the document's review run: it accepts the writer's
 * own pending Changes and pending copy-edits, applies them to the document, and stamps every accepted
 * Change with the version (save-version.ts). That needs the agent and rewrites the document, and
 * nothing a request or a command may ask for accepts a Change. So a document that has such Changes
 * is REFUSED here, with their number, and nothing is written; were the version saved without them,
 * the app's next save would stamp them with a later version and Compare would place them in the
 * wrong one. Changes still pending review (an agent's proposals) are left pending, as the app's save
 * leaves them.
 *
 * Electron-free, and imports nothing from Bridle at run time.
 */
import { lstat } from 'node:fs/promises'
import type { VersionSnapshotResult } from './agent'
import { assertCollectionWritable } from './collection-write-gate'
import { documentPathRefusal, type Change, type ChangeStore } from './changes'
import { ObjectRepairRefused, repairStandingObjectOf, repairStandingObjectOfBytes } from './history-object-repair'
import type { SnapshotBytesMeta } from './snapshot-bytes'
import { FILE_VERSION_CAP_BYTES, FILE_VERSION_CAP_LABEL, isMarkdownDocument } from '../shared/file-versions'
import type { AuthorIdentity, Version, VersionStore } from './versions'
import type { Workspace } from './workspace'

/** The two calls of Bridle's snapshot store a version save makes. */
export type VersionSnapshots = {
  beginRestorePoint(label: string, sessionId?: string): Promise<string>
  snapshotFile(absPath: string, meta: { sessionId?: string; capability?: string }): Promise<{ id: string }>
}

/** The two calls of the snapshot store a version save of bytes already in hand makes (`snapshotBytesOfSavedText`). */
export type VersionByteSnapshots = Pick<VersionSnapshots, 'beginRestorePoint'> & {
  snapshotBytes(absPath: string, bytes: Uint8Array, meta: SnapshotBytesMeta): Promise<{ id: string }>
}

/** A refusal of a version save, in words for the person; nothing was written when it is thrown before the snapshot. `out-of-backup-scope`: a Folio version a backup would hold back (folio-version-save.ts). */
export class VersionSaveRefused extends Error {
  override readonly name = 'VersionSaveRefused'
  /** `version-unsettled`: the writer must save this version in WriteFlex (cli/outcome.ts). Otherwise a plain refusal. */
  constructor(message: string, readonly code: 'refused' | 'version-unsettled' | 'out-of-backup-scope' = 'refused') {
    super(message)
  }
}

/**
 * Save version (ADR-0014/C6): one restore point plus one file snapshot of the document as it stands
 * on disk. The returned restore-point id is the version handle Versions and Compare read. Only a
 * document is ever copied into the history store: the path is judged before, and again in the tick
 * the snapshot starts, because beginning the restore point waited.
 */
export async function snapshotVersionOfSavedText(input: {
  workspace: Workspace
  snapshots: VersionSnapshots
  sessionId: string
  path: string
  /** Default true. False only for a caller that has already put a damaged object right under a folder it holds (the command line, cli/history-store.ts). */
  repairObject?: boolean
}): Promise<VersionSnapshotResult> {
  const { workspace, snapshots, sessionId, path } = input
  const refusal = documentPathRefusal(workspace, path)
  if (refusal) throw new VersionSaveRefused(`A version cannot be saved: ${refusal}`)
  // Bridle's store refuses to save over a damaged object of the same name, for ever. Every version snapshot passes here (a Folio
  // save, the approved settle of a Folio save, an ordinary Save version, the first version on close), so the repair is made here,
  // before the restore point is begun and anything is written (history-object-repair.ts).
  if (input.repairObject !== false) {
    await repairStandingObjectOf(workspace, path).catch((error: unknown) => {
      if (error instanceof ObjectRepairRefused) throw new VersionSaveRefused(`${error.message} Nothing was saved.`)
      throw error
    })
  }
  const versionId = await snapshots.beginRestorePoint(`version: ${path}`, sessionId)
  const lateRefusal = documentPathRefusal(workspace, path)
  if (lateRefusal) throw new VersionSaveRefused(`A version cannot be saved: ${lateRefusal}`)
  const snapshot = await snapshots.snapshotFile(workspace.absolute(path), { sessionId, capability: 'change.save-version' })
  return { versionId, snapshotId: snapshot.id }
}

/**
 * `snapshotVersionOfSavedText` for bytes the caller has already read and judged (a file version, file-versions.ts): one restore point and one snapshot
 * of EXACTLY these bytes. The file is not read again, so what is stored cannot differ from what was judged, whatever the file became in between.
 * The path is judged before and again after the restore point is begun, as there; an object standing at the bytes' name that is damaged is put right first.
 */
export async function snapshotBytesOfSavedText(input: {
  workspace: Workspace
  snapshots: VersionByteSnapshots
  sessionId: string
  path: string
  bytes: Uint8Array
}): Promise<VersionSnapshotResult> {
  const { workspace, snapshots, sessionId, path, bytes } = input
  const refusal = documentPathRefusal(workspace, path)
  if (refusal) throw new VersionSaveRefused(`A version cannot be saved: ${refusal}`)
  await repairStandingObjectOfBytes(workspace, bytes).catch((error: unknown) => {
    if (error instanceof ObjectRepairRefused) throw new VersionSaveRefused(`${error.message} Nothing was saved.`)
    throw error
  })
  const versionId = await snapshots.beginRestorePoint(`version: ${path}`, sessionId)
  const lateRefusal = documentPathRefusal(workspace, path)
  if (lateRefusal) throw new VersionSaveRefused(`A version cannot be saved: ${lateRefusal}`)
  const snapshot = await snapshots.snapshotBytes(workspace.absolute(path), bytes, { sessionId, capability: 'change.save-version' })
  return { versionId, snapshotId: snapshot.id }
}

/**
 * The Changes the app's "Save version" would settle into the version: accepted ones, and pending
 * ones that are the writer's own or copy-edits, not yet in any version. The same rule as
 * save-version.ts's `accepted`, applied to every such Change of the document.
 */
export function changesAVersionWouldSettle(changes: readonly Change[]): Change[] {
  return changes.filter((change) => !change.snapshotId && (
    change.status === 'accepted'
    || (change.status === 'pending' && (change.provenance === 'writer' || change.editClass === 'copy'))
  ))
}

export type SavedTextVersionStores = {
  workspace: Workspace
  versions: Pick<VersionStore, 'append'>
  changes: Pick<ChangeStore, 'list'>
  /** Take the version's snapshot of the saved text (`snapshotVersionOfSavedText`, or the agent's method that calls it). */
  snapshot: (path: string) => Promise<VersionSnapshotResult>
  author: AuthorIdentity
  /** Throws when this process does not hold the Collection now. Asked before each store is written. */
  confirmOwner: () => Promise<void>
}

export type SavedTextVersion = { record: Version; versionId: string; snapshotId: string }

/** Save a version named `name` of the text `path` holds on disk. Refuses, writing nothing, as described above. */
export async function saveVersionOfSavedText(stores: SavedTextVersionStores, input: { path: string; name: string; note?: string; /** In place of the stores' author: set only by the app's own code, never from a request. */ author?: AuthorIdentity }): Promise<SavedTextVersion> {
  const { workspace } = stores
  // The snapshot and its version record must precede any rename intent for this path.
  return workspace.exclusive(input.path, async () => {
    const name = input.name.trim()
    if (name === '') throw new VersionSaveRefused('Version name is required.')
    const note = input.note?.trim()
    const refusal = documentPathRefusal(workspace, input.path)
    if (refusal) throw new VersionSaveRefused(`A version cannot be saved: ${refusal}`)
    const path = workspace.relative(workspace.absolute(input.path))
    // Without a file, Bridle would record "absent" and the version would have no text to compare or restore.
    const info = await lstat(workspace.absolute(path)).catch(() => null)
    if (!info) throw new VersionSaveRefused(`${path} does not exist, so there is no text to save a version of.`)
    if (!info.isFile()) throw new VersionSaveRefused(`${path} is not an ordinary file (a link or a folder stands at that name), so no version was saved.`)
    // A table, widget page or image over the cap is not given file versions (a Folio version lists it as a reference). Judged from its size, before a byte is read.
    if (!isMarkdownDocument(path) && info.size > FILE_VERSION_CAP_BYTES) throw new VersionSaveRefused(`${path} is over ${FILE_VERSION_CAP_LABEL}, so it is not given file versions: a Folio version lists it as a reference and keeps no copy. No version was saved.`)

    const unsettled = changesAVersionWouldSettle(await stores.changes.list({ path }))
    if (unsettled.length > 0) {
      const n = unsettled.length
      throw new VersionSaveRefused(
        `${path} has ${n} change${n === 1 ? '' : 's'} that saving a version in WriteFlex would gather into it (accepted, the writer's own, or a copy-edit, and not yet in any version). `
        + 'This command saves the text as it stands on disk and settles no changes, so it saved nothing. Save this version in WriteFlex.',
        'version-unsettled',
      )
    }

    await stores.confirmOwner()
    assertCollectionWritable(workspace.root)
    const snapshot = await stores.snapshot(path)
    await stores.confirmOwner()
    const record = await stores.versions.append({
      path, name, author: input.author ?? stores.author,
      ...(note ? { note } : {}),
      snapshotId: snapshot.snapshotId,
      versionId: snapshot.versionId,
    })
    return { record, ...snapshot }
  })
}
