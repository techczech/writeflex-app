/**
 * The app's side of a requested version save (request-executor.ts `saveVersion`), bound to ONE
 * Collection for its whole life. A window's "current" Workspace, stores and agent change when the
 * window is bound to another Collection or closed, and a request read from one Collection's inbox can
 * still be in flight then. So nothing here is looked up from the window when the save runs:
 *
 *  - the Workspace, the version store and the review store are the objects given when the binding
 *    was made, and each must be of the binding's root (canonical roots compared) or nothing is saved;
 *  - the agent is the one serving the binding at the time (the active thread's, which changes within
 *    a Collection), and is used only if its Workspace is of the same root;
 *  - before the snapshot and before the version record are written, the binding must still be live
 *    (`live`: not replaced, window not closed) and the roots must still agree. A save that finds
 *    otherwise is refused; it is never carried out in another Collection.
 *
 * Electron-free: ipc.ts gives it the window's objects at bind time, tests give it their own.
 */
import type { VersionSnapshotResult } from './agent'
import type { ChangeStore } from './changes'
import { normaliseRoot } from './root-resolution'
import { saveVersionOfSavedText, VersionSaveRefused, type SavedTextVersion } from './saved-text-version'
import type { AuthorIdentity, VersionStore } from './versions'
import type { Workspace } from './workspace'

/** The part of the agent a version save uses. */
export type VersionSnapshotAgent = { workspace: { root: string }; snapshotReviewVersion(path: string): Promise<VersionSnapshotResult> }

export type VersionSaveBinding = {
  workspace: Workspace
  versions: VersionStore
  changes: ChangeStore
  /** The agent serving this binding now, awaited if it is still starting; null when there is none. */
  agent: () => Promise<VersionSnapshotAgent | null>
  author: () => Promise<AuthorIdentity>
  /** False once the window was bound to another Collection or closed. */
  live: () => boolean
  /** Told after a version was saved (the window refreshes its list). */
  onSaved?: () => void
}

export type RequestedVersionSave = (input: { path: string; name: string; note?: string; author?: AuthorIdentity }, confirmOwner: () => Promise<void>) => Promise<SavedTextVersion>

const CLOSED = 'WriteFlex no longer has this Collection open in that window, so no version was saved. Run the command again.'

export function requestedVersionSave(binding: VersionSaveBinding): RequestedVersionSave {
  const root = normaliseRoot(binding.workspace.root)
  const sameRoot = (other: string): boolean => normaliseRoot(other) === root
  const assertBound = (): void => {
    if (!binding.live()) throw new VersionSaveRefused(CLOSED)
    if (!sameRoot(binding.versions.root) || !sameRoot(binding.changes.root)) {
      throw new VersionSaveRefused('WriteFlex\'s version stores for this window belong to another Collection, so no version was saved.')
    }
  }
  return async (input, confirmOwner) => {
    assertBound()
    const agent = await binding.agent()
    if (!agent) throw new VersionSaveRefused('WriteFlex has no history store open for this Collection yet. Try again in a moment.')
    const assertAgent = (): void => {
      if (!sameRoot(agent.workspace.root)) throw new VersionSaveRefused(CLOSED)
    }
    const author = await binding.author()
    const saved = await saveVersionOfSavedText({
      workspace: binding.workspace, versions: binding.versions, changes: binding.changes, author,
      // Asked before the snapshot and before the version record: both waited on something first.
      confirmOwner: async () => {
        await confirmOwner()
        assertBound()
        assertAgent()
      },
      snapshot: (path) => agent.snapshotReviewVersion(path),
    }, input)
    binding.onSaved?.()
    return saved
  }
}
