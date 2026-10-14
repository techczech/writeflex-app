// What the person has tried in the Guide (ADR-0043, ticket 07). Pure data in, pure data out: main
// stores one compact record in the settings store (key `guide.progress`, a JSON string, because
// settings values are primitives), and the renderer reads it. The record lives in the settings
// file, never in the example folder, so it survives the example's removal.
//
// Events in: "command ran" (a registry command id), "chapter opened", "chapter finished", "topic read"
// (ticket 08: opening a How it works or Features topic) and the three first steps. Every event returns the same object when it changes nothing, so a caller
// can tell whether to save and broadcast. Chapter rows and counts are derived elsewhere
// (`src/renderer/src/commands/guide-chapters.ts`) from the registry; this record holds only ids.
import { TASK_GROUPS, type TaskGroup } from '../renderer/src/commands/command-task-groups'
import { isTopicId } from './guide-topics'

export const GUIDE_PROGRESS_KEY = 'guide.progress'

export type GuideStep = 'folder' | 'file' | 'example'

export type GuideProgress = {
  /** Registry command ids that have run at least once, in the order they first ran. */
  ran: string[]
  /** Chapters (task group names) opened at least once. */
  opened: string[]
  /** Chapter name to the time (epoch ms) its last command was first run. */
  finished: Record<string, number>
  /** The first steps: the folder's and file's names, and that the example was opened. */
  steps: { folder?: string; file?: string; example?: true }
  /** Topic ids (`how.3`, `feature.1`) opened at least once: the topic lists' Read. */
  read: string[]
}

const MAX_ID = 100
const MAX_RAN = 1000

export const emptyGuideProgress = (): GuideProgress => ({ ran: [], opened: [], finished: {}, steps: {}, read: [] })

const isChapter = (value: unknown): value is TaskGroup => typeof value === 'string' && (TASK_GROUPS as readonly string[]).includes(value)

/** Read the stored string. Anything unreadable is an empty record: progress is convenience state. */
export function parseGuideProgress(raw: unknown): GuideProgress {
  if (typeof raw !== 'string') return emptyGuideProgress()
  let data: unknown
  try { data = JSON.parse(raw) } catch { return emptyGuideProgress() }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return emptyGuideProgress()
  const { ran, opened, finished, steps, read } = data as Record<string, unknown>
  const out = emptyGuideProgress()
  if (Array.isArray(ran)) out.ran = [...new Set(ran.filter((id): id is string => typeof id === 'string' && id !== '' && id.length <= MAX_ID))].slice(0, MAX_RAN)
  if (Array.isArray(opened)) out.opened = [...new Set(opened.filter(isChapter))]
  if (Array.isArray(read)) out.read = [...new Set(read.filter(isTopicId))]
  if (finished && typeof finished === 'object' && !Array.isArray(finished)) {
    for (const [chapter, at] of Object.entries(finished)) if (isChapter(chapter) && typeof at === 'number' && Number.isFinite(at)) out.finished[chapter] = at
  }
  if (steps && typeof steps === 'object' && !Array.isArray(steps)) {
    const { folder, file, example } = steps as Record<string, unknown>
    if (typeof folder === 'string' && folder !== '') out.steps.folder = folder.slice(0, 200)
    if (typeof file === 'string' && file !== '') out.steps.file = file.slice(0, 200)
    if (example === true) out.steps.example = true
  }
  return out
}

export const serialiseGuideProgress = (progress: GuideProgress): string => JSON.stringify(progress)

/** Event: a registry command ran, by any route, in any window. */
export function withCommandRan(progress: GuideProgress, id: unknown): GuideProgress {
  if (typeof id !== 'string' || id === '' || id.length > MAX_ID) return progress
  if (progress.ran.includes(id) || progress.ran.length >= MAX_RAN) return progress
  return { ...progress, ran: [...progress.ran, id] }
}

/** Event: a chapter was opened (chosen in the Guide, or its lesson file was opened). */
export function withChapterOpened(progress: GuideProgress, chapter: unknown): GuideProgress {
  if (!isChapter(chapter) || progress.opened.includes(chapter)) return progress
  return { ...progress, opened: [...progress.opened, chapter] }
}

/** Event: a topic was opened, so it reads "Read". Unknown ids change nothing. */
export function withTopicRead(progress: GuideProgress, topic: unknown): GuideProgress {
  if (!isTopicId(topic) || progress.read.includes(topic)) return progress
  return { ...progress, read: [...progress.read, topic] }
}

/** Event: every command of the chapter has been tried. The first date stays. */
export function withChapterFinished(progress: GuideProgress, chapter: unknown, at: number): GuideProgress {
  if (!isChapter(chapter) || progress.finished[chapter] !== undefined || !Number.isFinite(at)) return progress
  return { ...progress, finished: { ...progress.finished, [chapter]: at } }
}

/** Event: one of the three first steps was done. A step ticks once; the first detail stays. */
export function withStepDone(progress: GuideProgress, step: GuideStep, detail?: string): GuideProgress {
  if (step === 'example') return progress.steps.example ? progress : { ...progress, steps: { ...progress.steps, example: true } }
  if (step !== 'folder' && step !== 'file') return progress
  if (progress.steps[step] !== undefined || typeof detail !== 'string' || detail === '') return progress
  return { ...progress, steps: { ...progress.steps, [step]: detail.slice(0, 200) } }
}

/** What a chapter row says about itself (the drawing's four histories). */
export type ChapterHistory =
  | { kind: 'not-opened' }
  | { kind: 'opened' }
  | { kind: 'tried'; tried: number; total: number }
  | { kind: 'finished'; at: number }

/**
 * The history of one chapter. `tried` and `total` count rows (a merged row counts once). Finished
 * is kept once earned, even if the build later adds a command. Opened with nothing tried reads
 * "Opened"; anything tried reads "N of M tried"; nothing at all reads "Not opened".
 */
export function chapterHistory(progress: GuideProgress, chapter: string, tried: number, total: number): ChapterHistory {
  const at = progress.finished[chapter]
  if (at !== undefined) return { kind: 'finished', at }
  if (tried > 0) return { kind: 'tried', tried, total }
  return progress.opened.includes(chapter) ? { kind: 'opened' } : { kind: 'not-opened' }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "6 Oct": the day and the short month, as drawn. */
export const guideDate = (at: number): string => {
  const date = new Date(at)
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`
}

/** The drawn strings of a chapter's history. */
export function chapterHistoryText(history: ChapterHistory): string {
  switch (history.kind) {
    case 'not-opened': return 'Not opened'
    case 'opened': return 'Opened'
    case 'tried': return `${history.tried} of ${history.total} tried`
    case 'finished': return `Finished ${guideDate(history.at)}`
  }
}
