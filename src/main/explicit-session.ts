import { DiaryCaptureTracker, type DiaryCaptureEvent } from './diary-capture'
import type { DiarySessionRecord } from './diary'
import type { ExplicitSessionEndReason, ExplicitSessionState } from '../shared/explicit-session'
import { DIARY_IDLE_MS } from './diary-capture'

export type ExplicitSessionOptions = {
  durationMinutes: number | null
  targetWords: number | null
  tick: boolean
}

export function recorderOwner(explicitActive: boolean, automaticEligible: boolean): 'explicit' | 'automatic' | 'none' {
  if (explicitActive) return 'explicit'
  return automaticEligible ? 'automatic' : 'none'
}

export function shouldIdleCloseExplicitSession(session: ExplicitSessionState, at = Date.now()): boolean {
  return session.status === 'running'
    && session.durationMs === null
    && at - session.lastActivityAt >= DIARY_IDLE_MS
}

export class ExplicitSessionRecorder {
  #capture = new DiaryCaptureTracker()
  #session: ExplicitSessionState | null = null
  #event: DiaryCaptureEvent = { kind: 'none' }

  get active(): boolean {
    return this.#session?.status === 'running'
  }

  start(path: string, words: number, options: ExplicitSessionOptions, at = Date.now()): ExplicitSessionState {
    const id = this.#capture.begin(path, words, at)
    this.#session = {
      status: 'running',
      id,
      startedAt: at,
      lastActivityAt: at,
      durationMs: options.durationMinutes === null ? null : options.durationMinutes * 60_000,
      targetWords: options.targetWords,
      tick: options.tick,
      netWords: 0,
    }
    return { ...this.#session }
  }

  observe(path: string, words: number, at = Date.now(), beforeWords = words): ExplicitSessionState {
    if (!this.#session || this.#session.status !== 'running') throw new Error('No explicit session is running.')
    this.#event = this.#capture.observe(path, words, at, beforeWords, { splitOnIdle: this.#session.durationMs === null })
    const record = this.#capture.current()
    this.#session = {
      ...this.#session,
      lastActivityAt: this.#capture.lastActivityAt() ?? this.#session.lastActivityAt,
      netWords: record?.netWords ?? 0,
    }
    return { ...this.#session }
  }

  state(): ExplicitSessionState | null {
    return this.#session ? { ...this.#session } : null
  }

  adjustTarget(targetWords: number | null): ExplicitSessionState {
    if (!this.#session) throw new Error('No explicit session is running.')
    if (this.#session.status !== 'running') return { ...this.#session }
    this.#session = { ...this.#session, targetWords }
    return { ...this.#session }
  }

  takePersistenceRecords(): DiarySessionRecord[] {
    const event = this.#event
    this.#event = { kind: 'none' }
    if (event.kind === 'checkpoint') return [event.record]
    return []
  }

  close(reason: ExplicitSessionEndReason, at = Date.now()): { session: ExplicitSessionState; record: DiarySessionRecord | null } | null {
    if (!this.#session || this.#session.status !== 'running') return null
    const record = this.#capture.close()
    this.#event = { kind: 'none' }
    const completed = reason === 'duration'
    this.#session = {
      ...this.#session,
      status: completed ? 'completed' : 'ended',
      netWords: record?.netWords ?? this.#session.netWords,
      endedAt: at,
      endReason: reason,
    }
    return { session: { ...this.#session }, record }
  }
}
