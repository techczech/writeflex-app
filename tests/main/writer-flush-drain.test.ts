import { describe, expect, test } from 'bun:test'
import { createWriterFlushQueue } from '../../src/renderer/src/app/writer-mode'

/**
 * Vaults 06 review round 2: a tracked review edit made just before the window closes waits 700 ms for
 * its debounce; the close must record it before it lets the window go. The queue is writer-mode's
 * debounce and per-path serialisation, with the drain the close awaits (App.tsx's close handler).
 */
function fakeTimers() {
  const live = new Set<{ run: () => void }>()
  return {
    setTimer: (run: () => void) => { const timer = { run }; live.add(timer); return timer },
    clearTimer: (handle: unknown) => { live.delete(handle as { run: () => void }) },
    fire: () => { for (const timer of [...live]) { live.delete(timer); timer.run() } },
    get armed() { return live.size },
  }
}

function harness(options: { slowMs?: number; failing?: string[] } = {}) {
  const timers = fakeTimers()
  const recorded: string[] = []
  const started: string[] = []
  const queue = createWriterFlushQueue({
    flush: async (path) => {
      started.push(path)
      if (options.slowMs) await new Promise((resolve) => setTimeout(resolve, options.slowMs))
      if (options.failing?.includes(path)) throw new Error('ledger refused')
      recorded.push(path)
      return [path]
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  return { queue, timers, recorded, started }
}

describe('the writer-review flush drain', () => {
  test('an edit still inside its debounce is recorded by the drain, and the timer is cancelled', async () => {
    const { queue, timers, recorded } = harness()
    queue.schedule('a.md')
    expect(queue.idle()).toBe(false)
    await queue.drain()
    expect(recorded).toEqual(['a.md'])
    expect(timers.armed).toBe(0)
    expect(queue.idle()).toBe(true)
    timers.fire() // nothing left for a late timer to do
    expect(recorded).toEqual(['a.md'])
  })

  test('the drain waits for a flush already running (the debounce fired just before the close)', async () => {
    const { queue, timers, recorded } = harness({ slowMs: 30 })
    queue.schedule('a.md')
    timers.fire()
    expect(recorded).toEqual([])
    await queue.drain()
    expect(recorded).toEqual(['a.md'])
  })

  test('every path still owed is recorded, not only the last one edited', async () => {
    const { queue, recorded } = harness()
    queue.schedule('a.md')
    queue.schedule('b.md') // restarts the one debounce timer for b.md
    await queue.drain()
    expect(recorded.sort()).toEqual(['a.md', 'b.md'])
  })

  test('flushes for one path stay serialised', async () => {
    const { queue, started, recorded } = harness({ slowMs: 10 })
    const first = queue.enqueue('a.md')
    const second = queue.enqueue('a.md')
    await new Promise((resolve) => setTimeout(resolve, 2))
    expect(started).toEqual(['a.md']) // the second waits for the first
    await first
    await second
    expect(recorded).toEqual(['a.md', 'a.md'])
  })

  test('a ledger failure does not make the drain reject (the close is not trapped by it), but it is reported and stays owed', async () => {
    const { queue, started } = harness({ failing: ['a.md'] })
    queue.schedule('a.md')
    await expect(queue.drain()).resolves.toEqual({ failed: ['a.md'] })
    expect(started).toEqual(['a.md']) // tried once in this drain
    expect(queue.idle()).toBe(false)
    // The next drain tries it again.
    await expect(queue.drain()).resolves.toEqual({ failed: ['a.md'] })
    expect(started).toEqual(['a.md', 'a.md'])
  })

  test('a failure from a flush the drain did not start (the debounce fired first) is reported too', async () => {
    const { queue, timers } = harness({ slowMs: 10, failing: ['a.md'] })
    queue.schedule('a.md')
    timers.fire()
    expect(await queue.drain()).toEqual({ failed: ['a.md'] })
  })

  test('round 3 (S3): an edit scheduled while the drain waits is recorded before it returns', async () => {
    const timers = fakeTimers()
    const recorded: string[] = []
    let releaseA: () => void = () => {}
    const queue = createWriterFlushQueue({
      flush: async (path) => {
        if (path === 'a.md') await new Promise<void>((resolve) => { releaseA = resolve })
        recorded.push(path)
        return [path]
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    queue.schedule('a.md')
    const draining = queue.drain()
    await new Promise((resolve) => setTimeout(resolve, 0))
    queue.schedule('b.md') // B edited and saved while A's ledger write is slow; its debounce is armed
    releaseA() // A finishes before B's debounce fires
    expect(await draining).toEqual({ failed: [] })
    expect(recorded).toEqual(['a.md', 'b.md'])
    expect(timers.armed).toBe(0)
    expect(queue.idle()).toBe(true)
  })

  test('cancel stops the timer but the path stays owed for the drain', async () => {
    const { queue, timers, recorded } = harness()
    queue.schedule('a.md')
    queue.cancel()
    expect(timers.armed).toBe(0)
    expect(queue.idle()).toBe(false)
    await queue.drain()
    expect(recorded).toEqual(['a.md'])
  })
})
