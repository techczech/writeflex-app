import { useEffect, useRef, type DragEvent, type KeyboardEvent } from 'react'
import { Check, Scissors } from 'lucide-react'
import type { Offcut } from '../../../preload'
import { offcutKey, offcutOrigin } from './board-projection'

/** The drag payload an offcut carries; only the Idea column accepts it. */
export const OFFCUT_DRAG_MIME = 'application/x-writeflex-offcut'

export const OFFCUTS_EMPTY = 'No offcuts in this collection. Cut a passage to Scraps while you write, and it waits here.'

export type OffcutsColumnProps = {
  offcuts: Offcut[]
  selectedKey: string | null
  onSelect: (offcut: Offcut) => void
  onDragStart: (event: DragEvent, offcut: Offcut) => void
  onDragEnd: () => void
}

/**
 * The Offcuts column (locked design frames 1 and 6): every scrap in the Collection, its text start
 * and "from <piece> · date". With none it stays, saying where offcuts will land. It is a column but
 * not a stage, so it wears `boff-col`, never the stage lane's `bcol`.
 */
export function OffcutsColumn({ offcuts, selectedKey, onSelect, onDragStart, onDragEnd }: OffcutsColumnProps): JSX.Element {
  return (
    <section className="boff-col" data-status="offcuts" aria-label="Offcuts">
      <div className="bcol-head">
        <span className="c-dot offcuts" />
        <span className="c-name offcuts">Offcuts</span>
        <span className="c-count">{offcuts.length}</span>
      </div>
      <div className="bcol-list">
        {offcuts.length === 0 ? <div className="boff-empty">{OFFCUTS_EMPTY}</div> : offcuts.map((offcut) => {
          const key = offcutKey(offcut)
          return (
            <article
              key={key}
              className={`boff${selectedKey === key ? ' sel' : ''}${offcut.done ? ' done' : ''}`}
              draggable
              tabIndex={-1}
              data-offcut={key}
              title={offcut.text}
              onClick={() => onSelect(offcut)}
              onDragStart={(event) => onDragStart(event, offcut)}
              onDragEnd={onDragEnd}
            >
              <div className="boff-text">{offcut.text}</div>
              <div className="boff-from">{offcutOrigin(offcut)}</div>
              <div className="kbhint"><kbd>⌥→</kbd> make idea · <kbd>⏎</kbd> open piece</div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

export type OffcutNamerProps = {
  offcut: Offcut
  name: string
  busy: boolean
  error: string | null
  onChange: (name: string) => void
  onSubmit: () => void
  onCancel: () => void
}

/** Offcut to idea, step one (frame 2): name the idea. ↵ makes it; Esc puts the offcut back. */
export function OffcutNamer({ offcut, name, busy, error, onChange, onSubmit, onCancel }: OffcutNamerProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    const input = inputRef.current
    input?.focus()
    input?.setSelectionRange(input.value.length, input.value.length)
  }, [offcut.id])
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (!busy) onSubmit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }
  return (
    <div className="boff-namer" role="dialog" aria-label="Name the idea">
      <label className="boff-namer-label" htmlFor="boff-namer-input">Name the idea</label>
      <input
        id="boff-namer-input"
        ref={inputRef}
        className="boff-namer-input"
        value={name}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="boff boff-quote">{offcut.firstWords}</div>
      {error && <div className="boff-namer-error" role="alert">{error}</div>}
      <div className="boff-namer-actions">
        <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={onSubmit}>Make idea <kbd>↵</kbd></button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/** `tone: 'source'` marks a source step, whose tick is the sources blue (frame 4) rather than scraps amber. */
export type BoardActivityRow = { text: string; stepId: string | null; refused?: boolean; tone?: 'source' }

/** The Board's activity row (frames 3 and 4): what the last step did, and its one Undo. */
export function BoardActivity({ activity, onUndo }: { activity: BoardActivityRow; onUndo: (id: string) => void }): JSX.Element {
  return (
    <div className={`board-activity${activity.refused ? ' refused' : ''}`} role="status">
      {activity.refused ? <Scissors aria-hidden="true" /> : <span className={`ba-tick${activity.tone === 'source' ? ' source' : ''}`}><Check aria-hidden="true" /></span>}
      <span className="ba-text">{activity.text}</span>
      {activity.stepId && (
        <button type="button" className="btn ba-undo" onClick={() => onUndo(activity.stepId!)} title="Undo (⌘⇧Z)">
          Undo <kbd>⌘⇧Z</kbd>
        </button>
      )}
    </div>
  )
}
