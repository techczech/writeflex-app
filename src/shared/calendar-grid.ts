/**
 * The Details card's calendar (0.26): pure date arithmetic on `YYYY-MM-DD` strings, no Date-with-time-zone traps.
 * Weeks start on Monday (the drawn calendar: MO to SU). A grid is always six weeks, so the popover keeps its height.
 */

export type CalendarDay = { iso: string; day: number; inMonth: boolean }

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

const daysIn = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate()

/** A real calendar date `YYYY-MM-DD` as [year, month, day]; null for anything else (month 13, 31 February, other shapes). */
export function parseIsoDate(value: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null
  return [year, month, day]
}

export const isIsoDate = (value: string): boolean => parseIsoDate(value) !== null

export function toIsoDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`
}

/** `iso` moved by whole days (negative goes back), through month and year ends. */
export function addDays(iso: string, days: number): string {
  const parts = parseIsoDate(iso)
  if (!parts) return iso
  const moved = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days))
  return toIsoDate(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate())
}

/** `iso` moved by whole months, keeping the day of the month or the last day the new month has. */
export function addMonths(iso: string, months: number): string {
  const parts = parseIsoDate(iso)
  if (!parts) return iso
  const index = parts[0] * 12 + (parts[1] - 1) + months
  const year = Math.floor(index / 12)
  const month = (index % 12 + 12) % 12 + 1
  return toIsoDate(year, month, Math.min(parts[2], daysIn(year, month)))
}

/** The six weeks (42 days, Monday first) that show the month of `iso`. */
export function monthGrid(iso: string): CalendarDay[][] {
  const parts = parseIsoDate(iso)
  if (!parts) return []
  const [year, month] = parts
  const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7
  const first = toIsoDate(year, month, 1)
  const weeks: CalendarDay[][] = []
  for (let week = 0; week < 6; week += 1) {
    const row: CalendarDay[] = []
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = addDays(first, week * 7 + weekday - firstWeekday)
      const day = parseIsoDate(date)!
      row.push({ iso: date, day: day[2], inMonth: day[0] === year && day[1] === month })
    }
    weeks.push(row)
  }
  return weeks
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "October 2026". */
export function monthTitle(iso: string): string {
  const parts = parseIsoDate(iso)
  return parts ? `${MONTHS[parts[1] - 1]} ${parts[0]}` : iso
}

/** Today in the writer's own time zone, as `YYYY-MM-DD`. */
export function todayIso(now: Date = new Date()): string {
  return toIsoDate(now.getFullYear(), now.getMonth() + 1, now.getDate())
}
