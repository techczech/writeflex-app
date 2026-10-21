import type { FolioAgentInstructionsAction, FolioAgentInstructionsStatus } from '../../../shared/folio-agent-files'

/** One choice in the pill's menu: the steps it takes, in order (each is one request to main). */
export type AgentPillItem = { id: 'both' | 'agents' | 'claude'; label: string; steps: FolioAgentInstructionsAction[] }

/**
 * What the pill beside Open Folio says and offers (2026-10-19 redesign, element 1, option C).
 * `written` and `attention` read as plain text (nothing to choose); `none`, `partial` and `edited` are a menu.
 */
export type AgentPillModel = {
  state: 'none' | 'partial' | 'edited' | 'written' | 'attention'
  label: string
  /** The long sentence for the tooltip: what is wrong, in plain words. */
  title: string
  items: AgentPillItem[]
  /** AGENTS.md exists as a file WriteFlex can open. */
  canOpen: boolean
}

/** The pill's text and menu from main's status. Pure, so the tests read it. */
export function agentPillModel(status: FolioAgentInstructionsStatus): AgentPillModel {
  const agentsMissing = status.agents === 'missing'
  const agentsNoPart = status.agents === 'no-maintained-part'
  const agentsEdited = status.agents === 'edited'
  const claudeMissing = status.claude === 'missing'
  const claudeOwn = status.claude === 'own'
  const writeAgents = agentsMissing || agentsNoPart
  const writeClaude = claudeMissing || claudeOwn
  const both = writeAgents && writeClaude
  const items: AgentPillItem[] = []
  if (writeAgents && writeClaude) items.push({ id: 'both', label: agentsMissing && claudeMissing ? 'Write AGENTS.md and CLAUDE.md' : 'Write AGENTS.md and CLAUDE.md as needed', steps: ['restore', 'write-claude'] })
  if (writeAgents) items.push({ id: 'agents', label: agentsMissing ? (both ? 'Write AGENTS.md only' : 'Write AGENTS.md') : 'Add WriteFlex’s part to AGENTS.md', steps: ['restore'] })
  if (agentsEdited) items.push({ id: 'agents', label: 'Restore WriteFlex’s part of AGENTS.md', steps: ['restore'] })
  if (writeClaude) items.push({ id: 'claude', label: claudeMissing ? (both ? 'Write CLAUDE.md only' : 'Write CLAUDE.md') : 'Add the import line to CLAUDE.md', steps: ['write-claude'] })

  const canOpen = status.agents !== 'missing' && status.agents !== 'unreadable'
  const problems: string[] = []
  if (agentsMissing) problems.push('AGENTS.md is missing, so agents are not told how this Folio works.')
  if (agentsNoPart) problems.push('AGENTS.md has no WriteFlex part, so agents are not told how this Folio works.')
  if (agentsEdited) problems.push('You edited WriteFlex’s part of AGENTS.md, so WriteFlex no longer updates it.')
  if (status.agents === 'damaged') problems.push('A WriteFlex marker line in AGENTS.md is missing or changed, so WriteFlex leaves the file alone.')
  if (status.agents === 'unreadable') problems.push('AGENTS.md is not a file WriteFlex can open.')
  if (claudeMissing) problems.push('CLAUDE.md is missing, so Claude Code does not read these instructions.')
  if (claudeOwn) problems.push('Claude Code reads your own CLAUDE.md, which does not import AGENTS.md.')
  if (status.claude === 'unreadable') problems.push('CLAUDE.md is not a file WriteFlex can change.')
  const title = problems.length ? problems.join(' ') : 'AGENTS.md and CLAUDE.md are written. WriteFlex keeps its part of AGENTS.md up to date.'

  if (items.length === 0) {
    return problems.length === 0
      ? { state: 'written', label: 'Agent instructions: written', title, items, canOpen }
      : { state: 'attention', label: 'Agent instructions: need a look', title, items, canOpen }
  }
  if (agentsMissing && claudeMissing) return { state: 'none', label: 'Agent instructions: not written', title, items, canOpen }
  if (agentsMissing) return { state: 'partial', label: 'Agent instructions: AGENTS.md not written', title, items, canOpen }
  if (agentsNoPart) return { state: 'partial', label: 'Agent instructions: AGENTS.md has no WriteFlex part', title, items, canOpen }
  if (claudeMissing) return { state: 'partial', label: 'Agent instructions: CLAUDE.md not written', title, items, canOpen }
  if (claudeOwn) return { state: 'partial', label: 'Agent instructions: CLAUDE.md does not import AGENTS.md', title, items, canOpen }
  return { state: 'edited', label: 'Agent instructions: edited', title, items, canOpen }
}

/** The pill's three writes by command name (the palette's); each runs only when the model offers it. */
export type AgentPillRequest = 'both' | 'agents' | 'claude'

/** The offered item for a request; `both` falls back to nothing (a partly written pair has no "both"). */
export function agentPillItemFor(model: AgentPillModel, request: AgentPillRequest): AgentPillItem | null {
  return model.items.find((item) => item.id === request) ?? null
}
