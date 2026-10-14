/**
 * The proposal card's four channels (ticket 09). Main owns every read and write; the renderer only
 * names a proposal and, on Accept, which changes it keeps.
 */

import type { PlanAcceptEdits, PlanAcceptResult, PlanProposalView, PlanUndoResult } from '../shared/plan-proposal'

type IpcEvent = { sender: { id: number } }
export type PlanProposalIpcRegistrar = { handle: (channel: string, handler: (event: IpcEvent, input: any) => unknown) => void }

export type PlanProposalAgent = {
  planProposalView(id: string): Promise<PlanProposalView | null>
  acceptPlanProposal(id: string, edits?: PlanAcceptEdits): Promise<PlanAcceptResult>
  discardPlanProposal(id: string): Promise<unknown>
  undoPlanProposal(id: string): Promise<PlanUndoResult>
}

export type PlanProposalIpcDependencies<State> = {
  stateForSender: (id: number) => State
  requireAgent: (state: State) => Promise<PlanProposalAgent>
  notifyCollectionChanged: (state: State, paths: string[]) => void
  notifyChangedOnDisk: (state: State, paths: string[]) => void
}

function proposalId(input: unknown): string {
  const id = (input as { id?: unknown } | undefined)?.id
  if (typeof id !== 'string' || !id) throw new Error('Invalid running-order proposal.')
  return id
}

function edits(input: unknown): PlanAcceptEdits | undefined {
  const raw = (input as { edits?: unknown } | undefined)?.edits
  if (raw === undefined) return undefined
  const value = raw as Partial<PlanAcceptEdits>
  if (!Array.isArray(value.enabled) || !value.enabled.every((id) => typeof id === 'string')) throw new Error('Invalid proposal edits.')
  if (!Array.isArray(value.writerMoves) || !value.writerMoves.every((move) => (
    move && typeof move.id === 'string' && typeof move.title === 'string' && Number.isInteger(move.to) && move.to >= 0 && typeof move.enabled === 'boolean'
  ))) throw new Error('Invalid proposal edits.')
  return { enabled: value.enabled, writerMoves: value.writerMoves }
}

export function registerPlanProposalIpcHandlers<State>(ipc: PlanProposalIpcRegistrar, deps: PlanProposalIpcDependencies<State>): void {
  const agentFor = async (event: IpcEvent) => {
    const state = deps.stateForSender(event.sender.id)
    return { state, agent: await deps.requireAgent(state) }
  }
  const publish = (state: State, paths: string[]) => {
    deps.notifyCollectionChanged(state, paths)
    deps.notifyChangedOnDisk(state, paths)
  }

  ipc.handle('plan-proposal:view', async (event, input) => (await agentFor(event)).agent.planProposalView(proposalId(input)))

  ipc.handle('plan-proposal:accept', async (event, input) => {
    const { state, agent } = await agentFor(event)
    const result = await agent.acceptPlanProposal(proposalId(input), edits(input))
    if (result.ok) publish(state, result.paths)
    return result
  })

  ipc.handle('plan-proposal:discard', async (event, input) => {
    const { agent } = await agentFor(event)
    await agent.discardPlanProposal(proposalId(input))
    return null
  })

  ipc.handle('plan-proposal:undo', async (event, input) => {
    const { state, agent } = await agentFor(event)
    const result = await agent.undoPlanProposal(proposalId(input))
    if (result.ok) publish(state, result.paths)
    return result
  })
}
