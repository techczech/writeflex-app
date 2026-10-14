import {
  GUIDE_PROGRESS_KEY, parseGuideProgress, serialiseGuideProgress, withChapterFinished, withChapterOpened, withCommandRan, withStepDone, withTopicRead,
  type GuideProgress, type GuideStep,
} from '../shared/guide-progress'
import type { SettingsStore } from './settings'

/**
 * Where the Guide's progress is kept: ONE key in the settings store (`guide.progress`, a compact
 * JSON string), never in the example folder, so it survives the example's removal. Each event
 * reads the record, applies the pure change from `src/shared/guide-progress.ts`, and saves and
 * announces only when something changed. Any window's event counts: main is the one writer.
 */
export class GuideProgressStore {
  /** Set by `registerIpc`: pushes the new value of the key to every window. */
  onChange: (key: string) => void = () => {}

  constructor(private readonly settings: Pick<SettingsStore, 'get' | 'set'>) {}

  read(): GuideProgress {
    return parseGuideProgress(this.settings.get(GUIDE_PROGRESS_KEY))
  }

  #apply(change: (progress: GuideProgress) => GuideProgress): void {
    const before = this.read()
    const after = change(before)
    if (after === before) return
    // log:false — a tick is not "a change made in Settings", so it stays out of the changelog.
    this.settings.set(GUIDE_PROGRESS_KEY, serialiseGuideProgress(after), 'Guide progress', { log: false })
    this.onChange(GUIDE_PROGRESS_KEY)
  }

  commandRan(id: unknown): void { this.#apply((progress) => withCommandRan(progress, id)) }
  chapterOpened(chapter: unknown): void { this.#apply((progress) => withChapterOpened(progress, chapter)) }
  chapterFinished(chapter: unknown): void { this.#apply((progress) => withChapterFinished(progress, chapter, Date.now())) }
  topicRead(id: unknown): void { this.#apply((progress) => withTopicRead(progress, id)) }
  stepDone(step: GuideStep, detail?: string): void { this.#apply((progress) => withStepDone(progress, step, detail)) }
}
