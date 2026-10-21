import { collectionDir } from './plan-ipc'
import { readFolioDetails, setFolioDetail, undoFolioDetail } from './folio-details'
import { workspaceDetailValues } from './folio-detail-values'
import type { Workspace } from './workspace'
import type { FolioDetailAnswer, FolioDetailUndoAnswer, FolioDetailValuesAnswer, FolioDetailsRead, FolioDetailsRefusal } from '../shared/folio-details'

/**
 * The Details card's IPC seam (0.26 ticket 4). Four channels; each names a Folio by its folder only. A `path` or
 * any other field in the request is ignored: main derives the Index Note (folio-details.ts). The folder must be a
 * Workspace-relative path; it is put in its one spelling (folio-dir.ts) before the lock or the Index Note is
 * derived from it.
 *
 * After a write or an Undo, the collection is told (the Folio outline and the Board read again) and so is every
 * open buffer of the Index Note (`file:changed-on-disk`, as the Plan writes do), so an open editor shows the new
 * text. A refusal tells nobody: nothing was written.
 */

type DetailsIpcEvent = { sender: { id: number } }
export type FolioDetailsIpcRegistrar = { handle: (channel: string, handler: (event: DetailsIpcEvent, input: any) => unknown) => void }

export type FolioDetailsIpcDependencies<State> = {
  stateForSender: (id: number) => State
  requireWorkspace: (state: State) => Workspace
  checkpointFile: (state: State, path: string) => Promise<void>
  notifyCollectionChanged: (state: State, paths: string[]) => void
  notifyChangedOnDisk: (state: State, paths: string[]) => void
  /** The writer's own name (git's user.name for the Workspace, else this computer's user name); offered first for Author. */
  writerName?: (state: State, workspace: Workspace) => Promise<string | null>
}

const NOT_A_FOLIO: FolioDetailsRefusal = { ok: false, refused: 'outside', message: 'That is not a Folio in this Workspace, so nothing was changed.' }

/** The folder a request names, in its one spelling; null when it is not a Workspace-relative folder. */
function folioDir(workspace: Workspace, input: unknown): string | null {
  const dir = (input as { dir?: unknown } | null)?.dir
  if (typeof dir !== 'string' || dir.includes('\\') || dir.includes('\u0000')) return null
  try { return collectionDir(workspace, { dir }) } catch { return null }
}

export function registerFolioDetailsIpc<State>(ipc: FolioDetailsIpcRegistrar, dependencies: FolioDetailsIpcDependencies<State>): void {
  const context = (event: DetailsIpcEvent) => {
    const state = dependencies.stateForSender(event.sender.id)
    const workspace = dependencies.requireWorkspace(state)
    const options = { beforeIndexWrite: (path: string) => dependencies.checkpointFile(state, path) }
    const tell = (path: string) => {
      dependencies.notifyCollectionChanged(state, [path])
      dependencies.notifyChangedOnDisk(state, [path])
    }
    return { workspace, options, tell }
  }

  ipc.handle('folio:read-details', async (event, input: unknown): Promise<FolioDetailsRead> => {
    const { workspace } = context(event)
    const dir = folioDir(workspace, input)
    return dir === null ? NOT_A_FOLIO : readFolioDetails(workspace, dir)
  })

  // The values the Author, Audience and Language pickers offer: read-only, whole Workspace, no folder named.
  ipc.handle('folio:detail-values', async (event): Promise<FolioDetailValuesAnswer> => {
    const state = dependencies.stateForSender(event.sender.id)
    const workspace = dependencies.requireWorkspace(state)
    let you: string | null = null
    try { you = (await dependencies.writerName?.(state, workspace)) ?? null } catch { you = null }
    try {
      return { ok: true, ...(await workspaceDetailValues(workspace, you)) }
    } catch {
      return { ok: false, refused: 'unwritable', message: 'WriteFlex could not read the values used in this Workspace.' }
    }
  })

  ipc.handle('folio:set-detail', async (event, input: unknown): Promise<FolioDetailAnswer> => {
    const { workspace, options, tell } = context(event)
    const dir = folioDir(workspace, input)
    if (dir === null) return NOT_A_FOLIO
    const request = (input ?? {}) as { field?: unknown; value?: unknown; basis?: unknown }
    const answer = await setFolioDetail(workspace, dir, { field: request.field, value: request.value, basis: request.basis }, options)
    if (answer.ok && answer.changed) tell(answer.indexPath)
    return answer
  })

  ipc.handle('folio:undo-detail', async (event, input: unknown): Promise<FolioDetailUndoAnswer> => {
    const { workspace, options, tell } = context(event)
    const dir = folioDir(workspace, input)
    if (dir === null) return NOT_A_FOLIO
    const token = (input as { token?: unknown } | null)?.token
    const answer = await undoFolioDetail(workspace, dir, typeof token === 'string' && token.length <= 200 ? token : null, options)
    if (answer.ok) tell(answer.indexPath)
    return answer
  })
}
