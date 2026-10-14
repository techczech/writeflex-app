export type ReadingRoomSide = 'left' | 'right'

export const MIN_ROOM_WIDTH = 280
export const MIN_EDITOR_WIDTH = 360

function browserWidth(): number {
  return typeof window === 'undefined'
    ? MIN_ROOM_WIDTH + MIN_EDITOR_WIDTH
    : window.innerWidth
}

export function ceilingForReadingRoom(
  span: number | null,
  fallbackWidth: number = browserWidth(),
): number {
  const available = span ?? fallbackWidth
  return Math.max(MIN_ROOM_WIDTH, available - MIN_EDITOR_WIDTH)
}

export function clampReadingRoomWidth(
  width: number,
  span: number | null = null,
  fallbackWidth: number = browserWidth(),
): number {
  return Math.min(
    ceilingForReadingRoom(span, fallbackWidth),
    Math.max(MIN_ROOM_WIDTH, Math.round(width)),
  )
}

export function readingRoomWidthForPointer(
  startWidth: number,
  startX: number,
  clientX: number,
  side: ReadingRoomSide,
  span: number | null,
): number {
  const delta = side === 'left' ? clientX - startX : startX - clientX
  return clampReadingRoomWidth(startWidth + delta, span)
}

export function readingRoomWidthForKey(
  width: number,
  key: 'ArrowLeft' | 'ArrowRight',
  shiftKey: boolean,
  side: ReadingRoomSide,
  span: number | null,
): number {
  const movement = shiftKey ? 64 : 16
  const spatialDirection = key === 'ArrowRight' ? 1 : -1
  const widthDirection = side === 'left' ? spatialDirection : -spatialDirection
  return clampReadingRoomWidth(width + movement * widthDirection, span)
}

export type ReadingRoomResizeSession = {
  dispose: () => void
}

export function beginReadingRoomResize(
  event: PointerEvent,
  element: HTMLElement,
  options: {
    side: ReadingRoomSide
    span: number | null
    startWidth: number
    onWidth: (width: number) => void
    onFinish: (width: number) => void
    onResizingChange: (resizing: boolean) => void
    requestFrame?: (callback: FrameRequestCallback) => number
    cancelFrame?: (handle: number) => void
  },
): ReadingRoomResizeSession {
  const requestFrame = options.requestFrame ?? window.requestAnimationFrame.bind(window)
  const cancelFrame = options.cancelFrame ?? window.cancelAnimationFrame.bind(window)
  const pointerId = event.pointerId
  const startX = event.clientX
  let latestX = startX
  let paintedWidth = options.startWidth
  let frame: number | null = null
  let ended = false

  const widthAtLatestPointer = (): number =>
    readingRoomWidthForPointer(
      options.startWidth,
      startX,
      latestX,
      options.side,
      options.span,
    )

  const paintLatestWidth = (): number => {
    const width = widthAtLatestPointer()
    if (width !== paintedWidth) {
      paintedWidth = width
      options.onWidth(width)
    }
    return width
  }

  const removeListeners = (): void => {
    element.removeEventListener('pointermove', move)
    element.removeEventListener('pointerup', pointerUp)
    element.removeEventListener('pointercancel', pointerCancel)
    element.removeEventListener('lostpointercapture', lostPointerCapture)
  }

  const releasePointer = (): void => {
    if (element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId)
    }
  }

  const finish = (): void => {
    if (ended) return
    ended = true
    if (frame !== null) {
      cancelFrame(frame)
      frame = null
    }
    const width = paintLatestWidth()
    removeListeners()
    releasePointer()
    options.onResizingChange(false)
    options.onFinish(width)
  }

  function move(pointer: PointerEvent): void {
    if (ended || pointer.pointerId !== pointerId) return
    latestX = pointer.clientX
    if (frame !== null) return
    frame = requestFrame(() => {
      frame = null
      if (!ended) paintLatestWidth()
    })
  }

  function pointerUp(pointer: PointerEvent): void {
    if (pointer.pointerId !== pointerId) return
    latestX = pointer.clientX
    finish()
  }

  function pointerCancel(pointer: PointerEvent): void {
    if (pointer.pointerId === pointerId) finish()
  }

  function lostPointerCapture(pointer: PointerEvent): void {
    if (pointer.pointerId === pointerId) finish()
  }

  element.setPointerCapture(pointerId)
  element.addEventListener('pointermove', move)
  element.addEventListener('pointerup', pointerUp)
  element.addEventListener('pointercancel', pointerCancel)
  element.addEventListener('lostpointercapture', lostPointerCapture)
  options.onResizingChange(true)

  return {
    dispose(): void {
      if (ended) return
      ended = true
      if (frame !== null) {
        cancelFrame(frame)
        frame = null
      }
      removeListeners()
      releasePointer()
      options.onResizingChange(false)
    },
  }
}
