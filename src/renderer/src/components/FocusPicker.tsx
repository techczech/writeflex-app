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
import { digitTarget, moveCursor, PICKER_COLUMNS, rowDigit, type PickerCursor, type PickerRow } from './focus-picker-model'

/**
 * Focus and readability (Round A, ADR-0028; two columns in 0.23): a transient modal opened by the
 * "Focus and readability…" command or the Focus Chip — modes are commands, not chrome, so nothing
 * about this surface is resident. Left, Text readability: one mode at a time. Right, Text overlay:
 * Line focus and Ruler, each on or off by itself. ↑/↓ walk a column, ←/→ move between columns, ↵
 * applies, digits 0–5 pick a readability mode and 6–7 an overlay, Esc closes; ✓ marks what is on.
 * The cursor row holds real DOM focus, so ↵/Space activate natively and screen readers follow.
 * The chosen row of each column is tinted and bold; the pills and slider of rows that are not chosen are faded
 * (still clickable and reachable by keyboard) until the row is hovered or focused.
 */

const STYLES: LeadStyle[] = ['bold', 'colour', 'contrast']
const COLUMN_HEADINGS = ['Text readability', 'Text overlay']

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
  const rowRefs = useRef<Array<Array<HTMLButtonElement | null>>>([[], []])
  // The cursor opens on the active mode, so ↓ from Off walks forward and ↵ on open re-applies what
  // is already on (a harmless no-op) rather than jumping somewhere arbitrary.
  const [cursor, setCursor] = useState<PickerCursor>(() => {
    const index = PICKER_COLUMNS[0].findIndex((row) => row.kind === 'mode' && row.mode === mode)
    return { column: 0, row: index < 0 ? 0 : index }
  })

  // The picker owns the keyboard while up (the overlay-guard law): focus lives on the cursor row.
  useEffect(() => {
    rowRefs.current[cursor.column][cursor.row]?.focus()
  }, [cursor])

  /** Readability rows apply and close; overlay rows toggle and keep the picker up for their pills. */
  function activate(row: PickerRow): void {
    if (row.kind === 'lineFocus') onToggleLineFocus()
    else if (row.kind === 'ruler') onToggleRuler()
    else if (row.kind === 'overlaysOff') {
      // A toggle on an "on" overlay turns it off. The two are never on together, but check both.
      if (lineOverlay.lineFocus.on) onToggleLineFocus()
      if (lineOverlay.ruler.on) onToggleRuler()
    } else onSelect(row.mode)
  }

  function rowOn(row: PickerRow): boolean {
    if (row.kind === 'lineFocus') return lineOverlay.lineFocus.on
    if (row.kind === 'ruler') return lineOverlay.ruler.on
    if (row.kind === 'overlaysOff') return !lineOverlay.lineFocus.on && !lineOverlay.ruler.on
    return mode === row.mode
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    // Pills and the opacity slider keep their own arrow keys; moving between rows applies to rows only.
    if ((e.target as HTMLElement).classList.contains('pi')) {
      const moved = moveCursor(cursor, e.key)
      if (moved) {
        e.preventDefault()
        setCursor(moved)
        return
      }
    }
    const digit = digitTarget(e.key)
    if (digit) {
      e.preventDefault()
      activate(PICKER_COLUMNS[digit.column][digit.row])
    }
  }

  function renderRow(row: PickerRow, column: 0 | 1, index: number): JSX.Element {
    const key = row.kind === 'mode' ? row.mode || 'off' : row.kind
    const on = rowOn(row)
    return (
      <div key={key} className={on ? 'pr chosen' : 'pr faded'}>
        <button
          type="button"
          ref={(element) => {
            rowRefs.current[column][index] = element
          }}
          className={cursor.column === column && cursor.row === index ? 'pi cursor' : 'pi'}
          onClick={() => activate(row)}
          // Hover deliberately does NOT move the keyboard cursor: the picker opens under
          // wherever the pointer happens to sit (a palette click, the chip), which would hand
          // the cursor to an arbitrary row. Hover keeps its own identical tint.
          aria-pressed={on}
        >
          <span className="num" aria-hidden="true">{rowDigit(column, index)}</span>
          {row.label}
          <span className="on" aria-hidden="true">{on ? '✓' : ''}</span>
        </button>
        {row.kind === 'lineFocus' && (
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
        {row.kind === 'ruler' && (
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
        {row.kind === 'mode' && row.mode === 'anchored' && (
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
    )
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
        aria-label="Focus and readability"
        onKeyDown={onKeyDown}
      >
        <div className="ph">Focus and readability</div>
        <div className="fp-cols">
          {PICKER_COLUMNS.map((rows, column) => (
            <div key={COLUMN_HEADINGS[column]} className="fp-col" role="group" aria-label={COLUMN_HEADINGS[column]}>
              <div className="fp-col-head">{COLUMN_HEADINGS[column]}</div>
              {rows.map((row, index) => renderRow(row, column as 0 | 1, index))}
            </div>
          ))}
        </div>
        <div className="pf">↑↓ then ↵ · ←→ switch column · 0–7 selects · Esc closes · lead-in style also lives in Settings → Editor (default: Contrast)</div>
      </div>
    </div>
  )
}
