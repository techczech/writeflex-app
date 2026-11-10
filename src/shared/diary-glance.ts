export type DiaryDay = { date: string; words: number; minutes: number }
export type DiaryGlance = { designated: boolean; counted: boolean; todayWords: number; streak: number; days: Array<{ date: string; written: boolean }>; sessionLine: string }
export function calendarDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function summariseDiary(days: DiaryDay[], now = new Date()) {
  const byDate = new Map(days.map(day => [day.date, day]))
  const dateAt = (offset: number) => calendarDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset))
  const written = (date: string) => byDate.has(date) && (byDate.get(date)!.minutes > 0 || byDate.get(date)!.words !== 0)
  let offset = written(dateAt(0)) ? 0 : -1
  let streak = 0
  while (written(dateAt(offset--))) streak++
  return { todayWords: byDate.get(dateAt(0))?.words ?? 0, streak,
    days: Array.from({ length: 14 }, (_, index) => ({ date: dateAt(index - 13), written: written(dateAt(index - 13)) })) }
}
