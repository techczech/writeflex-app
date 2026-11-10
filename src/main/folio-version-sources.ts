/**
 * The stores the Folio version reads run over, for one Collection: the shared reader's (ticket 07) and Compare's (ticket 08). Reads
 * only. Electron-free, so the app's window, the agent's verb and the command line all build their sources the same way.
 */
import { readSnapshotBytes } from './cli/history-store'
import { readBytes } from './cli/guarded-fs'
import { FolioVersionStore } from './folio-versions'
import { getFolioObject } from './folio-version-objects'
import type { FolioCompareSources } from './folio-version-compare'
import type { VersionReaderSources } from './folio-version-reader'
import { readMovedVersions } from './version-moves'
import type { Workspace } from './workspace'

/** The shared reader's sources over this Collection's own stores (ticket 07). */
export function defaultReaderSources(workspace: Workspace): VersionReaderSources {
  return {
    workspace,
    folioVersions: new FolioVersionStore(workspace),
    fileVersions: () => readMovedVersions(workspace.root),
    readSnapshotBytes: (snapshotId) => readSnapshotBytes(workspace.root, snapshotId),
    readFolioObject: (sha256) => getFolioObject(workspace.root, sha256),
  }
}

/** Compare's sources (ticket 08): the reader's, and a working file's bytes through the guarded reader (a link or a missing file is `null`). */
export function defaultCompareSources(workspace: Workspace): FolioCompareSources {
  return { ...defaultReaderSources(workspace), readWorkingBytes: (path) => readBytes(workspace, path).catch(() => null) }
}
