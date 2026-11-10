/**
 * The file-versions panel's IPC doors (Folio versions ticket 19): list, compare, save a version, restore, save as a copy. Each names a file by its
 * Collection-relative path and nothing else about where it is: the path is judged again in main (file-versions.ts `checkedFilePath`), the Collection is
 * the one the window held when the call began (the binding's `live` and `confirmOwner`), and every refusal is answered as `{ ok: false, code, message }`
 * with a sentence for the writer, never as a thrown error the window has to interpret. `list` and `compare` write nothing.
 */
import { CollectionClosed } from './folio-version-import'
import { defaultFileVersionReads } from './file-version-sources'
import { compareFileVersions, FileVersionRefused, listFileVersions, listInsertedFiles } from './file-versions'
import { requestedFileVersion, type FileVersionBinding } from './requested-file-version'
import { VersionSaveRefused } from './saved-text-version'
import type { VersionStore } from './versions'
import type { Workspace } from './workspace'
import type { FileCompare, FileVersionAnswer, FileVersionsListing, FolioInsertedFile, RestoreFileVersionResult, SaveFileCopyResult, SaveFileVersionResult } from '../shared/file-versions'

type FileVersionsIpcEvent = { sender: { id: number } }
export type FileVersionsIpcRegistrar = { handle: (channel: string, handler: (event: FileVersionsIpcEvent, input: any) => unknown) => void }

/** What a call runs over, captured when the call begins: the window's Collection, its version store, the bound writes and the owner check. */
export type FileVersionsContext = { workspace: Workspace; versions: VersionStore; binding: FileVersionBinding; confirmOwner: () => Promise<void> }
export type FileVersionsIpcDependencies = { context: (event: FileVersionsIpcEvent) => Promise<FileVersionsContext> }

/** A refusal as the answer the window shows; anything that is not a refusal in words is a failure with a plain sentence (the detail stays in the log). */
function refusalAnswer(error: unknown): FileVersionAnswer<never> {
  if (error instanceof FileVersionRefused) return { ok: false, code: error.code, message: error.message }
  if (error instanceof VersionSaveRefused) return { ok: false, code: 'refused', message: error.message }
  if (error instanceof CollectionClosed) return { ok: false, code: 'unavailable', message: 'WriteFlex no longer has this Collection open in that window, so nothing was written.' }
  const message = error instanceof Error && error.message !== '' && !/ENOENT|EACCES|EPERM|at \w+/.test(error.message) ? error.message : 'That could not be done. Nothing was changed.'
  return { ok: false, code: 'unavailable', message }
}

export function registerFileVersionsIpc(ipc: FileVersionsIpcRegistrar, dependencies: FileVersionsIpcDependencies): void {
  ipc.handle('file-versions:list', async (event, input: { path?: unknown } | null): Promise<FileVersionAnswer<{ listing: FileVersionsListing }>> => {
    try {
      const { workspace, versions } = await dependencies.context(event)
      return { ok: true, listing: await listFileVersions(defaultFileVersionReads(workspace, versions), input?.path) }
    } catch (error) { return refusalAnswer(error) }
  })

  ipc.handle('file-versions:inserted', async (event, input: { dir?: unknown } | null): Promise<FileVersionAnswer<{ files: FolioInsertedFile[]; unavailable?: string }>> => {
    try {
      const { workspace, versions } = await dependencies.context(event)
      return { ok: true, ...(await listInsertedFiles(defaultFileVersionReads(workspace, versions), input?.dir)) }
    } catch (error) { return refusalAnswer(error) }
  })

  ipc.handle('file-versions:compare', async (event, input: { path?: unknown; from?: unknown; to?: unknown } | null): Promise<FileVersionAnswer<{ compare: FileCompare }>> => {
    try {
      const { workspace, versions } = await dependencies.context(event)
      return { ok: true, compare: await compareFileVersions(defaultFileVersionReads(workspace, versions), { path: input?.path, from: input?.from, to: input?.to }) }
    } catch (error) { return refusalAnswer(error) }
  })

  ipc.handle('file-versions:save', async (event, input: { path?: unknown; name?: unknown; note?: unknown } | null): Promise<FileVersionAnswer<SaveFileVersionResult>> => {
    try {
      const { binding, confirmOwner } = await dependencies.context(event)
      return { ok: true, ...(await requestedFileVersion(binding).save({ path: input?.path, name: input?.name, note: input?.note }, confirmOwner)) }
    } catch (error) { return refusalAnswer(error) }
  })

  ipc.handle('file-versions:restore', async (event, input: { path?: unknown; versionId?: unknown; expectVersionSha256?: unknown; expectWorkingSha256?: unknown } | null): Promise<FileVersionAnswer<RestoreFileVersionResult>> => {
    try {
      const { binding, confirmOwner } = await dependencies.context(event)
      return { ok: true, ...(await requestedFileVersion(binding).restore({ path: input?.path, versionId: input?.versionId, expectVersionSha256: input?.expectVersionSha256, expectWorkingSha256: input?.expectWorkingSha256 ?? null }, confirmOwner)) }
    } catch (error) { return refusalAnswer(error) }
  })

  ipc.handle('file-versions:copy', async (event, input: { path?: unknown; versionId?: unknown; expectVersionSha256?: unknown; name?: unknown } | null): Promise<FileVersionAnswer<SaveFileCopyResult>> => {
    try {
      const { binding, confirmOwner } = await dependencies.context(event)
      return { ok: true, ...(await requestedFileVersion(binding).copy({ path: input?.path, versionId: input?.versionId, expectVersionSha256: input?.expectVersionSha256, name: input?.name }, confirmOwner)) }
    } catch (error) { return refusalAnswer(error) }
  })
}
