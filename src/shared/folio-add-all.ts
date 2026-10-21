/**
 * The "Add all from this folder" sheet's rules, pure so the order and the keyboard moves can be tested
 * without a window. The sheet lists every addable unlisted file in chapter order; the writer may drag
 * rows or move the focused row with Alt+Up/Down, and "Add N" adds them in the order shown.
 */

import { compareChapterOrder } from './folio-chapter-order'

export type AddAllCandidate = { path: string; title: string }

/** The files the sheet offers: unlisted, not already carried by the manifest, in chapter order. */
export function addAllCandidates(unlisted: ReadonlyArray<{ path: string | null; title: string; manifestBacked?: boolean; putBackRefusal?: string }>): AddAllCandidate[] {
  return unlisted
    .flatMap((part) => (part.path && part.manifestBacked !== true && !part.putBackRefusal ? [{ path: part.path, title: part.title }] : []))
    .sort((a, b) => compareChapterOrder(a.path, b.path))
}

/** Move the row at `from` so that it sits at `to` (indices into the same list). Out-of-range asks change nothing. */
export function moveRowTo<T>(rows: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return [...rows]
  const next = [...rows]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/** Alt+Up (-1) or Alt+Down (+1) on the row at `index`: the new list and where the row now is (it stays put at an edge). */
export function nudgeRow<T>(rows: readonly T[], index: number, delta: -1 | 1): { rows: T[]; index: number } {
  const to = index + delta
  if (index < 0 || index >= rows.length || to < 0 || to >= rows.length) return { rows: [...rows], index }
  return { rows: moveRowTo(rows, index, to), index: to }
}

/** What a key pressed anywhere inside the sheet does: Esc closes, ⌘↵ (Ctrl+↵ off the Mac) adds, Tab moves focus within it. */
export function sheetKeyAction(event: { key: string; metaKey?: boolean; ctrlKey?: boolean }): 'close' | 'add' | 'tab' | null {
  if (event.key === 'Escape') return 'close'
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) return 'add'
  if (event.key === 'Tab') return 'tab'
  return null
}

/**
 * The focus trap: where Tab (or ⇧Tab) goes among the sheet's `count` focusable elements from the one at
 * `current` (-1 = focus is on none of them). It wraps at both ends. Null = nothing to focus.
 */
export function trappedFocus(count: number, current: number, backwards: boolean): number | null {
  if (count === 0) return null
  if (current < 0) return backwards ? count - 1 : 0
  return backwards ? (current - 1 + count) % count : (current + 1) % count
}
