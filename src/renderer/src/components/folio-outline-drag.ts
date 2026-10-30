import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'

export const AMBIGUOUS_DRAG_MESSAGE = 'Two parts here are identical, so WriteFlex cannot tell which one you are moving. Change the title or gloss of one of them first.'
export const OUTLINE_DRAG_CHANGED_MESSAGE = 'The running order changed during dragging. Drag the part again.'

type DropRow = { index: number; top: number; bottom: number; key?: string }

export function outlineDragRefusal(rows: readonly Pick<DropRow, 'index' | 'key'>[], from: number, sourceKey: string): string | null {
  if (rows.filter(row => row.key === sourceKey).length > 1) return AMBIGUOUS_DRAG_MESSAGE
  return rows.some(row => row.index === from && row.key === sourceKey) ? null : OUTLINE_DRAG_CHANGED_MESSAGE
}

/** Resolve the insertion boundary in the current row geometry, then account for removing the source. */
export function outlineDropTarget(rows: readonly DropRow[], from: number, y: number, commit = true, sourceKey?: string): { to: number; boundary: number; after: boolean } | null {
  if (!commit || !rows.some(row => row.index === from && (sourceKey === undefined || row.key === sourceKey))) return null
  const before = rows.findIndex(row => y < (row.top + row.bottom) / 2)
  const boundary = before < 0 ? rows.length - 1 : before
  const slot = rows[boundary].index + (before < 0 ? 1 : 0)
  return { to: slot > from ? slot - 1 : slot, boundary, after: before < 0 }
}

/** The manager keeps its rows still during a drag. Only these two disposable overlays move. */
export function useOutlinePartDrag({ listRef, allParts, enabled, onMove, onActive, onRefuse }: {
  listRef: RefObject<HTMLDivElement>
  allParts: readonly { index: number; key: string }[]
  enabled: boolean
  onMove: (from: number, to: number, sourceKey: string) => void | Promise<void>
  onActive: (active: boolean) => void
  onRefuse: (message: string) => void
}): (event: ReactPointerEvent<HTMLElement>, index: number) => void {
  const latest = useRef({ enabled, onMove, onActive, onRefuse, allParts })
  latest.current = { enabled, onMove, onActive, onRefuse, allParts }
  const cleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => cleanup.current?.(), [])
  return useCallback((event, from) => {
    if (!latest.current.enabled || event.button !== 0 || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || (event.target as Element).closest('button,input,textarea,select,a')) return
    const sourceKey = event.currentTarget.dataset.partKey
    if (sourceKey === undefined) return
    cleanup.current?.()
    // Freeze the displayed model at the press, before a sub-threshold refresh can re-index this row.
    const { onActive, onMove, onRefuse, allParts } = latest.current
    const sourceRefusal = (): string | null => {
      // The model includes parts omitted from this view; a hidden twin is still ambiguous.
      const modelRefusal = outlineDragRefusal(allParts, from, sourceKey)
      if (modelRefusal) return modelRefusal
      const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-part-index]') ?? [])]
      return outlineDragRefusal(rows.map(row => ({ index: Number(row.dataset.partIndex), key: row.dataset.partKey })), from, sourceKey)
    }
    onActive(true)
    const row = event.currentTarget
    const pointer = event.pointerId
    const startX = event.clientX, startY = event.clientY
    const scroll = row.closest<HTMLElement>('.fr-body')
    let x = startX, y = startY, active = false, refused = false, frame = 0, finished = false
    let ghost: HTMLElement | null = null, line: HTMLElement | null = null
    let offsetX = 0, offsetY = 0, lastTime = 0
    // Read current geometry, including after auto-scroll; never infer an index from the last hovered row.
    const target = (commit = true): { to: number; top: number; left: number; width: number } | null => {
      const list = listRef.current
      if (!list || !scroll) return null
      const viewport = scroll.getBoundingClientRect()
      if (x < viewport.left || x > viewport.right || y < viewport.top || y > viewport.bottom) return null
      const rows = [...list.querySelectorAll<HTMLElement>('[data-part-index]')]
      if (!rows.length) return null
      const boxes = rows.map(el => ({ el, box: el.getBoundingClientRect() }))
      const drop = outlineDropTarget(boxes.map(({ el, box }) => ({ index: Number(el.dataset.partIndex), key: el.dataset.partKey, top: box.top, bottom: box.bottom })), from, y, commit, sourceKey)
      if (!drop) return null
      const boundary = boxes[drop.boundary].box
      return { to: drop.to, top: drop.after ? boundary.bottom : boundary.top, left: boundary.left, width: boundary.width }
    }
    const paint = (): void => {
      const place = target()
      if (ghost) ghost.style.transform = `translate3d(${x - offsetX}px,${y - offsetY}px,0)`
      if (line) {
        line.hidden = !place || place.to === from
        if (place) { line.style.width = `${place.width}px`; line.style.transform = `translate3d(${place.left}px,${place.top}px,0)` }
      }
    }
    const tick = (time: number): void => {
      const elapsed = Math.min(32, lastTime ? time - lastTime : 16); lastTime = time
      if (scroll) {
        const box = scroll.getBoundingClientRect(), edge = 44
        const speed = y < box.top + edge ? -Math.min(1, (box.top + edge - y) / edge) : y > box.bottom - edge ? Math.min(1, (y - box.bottom + edge) / edge) : 0
        if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) scroll.scrollTop += speed * elapsed * .9
      }
      paint(); frame = requestAnimationFrame(tick)
    }
    const move = (e: PointerEvent): void => {
      if (e.pointerId !== pointer) return
      if (e.buttons === 0) { finish(false); return }
      x = e.clientX; y = e.clientY
      if (refused) { e.preventDefault(); return }
      if (!active) {
        if (Math.hypot(x - startX, y - startY) < 5) return
        active = true
        const refusal = sourceRefusal()
        if (refusal) { refused = true; e.preventDefault(); onRefuse(refusal); return }
        const box = row.getBoundingClientRect(); offsetX = startX - box.left; offsetY = startY - box.top
        ghost = row.cloneNode(true) as HTMLElement
        ghost.removeAttribute('id'); ghost.removeAttribute('role'); ghost.setAttribute('aria-hidden', 'true')
        ghost.classList.add('fr-outline-drag-ghost'); ghost.style.width = `${box.width}px`
        ghost.style.gridTemplateColumns = getComputedStyle(row).gridTemplateColumns
        line = document.createElement('div'); line.className = 'fr-outline-drop-line'; line.setAttribute('aria-hidden', 'true')
        document.body.append(ghost, line); row.classList.add('dragging')
        try { row.setPointerCapture(pointer) } catch { /* Window listeners still own the press. */ }
        frame = requestAnimationFrame(tick)
      }
      e.preventDefault()
      // The moving copy follows every event, independent of React and the frame's geometry work.
      if (ghost) ghost.style.transform = `translate3d(${x - offsetX}px,${y - offsetY}px,0)`
    }
    const swallowClick = (e: MouseEvent): void => { e.preventDefault(); e.stopPropagation() }
    const finish = (commit: boolean, e?: PointerEvent): void => {
      if (finished || (e && e.pointerId !== pointer)) return
      finished = true
      if (e) { x = e.clientX; y = e.clientY }
      const refusal = active && !refused && commit ? sourceRefusal() : null
      const place = active && !refused && !refusal ? target(commit) : null
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', escape, true)
      row.removeEventListener('lostpointercapture', cancel)
      ghost?.remove(); line?.remove(); row.classList.remove('dragging')
      try { if (row.hasPointerCapture(pointer)) row.releasePointerCapture(pointer) } catch { /* unmounted */ }
      cleanup.current = null
      if (refusal) onRefuse(refusal)
      if (active) {
        window.addEventListener('click', swallowClick, true)
        setTimeout(() => window.removeEventListener('click', swallowClick, true), 0)
        const committed = !!place && place.to !== from
        if (committed) {
          // Retain the press's hold until the write settles, including every early refusal in move().
          void (async () => {
            try { await onMove(from, place!.to, sourceKey) }
            finally { onActive(false) }
          })()
          return
        }
      }
      onActive(false)
    }
    const up = (e: PointerEvent): void => finish(true, e)
    const cancel = (): void => finish(false)
    const escape = (e: KeyboardEvent): void => {
      if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); e.stopImmediatePropagation(); return }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false) } }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', escape, true)
    row.addEventListener('lostpointercapture', cancel)
    cleanup.current = cancel
  }, [listRef])
}
