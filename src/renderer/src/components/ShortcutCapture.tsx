import { useEffect, useState } from 'react'
import { shortcutCaptureActive } from '../commands/chords'
import { eventToChord } from '../app/shortcuts'

type Props = {
  /** The command being assigned (popover heading context + aria labelling). */
  label: string
  /** Live conflict check: labels of other commands whose EFFECTIVE chord equals the candidate. */
  conflictsFor: (chord: string) => string[]
  /** A conflict-free chord was pressed — save it and close. */
  onAssign: (chord: string) => void
  /** The writer chose to steal a conflicted chord: reassign it here, unassign the claimants. */
  onMoveHere: (chord: string) => void
  onCancel: () => void
}

/**
 * The Keycap Ledger's capture popover (Round A T6, mockup §4): "press keys now". A window-level
 * CAPTURE listener swallows every keystroke while it is open — Esc cancels, a conflict-free chord
 * saves immediately, a conflicting chord is flagged HERE and blocks until the writer either picks
 * another chord, cancels, or moves the chord to this command. While open, App's overlay-raising
 * keys (⇧⌘K/⇧⌘P/⌘,/?) stand down via `shortcutCaptureActive` so the popover alone hears the keys.
 */
export function ShortcutCapture({ label, conflictsFor, onAssign, onMoveHere, onCancel }: Props): JSX.Element {
  const [conflict, setConflict] = useState<{ chord: string; labels: string[] } | null>(null)

  useEffect(() => {
    shortcutCaptureActive.current = true
    function onKeyDown(e: KeyboardEvent): void {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        onCancel()
        return
      }
      const chord = eventToChord(e)
      if (!chord) return // a lone modifier or a typing key — keep listening
      const labels = conflictsFor(chord)
      if (labels.length === 0) {
        onAssign(chord)
        return
      }
      setConflict({ chord, labels })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      shortcutCaptureActive.current = false
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [conflictsFor, onAssign, onCancel])

  return (
    <span className="shortcut-pop" role="dialog" aria-label={`Assign a chord to ${label}`}>
      <span className="sp-title">Assign a chord</span>
      <span className="sp-rec" aria-live="polite">
        {conflict ? (
          <>
            <kbd>{conflict.chord}</kbd> is taken by {conflict.labels[0]}
          </>
        ) : (
          <>◉&nbsp; press keys now</>
        )}
      </span>
      {conflict && (
        <button type="button" className="sp-move" onClick={() => onMoveHere(conflict.chord)}>
          Move it here
        </button>
      )}
      <span className="sp-meta">Esc cancels · conflicts are flagged here before anything is saved · appears in the Changelog with a reset</span>
    </span>
  )
}
