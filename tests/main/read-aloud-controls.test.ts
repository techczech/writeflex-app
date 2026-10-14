import { expect, test } from 'bun:test'
import {
  pauseReadAloudForDocumentChange,
  runPauseResumeReadAloud,
} from '../../src/renderer/src/app/read-aloud-controls'
import { createPlayer } from '../../src/renderer/src/editor/read-aloud-player'
import { fakeSpeechEngine } from '../../src/renderer/src/editor/speech-engine'

const SOURCE = 'First sentence. Second sentence.'
const OPTIONS = { announce: 'silent' as const, changes: [] }

test('the widened command starts while idle, pauses while speaking and resumes while paused', () => {
  const base = fakeSpeechEngine()
  let pauseCalls = 0
  const engine = {
    ...base,
    pause() {
      pauseCalls++
      base.pause()
    },
  }
  const player = createPlayer(engine, () => {})
  const control = () =>
    runPauseResumeReadAloud({
      player,
      currentInput: () => ({ source: SOURCE, fromOffset: 0, options: OPTIONS }),
      start: () => player.start(SOURCE, 0, OPTIONS),
    })

  expect(control()).toBe('started')
  expect(player.state().speaking).toBe(true)

  expect(control()).toBe('paused')
  expect(player.state().paused).toBe(true)
  expect(pauseCalls).toBe(1)

  expect(control()).toBe('resumed')
  expect(player.state().paused).toBe(false)
})

test('a scroll-caused pause continues at the reading position instead of restarting from the caret', () => {
  const base = fakeSpeechEngine()
  let resumeCalls = 0
  const engine = {
    ...base,
    resume() {
      resumeCalls++
      base.resume()
    },
  }
  const player = createPlayer(engine, () => {})
  const control = (resumeFromPausedPosition = false) =>
    runPauseResumeReadAloud({
      player,
      currentInput: () => ({ source: SOURCE, fromOffset: SOURCE.indexOf('Second'), options: OPTIONS }),
      start: () => player.start(SOURCE, 0, OPTIONS),
      resumeFromPausedPosition,
    })

  expect(control()).toBe('started')
  const pausedOffset = player.state().sourceOffset
  expect(control()).toBe('paused')

  expect(control(true)).toBe('resumed')
  expect(resumeCalls).toBe(1)
  expect(player.state().paused).toBe(false)
  expect(player.state().sourceOffset).toBe(pausedOffset)
})

test('a document-changing transaction pauses speech and explicit resume still overrides it', () => {
  const player = createPlayer(fakeSpeechEngine(), () => {})
  player.start(SOURCE, 0, OPTIONS)

  expect(pauseReadAloudForDocumentChange(player)).toBe(true)
  expect(player.state().paused).toBe(true)

  player.resume(SOURCE, SOURCE.indexOf('Second'), OPTIONS)
  expect(player.state().paused).toBe(false)
  expect(player.state().speaking).toBe(true)
})
