import { useEffect, type RefObject } from 'react'

/** Width of the hot zone at each visible edge of the scrolling row, in px. */
export const EDGE_ZONE_PX = 48
/** Fastest scroll, at the very edge, in px per frame. */
export const MAX_SPEED_PX = 20
/** Constant speed when the writer prefers reduced motion. */
export const REDUCED_SPEED_PX = 4

/**
 * Signed px-per-frame scroll speed for a pointer at `x` over a row spanning `left`..`right`.
 * Negative scrolls left, positive right, 0 inside the middle or outside the row. The speed grows
 * linearly with closeness to the edge; reduced motion uses one slow constant.
 */
export function edgeScrollSpeed(x: number, left: number, right: number, reducedMotion = false): number {
  if (x < left || x > right) return 0
  const zone = Math.min(EDGE_ZONE_PX, (right - left) / 2)
  const fromLeft = x - left
  const fromRight = right - x
  const pick = (depth: number): number => reducedMotion ? REDUCED_SPEED_PX : Math.max(1, Math.round(MAX_SPEED_PX * (1 - depth / zone)))
  if (fromLeft < zone) return -pick(fromLeft)
  if (fromRight < zone) return pick(fromRight)
  return 0
}

/**
 * While `active` (a drag over the Board is in progress), scrolls `ref`'s element sideways when the
 * pointer nears its left or right edge. Stops when `active` turns false, the pointer leaves the
 * element's box, or the element reaches its end. Never scrolls when `active` is false.
 */
export function useDragAutoScroll(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return
    let pointer: { x: number; y: number } | null = null
    let frame = 0
    const onOver = (event: DragEvent): void => { pointer = { x: event.clientX, y: event.clientY } }
    const tick = (): void => {
      const el = ref.current
      if (el && pointer) {
        const box = el.getBoundingClientRect()
        const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        const inside = pointer.y >= box.top && pointer.y <= box.bottom
        const speed = inside ? edgeScrollSpeed(pointer.x, box.left, box.right, reduced) : 0
        const max = el.scrollWidth - el.clientWidth
        if ((speed < 0 && el.scrollLeft > 0) || (speed > 0 && el.scrollLeft < max)) el.scrollLeft += speed
      }
      frame = requestAnimationFrame(tick)
    }
    document.addEventListener('dragover', onOver)
    frame = requestAnimationFrame(tick)
    return () => {
      document.removeEventListener('dragover', onOver)
      cancelAnimationFrame(frame)
    }
  }, [ref, active])
}
