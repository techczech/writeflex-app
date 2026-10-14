import { expect, test, spyOn } from 'bun:test'
import { ambientDebouncer } from '../../src/renderer/src/hooks/useAmbientSnapshot'

test('three selection changes coalesce at 250ms; file switch sends immediately and cancels stale work', () => {
  let clock = 0
  let id = 0
  const tasks = new Map<number, { at: number; run: () => void }>()
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, ms: number) => {
    tasks.set(++id, { at: clock + ms, run }); return id
  }) as typeof setTimeout)
  const cancel = spyOn(globalThis, 'clearTimeout').mockImplementation(((key: number) => { tasks.delete(key) }) as typeof clearTimeout)
  const advance = (ms: number) => { clock += ms; for (const [key, task] of tasks) if (task.at <= clock) { tasks.delete(key); task.run() } }
  try {
    const sent: string[] = []
    let selection = 'one'
    const debounce = ambientDebouncer(() => sent.push(selection))
    debounce.update('workspace/a.md')
    expect(sent).toEqual(['one'])
    sent.length = 0
    debounce.update('workspace/a.md'); advance(70)
    selection = 'two'; debounce.update('workspace/a.md'); advance(70)
    selection = 'three'; debounce.update('workspace/a.md'); advance(249)
    expect(sent).toEqual([])
    advance(1); expect(sent).toEqual(['three'])
    debounce.update('workspace/a.md')
    selection = 'new file'; debounce.update('workspace/b.md')
    expect(sent).toEqual(['three', 'new file'])
    advance(300); expect(sent).toHaveLength(2)
    debounce.update('workspace/b.md'); debounce.dispose(); advance(300)
    expect(sent).toHaveLength(2)
  } finally { timer.mockRestore(); cancel.mockRestore() }
})
