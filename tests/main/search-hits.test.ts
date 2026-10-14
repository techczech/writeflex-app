import { test, expect } from 'bun:test'
import { createSequencer } from '../../src/renderer/src/search-hits'

test('sequencer: only the latest begun request is current', () => {
  const sequencer = createSequencer()
  const first = sequencer.begin()
  const second = sequencer.begin()
  expect(sequencer.isCurrent(first)).toBe(false)
  expect(sequencer.isCurrent(second)).toBe(true)
})

test('sequencer drops a slow earlier response that resolves after a fast later one', async () => {
  // Simulates the SearchPanel race: search "abc" (slow), then "xyz" (fast). The panel keeps
  // whichever response passes the isCurrent gate — the "abc" response arrives last but must lose.
  const sequencer = createSequencer()
  let shown: { query: string; matches: string[] } | null = null

  const run = async (query: string, matches: string[], delayMs: number): Promise<void> => {
    const seq = sequencer.begin()
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (!sequencer.isCurrent(seq)) return
    shown = { query, matches }
  }

  const slow = run('abc', ['stale-abc-hit'], 30)
  const fast = run('xyz', ['fresh-xyz-hit'], 5)
  await Promise.all([slow, fast])

  expect(shown).toEqual({ query: 'xyz', matches: ['fresh-xyz-hit'] })
})
