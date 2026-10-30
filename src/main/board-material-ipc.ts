/**
 * The Board's material channels (scraps tickets 02 and 03): offcut to idea, add a drawer scrap to the
 * end of its piece, attach a source to a piece, and undo the latest of those. Main owns every read and
 * write; the renderer names the scrap or source, the piece, the collection and the idea's name.
 */

import { assertRelativeWorkspacePath } from './workspace'
import type { BoardMaterialDesk } from './board-material-desk'
import type { AppendScrapInput, AttachSourceInput, PromoteOffcutInput } from '../shared/board-material'
import type { PieceSourceListing } from '../shared/piece-sources'

type IpcEvent = { sender: { id: number } }
export type BoardMaterialIpcRegistrar = { handle: (channel: string, handler: (event: IpcEvent, input: any) => unknown) => void }

export type BoardMaterialIpcDependencies<State> = {
  stateForSender: (id: number) => State
  deskFor: (state: State) => Promise<Pick<BoardMaterialDesk, 'promoteOffcut' | 'appendScrap' | 'attachSource' | 'undo'>>
  /** A piece's sources, listed and cited (read only). `dir` is the collection when the caller knows it. */
  listSources: (state: State, input: { path: string; dir?: string }) => Promise<PieceSourceListing>
  /** Refresh every projection, reload open files, and re-list the Scratchpad for these paths. */
  publish: (state: State, paths: string[]) => void
}

function text(input: unknown, key: string): string {
  const value = (input as Record<string, unknown> | undefined)?.[key]
  if (typeof value !== 'string') throw new Error(`Invalid Board request: ${key} is missing.`)
  return value
}

function path(input: unknown, key: string): string {
  const value = text(input, key)
  assertRelativeWorkspacePath(value)
  return value
}

function promoteInput(input: unknown): PromoteOffcutInput {
  const dir = text(input, 'dir')
  if (dir !== '') assertRelativeWorkspacePath(dir)
  const scrapId = text(input, 'scrapId')
  const scrapsPath = text(input, 'scrapsPath')
  // A lossless Scratchpad offcut has no scraps file ('' on the Board); its id is its address.
  if (scrapsPath !== '') assertRelativeWorkspacePath(scrapsPath)
  else if (!/^p_[0-9a-z]{6,40}$/.test(scrapId)) throw new Error('Invalid Board request: scrapsPath is missing.')
  return { dir, scrapsPath, scrapId, name: text(input, 'name') }
}

function appendInput(input: unknown): AppendScrapInput {
  return { piece: path(input, 'piece'), scrapId: text(input, 'scrapId') }
}

function attachInput(input: unknown): AttachSourceInput {
  const dir = text(input, 'dir')
  if (dir !== '') assertRelativeWorkspacePath(dir)
  return { dir, piece: path(input, 'piece'), source: path(input, 'source') }
}

export function registerBoardMaterialIpcHandlers<State>(ipc: BoardMaterialIpcRegistrar, deps: BoardMaterialIpcDependencies<State>): void {
  const context = async (event: IpcEvent) => {
    const state = deps.stateForSender(event.sender.id)
    return { state, desk: await deps.deskFor(state) }
  }

  ipc.handle('board-material:promote-offcut', async (event, input) => {
    const request = promoteInput(input)
    const { state, desk } = await context(event)
    const result = await desk.promoteOffcut(request)
    if (result.ok) deps.publish(state, result.paths)
    return result
  })

  ipc.handle('board-material:append-scrap', async (event, input) => {
    const request = appendInput(input)
    const { state, desk } = await context(event)
    const result = await desk.appendScrap(request)
    if (result.ok) deps.publish(state, result.paths)
    return result
  })

  ipc.handle('board-material:attach-source', async (event, input) => {
    const request = attachInput(input)
    const { state, desk } = await context(event)
    const result = await desk.attachSource(request)
    if (result.ok) deps.publish(state, result.paths)
    return result
  })

  ipc.handle('board-material:list-sources', async (event, input) => {
    const dir = (input as { dir?: unknown } | undefined)?.dir
    if (dir !== undefined && typeof dir !== 'string') throw new Error('Invalid Board request: dir must be text.')
    if (dir) assertRelativeWorkspacePath(dir)
    return deps.listSources(deps.stateForSender(event.sender.id), { path: path(input, 'path'), ...(dir !== undefined ? { dir } : {}) })
  })

  ipc.handle('board-material:undo', async (event, input) => {
    const id = text(input, 'id')
    const { state, desk } = await context(event)
    const result = await desk.undo(id)
    if (result.ok) deps.publish(state, result.paths)
    return result
  })
}
