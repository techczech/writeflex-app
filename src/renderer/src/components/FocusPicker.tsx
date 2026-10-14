import { useEffect, useRef, useState } from 'react'
import { LEAD_STYLE_NAMES, type FocusMode, type LeadStyle } from '../editor/focus-modes'
import {
  LINE_FOCUS_DIM_NAMES,
  LINE_FOCUS_DIMS,
  LINE_FOCUS_SIZES,
  LINE_FOLLOW_NAMES,
  LINE_FOLLOWS,
  LINE_OVERLAY_SETTINGS,
  RULER_COVER_NAMES,
  RULER_COVERS,
  RULER_OPACITY_MAX,
  RULER_OPACITY_MIN,
  RULER_OPACITY_STEP,
  type LineOverlayConfig,
} from '../editor/line-overlay'

/**
 * The Focus Picker (Round A, ADR-0028): a transient modal opened by the "Focus…" command or the
 * Focus Chip — modes are commands, not chrome, so nothing about this surface is resident. ↑/↓ walk
 * the rows (usability review note, 2026-07-24) and ↵ applies; digits 0–5 jump straight to a mode; ←/→ cycle
 * the lead-in style while Anchored is the cursor row; Esc closes; ✓ marks the active mode. The
 * cursor row holds real DOM focus, so ↵/Space activate natively and screen readers follow.
 */

type RowKind = FocusMode | 'lineFocus' | 'ruler'
const ROWS: Array<{ mode: RowKind; label: string }> = [
  { mode: '', label: 'Off' },
  { mode: 'fade', label: 'Fade other paragraphs' },
  { mode: 'sentence', label: 'Highlight sentence' },
  { mode: 'segment', label: 'Segment focus' },
  { mode: 'breakup', label: 'Sentence breakup' },
  { mode: 'anchored', label: 'Anchored reading' },
  // Overlays, not exclusive modes: switch rows that combine with whichever mode is on.
  { mode: 'lineFocus', label: 'Line focus' },
  { mode: 'ruler', label: 'Ruler' },
]

const STYLES: LeadStyle[] = ['bold', 'colour', 'contrast']

export type FocusPickerProps = {
  mode: FocusMode
  leadStyle: LeadStyle
  lineOverlay: LineOverlayConfig
  onToggleLineFocus: () => void
  onToggleRuler: () => void
  /** A pill or slider of Line focus / Ruler changed (persisted key, value); the picker stays open. */
  onOverlayChange: (key: string, value: boolean | string | number, label: string) => void
  /** A mode row (or its digit) was chosen — App applies it and closes the picker. */
  onSelect: (mode: FocusMode) => void
  /** A lead-in style pill was chosen — App applies it (and Anchored); the picker stays open. */
  onSelectStyle: (style: LeadStyle) => void
  onClose: () => void
}

export function FocusPicker({ mode, leadStyle, lineOverlay, onToggleLineFocus, onToggleRuler, onOverlayChange, onSelect, onSelectStyle, onClose }: FocusPickerProps): JSX.Element {
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
  // The cursor opens on the active mode, so ↓ from Off walks forward and ↵ on open re-applies what
  // is already on (a harmless no-op) rather than jumping somewhere arbitrary.
  const [cursor, setCursor] = useState(() => {
    const index = ROWS.findIndex((row) => row.mode === mode)
    return index < 0 ? 0 : index
  })

  // The picker owns the keyboard while up (the overlay-guard law): focus lives on the cursor row.
  useEffect(() => {
    rowRefs.current[cursor]?.focus()
  }, [cursor])

  /** Mode rows apply and close; overlay rows toggle and keep the picker up for their pills. */
  function activate(row: RowKind): void {
    if (row === 'lineFocus') onToggleLineFocus()
    else if (row === 'ruler') onToggleRuler()
    else onSelect(row)
  }

  function rowOn(row: RowKind): boolean {
    if (row === 'lineFocus') return lineOverlay.lineFocus.on
    if (row === 'ruler') return lineOverlay.ruler.on
    return mode === row
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : ROWS.length - 1
      setCursor((current) => (current + step) % ROWS.length)
      return
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      setCursor(e.key === 'Home' ? 0 : ROWS.length - 1)
      return
    }
    // ←/→ cycle the lead-in style while Anchored is the cursor row — the only row with a sub-choice.
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && ROWS[cursor]?.mode === 'anchored') {
      e.preventDefault()
      const at = STYLES.indexOf(leadStyle)
      const step = e.key === 'ArrowRight' ? 1 : STYLES.length - 1
      onSelectStyle(STYLES[((at < 0 ? 0 : at) + step) % STYLES.length])
      return
    }
    // On the overlay rows ←/→ cycle the first pill group: Size for Line focus, Covers for Ruler.
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && ROWS[cursor]?.mode === 'lineFocus') {
      e.preventDefault()
      const sizes = LINE_FOCUS_SIZES
      const at = Math.max(0, sizes.indexOf(lineOverlay.lineFocus.size))
      onOverlayChange(LINE_OVERLAY_SETTINGS.lineFocusSize, sizes[(at + (e.key === 'ArrowRight' ? 1 : sizes.length - 1)) % sizes.length], 'Line focus size')
      return
    }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && ROWS[cursor]?.mode === 'ruler') {
      e.preventDefault()
      const at = Math.max(0, RULER_COVERS.indexOf(lineOverlay.ruler.covers))
      onOverlayChange(LINE_OVERLAY_SETTINGS.rulerCovers, RULER_COVERS[(at + (e.key === 'ArrowRight' ? 1 : RULER_COVERS.length - 1)) % RULER_COVERS.length], 'Ruler covers')
      return
    }
    if (/^[0-7]$/.test(e.key)) {
      e.preventDefault()
      activate(ROWS[Number(e.key)].mode)
    }
  }

  return (
    <div
      className="overlay open focus-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="focus-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Focus Picker"
        onKeyDown={onKeyDown}
      >
        <div className="ph">Focus</div>
        {ROWS.map((row, index) => (
          <div key={row.mode || 'off'}>
            <button
              type="button"
              ref={(element) => {
                rowRefs.current[index] = element
              }}
              className={index === cursor ? 'pi cursor' : 'pi'}
              onClick={() => activate(row.mode)}
              // Hover deliberately does NOT move the keyboard cursor: the picker opens under
              // wherever the pointer happens to sit (a palette click, the chip), which would hand
              // the cursor to an arbitrary row. Hover keeps its own identical tint.
              aria-pressed={rowOn(row.mode)}
            >
              <span className="num" aria-hidden="true">{index}</span>
              {row.label}
              <span className="on" aria-hidden="true">{rowOn(row.mode) ? '✓' : ''}</span>
            </button>
            {row.mode === 'lineFocus' && (
              <div className="overlay-pills" role="group" aria-label="Line focus options">
                <div className="pill-line">
                  <span className="pill-label">Size</span>
                  {LINE_FOCUS_SIZES.map((size) => (
                    <button key={size} type="button" className={lineOverlay.lineFocus.size === size ? 'on' : undefined} aria-pressed={lineOverlay.lineFocus.size === size} onClick={() => onOverlayChange(LINE_OVERLAY_SETTINGS.lineFocusSize, size, 'Line focus size')}>
                      {size} {size === 1 ? 'line' : 'lines'}
                    </button>
                  ))}
                </div>
                <div className="pill-line">
                  <span className="pill-label">Follow</span>
                  {LINE_FOLLOWS.map((follow) => (
                    <button key={follow} type="button" className={lineOverlay.lineFocus.follow === follow ? 'on' : undefined} aria-pressed={lineOverlay.lineFocus.follow === follow} onClick={() => onOverlayChange(LINE_OVERLAY_SETTINGS.lineFocusFollow, follow, 'Line focus follow')}>
                      {LINE_FOLLOW_NAMES[follow]}
                    </button>
                  ))}
                </div>
                <div className="pill-line">
                  <span className="pill-label">Dim</span>
                  {LINE_FOCUS_DIMS.map((dim) => (
                    <button key={dim} type="button" className={lineOverlay.lineFocus.dim === dim ? 'on' : undefined} aria-pressed={lineOverlay.lineFocus.dim === dim} onClick={() => onOverlayChange(LINE_OVERLAY_SETTINGS.lineFocusDim, dim, 'Line focus dim')}>
                      {LINE_FOCUS_DIM_NAMES[dim]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {row.mode === 'ruler' && (
              <div className="overlay-pills" role="group" aria-label="Ruler options">
                <div className="pill-line">
                  <span className="pill-label">Covers</span>
                  {RULER_COVERS.map((covers) => (
                    <button key={covers} type="button" className={lineOverlay.ruler.covers === covers ? 'on' : undefined} aria-pressed={lineOverlay.ruler.covers === covers} onClick={() => onOverlayChange(LINE_OVERLAY_SETTINGS.rulerCovers, covers, 'Ruler covers')}>
                      {RULER_COVER_NAMES[covers]}
                    </button>
                  ))}
                </div>
                <div className="pill-line">
                  <span className="pill-label">Opacity</span>
                  <input
                    type="range"
                    className="overlay-opacity"
                    aria-label="Ruler opacity"
                    min={RULER_OPACITY_MIN}
                    max={RULER_OPACITY_MAX}
                    step={RULER_OPACITY_STEP}
                    value={lineOverlay.ruler.opacity}
                    disabled={lineOverlay.ruler.covers === 'thin'}
                    onChange={(e) => onOverlayChange(LINE_OVERLAY_SETTINGS.rulerOpacity, Number(e.target.value), 'Ruler opacity')}
                  />
                  <span className="pill-value">{lineOverlay.ruler.opacity}%</span>
                </div>
                <div className="pill-line">
                  <span className="pill-label">Follow</span>
                  {LINE_FOLLOWS.map((follow) => (
                    <button key={follow} type="button" className={lineOverlay.ruler.follow === follow ? 'on' : undefined} aria-pressed={lineOverlay.ruler.follow === follow} onClick={() => onOverlayChange(LINE_OVERLAY_SETTINGS.rulerFollow, follow, 'Ruler follow')}>
                      {LINE_FOLLOW_NAMES[follow]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {row.mode === 'anchored' && (
              <div className="styles" role="group" aria-label="Anchored lead-in style">
                {STYLES.map((style) => (
                  <button
                    key={style}
                    type="button"
                    className={leadStyle === style ? 'on' : undefined}
                    aria-pressed={leadStyle === style}
                    onClick={() => onSelectStyle(style)}
                  >
                    {LEAD_STYLE_NAMES[style]}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        <div className="pf">↑↓ then ↵ · 0–7 selects · Esc closes · lead-in style also lives in Settings → Editor (default: Contrast)</div>
      </div>
    </div>
  )
}
