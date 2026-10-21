/**
 * The Plan's and the Folder dashboard's "Agent instructions" row (ticket 0.23-08): its state, and the
 * author's two requests (Restore WriteFlex's part, write CLAUDE.md or add its import line). Only for a
 * folder that is a Folio: a folder with no manifest answers null and refuses the requests.
 */

import { existsSync } from 'node:fs'
import { MANIFEST_NAME } from './folio'
import {
  actOnFolioAgentInstructions,
  folioAgentInstructionsStatus,
  type FolioAgentInstructionsAction,
  type FolioAgentInstructionsStatus,
} from './folio-agent-instructions'
import { collectionDir } from './plan-ipc'
import type { Workspace } from './workspace'

type Event = { sender: { id: number } }
export type FolioAgentInstructionsIpcRegistrar = { handle: (channel: string, handler: (event: Event, input: any) => unknown) => void }

export type FolioAgentInstructionsIpcDependencies<State> = {
  stateForSender: (id: number) => State
  requireWorkspace: (state: State) => Workspace
  /** A restore point before an existing file is changed. */
  checkpointFile: (state: State, path: string) => Promise<void>
  notifyCollectionChanged: (state: State, paths: string[]) => void
  notifyChangedOnDisk: (state: State, paths: string[]) => void
}

const ACTIONS = new Set<FolioAgentInstructionsAction>(['restore', 'write-claude'])

function isFolio(ws: Workspace, dir: string): boolean {
  return existsSync(ws.absolute(dir === '' ? MANIFEST_NAME : `${dir}/${MANIFEST_NAME}`))
}

export function registerFolioAgentInstructionsIpc<State>(
  ipc: FolioAgentInstructionsIpcRegistrar,
  dependencies: FolioAgentInstructionsIpcDependencies<State>,
): void {
  const context = (event: Event, input: { dir?: string } | undefined) => {
    const state = dependencies.stateForSender(event.sender.id)
    const ws = dependencies.requireWorkspace(state)
    const dir = collectionDir(ws, input)
    const publish = (paths: string[]) => {
      if (paths.length === 0) return
      dependencies.notifyCollectionChanged(state, paths)
      dependencies.notifyChangedOnDisk(state, paths)
    }
    return { state, ws, dir, publish, beforeChange: (path: string) => dependencies.checkpointFile(state, path) }
  }

  ipc.handle('folio:agent-instructions', async (event, input: { dir?: string }): Promise<FolioAgentInstructionsStatus | null> => {
    const { ws, dir, publish, beforeChange } = context(event, input)
    if (!isFolio(ws, dir)) return null
    const status = await folioAgentInstructionsStatus(ws, dir, beforeChange)
    publish(status.written)
    return status
  })

  ipc.handle('folio:agent-instructions-act', async (event, input: { dir?: string; action?: unknown }): Promise<FolioAgentInstructionsStatus> => {
    const { ws, dir, publish, beforeChange } = context(event, input)
    if (typeof input?.action !== 'string' || !ACTIONS.has(input.action as FolioAgentInstructionsAction)) throw new Error('Invalid agent instructions request.')
    if (!isFolio(ws, dir)) throw new Error('This folder is not a Folio, so WriteFlex writes no agent instructions here.')
    const written = await actOnFolioAgentInstructions(ws, dir, input.action as FolioAgentInstructionsAction, beforeChange)
    const status = await folioAgentInstructionsStatus(ws, dir, beforeChange)
    publish([...written, ...status.written])
    return { ...status, written: [...written, ...status.written] }
  })
}
