import type { FocusMode } from '../editor/focus-modes'

/**
 * The Focus and readability picker's rows and keyboard model, kept apart from the component so the
 * keys can be tested without a DOM. Two columns: Text readability (one mode at a time) and Text
 * overlay (Line focus and Ruler, each on or off by itself).
 */

export type ReadabilityRow = { kind: 'mode'; mode: FocusMode; label: string }
export type OverlayRow = { kind: 'overlaysOff'; label: string } | { kind: 'lineFocus'; label: string } | { kind: 'ruler'; label: string }
export type PickerRow = ReadabilityRow | OverlayRow

export const READABILITY_ROWS: ReadabilityRow[] = [
  { kind: 'mode', mode: '', label: 'Off' },
  { kind: 'mode', mode: 'fade', label: 'Fade other paragraphs' },
  { kind: 'mode', mode: 'sentence', label: 'Highlight sentence' },
  { kind: 'mode', mode: 'segment', label: 'Segment focus' },
  { kind: 'mode', mode: 'breakup', label: 'Sentence breakup' },
  { kind: 'mode', mode: 'anchored', label: 'Anchored reading' },
]

export const OVERLAY_ROWS: OverlayRow[] = [
  { kind: 'overlaysOff', label: 'Off' },
  { kind: 'lineFocus', label: 'Line focus' },
  { kind: 'ruler', label: 'Ruler' },
]

export const PICKER_COLUMNS: PickerRow[][] = [READABILITY_ROWS, OVERLAY_ROWS]

export type PickerCursor = { column: 0 | 1; row: number }

/** Digit shown beside a row: 0–5 on the left, 6–7 on the right; the right column's Off has none. */
export function rowDigit(column: 0 | 1, row: number): string {
  if (column === 0) return String(row)
  return row === 0 ? '' : String(READABILITY_ROWS.length + row - 1)
}

/** Where a digit key lands, or null for any other key. */
export function digitTarget(key: string): PickerCursor | null {
  if (!/^[0-7]$/.test(key)) return null
  const n = Number(key)
  return n < READABILITY_ROWS.length ? { column: 0, row: n } : { column: 1, row: n - READABILITY_ROWS.length + 1 }
}

/** The cursor after a navigation key, or null when the key is not one (↑↓ wrap within a column; ←→ switch column, keeping the row where it exists). */
export function moveCursor(cursor: PickerCursor, key: string): PickerCursor | null {
  const size = PICKER_COLUMNS[cursor.column].length
  switch (key) {
    case 'ArrowDown': return { ...cursor, row: (cursor.row + 1) % size }
    case 'ArrowUp': return { ...cursor, row: (cursor.row + size - 1) % size }
    case 'Home': return { ...cursor, row: 0 }
    case 'End': return { ...cursor, row: size - 1 }
    case 'ArrowLeft':
    case 'ArrowRight': {
      const column: 0 | 1 = cursor.column === 0 ? 1 : 0
      return { column, row: Math.min(cursor.row, PICKER_COLUMNS[column].length - 1) }
    }
    default: return null
  }
}
