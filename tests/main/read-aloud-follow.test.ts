import { expect, test } from 'bun:test'
import {
  createReadAloudScrollGuard,
  isReadAloudPositionOutsideViewport,
  normaliseReadAloudScrollMode,
  shouldTurnReadAloudPage,
} from '../../src/renderer/src/editor/read-aloud'
import { createPlayer } from '../../src/renderer/src/editor/read-aloud-player'
import { fakeSpeechEngine } from '../../src/renderer/src/editor/speech-engine'

function fakeClock(): {
  clock: {
    setTimeout(callback: () => void, delay: number): number
    clearTimeout(handle: number): void
  }
  advance(milliseconds: number): void
} {
  let now = 0
  let nextHandle = 1
  const pending = new Map<number, { at: number; callback: () => void }>()
  return {
    clock: {
      setTimeout(callback, delay) {
        const handle = nextHandle++
        pending.set(handle, { at: now + delay, callback })
        return handle
      },
      clearTimeout(handle) {
        pending.delete(handle)
      },
    },
    advance(milliseconds) {
      now += milliseconds
      for (const [handle, task] of [...pending].sort((left, right) => left[1].at - right[1].at)) {
        if (task.at > now) continue
        pending.delete(handle)
        task.callback()
      }
    },
  }
}

test('the reading position is outside only when it has left the viewport', () => {
  const viewport = { top: 100, bottom: 500 }

  expect(isReadAloudPositionOutsideViewport({ top: 120, bottom: 140 }, viewport)).toBe(false)
  expect(isReadAloudPositionOutsideViewport({ top: 90, bottom: 110 }, viewport)).toBe(false)
  expect(isReadAloudPositionOutsideViewport({ top: 490, bottom: 510 }, viewport)).toBe(false)
  expect(isReadAloudPositionOutsideViewport({ top: 60, bottom: 80 }, viewport)).toBe(true)
  expect(isReadAloudPositionOutsideViewport({ top: 520, bottom: 540 }, viewport)).toBe(true)
  expect(isReadAloudPositionOutsideViewport({ top: 80, bottom: 100 }, viewport)).toBe(true)
  expect(isReadAloudPositionOutsideViewport({ top: 500, bottom: 520 }, viewport)).toBe(true)
  expect(isReadAloudPositionOutsideViewport(null, viewport)).toBe(true)
})

test('reading scroll defaults to Typewriter and accepts only the two declared modes', () => {
  expect(normaliseReadAloudScrollMode(null)).toBe('typewriter')
  expect(normaliseReadAloudScrollMode('typewriter')).toBe('typewriter')
  expect(normaliseReadAloudScrollMode('page')).toBe('page')
  expect(normaliseReadAloudScrollMode('continuous')).toBe('typewriter')
})

test('Page mode turns once the spoken position reaches the viewport bottom margin', () => {
  const viewport = { top: 100, bottom: 500 }

  expect(shouldTurnReadAloudPage({ top: 120, bottom: 140 }, viewport)).toBe(false)
  expect(shouldTurnReadAloudPage({ top: 300, bottom: 320 }, viewport)).toBe(false)
  expect(shouldTurnReadAloudPage({ top: 440, bottom: 451 }, viewport)).toBe(false)
  expect(shouldTurnReadAloudPage({ top: 441, bottom: 452 }, viewport)).toBe(true)
  expect(shouldTurnReadAloudPage({ top: 520, bottom: 540 }, viewport)).toBe(true)
  expect(shouldTurnReadAloudPage(null, viewport)).toBe(true)
})

test('reading continues when following the voice scrolls beyond the viewport', () => {
  const source = Array.from(
    { length: 12 },
    (_, index) => `Sentence ${index + 1} carries the reading further down the document.`,
  ).join(' ')
  const engine = fakeSpeechEngine()
  const player = createPlayer(engine, () => {})
  const timer = fakeClock()
  const guard = createReadAloudScrollGuard(timer.clock)
  let visibleThrough = source.indexOf('Sentence 4')
  let followScrolls = 0

  player.start(source, 0, { announce: 'silent', changes: [] })
  for (let sentence = 2; sentence <= 12; sentence++) {
    engine.emitBoundary(source.indexOf(`Sentence ${sentence}`))
    const position = player.state().sourceOffset
    if (position === null || position < visibleThrough) continue

    followScrolls++
    guard.beginProgrammaticScroll()
    timer.advance(32)
    if (guard.shouldPauseForScroll()) player.pause()
    visibleThrough = position + 80
  }

  expect(followScrolls).toBeGreaterThan(1)
  expect(player.state().speaking).toBe(true)
  expect(player.state().paused).toBe(false)
  guard.dispose()
})

test('user scroll intent still makes the next scroll manual', () => {
  const timer = fakeClock()
  const guard = createReadAloudScrollGuard(timer.clock)
  guard.beginProgrammaticScroll()
  guard.noteUserScrollIntent()

  expect(guard.shouldPauseForScroll()).toBe(true)
  guard.dispose()
})
