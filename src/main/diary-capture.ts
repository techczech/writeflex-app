import { randomUUID } from 'node:crypto'
import type { DiarySessionRecord } from './diary'

export const DIARY_IDLE_MS = 90_000
export const DIARY_CHECKPOINT_MS = 60_000

export type DiaryCaptureEvent =
  | { kind: 'none' }
  | { kind: 'checkpoint'; record: DiarySessionRecord }
  | { kind: 'split'; closed: DiarySessionRecord | null; started: DiarySessionRecord | null }

type ActiveSession = {
  id: string
  startedAt: number
  lastActivityAt: number
  lastCheckpointAt: number
  baselines: Map<string, number>
  current: Map<string, number>
  pieces: string[]
  activeMs: number
}

/** Pure activity accumulator. Persistence and Counted-Collection gating stay outside this class. */
export class DiaryCaptureTracker {
  #active: ActiveSession | null = null
  #primed = new Map<string, number>()

  prime(path: string, words: number): void {
    if (!this.#active) this.#primed.set(path, words)
  }

  begin(path: string, words: number, at = Date.now()): string {
    this.#active = this.#start(path, words, at, words)
    this.#primed.clear()
    return this.#active.id
  }

  current(): DiarySessionRecord | null {
    return this.#active ? this.#record(this.#active) : null
  }

  lastActivityAt(): number | null {
    return this.#active?.lastActivityAt ?? null
  }

  observe(path: string, words: number, at = Date.now(), beforeWords = words, options: { splitOnIdle?: boolean } = {}): DiaryCaptureEvent {
    if (this.#active && options.splitOnIdle !== false && at - this.#active.lastActivityAt >= DIARY_IDLE_MS) {
      const closed = this.#persistable(this.#active)
      this.#active = this.#start(path, words, at, beforeWords)
      const started = this.#persistable(this.#active)
      return closed || started ? { kind: 'split', closed, started } : { kind: 'none' }
    }
    if (!this.#active) {
      this.#active = this.#start(path, words, at, beforeWords)
      const record = this.#persistable(this.#active)
      return record ? { kind: 'checkpoint', record } : { kind: 'none' }
    }
    const active = this.#active
    const activityGap = Math.max(0, at - active.lastActivityAt)
    if (activityGap < DIARY_IDLE_MS) active.activeMs += activityGap
    if (!active.baselines.has(path)) active.baselines.set(path, beforeWords)
    active.current.set(path, words)
    if (!active.pieces.includes(path)) active.pieces.push(path)
    active.lastActivityAt = at
    if (at - active.lastCheckpointAt >= DIARY_CHECKPOINT_MS) {
      active.lastCheckpointAt = at
      const record = this.#persistable(active)
      return record ? { kind: 'checkpoint', record } : { kind: 'none' }
    }
    return { kind: 'none' }
  }

  close(): DiarySessionRecord | null {
    if (!this.#active) return null
    const record = this.#persistable(this.#active)
    this.#active = null
    this.#primed.clear()
    return record
  }

  reset(): void {
    this.#active = null
    this.#primed.clear()
  }

  #start(path: string, words: number, at: number, beforeWords: number): ActiveSession {
    const baseline = beforeWords
    return {
      id: randomUUID(),
      startedAt: at,
      lastActivityAt: at,
      lastCheckpointAt: at,
      baselines: new Map([[path, baseline]]),
      current: new Map([[path, words]]),
      pieces: [path],
      activeMs: 0,
    }
  }

  #record(active: ActiveSession): DiarySessionRecord {
    let netWords = 0
    for (const [path, baseline] of active.baselines) netWords += (active.current.get(path) ?? baseline) - baseline
    return {
      id: active.id,
      startedAt: active.startedAt,
      minutes: Math.max(1, Math.ceil(active.activeMs / 60_000)),
      netWords,
      pieces: [...active.pieces],
    }
  }

  #persistable(active: ActiveSession): DiarySessionRecord | null {
    const record = this.#record(active)
    return record.netWords > 0 ? record : null
  }
}
