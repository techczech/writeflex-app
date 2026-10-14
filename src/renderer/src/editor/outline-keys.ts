/**
 * Keyboard model of the outline list (outline keyboard, 2026-10-07). Pure, so the panel and the tests
 * share one reading of a keypress.
 *
 * ↑ ↓ Home End move the focused row; ← → fold and unfold; ↵ (and Space) jump the editor to the heading and
 * keep focus in the list; ⌘↵ and Esc go back to the editor at that heading; ⇧↑ ⇧↓ extend the several-picked
 * selection; ⌘K opens the focused row's menu (the same one a right-click opens). The structure chords
 * (⌥⌘ arrows) are matched against the registry by the panel, ahead of this.
 */
export type OutlineKey = {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type OutlineKeyAction =
  | 'up' | 'down' | 'home' | 'end'
  | 'extendUp' | 'extendDown'
  | 'fold' | 'unfold'
  | 'jump' | 'jumpToEditor' | 'escape'
  | 'menu'

export function classifyOutlineKey(event: OutlineKey): OutlineKeyAction | null {
  const command = event.metaKey || event.ctrlKey
  if (event.altKey) return null
  if (command && !event.shiftKey && event.key.toLowerCase() === 'k' && event.metaKey) return 'menu'
  if (command && event.key === 'Enter') return 'jumpToEditor'
  if (command) return null
  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) return 'menu'
  if (event.shiftKey) {
    if (event.key === 'ArrowUp') return 'extendUp'
    if (event.key === 'ArrowDown') return 'extendDown'
    return null
  }
  switch (event.key) {
    case 'ArrowUp': return 'up'
    case 'ArrowDown': return 'down'
    case 'Home': return 'home'
    case 'End': return 'end'
    case 'ArrowLeft': return 'fold'
    case 'ArrowRight': return 'unfold'
    case 'Enter':
    case ' ': return 'jump'
    case 'Escape': return 'escape'
    default: return null
  }
}

/**
 * ⇧↑ / ⇧↓: move focus one heading and pick every heading between the anchor and the new focus.
 * `order` is the shown headings in document order. Returns null at either end (nothing to extend into).
 */
export function extendSelection(
  order: readonly number[],
  anchor: number | null,
  focus: number,
  delta: -1 | 1,
): { selected: number[]; focus: number; anchor: number } | null {
  const at = order.indexOf(focus)
  if (at === -1) return null
  const next = order[at + delta]
  if (next === undefined) return null
  const from = anchor !== null && order.includes(anchor) ? anchor : focus
  const a = order.indexOf(from)
  const b = order.indexOf(next)
  return { selected: order.slice(Math.min(a, b), Math.max(a, b) + 1), focus: next, anchor: from }
}

/**
 * Where a click on empty space in the list puts keyboard focus: the cursor's row when it is shown,
 * else the first row; null when the list is empty.
 */
export function emptySpaceFocusTarget(shownFroms: readonly number[], cursorFrom: number | null): number | null {
  if (shownFroms.length === 0) return null
  return cursorFrom !== null && shownFroms.includes(cursorFrom) ? cursorFrom : shownFroms[0]
}
