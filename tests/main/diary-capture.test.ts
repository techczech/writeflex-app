import { expect, test } from 'bun:test'
import { DiaryCaptureTracker, DIARY_IDLE_MS, DIARY_CHECKPOINT_MS } from '../../src/main/diary-capture'

test('idle at 90 seconds closes the previous automatic session and starts a new one', () => {
  const tracker = new DiaryCaptureTracker()
  const start = new Date(2026, 7, 2, 9, 0).getTime()
  expect(tracker.observe('a.md', 10, start)).toEqual({ kind: 'none' })
  expect(tracker.observe('a.md', 20, start + 30_000)).toMatchObject({ kind: 'none' })
  const split = tracker.observe('a.md', 25, start + DIARY_IDLE_MS + 30_000)
  expect(split.kind).toBe('split')
  if (split.kind === 'split') {
    expect(split.closed?.netWords).toBe(10)
    expect(split.started).toBeNull()
  }
})

test('periodic persistence occurs no more than once a minute while accruing', () => {
  const tracker = new DiaryCaptureTracker()
  const start = new Date(2026, 7, 2, 9, 0).getTime()
  tracker.observe('a.md', 10, start)
  expect(tracker.observe('a.md', 11, start + DIARY_CHECKPOINT_MS - 1).kind).toBe('none')
  expect(tracker.observe('a.md', 12, start + DIARY_CHECKPOINT_MS).kind).toBe('checkpoint')
})

test('pieces touched and net words accrue across documents in one session', () => {
  const tracker = new DiaryCaptureTracker()
  const start = new Date(2026, 7, 2, 9, 0).getTime()
  tracker.observe('a.md', 10, start)
  tracker.observe('a.md', 15, start + 10_000)
  tracker.observe('b.md', 20, start + 20_000)
  const event = tracker.close(start + 30_000)
  expect(event?.pieces).toEqual(['a.md', 'b.md'])
  expect(event?.netWords).toBe(5)
})

test('each idle-split session baselines from the count immediately before its first edit', () => {
  const tracker = new DiaryCaptureTracker()
  const start = new Date(2026, 7, 2, 9, 0).getTime()
  tracker.prime('a.md', 1_000)
  tracker.observe('a.md', 1_200, start, 1_000)
  const second = tracker.observe('a.md', 1_250, start + DIARY_IDLE_MS + 1, 1_200)
  expect(second).toMatchObject({ kind: 'split', closed: { netWords: 200 } })
  const third = tracker.observe('a.md', 1_260, start + (DIARY_IDLE_MS + 1) * 2, 1_250)
  expect(third).toMatchObject({ kind: 'split', closed: { netWords: 50 } })
  expect(tracker.close()).toMatchObject({ netWords: 10 })
})

test('closing after idle or sleep records only the active span', () => {
  const tracker = new DiaryCaptureTracker()
  const start = new Date(2026, 7, 2, 9, 0).getTime()
  tracker.observe('a.md', 20, start, 10)
  for (let minute = 1; minute <= 10; minute += 1) {
    tracker.observe('a.md', 20 + minute, start + minute * 60_000, 19 + minute)
  }
  expect(tracker.close()).toMatchObject({ minutes: 10, netWords: 20 })
})

test('a newly touched file uses its pre-change count so a first paste is counted', () => {
  const tracker = new DiaryCaptureTracker()
  const start = new Date(2026, 7, 2, 9, 0).getTime()
  tracker.observe('a.md', 20, start, 10)
  tracker.observe('b.md', 150, start + 1_000, 100)
  expect(tracker.close()).toMatchObject({ netWords: 60, pieces: ['a.md', 'b.md'] })
})

test('a zero-word first observation does not request persistence', () => {
  const tracker = new DiaryCaptureTracker()
  expect(tracker.observe('a.md', 10, Date.now(), 10)).toEqual({ kind: 'none' })
  expect(tracker.close()).toBeNull()
})
