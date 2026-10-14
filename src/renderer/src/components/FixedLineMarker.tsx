import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { fixedLineFromPointer, fixedLinePreset, nudgeFixedLine, FIXED_LINE_PRESETS } from '../editor/fixed-line'

export type FixedLineBounds = { top: number; height: number }

type FixedLineMarkerProps = {
  /** The fixed line, a fraction of the scroller's visible height. */
  fraction: number
  /** The scroller's top and height relative to the marker's offset parent (the editor pane). */
  bounds: FixedLineBounds
  /** Live while dragging or stepping: the editor follows at once. */
  onChange: (fraction: number) => void
  /** The drag ended or a key step landed: persist it. */
  onCommit: (fraction: number) => void
  /** Line focus / Ruler: ↑/↓ move one visual line (this fraction of the height) and the ghost and rule stay away. */
  lineStep?: number
  /** Escape or a cancelled pointer during a drag: abandon it without committing. Without it a cancel commits. */
  onCancel?: () => void
}

/**
 * The marker in the editor's left margin that shows, and sets, the height of the fixed line. Drag it
 * or focus it and press ↑/↓ (2% a step). The caller renders it only in read-aloud and typewriter mode.
 */
export function FixedLineMarker({ fraction, bounds, onChange, onCommit, lineStep, onCancel }: FixedLineMarkerProps): React.JSX.Element {
  const [engaged, setEngaged] = useState(false)
  const [dragging, setDragging] = useState(false)
  const lastRef = useRef(fraction)
  const y = bounds.top + fraction * bounds.height
  const ghost = lineStep === undefined && fixedLinePreset(fraction) !== 'middle'

  const fromPointer = (event: PointerEvent<HTMLDivElement>): number => {
    const parent = event.currentTarget.offsetParent?.getBoundingClientRect()
    return fixedLineFromPointer(event.clientY - (parent?.top ?? 0), bounds.top, bounds.height)
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    lastRef.current = fraction
    setDragging(true)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    const next = fromPointer(event)
    lastRef.current = next
    onChange(next)
  }
  const cancelDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (!onCancel) return endDrag(event)
    if (!dragging) return
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    onCancel()
  }
  useEffect(() => {
    if (!dragging || !onCancel) return
    const onEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setDragging(false)
      onCancel()
    }
    window.addEventListener('keydown', onEscape, true)
    return () => window.removeEventListener('keydown', onEscape, true)
  }, [dragging, onCancel])
  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    onCommit(lastRef.current)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const next = nudgeFixedLine(fraction, event.key === 'ArrowDown' ? 1 : -1, lineStep)
    onChange(next)
    onCommit(next)
  }

  return (
    <>
      {lineStep === undefined && <div className={`fixed-line-rule${engaged || dragging ? ' on' : ''}`} style={{ top: y }} aria-hidden="true" />}
      {ghost && (
        <div
          className="fixed-line-marker ghost"
          style={{ top: bounds.top + FIXED_LINE_PRESETS.middle * bounds.height }}
          aria-hidden="true"
          data-testid="fixed-line-marker-ghost"
        >
          ½
        </div>
      )}
      <div
        className="fixed-line-marker"
        data-testid="fixed-line-marker"
        role="slider"
        tabIndex={0}
        aria-label="Fixed line position"
        aria-orientation="vertical"
        aria-valuemin={10}
        aria-valuemax={90}
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuetext={`${Math.round(fraction * 100)}% down the editor`}
        title="Drag to set where the line sits (or ↑/↓ when focused)"
        style={{ top: y }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={cancelDrag}
        onPointerEnter={() => setEngaged(true)}
        onPointerLeave={() => setEngaged(false)}
        onFocus={() => setEngaged(true)}
        onBlur={() => setEngaged(false)}
        onKeyDown={onKeyDown}
      >
        ≡
      </div>
    </>
  )
}
