import { expect, test } from 'bun:test'
import { ExplicitSessionRecorder, recorderOwner, shouldIdleCloseExplicitSession } from '../../src/main/explicit-session'
import { DIARY_IDLE_MS } from '../../src/main/diary-capture'

test('an explicit session owns the recorder even in a Counted Collection', () => {
  expect(recorderOwner(true, true)).toBe('explicit')
  expect(recorderOwner(true, false)).toBe('explicit')
  expect(recorderOwner(false, true)).toBe('automatic')
  expect(recorderOwner(false, false)).toBe('none')
})

test('duration elapse closes with active-span minutes rather than wall-clock duration', () => {
  const start = new Date(2026, 7, 2, 9, 0).getTime()
  const recorder = new ExplicitSessionRecorder()
  recorder.start('draft.md', 100, { durationMinutes: 5, targetWords: null, tick: true }, start)
  recorder.observe('draft.md', 110, start + 60_000, 100)
  recorder.observe('draft.md', 120, start + 2 * 60_000 + 1_000, 110)
  const closed = recorder.close('duration', start + 5 * 60_000)
  expect(closed?.record).toMatchObject({ minutes: 3, netWords: 20, pieces: ['draft.md'] })
  expect(closed?.session).toMatchObject({ status: 'completed', endReason: 'duration', endedAt: start + 5 * 60_000 })
})

test('a words target reaches without ending the explicit session', () => {
  const start = Date.now()
  const recorder = new ExplicitSessionRecorder()
  recorder.start('draft.md', 100, { durationMinutes: null, targetWords: 25, tick: false }, start)
  const state = recorder.observe('draft.md', 125, start + 30_000, 100)
  expect(state).toMatchObject({ status: 'running', netWords: 25, targetWords: 25 })
  expect(recorder.active).toBe(true)
  expect(recorder.adjustTarget(50)).toMatchObject({ targetWords: 50, status: 'running' })
})

test('idle closes the explicit owner and makes automatic capture eligible again', () => {
  const start = Date.now()
  const recorder = new ExplicitSessionRecorder()
  recorder.start('draft.md', 100, { durationMinutes: null, targetWords: null, tick: false }, start)
  recorder.observe('draft.md', 110, start + 1_000, 100)
  expect(recorderOwner(recorder.active, true)).toBe('explicit')
  recorder.close('idle', start + 90_000)
  expect(recorderOwner(recorder.active, true)).toBe('automatic')
})

test('a timed session survives a pause three times the idle threshold and keeps active-span minutes', () => {
  const start = new Date(2026, 7, 2, 9, 0).getTime()
  const recorder = new ExplicitSessionRecorder()
  recorder.start('draft.md', 100, { durationMinutes: 10, targetWords: null, tick: false }, start)
  recorder.observe('draft.md', 110, start + 60_000, 100)
  const afterPause = recorder.observe('draft.md', 120, start + 60_000 + DIARY_IDLE_MS * 3, 110)

  expect(afterPause).toMatchObject({ status: 'running', netWords: 20 })
  expect(shouldIdleCloseExplicitSession(afterPause, afterPause.lastActivityAt + DIARY_IDLE_MS * 3)).toBe(false)
  expect(recorder.takePersistenceRecords()).toEqual([
    expect.objectContaining({ id: afterPause.id, minutes: 1, netWords: 20 }),
  ])
  expect(recorder.close('duration', start + 10 * 60_000)?.record).toMatchObject({ minutes: 1, netWords: 20 })
})

test('an untimed explicit session remains eligible for idle close', () => {
  const start = Date.now()
  const recorder = new ExplicitSessionRecorder()
  const session = recorder.start('draft.md', 10, { durationMinutes: null, targetWords: null, tick: false }, start)
  expect(shouldIdleCloseExplicitSession(session, start + DIARY_IDLE_MS - 1)).toBe(false)
  expect(shouldIdleCloseExplicitSession(session, start + DIARY_IDLE_MS)).toBe(true)
})

test('adjusting an ended recorder is a no-op', () => {
  const recorder = new ExplicitSessionRecorder()
  recorder.start('draft.md', 10, { durationMinutes: null, targetWords: 100, tick: false })
  const ended = recorder.close('manual')!.session
  expect(recorder.adjustTarget(200)).toEqual(ended)
})
