import { expect, test } from 'bun:test'
import { summariseDiary } from '../../src/shared/diary-glance'
import { addDays, addMonths, isIsoDate, monthGrid, monthTitle, parseIsoDate, todayIso } from '../../src/shared/calendar-grid'

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

// The Details card's calendar (0.26): pure date arithmetic on YYYY-MM-DD, Monday first, six weeks a month.

test('only real calendar dates parse', () => {
  expect(parseIsoDate('2026-10-14')).toEqual([2026, 10, 14])
  expect(parseIsoDate('2028-02-29')).toEqual([2028, 2, 29])
  for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-10-32', '26-10-14', '2026-1-4', '14 Oct 2026', '']) expect(isIsoDate(bad)).toBe(false)
})

test('days and months move through month and year ends', () => {
  expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
  expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
  expect(addDays('2026-10-14', 7)).toBe('2026-10-21')
  expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
  expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
  expect(addMonths('2026-01-15', -1)).toBe('2025-12-15')
  expect(addMonths('2026-10-14', -13)).toBe('2025-09-14')
})

test('a month is six Monday-first weeks with the days around it marked out', () => {
  const grid = monthGrid('2026-10-14')
  expect(grid).toHaveLength(6)
  expect(grid.every((week) => week.length === 7)).toBe(true)
  // 1 October 2026 is a Thursday: the first row starts on Monday 28 September.
  expect(grid[0][0]).toEqual({ iso: '2026-09-28', day: 28, inMonth: false })
  expect(grid[0][3]).toEqual({ iso: '2026-10-01', day: 1, inMonth: true })
  expect(grid.flat().filter((day) => day.inMonth)).toHaveLength(31)
  expect(grid[5][6].iso).toBe('2026-11-08')
  expect(monthTitle('2026-10-14')).toBe('October 2026')
  expect(monthGrid('nope')).toEqual([])
})

test('today is the local calendar day', () => {
  expect(todayIso(new Date(2026, 9, 19, 23, 59))).toBe('2026-10-19')
})
