import { collectionDir } from './plan-ipc'
import { readFolioRoom, roomStateKey } from './folio-room'
import type { Workspace } from './workspace'
import { mergeRoomState, readRoomState, type FolioRoomModel, type RoomState } from '../shared/folio-room'

/**
 * The Folio room's IPC seam. Three channels, each naming a Folio by its folder only (put in its one spelling,
 * folio-dir.ts). `folio-room:read` writes nothing (I-4). The room's UI state lives in app state, keyed by the Folio's
 * one spelling, never in the Folio folder (I-8): `folio-room:get-state` and `folio-room:set-state` touch the settings
 * store only.
 */

type RoomIpcEvent = { sender: { id: number } }
export type FolioRoomIpcRegistrar = { handle: (channel: string, handler: (event: RoomIpcEvent, input: any) => unknown) => void }

export type FolioRoomStateStore = {
  folioRoomState(key: string): unknown
  setFolioRoomState(key: string, state: unknown): boolean
}

export type FolioRoomIpcDependencies<State> = {
  stateForSender: (id: number) => State
  requireWorkspace: (state: State) => Workspace
  store: FolioRoomStateStore
}

/** The folder a request names, in its one spelling; null when it is not a Workspace-relative folder. */
function roomDir(workspace: Workspace, input: unknown): string | null {
  const dir = (input as { dir?: unknown } | null)?.dir
  if (typeof dir !== 'string' || dir.includes('\\') || dir.includes('\u0000')) return null
  try { return collectionDir(workspace, { dir }) } catch { return null }
}

export function registerFolioRoomIpc<State>(ipc: FolioRoomIpcRegistrar, dependencies: FolioRoomIpcDependencies<State>): void {
  const workspaceOf = (event: RoomIpcEvent): Workspace => dependencies.requireWorkspace(dependencies.stateForSender(event.sender.id))

  ipc.handle('folio-room:read', async (event, input: unknown): Promise<FolioRoomModel | null> => {
    const workspace = workspaceOf(event)
    const dir = roomDir(workspace, input)
    return dir === null ? null : readFolioRoom(workspace, dir, (input as { essential?: unknown }).essential === true)
  })

  ipc.handle('folio-room:get-state', (event, input: unknown): RoomState => {
    const workspace = workspaceOf(event)
    const dir = roomDir(workspace, input)
    return readRoomState(dir === null ? undefined : dependencies.store.folioRoomState(roomStateKey(workspace, dir)))
  })

  ipc.handle('folio-room:set-state', (event, input: unknown): boolean => {
    const workspace = workspaceOf(event)
    const dir = roomDir(workspace, input)
    if (dir === null) return false
    const key = roomStateKey(workspace, dir)
    const current = readRoomState(dependencies.store.folioRoomState(key))
    const next = mergeRoomState(current, (input as { state?: unknown }).state)
    if (JSON.stringify(current) === JSON.stringify(next)) return true
    return dependencies.store.setFolioRoomState(key, next)
  })
}
