import { expect, test, spyOn } from 'bun:test'
import { snapshotScheduler } from '../../src/renderer/src/hooks/useEditorSnapshot'

test('typing is debounced at 150ms, but a change of the editor\'s file recomputes at once', () => {
  let clock = 0
  let id = 0
  const tasks = new Map<number, { at: number; run: () => void }>()
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, ms: number) => {
    tasks.set(++id, { at: clock + ms, run }); return id
  }) as typeof setTimeout)
  const cancel = spyOn(globalThis, 'clearTimeout').mockImplementation(((key: number) => { tasks.delete(key) }) as typeof clearTimeout)
  const advance = (ms: number) => { clock += ms; for (const [key, task] of tasks) if (task.at <= clock) { tasks.delete(key); task.run() } }
  try {
    let path: string | null = 'a.md'
    let reads = 0
    const scheduler = snapshotScheduler(() => path, () => { reads++ })
    scheduler.schedule()
    expect(reads).toBe(1) // first read is immediate
    scheduler.schedule(); advance(100); scheduler.schedule(); advance(149)
    expect(reads).toBe(1) // typing waits
    advance(1)
    expect(reads).toBe(2)
    scheduler.schedule() // a pending typing tick …
    path = 'b.md' // … then the editor switches file: no waiting
    scheduler.schedule()
    expect(reads).toBe(3)
    advance(300)
    expect(reads).toBe(3) // the superseded timer was cancelled
    scheduler.dispose()
  } finally { timer.mockRestore(); cancel.mockRestore() }
})
