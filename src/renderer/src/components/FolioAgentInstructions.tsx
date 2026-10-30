import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Bot, ChevronDown } from 'lucide-react'
import { agentPillItemFor, agentPillModel, type AgentPillItem, type AgentPillRequest } from '../plan/agent-instructions-pill'
import { humanReadableError } from '../error-text'
import type { FolioAgentInstructionsAction, FolioAgentInstructionsStatus } from '../../../shared/folio-agent-files'

/** One line of the row: what it says and the request its button makes (none when there is nothing to offer). */
export type AgentInstructionsLine = { text: string; action?: { label: string; request: FolioAgentInstructionsAction } }

/** What the row says about AGENTS.md and CLAUDE.md, from main's status. Pure, so the tests read it. */
export function agentInstructionsLines(status: FolioAgentInstructionsStatus): { agents: AgentInstructionsLine; claude: AgentInstructionsLine | null; canOpen: boolean } {
  const agents: AgentInstructionsLine = (() => {
    switch (status.agents) {
      case 'current': return { text: 'AGENTS.md · WriteFlex keeps its part up to date' }
      case 'edited': return { text: 'You edited WriteFlex’s part of AGENTS.md, so WriteFlex no longer updates it.', action: { label: 'Restore', request: 'restore' } }
      case 'no-maintained-part': return { text: 'AGENTS.md has no WriteFlex part, so agents are not told how this Folio works.', action: { label: 'Add WriteFlex’s part', request: 'restore' } }
      case 'missing': return { text: 'AGENTS.md is missing, so agents are not told how this Folio works.', action: { label: 'Write it again', request: 'restore' } }
      case 'damaged': return { text: 'A WriteFlex marker line in AGENTS.md is missing or changed, so WriteFlex leaves the file alone.' }
      case 'unreadable': return { text: 'AGENTS.md is not a file WriteFlex can open.' }
    }
  })()
  const claude: AgentInstructionsLine | null = (() => {
    switch (status.claude) {
      case 'imports': return null
      case 'own': return { text: 'Claude Code reads your own CLAUDE.md, which does not import AGENTS.md.', action: { label: 'Add the import line', request: 'write-claude' } }
      case 'missing': return { text: 'CLAUDE.md is missing, so Claude Code does not read these instructions.', action: { label: 'Write CLAUDE.md', request: 'write-claude' } }
      case 'unreadable': return { text: 'CLAUDE.md is not a file WriteFlex can change.' }
    }
  })()
  return { agents, claude, canOpen: status.agents !== 'missing' && status.agents !== 'unreadable' }
}

export type FolioAgentInstructionsRowProps = {
  status: FolioAgentInstructionsStatus
  busy?: boolean
  onOpen: (path: string) => void
  onAct: (action: FolioAgentInstructionsAction) => void
}

/** The "Agent instructions" row of the Plan and the Folder dashboard, in the row style of the cover line. */
export function FolioAgentInstructionsRow({ status, busy = false, onOpen, onAct }: FolioAgentInstructionsRowProps): JSX.Element {
  const lines = agentInstructionsLines(status)
  const actionButton = (line: AgentInstructionsLine) => line.action && (
    <button type="button" className="ghost" disabled={busy} onClick={() => onAct(line.action!.request)}>{line.action.label}</button>
  )
  return (
    <div className="folio-agents" role="group" aria-label="Agent instructions">
      <div className="cv-src folio-agents-line" data-state={status.agents}>
        <Bot className="icon sm" aria-hidden="true" />
        <strong>Agent instructions</strong>
        <span className="folio-agents-text">{lines.agents.text}</span>
        {lines.canOpen && (
          <button type="button" className="ghost" title={`Open ${status.agentsPath}`} aria-label={`Open the agent instructions, ${status.agentsPath}`} onClick={() => onOpen(status.agentsPath)}>Open</button>
        )}
        {actionButton(lines.agents)}
      </div>
      {lines.claude && (
        <div className="cv-src folio-agents-line folio-agents-claude" data-state={status.claude}>
          <span className="folio-agents-text">{lines.claude.text}</span>
          {actionButton(lines.claude)}
        </div>
      )}
    </div>
  )
}

/** The row with its own reads: the state on mount, on `dir` change and on every collection change. Draws
 *  nothing for a folder that is not a Folio. */
export function FolioAgentInstructions({ dir, onOpenPiece, onStatus }: { dir: string; onOpenPiece: (path: string) => void; onStatus: (message: string) => void }): JSX.Element | null {
  const [status, setStatus] = useState<FolioAgentInstructionsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const reload = useCallback(() => {
    void window.writeflex.folioAgentInstructions.read(dir).then(setStatus).catch(() => setStatus(null))
  }, [dir])
  useEffect(() => { reload() }, [reload])
  useEffect(() => window.writeflex.onCollectionChanged(() => reload()), [reload])
  const act = useCallback(async (action: FolioAgentInstructionsAction) => {
    setBusy(true)
    try {
      setStatus(await window.writeflex.folioAgentInstructions.act(dir, action))
    } catch (error) {
      onStatus(humanReadableError(error, 'The agent instructions could not be written.'))
    } finally {
      setBusy(false)
    }
  }, [dir, onStatus])
  if (!status) return null
  return <FolioAgentInstructionsRow status={status} busy={busy} onOpen={onOpenPiece} onAct={(action) => void act(action)} />
}

export type FolioAgentPillHandle = {
  /** The palette's three writes. Says in plain words (via `onStatus`) when there is nothing to write. */
  run: (request: AgentPillRequest) => void
}

/**
 * The agent instructions pill in the Folio page's header strip, beside Open Folio (2026-10-19 redesign, element 1,
 * option C). A menu to write both files or either one while something is missing; plain text once both exist.
 * Draws nothing for a folder that is not a Folio.
 */
export const FolioAgentInstructionsPill = forwardRef<FolioAgentPillHandle, { dir: string; onOpenPiece: (path: string) => void; onStatus: (message: string) => void }>(function FolioAgentInstructionsPill({ dir, onOpenPiece, onStatus }, ref) {
  const [status, setStatus] = useState<FolioAgentInstructionsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [requests, setRequests] = useState<AgentPillRequest[]>([])
  const root = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const reload = useCallback(() => {
    void window.writeflex.folioAgentInstructions.read(dir).then(setStatus).catch(() => setStatus(null))
  }, [dir])
  useEffect(() => { reload() }, [reload])
  useEffect(() => window.writeflex.onCollectionChanged(() => reload()), [reload])

  const perform = useCallback(async (item: AgentPillItem) => {
    setBusy(true)
    setOpen(false)
    try {
      let next: FolioAgentInstructionsStatus | null = null
      for (const step of item.steps) next = await window.writeflex.folioAgentInstructions.act(dir, step)
      if (next) setStatus(next)
    } catch (error) {
      onStatus(humanReadableError(error, 'The agent instructions could not be written.'))
      reload()
    } finally {
      setBusy(false)
    }
  }, [dir, onStatus, reload])

  const model = status ? agentPillModel(status) : null
  useImperativeHandle(ref, () => ({ run: request => setRequests(current => [...current, request]) }), [])

  // A command can mount this inspector before its status read finishes. Keep each invocation until
  // the real status is available, and resolve the next one after the preceding write has refreshed it.
  useEffect(() => {
    if (!model || busy || requests.length === 0) return
    const [request, ...remaining] = requests
    setRequests(remaining)
    const writes = model.items.filter((item) => item.id !== 'both' && !/^Restore/.test(item.label))
    const item = agentPillItemFor(model, request) ?? (request === 'both' && writes.length === 1 ? writes[0] : null)
    if (item) void perform(item)
    else onStatus(model.items.length === 0 ? 'Both agent instruction files are already written.' : 'That agent instruction file is already written.')
  }, [busy, model, onStatus, perform, requests])

  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onPointer = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    window.addEventListener('pointerdown', onPointer)
    return () => window.removeEventListener('pointerdown', onPointer)
  }, [open])

  if (!status || !model) return null
  const closeMenu = (): void => { setOpen(false); trigger.current?.focus() }
  const onMenuKey = (event: React.KeyboardEvent): void => {
    const list = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = list.indexOf(document.activeElement as HTMLElement)
    const move = (to: number): void => { event.preventDefault(); list[(to + list.length) % list.length]?.focus() }
    if (event.key === 'ArrowDown') move(at + 1)
    else if (event.key === 'ArrowUp') move(at - 1)
    else if (event.key === 'Home') move(0)
    else if (event.key === 'End') move(list.length - 1)
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu() }
    else if (event.key === 'Tab') setOpen(false)
  }

  if (model.items.length === 0) {
    // Both exist (or the problem is not one a button can fix): plain text, with a way to open the file.
    return (
      <span className="folio-agent-pill plain" role="group" aria-label="Agent instructions" data-state={model.state} title={model.title}>
        <Bot className="icon sm" aria-hidden="true" />
        <span className="folio-agent-pill-text">{model.label}</span>
        {model.canOpen && <button type="button" className="folio-agent-pill-open" title={`Open ${status.agentsPath}`} aria-label={`Open the agent instructions, ${status.agentsPath}`} onClick={() => onOpenPiece(status.agentsPath)}>Open</button>}
      </span>
    )
  }
  return (
    <span className="folio-agent-pill-wrap" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="folio-agent-pill"
        data-state={model.state}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={model.label}
        title={model.title}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true) } }}
      >
        <Bot className="icon sm" aria-hidden="true" />
        <span className="folio-agent-pill-text">{model.label}</span>
        <ChevronDown className="icon sm" aria-hidden="true" />
      </button>
      {open && (
        <div className="folio-agent-menu" role="menu" aria-label="Agent instructions" onKeyDown={onMenuKey}>
          <div className="folio-open-menu-head" aria-hidden="true">Agent instructions</div>
          {model.items.map((item) => (
            <button key={`${item.id}:${item.label}`} type="button" role="menuitem" className="folio-open-item" data-agent-pill-item={item.id} onClick={() => void perform(item)}>{item.label}</button>
          ))}
          {model.canOpen && <button type="button" role="menuitem" className="folio-open-item" onClick={() => { setOpen(false); onOpenPiece(status.agentsPath) }}>Open AGENTS.md</button>}
          <div className="folio-agent-menu-foot">Agents read these files to learn how this Folio works.</div>
        </div>
      )}
    </span>
  )
})
