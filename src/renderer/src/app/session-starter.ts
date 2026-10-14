export const SESSION_PRESETS = [15, 30, 45, 60] as const

export type SessionStarterState = {
  minutes: string
  words: string
  tick: boolean
  replaceMinutes: boolean
}

export type SessionStarterRequest = {
  durationMinutes: number | null
  targetWords: number | null
  tick: boolean
}

export function createSessionStarterState(tick: boolean): SessionStarterState {
  return { minutes: '30', words: '', tick, replaceMinutes: true }
}

export function applyMinuteDigit(state: SessionStarterState, digit: string): SessionStarterState {
  if (!/^\d$/.test(digit)) return state
  const next = state.replaceMinutes ? digit : `${state.minutes}${digit}`
  return { ...state, minutes: next.slice(-3), replaceMinutes: false }
}

export function removeMinuteDigit(state: SessionStarterState): SessionStarterState {
  return { ...state, minutes: state.replaceMinutes ? '' : state.minutes.slice(0, -1), replaceMinutes: false }
}

export function selectMinutePreset(state: SessionStarterState, minutes: number): SessionStarterState {
  if (!(SESSION_PRESETS as readonly number[]).includes(minutes)) return state
  return { ...state, minutes: String(minutes), replaceMinutes: true }
}

export function setWordsTarget(state: SessionStarterState, value: string): SessionStarterState {
  const digits = value.replace(/\D/g, '')
  if (digits === '') return { ...state, words: '' }
  return { ...state, words: String(Math.min(10_000_000, Number.parseInt(digits, 10))) }
}

export function sessionStarterRequest(state: SessionStarterState): SessionStarterRequest {
  const minutes = Number.parseInt(state.minutes, 10)
  const words = Number.parseInt(state.words, 10)
  return {
    durationMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null,
    targetWords: Number.isFinite(words) && words > 0 ? words : null,
    tick: state.tick,
  }
}
