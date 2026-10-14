import { expect, test } from 'bun:test'

type ReadingRoomSide = 'left' | 'right'
type ResizeModule = {
  MIN_EDITOR_WIDTH: number
  MIN_ROOM_WIDTH: number
  ceilingForReadingRoom: (span: number | null, fallbackWidth?: number) => number
  clampReadingRoomWidth: (width: number, span: number | null, fallbackWidth?: number) => number
  readingRoomWidthForPointer: (
    startWidth: number,
    startX: number,
    clientX: number,
    side: ReadingRoomSide,
    span: number | null,
  ) => number
  readingRoomWidthForKey: (
    width: number,
    key: 'ArrowLeft' | 'ArrowRight',
    shiftKey: boolean,
    side: ReadingRoomSide,
    span: number | null,
  ) => number
  beginReadingRoomResize: (
    event: PointerEvent,
    element: HTMLElement,
    options: {
      side: ReadingRoomSide
      span: number | null
      startWidth: number
      onWidth: (width: number) => void
      onFinish: (width: number) => void
      onResizingChange: (resizing: boolean) => void
      requestFrame: (callback: FrameRequestCallback) => number
      cancelFrame: (handle: number) => void
    },
  ) => { dispose: () => void }
}

async function loadResizeModule(): Promise<ResizeModule> {
  const module = await import('../../src/renderer/src/reading-room-resize').catch(() => ({}))
  expect(typeof (module as Record<string, unknown>).beginReadingRoomResize).toBe('function')
  return module as ResizeModule
}

class FakePointerTarget {
  readonly listeners = new Map<string, Set<(event: PointerEvent) => void>>()
  captured: number | null = null

  setPointerCapture(pointerId: number): void {
    this.captured = pointerId
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.captured === pointerId
  }

  releasePointerCapture(pointerId: number): void {
    if (this.captured === pointerId) this.captured = null
  }

  addEventListener(type: string, listener: (event: PointerEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: PointerEvent) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string, pointerId: number, clientX: number): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ clientX, pointerId } as PointerEvent)
    }
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0)
  }
}

class FrameQueue {
  readonly callbacks = new Map<number, FrameRequestCallback>()
  next = 1

  request = (callback: FrameRequestCallback): number => {
    const handle = this.next
    this.next += 1
    this.callbacks.set(handle, callback)
    return handle
  }

  cancel = (handle: number): void => {
    this.callbacks.delete(handle)
  }

  flush(): void {
    const callbacks = [...this.callbacks.values()]
    this.callbacks.clear()
    for (const callback of callbacks) callback(0)
  }
}

test('Reading Room geometry has only the Room minimum and the draft minimum', async () => {
  const resize = await loadResizeModule()

  expect(resize.MIN_ROOM_WIDTH).toBe(280)
  expect(resize.MIN_EDITOR_WIDTH).toBe(360)
  expect(resize.ceilingForReadingRoom(5_000)).toBe(4_640)
  expect(resize.clampReadingRoomWidth(99, 2_000)).toBe(280)
  expect(resize.clampReadingRoomWidth(5_000, 2_000)).toBe(1_640)
})

test('pointer and keyboard widths are monotonic and mirrored on both Room sides', async () => {
  const resize = await loadResizeModule()
  const left = [90, 100, 110].map((clientX) =>
    resize.readingRoomWidthForPointer(448, 100, clientX, 'left', 2_000))
  const right = [90, 100, 110].map((clientX) =>
    resize.readingRoomWidthForPointer(448, 100, clientX, 'right', 2_000))

  expect(left).toEqual([438, 448, 458])
  expect(right).toEqual([458, 448, 438])
  expect(resize.readingRoomWidthForKey(448, 'ArrowRight', false, 'left', 2_000)).toBe(464)
  expect(resize.readingRoomWidthForKey(448, 'ArrowLeft', true, 'left', 2_000)).toBe(384)
  expect(resize.readingRoomWidthForKey(448, 'ArrowRight', false, 'right', 2_000)).toBe(432)
  expect(resize.readingRoomWidthForKey(448, 'ArrowLeft', true, 'right', 2_000)).toBe(512)
})

test('captured pointer moves coalesce to the latest position and persist exactly once on release', async () => {
  const resize = await loadResizeModule()
  const target = new FakePointerTarget()
  const frames = new FrameQueue()
  const widths: number[] = []
  const finished: number[] = []
  const resizing: boolean[] = []

  resize.beginReadingRoomResize(
    { clientX: 100, pointerId: 7 } as PointerEvent,
    target as unknown as HTMLElement,
    {
      side: 'left',
      span: 2_000,
      startWidth: 448,
      onWidth: (width) => widths.push(width),
      onFinish: (width) => finished.push(width),
      onResizingChange: (value) => resizing.push(value),
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
    },
  )

  expect(target.captured).toBe(7)
  expect(target.listenerCount()).toBe(4)
  target.dispatch('pointermove', 7, 112)
  target.dispatch('pointermove', 7, 148)
  expect(widths).toEqual([])
  expect(frames.callbacks.size).toBe(1)
  frames.flush()
  expect(widths).toEqual([496])

  target.dispatch('pointermove', 7, 164)
  target.dispatch('pointerup', 7, 164)
  target.dispatch('lostpointercapture', 7, 164)

  expect(widths).toEqual([496, 512])
  expect(finished).toEqual([512])
  expect(resizing).toEqual([true, false])
  expect(target.listenerCount()).toBe(0)
  expect(target.captured).toBeNull()
  expect(frames.callbacks.size).toBe(0)
})

test('pointerup, pointercancel, and lostpointercapture each end a drag without surviving listeners', async () => {
  const resize = await loadResizeModule()

  for (const terminator of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    const target = new FakePointerTarget()
    const frames = new FrameQueue()
    const finished: number[] = []
    resize.beginReadingRoomResize(
      { clientX: 100, pointerId: 9 } as PointerEvent,
      target as unknown as HTMLElement,
      {
        side: 'right',
        span: 2_000,
        startWidth: 448,
        onWidth: () => {},
        onFinish: (width) => finished.push(width),
        onResizingChange: () => {},
        requestFrame: frames.request,
        cancelFrame: frames.cancel,
      },
    )
    target.dispatch('pointermove', 9, 132)
    target.dispatch(terminator, 9, terminator === 'pointerup' ? 140 : 0)

    expect(finished).toEqual([terminator === 'pointerup' ? 408 : 416])
    expect(target.listenerCount()).toBe(0)
  }
})
