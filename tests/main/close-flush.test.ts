// A closing window's flush (src/renderer/src/app/close-flush.ts): "no write failed" is not "everything
// is on disk". Typing during a write leaves the document unsaved, so the flush repeats until nothing is.
import { describe, expect, it } from 'bun:test'
import { CLOSE_FLUSH_MAX_PASSES, flushUntilClean } from '../../src/renderer/src/app/close-flush'

/** A buffer and a disk, with a save that reads the buffer when it starts and lands when it ends. */
function fakeEditor(initial: Record<string, string>) {
  const buffer = new Map(Object.entries(initial))
  const disk = new Map<string, string>()
  const saves: string[] = []
  let duringSave: ((path: string, nth: number) => void) | null = null
  let failing: string | null = null
  return {
    buffer, disk, saves,
    typeDuringSave: (run: (path: string, nth: number) => void) => { duringSave = run },
    failOn: (path: string) => { failing = path },
    ports: {
      unsaved: () => [...buffer.keys()].filter((path) => disk.get(path) !== buffer.get(path)),
      save: async (path: string) => {
        const text = buffer.get(path)!
        saves.push(path)
        await Promise.resolve()
        duringSave?.(path, saves.length)
        if (failing === path) return false
        disk.set(path, text)
        return true
      },
    },
  }
}

describe('flushUntilClean', () => {
  it('writes every unsaved document once when nothing changes meanwhile', async () => {
    const e = fakeEditor({ 'a.md': 'A', 'b.md': 'B' })
    expect(await flushUntilClean(e.ports)).toEqual({ flushed: ['a.md', 'b.md'], failed: 0, clean: true })
    expect(e.saves).toEqual(['a.md', 'b.md'])
  })

  it('with nothing unsaved it writes nothing and is clean', async () => {
    const e = fakeEditor({})
    expect(await flushUntilClean(e.ports)).toEqual({ flushed: [], failed: 0, clean: true })
  })

  it('text typed during a write is written by a further pass: the later sentence is on disk', async () => {
    const e = fakeEditor({ 'a.md': 'first sentence.' })
    e.typeDuringSave((path, nth) => { if (nth === 1) e.buffer.set(path, 'first sentence. A later sentence.') })
    const result = await flushUntilClean(e.ports)
    expect(result).toEqual({ flushed: ['a.md'], failed: 0, clean: true })
    expect(e.saves).toEqual(['a.md', 'a.md'])
    expect(e.disk.get('a.md')).toBe('first sentence. A later sentence.')
  })

  it('typing through every pass: it stops at the bound and says the documents are not all saved', async () => {
    const e = fakeEditor({ 'a.md': 'x' })
    e.typeDuringSave((path, nth) => { e.buffer.set(path, `x${'.'.repeat(nth)}`) })
    const result = await flushUntilClean(e.ports)
    expect(result.clean).toBe(false)
    expect(result.failed).toBe(0)
    expect(e.saves).toHaveLength(CLOSE_FLUSH_MAX_PASSES)
  })

  it('a failed write stops the flush at once and is never clean', async () => {
    const e = fakeEditor({ 'a.md': 'A', 'b.md': 'B' })
    e.failOn('a.md')
    const result = await flushUntilClean(e.ports)
    expect(result).toEqual({ flushed: ['a.md', 'b.md'], failed: 1, clean: false })
    expect(e.saves).toEqual(['a.md', 'b.md']) // the pass finishes (b.md is written); no second pass
  })
})
