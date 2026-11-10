/**
 * The app's side of a Folio version save, bound to ONE Collection for its whole life, as
 * requested-version-save.ts is for a single file (and for the same reasons: a window's current
 * Workspace, stores and agent change under a request in flight, so nothing is looked up when the save
 * runs, and a save that finds the binding replaced or the roots disagreeing is refused).
 *
 * Two doors, one function (folio-version-save.ts):
 *  - `requestedFolioVersionSave`: carried out for a command (`writeflex save-folio-version`) or the
 *    in-app agent. It settles NOTHING: the writer's own waiting changes make it refuse `version-unsettled`.
 *  - `folioVersionSaveWithApproval`: the app's own call after the writer approved the sheet (ticket 04
 *    wires it to the window). It also accepts the writer's own waiting changes into their files first,
 *    the way the per-file save does (`saveNamedVersion`).
 *
 * Electron-free: ipc.ts gives it the window's objects at bind time, tests give it their own.
 */
import { verifiedSnapshotHash } from './cli/history-store'
import { readBytes } from './cli/guarded-fs'
import type { ChangeStore } from './changes'
import { FolioVersionStore } from './folio-versions'
import { saveFolioVersion, type FolioSaveInput, type FolioSaveStores, type SavedFolioVersion } from './folio-version-save'
import type { VersionSnapshotAgent, VersionSaveBinding } from './requested-version-save'
import { saveNamedVersion } from './save-version'
import { VersionSaveRefused } from './saved-text-version'
import { normaliseRoot } from './root-resolution'
import type { WorkspaceAgent } from './agent'

export type FolioVersionSaveBinding = VersionSaveBinding & {
  /** The agent able to settle changes (`applyAcceptedChangesForVersion`); only `folioVersionSaveWithApproval` asks for it. */
  settleAgent?: () => Promise<Pick<WorkspaceAgent, 'workspace' | 'snapshotReviewVersion' | 'applyAcceptedChangesForVersion'> | null>
}

/** Overrides of the scope rules, for tests; production passes none (the backup's own scope, the 25 MiB cap). */
export type FolioSaveOptions = Pick<FolioSaveStores, 'isDocument' | 'isInsertedFile' | 'limits' | 'insertedFileCap'>

export type RequestedFolioVersionSave = (input: FolioSaveInput, confirmOwner: () => Promise<void>) => Promise<SavedFolioVersion>

const CLOSED = 'WriteFlex no longer has this Collection open in that window, so no Folio version was saved. Run the command again.'

type Prepared = { stores: FolioSaveStores; changes: ChangeStore }

async function prepare(binding: FolioVersionSaveBinding, confirmOwner: () => Promise<void>, agent: VersionSnapshotAgent, options: FolioSaveOptions): Promise<Prepared> {
  const root = normaliseRoot(binding.workspace.root)
  const sameRoot = (other: string): boolean => normaliseRoot(other) === root
  const assertBound = (): void => {
    if (!binding.live()) throw new VersionSaveRefused(CLOSED)
    if (!sameRoot(binding.versions.root) || !sameRoot(binding.changes.root)) {
      throw new VersionSaveRefused('WriteFlex\'s version stores for this window belong to another Collection, so no Folio version was saved.')
    }
    if (!sameRoot(agent.workspace.root)) throw new VersionSaveRefused(CLOSED)
  }
  assertBound()
  const author = await binding.author()
  return {
    changes: binding.changes,
    stores: {
      workspace: binding.workspace, versions: binding.versions, changes: binding.changes, author, ...options,
      folioVersions: new FolioVersionStore(binding.workspace),
      // Asked before each store is written: all of them waited on something first.
      confirmOwner: async () => { await confirmOwner(); assertBound() },
      // A damaged object of the same name is put right inside the snapshot itself (snapshotVersionOfSavedText).
      snapshot: (path) => agent.snapshotReviewVersion(path),
      snapshotHash: (snapshotId) => verifiedSnapshotHash(binding.workspace.root, snapshotId),
      readBytes: (path) => readBytes(binding.workspace, path),
    },
  }
}

export function requestedFolioVersionSave(binding: FolioVersionSaveBinding, options: FolioSaveOptions = {}): RequestedFolioVersionSave {
  return async (input, confirmOwner) => {
    const agent = await binding.agent()
    if (!agent) throw new VersionSaveRefused('WriteFlex has no history store open for this Collection yet. Try again in a moment.')
    const { stores } = await prepare(binding, confirmOwner, agent, options)
    const saved = await saveFolioVersion(stores, input)
    binding.onSaved?.()
    return saved
  }
}

/** The save the writer approved in the app: waiting changes of the writer's own are settled first. Never reachable from a request or the command line. */
export function folioVersionSaveWithApproval(binding: FolioVersionSaveBinding, options: FolioSaveOptions = {}): RequestedFolioVersionSave {
  return async (input, confirmOwner) => {
    const agent = await binding.settleAgent?.()
    if (!agent) throw new VersionSaveRefused('WriteFlex has no history store open for this Collection yet. Try again in a moment.')
    const { stores, changes } = await prepare(binding, confirmOwner, agent, options)
    const saved = await saveFolioVersion({
      ...stores,
      settle: {
        run: async ({ path, changeIds, versionName, folioSave }) => {
          await saveNamedVersion({ path, name: versionName, changeIds, changes, versions: binding.versions, agent: agent as unknown as WorkspaceAgent, author: input.author ?? stores.author, folioSave })
        },
      },
    }, input)
    binding.onSaved?.()
    return saved
  }
}
