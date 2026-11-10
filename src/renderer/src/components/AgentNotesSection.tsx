import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react'
import { AgentNotes } from './AgentNotes'

/**
 * Agent notes inside the Agent tab (house rule R6, owner decision D1): the tab of its own is retired, and what the
 * agent left about a piece is read here, one line under the Digest, closed until opened. No note file and no discarded
 * object was moved or deleted: the margin reads change records, not these note files, so they stay where they were
 * and this section is where they are reached. It shows nothing at all while there are none.
 */
export function AgentNotesSection(props: React.ComponentProps<typeof AgentNotes>): JSX.Element | null {
  const { dir } = props
  const [count, setCount] = useState(0)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let alive = true
    const load = (): void => { void window.writeflex.agentNotes.list(dir).then((notes) => { if (alive) setCount(notes.length) }, () => { if (alive) setCount(0) }) }
    load()
    const stop = window.writeflex.agentNotes.onChanged(load)
    return () => { alive = false; stop() }
  }, [dir])
  if (count === 0) return null
  return (
    <section className="digest agent-notes-section" aria-label="Agent notes">
      <button type="button" className="d-head d-toggle" aria-expanded={open} aria-controls="agent-notes-details" data-testid="agent-notes-toggle" onClick={() => setOpen((now) => !now)}>
        <Sparkles className="icon sm" aria-hidden="true" />
        <span className="d-sum">{count === 1 ? '1 agent note' : `${count} agent notes`}</span>
        {open ? <ChevronDown className="icon sm" aria-hidden="true" /> : <ChevronRight className="icon sm" aria-hidden="true" />}
      </button>
      {open && <div id="agent-notes-details" className="agent-notes-body" data-testid="agent-notes-details"><AgentNotes {...props} /></div>}
    </section>
  )
}
