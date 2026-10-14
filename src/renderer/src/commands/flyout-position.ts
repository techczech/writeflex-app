/**
 * Where the child list of an Actions here opener stands (the drawing: `.fly`, 6px right of the panel,
 * 3px above the opener row so the first child row lines up with it). Pure: rectangles in, a position out.
 */
export type Rect = { left: number; top: number; right: number; bottom: number }
export type FlyoutPlacement = { left: number; top: number; side: 'right' | 'left' }

export const FLYOUT_GAP = 6
export const FLYOUT_LIFT = 3
export const FLYOUT_EDGE = 8

/**
 * `prefer` (a list inside a list takes the side its parent took) wins whenever that side fits.
 * The child goes on the right of the parent when it fits inside the window, otherwise on the left. When
 * neither side has room it takes the side with more, pinned to the window edge. Vertically it is top
 * aligned with the opener row and shifted up as far as needed to end inside the window.
 */
export function placeFlyout(
  parent: Rect,
  row: Rect,
  child: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = FLYOUT_GAP,
  edge = FLYOUT_EDGE,
  prefer?: 'right' | 'left',
): FlyoutPlacement {
  const rightAt = parent.right + gap
  const leftAt = parent.left - gap - child.width
  const fitsRight = rightAt + child.width <= viewport.width - edge
  const fitsLeft = leftAt >= edge
  const preferred = prefer === 'left' ? fitsLeft : prefer === 'right' ? fitsRight : false
  const side: 'right' | 'left' = preferred ? prefer! : fitsRight ? 'right' : fitsLeft ? 'left' : viewport.width - parent.right >= parent.left ? 'right' : 'left'
  const raw = side === 'right' ? rightAt : leftAt
  const left = Math.max(edge, Math.min(raw, viewport.width - child.width - edge))
  const top = Math.max(edge, Math.min(row.top - FLYOUT_LIFT, viewport.height - child.height - edge))
  return { left, top, side }
}
