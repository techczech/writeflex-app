// The editor selection bubble (ADR-0050 journey 1, ticket 04): over a live selection in the current
// text, a small bar offers the section, a copy or a cut. It only ever starts the controller's own
// guarded paths (exact span, saved-version refusal, cut reservation) — the bubble itself writes
// nothing, and it never appears over a saved version or an empty selection.
import { useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { fragmentStats } from '../../../shared/scratchpad-items'
import { writableState } from './scratchpad-editor'

export function ScratchpadSelectionBubble({
  view, tick, onSelectSection, onSendCopy, onCut,
}: {
  view: EditorView | null
  /** Bumped on selection changes so the bar follows the selection. */
  tick: number
  onSelectSection: () => void
  onSendCopy: () => void
  onCut: () => void
}): JSX.Element | null {
  const [held, setHeld] = useState(false)
  void tick
  if (!view || !writableState(view.state)) return null
  const selection = view.state.selection.main
  if (selection.from === selection.to) return null
  if (!view.hasFocus && !held) return null
  let coords: { left: number; top: number; bottom: number } | null = null
  try {
    coords = view.coordsAtPos(selection.from)
  } catch {
    return null
  }
  if (!coords) return null
  const blocks = fragmentStats(view.state.sliceDoc(selection.from, selection.to)).paragraphs
  const width = 380
  const left = Math.round(Math.min(Math.max(coords.left, 8), Math.max(8, window.innerWidth - width - 8)))
  const top = coords.top - 46 >= 50 ? Math.round(coords.top - 46) : Math.round(coords.bottom + 8)
  const act = (run: () => void) => (event: React.MouseEvent): void => {
    event.preventDefault()
    run()
  }
  return (
    <div
      className="sp-bubble"
      role="toolbar"
      aria-label="Send the selection to the Scratchpad"
      style={{ left, top }}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onMouseDown={(event) => event.preventDefault()}
    >
      <span className="sp-bubble-count">{blocks === 1 ? '1 block selected' : `${blocks} blocks selected`}</span>
      <button type="button" onClick={act(onSelectSection)}>Select the section</button>
      <button type="button" onClick={act(onSendCopy)}>Send a copy to Scratchpad</button>
      <button type="button" onClick={act(onCut)}>Cut to Scratchpad</button>
    </div>
  )
}
