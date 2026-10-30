import { useEffect, useRef } from 'react'
import { ChevronDown, Undo2 } from 'lucide-react'
import type { TurnActivity } from '@bridle/core'
import { ASSISTANT_MODES, visibleAssistantTurn, refusalMessage, turnEndMessage, type AssistantTurnActivity, type AssistantMode, type AssistantTurnUndo } from '../../../shared/assistant-turns'
import { providerDisplayName } from './AgentModelOptions'

export function ModeChip({ mode, open, onToggle, onChoose, onClose }: { mode: AssistantMode; open: boolean; onToggle: () => void; onChoose: (mode: AssistantMode) => void; onClose: () => void }): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onClose() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, onClose])
  return <div className="assistant-mode" ref={root} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); chip.current?.focus() }
    if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const items = [...root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus()
    }
    if (event.key === 'Tab' && open) onClose()
  }}>
    <button ref={chip} className="ghost assistant-mode-chip" type="button" aria-label={`Assistant mode: ${ASSISTANT_MODES.find((entry) => entry.id === mode)?.label}`} aria-haspopup="menu" aria-expanded={open} onClick={onToggle}>{ASSISTANT_MODES.find((entry) => entry.id === mode)?.label}<ChevronDown className="icon sm" aria-hidden="true" /></button>
    {open && <div className="assistant-mode-menu" role="menu" aria-label="Assistant mode">{ASSISTANT_MODES.map((entry) => <button key={entry.id} type="button" role="menuitemradio" aria-checked={entry.id === mode} onClick={() => { onChoose(entry.id); chip.current?.focus() }}><strong>{entry.label}</strong><small>{entry.description}</small></button>)}</div>}
  </div>
}

export function TurnStrip({ turns, selected, onSelect }: { turns: TurnActivity[]; selected: string | null; onSelect: (id: string) => void }): JSX.Element | null {
  const strip = useRef<HTMLDivElement>(null)
  useEffect(() => { if (strip.current) strip.current.scrollLeft = strip.current.scrollWidth }, [turns.length])
  if (!turns.length) return null
  return <div ref={strip} className="assistant-turn-strip" role="group" aria-label="Assistant turns">{turns.map((turn, index) => <button key={turn.turnId} type="button" className={`assistant-turn-step ${turn.outcome === 'error' ? 'failed' : turn.outcome === 'aborted' ? 'stopped' : ''}`} aria-pressed={selected === turn.turnId} title={turnEndMessage(turn)} aria-label={`Step ${index + 1}${turn.outcome === 'error' ? ' failed' : turn.outcome === 'aborted' ? ' stopped' : ''}`} onClick={() => onSelect(turn.turnId)}>{index + 1}{turn.outcome === 'error' ? ' failed' : turn.outcome === 'aborted' ? ' stopped' : ''}{turn.undo.undoneAt ? ' undone' : ''}</button>)}</div>
}

export function TurnSelection({ turn, number, busy, refusal, onUndo, onOpen }: { turn: AssistantTurnActivity; number: number; busy: boolean; refusal: AssistantTurnUndo | null; onUndo: (includingLater?: boolean) => void; onOpen: (path: string) => void }): JSX.Element {
  turn = visibleAssistantTurn(turn)
  const waiting = turn.items.filter((item) => item.kind === 'waiting').length
  return <section className="assistant-turn-selection" aria-label={`Turn ${number} details`}>
    <div className="assistant-turn-summary"><strong>Turn {number}</strong><span>{Object.entries(turn.counts).filter(([, count]) => count > 0).map(([kind, count]) => `${kind[0].toUpperCase() + kind.slice(1)} ${count}`).join(' · ') || 'Nothing written'}</span><button className="ghost assistant-turn-undo" type="button" disabled={busy || Boolean(turn.undo.undoneAt)} onClick={() => onUndo()}><Undo2 className="icon sm" aria-hidden="true" />Undo turn</button></div>
    <details className="assistant-turn-files"><summary>Files and details · {waiting} waiting</summary>
      <div className="assistant-turn-counts">{Object.entries(turn.counts).map(([kind, count]) => <span key={kind}>{kind[0].toUpperCase() + kind.slice(1)} {count}</span>)}</div>
      <div className="agent-turn-runtime">{providerDisplayName({ id: turn.responder.providerId })} · {turn.responder.modelId} · {({ oauth: 'Sign-in', apikey: 'API key', env: 'Environment', none: 'No account' })[turn.responder.authLane]}</div>
      {turn.items.map((item, index) => <div key={index} className="assistant-turn-file"><span>{item.kind}</span>{item.path && ['created', 'modified', 'moved'].includes(item.kind) && turn.openPaths?.includes(item.toPath ?? item.path) ? <button className="alink" type="button" onClick={() => onOpen(item.toPath ?? item.path!)}>{item.path}{item.toPath ? ` → ${item.toPath}` : ''}</button> : <span>{item.path ? `${item.path}${item.toPath ? ` → ${item.toPath}` : ''}` : item.message ?? item.capability}</span>}</div>)}
    </details>
    {(turn.reason || turn.undo.undoneAt) && <div className={`assistant-turn-end ${turn.outcome === 'error' ? 'failed' : ''}`}>{turn.undo.undoneAt ? 'Turn undone.' : turnEndMessage(turn)}</div>}
    {refusal && !refusal.undone && <div className="assistant-turn-refusal" role="status">{refusalMessage(refusal)}{refusal.reason === 'later-turns-exist' && <button className="ghost" type="button" disabled={busy} onClick={() => onUndo(true)}>Undo this and later turns</button>}</div>}
  </section>
}
