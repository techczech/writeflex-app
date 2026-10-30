type Clock = { now: () => number; after: (ms: number, callback: () => void) => () => void }
const clock: Clock = { now: Date.now, after: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer) } }

/** A transient notice's remaining visible time; hiding it never changes the underlying Undo step. */
export function createNoticeTimer(expire: () => void, time: Clock = clock) {
  let cancel: (() => void) | null = null
  let remaining = 0, started = 0, paused = false
  const clear = (): void => { cancel?.(); cancel = null; remaining = 0; paused = false }
  const arm = (): void => {
    started = time.now()
    cancel = time.after(remaining, () => { clear(); expire() })
  }
  return {
    clear,
    start(hovered = false): void { clear(); remaining = 8000; paused = hovered; if (!paused) arm() },
    pause(): void { if (paused || !cancel) return; remaining = Math.max(0, remaining - (time.now() - started)); cancel(); cancel = null; paused = true },
    resume(): void { if (!paused) return; paused = false; arm() },
  }
}
