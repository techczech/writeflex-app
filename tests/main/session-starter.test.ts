import { expect, test } from 'bun:test'
import {
  applyMinuteDigit,
  createSessionStarterState,
  selectMinutePreset,
  sessionStarterRequest,
  setWordsTarget,
} from '../../src/renderer/src/app/session-starter'
import { explicitSessionInstrument } from '../../src/shared/explicit-session'

test('minute digits replace the default and then append directly', () => {
  let state = createSessionStarterState(true)
  expect(state).toMatchObject({ minutes: '30', words: '', tick: true })
  state = applyMinuteDigit(state, '1')
  state = applyMinuteDigit(state, '5')
  expect(state.minutes).toBe('15')
  expect(sessionStarterRequest(state)).toEqual({ durationMinutes: 15, targetWords: null, tick: true })
})

test('preset chips select their minutes and a later digit starts a fresh direct entry', () => {
  let state = selectMinutePreset(createSessionStarterState(false), 45)
  expect(state.minutes).toBe('45')
  state = applyMinuteDigit(state, '6')
  expect(state.minutes).toBe('6')
})

test('the optional words target accepts positive whole words and ignores presentation characters', () => {
  let state = setWordsTarget(createSessionStarterState(true), '1,250 words')
  expect(state.words).toBe('1250')
  expect(sessionStarterRequest(state)).toEqual({ durationMinutes: 30, targetWords: 1250, tick: true })
  state = setWordsTarget(state, '0')
  expect(sessionStarterRequest(state).targetWords).toBeNull()
})

test('the optional words target is bounded from zero through ten million', () => {
  expect(setWordsTarget(createSessionStarterState(false), '-12').words).toBe('12')
  expect(setWordsTarget(createSessionStarterState(false), '10000000').words).toBe('10000000')
  expect(setWordsTarget(createSessionStarterState(false), '999999999').words).toBe('10000000')
})

test('explicit instrument states count up, count down, and complete in one fill model', () => {
  const startedAt = 1_000_000
  expect(explicitSessionInstrument({
    status: 'running', id: 's1', startedAt, lastActivityAt: startedAt, durationMs: null,
    targetWords: null, tick: false, netWords: 612,
  }, startedAt + 23 * 60_000 + 41_000)).toMatchObject({ label: '23:41 · +612 words', fillPercent: null, reached: false })
  expect(explicitSessionInstrument({
    status: 'running', id: 's2', startedAt, lastActivityAt: startedAt, durationMs: 30 * 60_000,
    targetWords: null, tick: true, netWords: 438,
  }, startedAt + 17 * 60_000 + 41_000)).toMatchObject({ label: '12:19 left · +438 words', fillPercent: 59, reached: false })
  expect(explicitSessionInstrument({
    status: 'running', id: 's3', startedAt, lastActivityAt: startedAt, durationMs: null,
    targetWords: 500, tick: false, netWords: 500,
  }, startedAt + 1_000)).toMatchObject({ fillPercent: 100, reached: true })
  expect(explicitSessionInstrument({
    status: 'completed', id: 's4', startedAt, lastActivityAt: startedAt, durationMs: 60_000,
    targetWords: null, tick: true, netWords: 10, endedAt: startedAt + 500, endReason: 'duration',
  }, startedAt + 70_000)).toMatchObject({ label: '00:00 left · +10 words', fillPercent: 100, reached: true })
})
