export type ExplicitSessionEndReason = 'manual' | 'duration' | 'idle'

export type ExplicitSessionState = {
  status: 'running' | 'completed' | 'ended'
  id: string
  startedAt: number
  lastActivityAt: number
  durationMs: number | null
  targetWords: number | null
  tick: boolean
  netWords: number
  endedAt?: number
  endReason?: ExplicitSessionEndReason
}

export type ExplicitSessionInstrument = {
  label: string
  fillPercent: number | null
  reached: boolean
}

function clock(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

export function explicitSessionInstrument(session: ExplicitSessionState, now = Date.now()): ExplicitSessionInstrument {
  const measuredElapsed = Math.max(0, (session.endedAt ?? now) - session.startedAt)
  const elapsed = session.status === 'completed' && session.durationMs !== null ? session.durationMs : measuredElapsed
  const signedWords = `${session.netWords >= 0 ? '+' : ''}${session.netWords.toLocaleString()} words`
  const timeReached = session.durationMs !== null && (session.status === 'completed' || elapsed >= session.durationMs)
  const wordsReached = session.targetWords !== null && session.netWords >= session.targetWords
  const reached = timeReached || wordsReached
  const progress = session.durationMs !== null
    ? elapsed / session.durationMs
    : session.targetWords !== null
      ? session.netWords / session.targetWords
      : null
  const fillPercent = progress === null ? null : Math.max(0, Math.min(100, Math.round(progress * 100)))
  const label = session.durationMs === null
    ? `${clock(elapsed)} · ${signedWords}`
    : `${clock(Math.max(0, session.durationMs - elapsed))} left · ${signedWords}`
  return { label, fillPercent, reached }
}
