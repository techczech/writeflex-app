import { WRITEFLEX_SELF_AUTHOR, type VersionStore, type Version } from './versions'
import type { EditorSaveResult, SaveFileOptions } from './workspace'
import type { SaveBasis } from '../shared/save-basis'
import { replicaSnapshotHash, replicaVersionsFor } from './replica-versions'
import { preserveVersion, sha256Of, type PreserveReceipt, type PreserveResult } from './preserve-version'

export type VersionContentRequest = {
  id?: string
  versionId?: string
  snapshotId?: string
  path?: string
}

export type SnapshotContentReader = {
  readSnapshotContent(entryId: string): Promise<string | null>
}

export type VersionRestoreCheckpoints = {
  preserveBeforeRestore(path: string, text: string): Promise<PreserveResult>
  checkpointRestored(path: string, text: string): Promise<boolean>
}

type VersionRestorer = SnapshotContentReader & VersionRestoreCheckpoints

export const RESTORE_RECOVERY_NAME = 'Before a version was restored'

export type VersionRestoreResult =
  | { refused: 'recovery-unverified'; message: string }
  | (EditorSaveResult & { status: 'restored' })
  | (EditorSaveResult & {
    status: 'restored-with-history-error'
    recovery: PreserveReceipt & { name: string }
  })

/** History checkpoints for named-document restore. The pre-write copy has a row the writer can return to. */
export function historyRestoreCheckpoints(
  history: SnapshotContentReader & { snapshotForPreserve(path: string): Promise<{ id: string; hash: string } | null> },
  versions?: VersionStore,
): VersionRestoreCheckpoints {
  const capture = (path: string, text: string) => preserveVersion({ text, history: () => history.snapshotForPreserve(path) })
  return {
    async preserveBeforeRestore(path, text) {
      const result = await capture(path, text)
      if (!result.kept) return result
      if (await history.readSnapshotContent(result.receipt.entryId) !== text) return { kept: false, refused: 'unavailable' }
      await versions?.append({ path, name: RESTORE_RECOVERY_NAME, author: WRITEFLEX_SELF_AUTHOR, snapshotId: result.receipt.entryId })
      return result
    },
    async checkpointRestored(path, text) {
      return (await capture(path, text)).kept
    },
  }
}

/** Writes that commit only over the version the open buffer was based on (shared/save-basis.ts). */
export type VersionFileWriter = {
  assertDocumentPath(path: string): void
  assertOnDisk(path: string, basis: SaveBasis): Promise<void>
  saveFileOver(path: string, content: string, basis: SaveBasis, options?: SaveFileOptions): Promise<EditorSaveResult>
}

export type VersionContentResult = {
  version: Version | null
  path: string | null
  snapshotId: string | null
  content: string | null
}

/**
 * The reader for every version's text: a replica version (`replica:<sha256>`, replica-versions.ts) is read
 * from the Collection's replica store, hash-checked, with no agent; any other from `primary` (the agent's
 * History) when there is one, and, when `offline` is given (synced Collections), from that agent-free
 * reader of the same History (cli/history-store.ts, which also reads journal copies made by sync) when
 * there is no agent or it has no such entry. `local` (synced Collections): a replica text held only in this
 * Mac's local recovery (replica-save-cycles.ts), read from local disk when the store has no such object.
 */
export function replicaAwareReader(root: string, primary: () => Promise<SnapshotContentReader | null>, offline?: SnapshotContentReader, local?: (sha: string) => Buffer | null): SnapshotContentReader {
  return {
    readSnapshotContent: async (entryId) => {
      const hash = replicaSnapshotHash(entryId)
      // `local`: this Mac's recovery copy (hash-checked), for a text the synced store does not hold yet.
      if (hash) return ((await replicaVersionsFor(root).read(hash)) ?? local?.(hash) ?? null)?.toString('utf8') ?? null
      // Without `offline` the primary's own failure stands (no agent: the error it always gave).
      if (!offline) return (await primary())?.readSnapshotContent(entryId) ?? null
      const reader = await primary().catch(() => null)
      const text = reader ? await reader.readSnapshotContent(entryId) : null
      if (text !== null) return text
      return offline.readSnapshotContent(entryId).catch(() => null)
    },
  }
}

function matchesRequest(version: Version, input: VersionContentRequest): boolean {
  if (input.id && version.id === input.id) return true
  if (input.versionId && version.versionId === input.versionId) return true
  if (input.snapshotId && version.snapshotId === input.snapshotId) return true
  return false
}

async function resolveVersion(
  versions: VersionStore,
  input: VersionContentRequest,
): Promise<Version | null> {
  const scoped = await versions.list(input.path ? { path: input.path } : undefined)
  return scoped.find((version) => matchesRequest(version, input)) ?? null
}

export async function readVersionContent(
  versions: VersionStore,
  snapshots: SnapshotContentReader,
  input: VersionContentRequest,
): Promise<VersionContentResult | null> {
  const version = await resolveVersion(versions, input)
  const snapshotId = version?.snapshotId ?? input.snapshotId ?? null
  if (!snapshotId) return null
  const content = await snapshots.readSnapshotContent(snapshotId)
  return {
    version,
    path: version?.path ?? input.path ?? null,
    snapshotId,
    content,
  }
}

/**
 * Put a version back as the document. `basis` is the version of the file the open buffer was based on,
 * after the renderer flushed the buffer through its own guarded save (review round 1, Muse M2): the
 * document as the writer has it is on disk then, and the pre-restore checkpoint records it. The restore
 * replaces only that version: another version on disk (an outside change, before or during the
 * checkpoint) stops it with DiskChangedUnderBuffer before anything is written.
 */
export async function restoreVersionContent(
  versions: VersionStore,
  restorer: VersionRestorer,
  writer: VersionFileWriter,
  input: VersionContentRequest & { basis: SaveBasis },
  beforeCommit?: SaveFileOptions['beforeCommit'],
): Promise<VersionRestoreResult | null> {
  const result = await readVersionContent(versions, restorer, input)
  if (!result?.path || result.content === null) return null
  const { path, content } = result
  const { basis } = input
  writer.assertDocumentPath(path)
  await writer.assertOnDisk(path, basis)
  if (basis.kind !== 'disk' && basis.kind !== 'keep-mine') {
    return { refused: 'recovery-unverified', message: 'Open the current document first so its text can be kept.' }
  }
  const expected = sha256Of(basis.text)
  const preserved = await restorer.preserveBeforeRestore(path, basis.text).catch(() => null)
  if (!preserved?.kept || !preserved.receipt?.entryId || preserved.receipt.sha256 !== expected) {
    // An outside edit can also explain a failed preservation. Report that through the conflict notice.
    await writer.assertOnDisk(path, basis)
    return { refused: 'recovery-unverified', message: 'The current text could not be verified in version history.' }
  }
  const file = await writer.saveFileOver(path, content, basis, {
    beforeCommit,
    // The textual basis alone cannot distinguish invalid UTF-8 from a literal replacement character.
    expect: { fingerprint: preserved.receipt.sha256 },
  })
  const checkpointed = await restorer.checkpointRestored(path, file.written).catch(() => false)
  if (checkpointed) return { ...file, status: 'restored' }
  return {
    ...file, status: 'restored-with-history-error',
    recovery: { ...preserved.receipt, name: RESTORE_RECOVERY_NAME },
  }
}
