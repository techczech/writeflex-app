/**
 * The stores the file-version operations (file-versions.ts) run over, for one Collection. Reads only, except where a caller adds a snapshot.
 * Electron-free, so the window, the agent's verb and the command line all build them the same way.
 */
import { readSnapshotBytesBounded, snapshotHashesOf } from './cli/history-store'
import { FolioVersionStore } from './folio-versions'
import type { FileVersionStores } from './file-versions'
import type { VersionStore } from './versions'
import type { Workspace } from './workspace'

/**
 * The exact bytes of snapshot `snapshotId`, refused (`'too-large'`) when the object holds more than `maxBytes`: the read itself stops at `maxBytes + 1`, so an
 * object that grows between any look at its size and the read is never pulled into memory whole. Null when there is no such snapshot or object. The object
 * is checked against its name by the history store's own reader.
 */
export async function readSnapshotBytesWithin(root: string, snapshotId: string, maxBytes: number): Promise<Buffer | 'too-large' | null> {
  return readSnapshotBytesBounded(root, snapshotId, maxBytes)
}

/** What the reads (list, compare) need, over this Collection's own stores. */
export function defaultFileVersionReads(workspace: Workspace, versions: Pick<VersionStore, 'list'>): Pick<FileVersionStores, 'workspace' | 'versions' | 'folioVersions' | 'snapshotHashes' | 'readSnapshotBytes'> {
  return {
    workspace,
    versions: versions as VersionStore,
    folioVersions: new FolioVersionStore(workspace),
    snapshotHashes: (ids) => snapshotHashesOf(workspace.root, ids),
    readSnapshotBytes: (snapshotId, maxBytes) => readSnapshotBytesWithin(workspace.root, snapshotId, maxBytes),
  }
}
