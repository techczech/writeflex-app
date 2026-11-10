import { Workspace } from './workspace'
import { parseFrontmatter } from './frontmatter'
import { summariseDiary, type DiaryDay } from '../shared/diary-glance'

/** Read only the designated diary; no capture, index creation or metadata writes. */
export async function readDiaryGlance(root: string, now = new Date()) {
  const ws = new Workspace(root)
  const days: DiaryDay[] = []
  for (const file of await ws.listFiles()) {
    if (file.directory !== '' || !/^\d{4}-\d{2}-\d{2}\.md$/.test(file.name)) continue
    const fields = parseFrontmatter((await ws.readFile(file.path)).content)?.extra
    if (!fields || fields.words_written === undefined || fields.mins_spent === undefined) continue
    const words = Number(fields.words_written), minutes = Number(fields.mins_spent)
    if (!Number.isFinite(words) || !Number.isFinite(minutes)) continue
    days.push({ date: file.name.slice(0, -3), words, minutes })
  }
  return summariseDiary(days, now)
}
