import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { dragLabel, dropFor, slotAt } from '../../../shared/folio-running-order'

/** What the Folio part draws while a piece is being dragged. Nothing is written until the pointer is released. */
export type PieceDragView = {
  /** The piece being moved, by path. */
  path: string
  /** Where the line shows: 0..n (n = after the last piece), or null when the pointer is over no place a piece can go. */
  slot: number | null
  /** The piece is over its own place: a drop changes nothing. */
  inPlace: boolean
  x: number
  y: number
  label: string
}

type Options = {
  listRef: RefObject<HTMLDivElement>
  /** The running order on screen, as paths and titles (latest render). */
  pieces: ReadonlyArray<{ path: string; title: string }>
  /** False while a filter is on or a write is under way: nothing can be dragged. */
  enabled: boolean
  /** Called on release over a place the piece is not already in. `beforePath` null = to the end. */
  onDrop: (path: string, beforePath: string | null, expected: string[]) => void
  /** Set while a drag is live and for a tick after it, so the release is not also a click that opens the file. */
  suppressClick: { current: boolean }
}

const START_DISTANCE_PX = 5

/**
 * Pointer-driven drag of a piece row, like the section drag in OutlinePane (pointer events, Escape cancels,
 * a 5 px threshold before it starts). The drop place is worked out from the pieces' boxes in the DOM
 * (`[data-fo-box]`, one per piece, its row and headings together), so an expanded piece is one target.
 *
 * The window listeners live only while a press is live: release, cancel, Escape, a lost capture and the
 * component going away all remove them. Once the drag has started (past the threshold) the row captures
 * the pointer, so the release reaches it even outside the window; capture is not taken on the press
 * itself, because a captured press would turn a click on the chevron into a click on the row.
 */
export function usePieceDrag({ listRef, pieces, enabled, onDrop, suppressClick }: Options): { drag: PieceDragView | null; start: (event: ReactPointerEvent, path: string) => void } {
  const [drag, setDrag] = useState<PieceDragView | null>(null)
  const piecesRef = useRef(pieces)
  piecesRef.current = pieces
  const dropRef = useRef(onDrop)
  dropRef.current = onDrop
  // The live press's teardown, so an unmount (or a second press) cannot leave listeners on the window.
  const stopRef = useRef<(() => void) | null>(null)
  useEffect(() => () => { stopRef.current?.() }, [])

  const start = useCallback((event: ReactPointerEvent, path: string) => {
    if (!enabled || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if ((event.target as Element).closest('.fo-chev-btn, button')) return
    stopRef.current?.()
    const startX = event.clientX
    const startY = event.clientY
    const row = event.currentTarget instanceof Element ? event.currentTarget : null
    const pointerId = event.pointerId
    let captured = false
    let active = false
    let latest: PieceDragView | null = null
    let expected: string[] = piecesRef.current.map((piece) => piece.path)

    const compute = (e: PointerEvent): PieceDragView | null => {
      const order = piecesRef.current
      const source = order.findIndex((piece) => piece.path === path)
      if (source < 0) return null
      const list = listRef.current
      const base = { path, x: e.clientX, y: e.clientY }
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const overPlace = el !== null && list !== null && list.contains(el) && !el.closest('[data-fo-also-heading], [data-fo-also-group], [data-fo-front-heading], [data-fo-front-group]')
      const label = order[source].title
      if (!overPlace || !list) return { ...base, slot: null, inPlace: true, label: '' }
      const boxes = [...list.querySelectorAll<HTMLElement>('[data-fo-box]')].map((box) => box.getBoundingClientRect())
      if (boxes.length !== order.length) return { ...base, slot: null, inPlace: true, label: '' }
      const slot = slotAt(boxes, e.clientY)
      expected = order.map((piece) => piece.path)
      const drop = dropFor(expected, source, slot)
      return { ...base, slot, inPlace: drop.inPlace, label: drop.inPlace ? '' : dragLabel(label, drop.position, order.length) }
    }

    const onMove = (e: PointerEvent): void => {
      if (!active) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < START_DISTANCE_PX) return
        active = true
        suppressClick.current = true
        try { row?.setPointerCapture(pointerId); captured = true } catch { captured = false }
      }
      latest = compute(e)
      setDrag(latest ?? { path, slot: null, inPlace: true, x: e.clientX, y: e.clientY, label: '' })
    }
    const removeListeners = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onEscape, true)
      row?.removeEventListener('lostpointercapture', onCancel)
      if (captured) { try { row?.releasePointerCapture(pointerId) } catch { /* already released */ } captured = false }
      if (stopRef.current === stop) stopRef.current = null
    }
    /** Teardown with no state change and no drop: for an unmount. */
    const stop = (): void => {
      removeListeners()
      if (active) suppressClick.current = false
    }
    let finished = false
    const finish = (commit: boolean): void => {
      if (finished) return
      finished = true
      removeListeners()
      setDrag(null)
      if (active) window.setTimeout(() => { suppressClick.current = false }, 0)
      const result = latest
      if (!commit || !active || !result || result.slot === null || result.inPlace) return
      const drop = dropFor(expected, expected.indexOf(path), result.slot)
      if (drop.inPlace) return
      dropRef.current(path, drop.beforePath, expected)
    }
    const onUp = (): void => finish(true)
    const onCancel = (): void => finish(false)
    const onEscape = (e: globalThis.KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) } }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onEscape, true)
    row?.addEventListener('lostpointercapture', onCancel)
    stopRef.current = stop
  }, [enabled, listRef, suppressClick])

  return { drag, start }
}
