import { expect, test } from 'bun:test'
import { createPlayer } from '../../src/renderer/src/editor/read-aloud-player'
import { fakeSpeechEngine } from '../../src/renderer/src/editor/speech-engine'

const OPTS = { announce: 'silent' as const, changes: [] }
const SOURCE = 'First sentence here. Second sentence here.\n\nSecond paragraph opens.'

test('a boundary event reports the matching SOURCE offset, not the spoken offset', () => {
  const engine = fakeSpeechEngine()
  const states: any[] = []
  const player = createPlayer(engine, (s) => states.push(s))
  player.start(SOURCE, 0, OPTS)
  engine.emitBoundary(engine.spoken[0].indexOf('Second'))
  expect(states.at(-1).sourceOffset).toBe(SOURCE.indexOf('Second sentence'))
})

test('rate nudges by exactly 0.1 and clamps at both ends', () => {
  const base = fakeSpeechEngine()
  const appliedRates: number[] = []
  const player = createPlayer({
    ...base,
    setRate(rate: number) {
      appliedRates.push(rate)
    },
  }, () => {})
  player.nudgeRate(0.1)
  player.nudgeRate(0.1)
  expect(player.state().rate).toBeCloseTo(1.2, 5)
  expect(appliedRates.slice(0, 2)).toEqual([1.1, 1.2])
  for (let i = 0; i < 50; i++) player.nudgeRate(0.1)
  expect(player.state().rate).toBe(2.5)
  for (let i = 0; i < 50; i++) player.nudgeRate(-0.1)
  expect(player.state().rate).toBe(0.5)
})

test('an exact rate change keeps the reading position and does not restart speech', () => {
  const base = fakeSpeechEngine()
  const appliedRates: number[] = []
  const player = createPlayer({
    ...base,
    setRate(rate: number) {
      appliedRates.push(rate)
    },
  }, () => {})
  player.start(SOURCE, 0, OPTS)
  base.emitBoundary(SOURCE.indexOf('Second sentence'))
  const positionBefore = player.state().sourceOffset
  const utterancesBefore = base.spoken.length
  const exactRatePlayer = player as typeof player & { setRate?: (rate: number) => void }

  expect(typeof exactRatePlayer.setRate).toBe('function')
  if (!exactRatePlayer.setRate) return
  exactRatePlayer.setRate(1.6)

  expect(player.state().rate).toBe(1.6)
  expect(player.state().sourceOffset).toBe(positionBefore)
  expect(base.spoken.length).toBe(utterancesBefore)
  expect(appliedRates).toEqual([1.6])
})

test('resume restarts from the caret sentence, not from where the voice stopped', () => {
  const engine = fakeSpeechEngine()
  const player = createPlayer(engine, () => {})
  player.start(SOURCE, 0, OPTS)
  engine.emitBoundary(0)
  player.pause()
  const caret = SOURCE.indexOf('Second sentence')
  const resumedAt = engine.spoken.length
  player.resume(SOURCE, caret, OPTS)
  expect(engine.spoken[resumedAt].startsWith('Second sentence here.')).toBe(true)
})

test('the next paragraph is queued so playback does not stall at a paragraph end', () => {
  const engine = fakeSpeechEngine()
  const player = createPlayer(engine, () => {})
  player.start(SOURCE, 0, OPTS)
  engine.emitEnd()
  expect(engine.spoken.at(-1)).toContain('Second paragraph opens.')
})

test('a level-one heading queues the following body paragraph before the heading ends', () => {
  const source = '# Heading one\n\nBody prose follows.'
  const engine = fakeSpeechEngine()
  const player = createPlayer(engine, () => {})

  player.start(source, source.indexOf('Heading'), { announce: 'announce', changes: [] })

  expect(engine.spoken).toEqual([
    'Heading, level one: Heading one.',
    'Body prose follows.',
  ])
  engine.emitEnd()
  engine.emitBoundary(0)
  expect(player.state().sourceOffset).toBe(source.indexOf('Body prose'))
})

test('a genuine synthesis failure stops playback instead of leaving speaking true', () => {
  const engine = fakeSpeechEngine()
  const player = createPlayer(engine, () => {})
  player.start(SOURCE, 0, OPTS)
  if ('emitError' in engine && typeof engine.emitError === 'function') {
    engine.emitError('synthesis-failed')
  }
  expect(player.state().speaking).toBe(false)
})

test('the interrupted error from a deliberate restart is not published as a playback failure', () => {
  const engine = fakeSpeechEngine()
  const states: any[] = []
  const player = createPlayer(engine, (state) => states.push(state))
  player.start(SOURCE, 0, OPTS)
  const restartStatesFrom = states.length

  player.resume(SOURCE, SOURCE.indexOf('Second sentence'), OPTS)

  expect(states.slice(restartStatesFrom).every((state) => state.speaking)).toBe(true)
  expect(player.state().speaking).toBe(true)
})

test('word boundaries publish the word range inside the source; punctuation stays outside', () => {
  const source = 'A schema is the shape of a situation we already know, and more.'
  const engine = fakeSpeechEngine()
  const states: any[] = []
  const player = createPlayer(engine, (s) => states.push(s))
  player.start(source, 0, OPTS)
  engine.emitBoundary(engine.spoken[0].indexOf('situation'), 'word')
  expect(states.at(-1).word).toEqual({ from: source.indexOf('situation'), to: source.indexOf('situation') + 9 })
  engine.emitBoundary(engine.spoken[0].indexOf('know'), 'word')
  expect(source.slice(states.at(-1).word.from, states.at(-1).word.to)).toBe('know')
})

test('a voice that sends no word boundaries never gets a word mark, only the sentence position', () => {
  const engine = fakeSpeechEngine()
  const states: any[] = []
  const player = createPlayer(engine, (s) => states.push(s))
  player.start(SOURCE, 0, OPTS)
  expect(states.every((s) => s.word === null)).toBe(true)
  engine.emitBoundary(engine.spoken[0].indexOf('Second'), 'sentence')
  expect(states.at(-1).sourceOffset).toBe(SOURCE.indexOf('Second sentence'))
  expect(states.at(-1).word).toBeNull()
})

test('a sentence boundary drops the previous word instead of leaving it behind', () => {
  const engine = fakeSpeechEngine()
  const player = createPlayer(engine, () => {})
  player.start(SOURCE, 0, OPTS)
  engine.emitBoundary(engine.spoken[0].indexOf('sentence'), 'word')
  expect(player.state().word).not.toBeNull()
  engine.emitBoundary(engine.spoken[0].indexOf('Second'), 'sentence')
  expect(player.state().word).toBeNull()
})

test('pausing keeps the word, stopping clears it', () => {
  const engine = fakeSpeechEngine()
  const player = createPlayer(engine, () => {})
  player.start(SOURCE, 0, OPTS)
  engine.emitBoundary(engine.spoken[0].indexOf('here'), 'word')
  const word = player.state().word
  expect(word).not.toBeNull()
  player.pause()
  expect(player.state().word).toEqual(word)
  player.continuePaused()
  expect(player.state().word).toEqual(word)
  player.stop()
  expect(player.state().word).toBeNull()
  expect(player.state().speaking).toBe(false)
})

test('a new paragraph starts with no word until the voice reports one', () => {
  const engine = fakeSpeechEngine()
  const player = createPlayer(engine, () => {})
  player.start(SOURCE, 0, OPTS)
  engine.emitBoundary(engine.spoken[0].indexOf('here'), 'word')
  engine.emitEnd()
  expect(player.state().sourceOffset).toBe(SOURCE.indexOf('Second paragraph'))
  expect(player.state().word).toBeNull()
})
