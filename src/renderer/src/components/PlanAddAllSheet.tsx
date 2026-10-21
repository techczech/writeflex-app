import { useEffect, useRef, useState } from 'react'
import { GripVertical, ListPlus } from 'lucide-react'
import { moveRowTo, nudgeRow, sheetKeyAction, trappedFocus, type AddAllCandidate } from '../../../shared/folio-add-all'

type Props = {
  folderName: string
  candidates: AddAllCandidate[]
  busy: boolean
  onAdd: (rows: AddAllCandidate[]) => void
  onClose: () => void
}

/** "Add all from this folder": every addable unlisted file in chapter order, to reorder before one Add. */
export function PlanAddAllSheet({ folderName, candidates, busy, onAdd, onClose }: Props): JSX.Element {
  const [rows, setRows] = useState(candidates)
  const [focused, setFocused] = useState(0)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const refocus = useRef(false)

  useEffect(() => { refs.current[0]?.focus() }, [])
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    refs.current[focused]?.focus()
  }, [rows, focused])

  const dialogRef = useRef<HTMLDivElement>(null)

  /** The sheet's own keys, from any focus inside it: Esc closes, ⌘↵ adds, Tab and ⇧Tab stay inside. */
  const onDialogKeyDown = (event: React.KeyboardEvent): void => {
    const dialog = dialogRef.current
    if (!dialog) return
    const action = sheetKeyAction(event)
    if (action === 'close') { event.preventDefault(); event.stopPropagation(); onClose(); return }
    if (action === 'add') { event.preventDefault(); event.stopPropagation(); if (!busy && rows.length > 0) onAdd(rows); return }
    if (action !== 'tab') return
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    const next = trappedFocus(focusable.length, focusable.indexOf(document.activeElement as HTMLElement), event.shiftKey)
    if (next === null) return
    event.preventDefault()
    focusable[next]?.focus()
  }

  const onRowKeyDown = (event: React.KeyboardEvent, index: number): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const delta = event.key === 'ArrowDown' ? 1 : -1
    if (event.altKey) {
      const next = nudgeRow(rows, index, delta)
      refocus.current = true
      setRows(next.rows)
      setFocused(next.index)
      return
    }
    const to = Math.max(0, Math.min(index + delta, rows.length - 1))
    setFocused(to)
    refs.current[to]?.focus()
  }

  const drop = (to: number): void => {
    if (dragFrom === null) return
    refocus.current = true
    setRows(moveRowTo(rows, dragFrom, to))
    setFocused(to)
    setDragFrom(null)
  }

  return (
    <div className="overlay open" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={dialogRef} className="sheet confirm aa-sheet" role="dialog" aria-modal="true" aria-labelledby="aa-title" data-testid="plan-add-all-sheet" onKeyDown={onDialogKeyDown}>
        <h2 id="aa-title">Add all from {folderName}</h2>
        <p className="unlisted-note">These {rows.length === 1 ? 'file is' : `${rows.length} files are`} in chapter order. Drag a row, or press <kbd>⌥↑</kbd> <kbd>⌥↓</kbd> on it, to change the order before adding.</p>
        <div className="parts aa-rows" role="listbox" aria-label="Files to add, in order">
          {rows.map((row, index) => (
            <button
              type="button"
              role="option"
              aria-selected={focused === index}
              className={`part aa-row${focused === index ? ' sel' : ''}`}
              key={row.path}
              ref={(el) => { refs.current[index] = el }}
              draggable
              onDragStart={() => setDragFrom(index)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); drop(index) }}
              onFocus={() => setFocused(index)}
              onKeyDown={(event) => onRowKeyDown(event, index)}
            >
              <GripVertical className="icon sm" aria-hidden="true" />
              <span className="num">{index + 1}</span>
              <span className="body"><span className="ptitle">{row.title}</span></span>
            </button>
          ))}
        </div>
        <div className="ip-act">
          <button type="button" className="btn idea-action" disabled={busy || rows.length === 0} onClick={() => onAdd(rows)}><ListPlus className="icon sm" aria-hidden="true" />Add {rows.length} <kbd>⌘↵</kbd></button>
          <button type="button" className="btn" onClick={onClose}>Cancel <kbd>esc</kbd></button>
        </div>
      </div>
    </div>
  )
}
