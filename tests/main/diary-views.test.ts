import { expect, test } from 'bun:test'
import { summariseDiary } from '../../src/shared/diary-glance'

test('cutting and zero-net days keep the streak; a gap breaks it, including across a month', () => {
  const days = [
    { date: '2026-10-30', words: 40, minutes: 10 },
    { date: '2026-10-31', words: -20, minutes: 20 },
    { date: '2026-11-01', words: 0, minutes: 30 },
  ]
  expect(summariseDiary(days, new Date(2026, 10, 2, 12))).toMatchObject({ todayWords: 0, streak: 3 })
  const result = summariseDiary([...days, { date: '2026-11-02', words: -5, minutes: 1 }], new Date(2026, 10, 2))
  expect(result.streak).toBe(4)
  expect(result.todayWords).toBe(-5)
  expect(result.days).toHaveLength(14)
  expect(result.days.at(-1)).toEqual({ date: '2026-11-02', written: true })
  expect(summariseDiary(days, new Date(2026, 10, 3)).streak).toBe(0)
})
