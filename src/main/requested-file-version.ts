/**
 * The app's side of the file-version writes (file-versions.ts), bound to ONE Collection for the whole life of the binding, as requested-version-save.ts
 * is for a Markdown version and for the same reasons. Nothing is looked up from the window when an operation runs: the Workspace and the version store
 * are the objects given when the binding was made and must be of the binding's root (canonical roots compared); the agent is the one serving the binding
 * now and is used only if its Workspace is of the same root; before every store or file is written the binding must still be live and the roots must
 * still agree (`confirmOwner`). An operation that finds otherwise writes nothing, and is never carried out in another Collection.
 *
 * Electron-free: ipc.ts gives it the window's objects at bind time, tests give it their own.
 */
import type { VersionSnapshotResult } from './agent'
import type { VersionSnapshotAgent, VersionSaveBinding } from './requested-version-save'
import { FileVersionRefused, restoreFileVersion, saveFileVersion, saveFileVersionAsCopy, type FileVersionStores } from './file-versions'
import { defaultFileVersionReads } from './file-version-sources'
import { normaliseRoot } from './root-resolution'
import type { AuthorIdentity } from './versions'
import type { RestoreFileVersionResult, SaveFileCopyResult, SaveFileVersionResult } from '../shared/file-versions'

/** The part of the agent a file version uses: it snapshots the bytes it is given (`snapshotVersionBytes`) and never reads the file for a snapshot. */
export type FileVersionAgent = Pick<VersionSnapshotAgent, 'workspace'> & { snapshotVersionBytes(path: string, bytes: Uint8Array): Promise<VersionSnapshotResult> }

export type FileVersionBinding = Pick<VersionSaveBinding, 'workspace' | 'versions' | 'author' | 'live' | 'onSaved'> & {
  /** The agent serving this binding now, awaited if it is still starting; null when there is none. */
  agent: () => Promise<FileVersionAgent | null>
  /** Told after a file was written by a restore or a copy, so the window reads the Collection again. */
  onFileWritten?: (path: string) => void
  /** Overrides of the rules, for tests; production passes none (the 25 MiB cap). */
  cap?: number
}

export type RequestedFileVersion = {
  save: (input: { path: unknown; name: unknown; note?: unknown; author?: AuthorIdentity }, confirmOwner: () => Promise<void>) => Promise<SaveFileVersionResult>
  restore: (input: { path: unknown; versionId: unknown; expectVersionSha256: unknown; expectWorkingSha256: unknown; author?: AuthorIdentity }, confirmOwner: () => Promise<void>) => Promise<RestoreFileVersionResult>
  copy: (input: { path: unknown; versionId: unknown; expectVersionSha256: unknown; name: unknown }, confirmOwner: () => Promise<void>) => Promise<SaveFileCopyResult>
}

const CLOSED = 'WriteFlex no longer has this Collection open in that window, so nothing was written. Run it again.'

export function requestedFileVersion(binding: FileVersionBinding): RequestedFileVersion {
  const root = normaliseRoot(binding.workspace.root)
  const sameRoot = (other: string): boolean => normaliseRoot(other) === root
  const assertBound = (): void => {
    if (!binding.live()) throw new FileVersionRefused(CLOSED)
    if (!sameRoot(binding.versions.root)) throw new FileVersionRefused('WriteFlex\'s version store for this window belongs to another Collection, so nothing was written.')
  }
  const prepared = async (confirmOwner: () => Promise<void>): Promise<FileVersionStores> => {
    assertBound()
    const agent: FileVersionAgent | null = await binding.agent()
    if (!agent) throw new FileVersionRefused('WriteFlex has no history store open for this Collection yet. Try again in a moment.')
    const author = await binding.author()
    return {
      ...defaultFileVersionReads(binding.workspace, binding.versions),
      versions: binding.versions,
      snapshotBytes: async (path, bytes) => {
        // The agent is the one serving the binding at the time; it is used only if it is of the same Collection.
        if (!sameRoot(agent.workspace.root)) throw new FileVersionRefused(CLOSED)
        return agent.snapshotVersionBytes(path, bytes)
      },
      author,
      // Asked before each store or file is written: all of them waited on something first.
      confirmOwner: async () => { await confirmOwner(); assertBound() },
      // The same check, synchronously, for the tick of the rename that commits a restore or a copy.
      assertBound,
      ...(binding.cap !== undefined ? { cap: binding.cap } : {}),
    }
  }
  return {
    save: async (input, confirmOwner) => {
      const saved = await saveFileVersion(await prepared(confirmOwner), input)
      binding.onSaved?.()
      return { version: saved.version }
    },
    restore: async (input, confirmOwner) => {
      const done = await restoreFileVersion(await prepared(confirmOwner), input)
      binding.onSaved?.()
      if (typeof input.path === 'string') binding.onFileWritten?.(input.path)
      return done
    },
    copy: async (input, confirmOwner) => {
      const done = await saveFileVersionAsCopy(await prepared(confirmOwner), input)
      binding.onFileWritten?.(done.path)
      return done
    },
  }
}
