import { expect, test } from 'bun:test'
import * as speechEngineModule from '../../src/renderer/src/editor/speech-engine'
import { fakeSpeechEngine, webSpeechEngine } from '../../src/renderer/src/editor/speech-engine'

type MockUtterance = {
  text: string
  rate: number
  voice: SpeechSynthesisVoice | null
  onboundary: ((event: { charIndex: number }) => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
}

function withMockWebSpeech(
  run: (context: { cancelCalls(): number; utterances: MockUtterance[] }) => void,
): void {
  const originalSynth = Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis')
  const originalUtterance = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisUtterance')
  const utterances: MockUtterance[] = []
  let cancels = 0

  class TestUtterance implements MockUtterance {
    rate = 1
    voice: SpeechSynthesisVoice | null = null
    onboundary: ((event: { charIndex: number }) => void) | null = null
    onend: (() => void) | null = null
    onerror: ((event: { error: string }) => void) | null = null

    constructor(readonly text: string) {}
  }

  Object.defineProperty(globalThis, 'speechSynthesis', {
    configurable: true,
    value: {
      cancel: () => { cancels++ },
      getVoices: () => [],
      pause: () => {},
      resume: () => {},
      speak: (utterance: MockUtterance) => { utterances.push(utterance) },
    },
  })
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
    configurable: true,
    value: TestUtterance,
  })

  try {
    run({ cancelCalls: () => cancels, utterances })
  } finally {
    if (originalSynth) Object.defineProperty(globalThis, 'speechSynthesis', originalSynth)
    else delete (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis
    if (originalUtterance) Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', originalUtterance)
    else delete (globalThis as { SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance }).SpeechSynthesisUtterance
  }
}

test('the fake records what it was asked to speak and replays scripted boundaries', () => {
  const engine = fakeSpeechEngine()
  const seen: number[] = []
  let ended = false
  engine.speak('The cat sat.', { voiceURI: null, rate: 1 }, {
    onBoundary: (i) => seen.push(i),
    onEnd: () => { ended = true },
    onError: () => {},
  })
  engine.emitBoundary(0)
  engine.emitBoundary(4)
  engine.emitEnd()
  expect(engine.spoken).toEqual(['The cat sat.'])
  expect(seen).toEqual([0, 4])
  expect(ended).toBe(true)
})

test('cancel stops further boundaries reaching the handler', () => {
  const engine = fakeSpeechEngine()
  const seen: number[] = []
  engine.speak('x', { voiceURI: null, rate: 1 }, {
    onBoundary: (i) => seen.push(i),
    onEnd: () => {},
    onError: () => {},
  })
  engine.cancel()
  engine.emitBoundary(0)
  expect(seen).toEqual([])
})

test('back-to-back speak calls queue and receive events in native order', () => {
  const engine = fakeSpeechEngine()
  const seen1: number[] = []
  let ended1 = false
  const seen2: number[] = []
  let ended2 = false

  engine.speak('First paragraph.', { voiceURI: null, rate: 1 }, {
    onBoundary: (i) => seen1.push(i),
    onEnd: () => { ended1 = true },
    onError: () => {},
  })
  engine.speak('Second paragraph.', { voiceURI: null, rate: 1 }, {
    onBoundary: (i) => seen2.push(i),
    onEnd: () => { ended2 = true },
    onError: () => {},
  })

  engine.emitBoundary(0)
  engine.emitBoundary(6)
  expect(seen1).toEqual([0, 6])
  expect(seen2).toEqual([])

  engine.emitEnd()
  engine.emitBoundary(0)
  engine.emitEnd()

  expect(engine.spoken).toEqual(['First paragraph.', 'Second paragraph.'])
  expect(seen1).toEqual([0, 6])
  expect(ended1).toBe(true)
  expect(seen2).toEqual([0])
  expect(ended2).toBe(true)
})

test('cancel interrupts only the current utterance and silently clears queued utterances', () => {
  const engine = fakeSpeechEngine()
  const firstErrors: string[] = []
  const secondErrors: string[] = []
  let firstEnded = false
  let secondEnded = false

  engine.speak('current', { voiceURI: null, rate: 1 }, {
    onBoundary: () => {},
    onEnd: () => { firstEnded = true },
    onError: (error) => firstErrors.push(error),
  })
  engine.speak('queued', { voiceURI: null, rate: 1 }, {
    onBoundary: () => {},
    onEnd: () => { secondEnded = true },
    onError: (error) => secondErrors.push(error),
  })
  engine.cancel()
  engine.emitEnd()

  expect(firstErrors).toEqual(['interrupted'])
  expect(secondErrors).toEqual([])
  expect(firstEnded).toBe(false)
  expect(secondEnded).toBe(false)
})

test('web speech queues without cancelling and forwards synthesis failures', () => {
  withMockWebSpeech(({ cancelCalls, utterances }) => {
    const errors: string[] = []
    const engine = webSpeechEngine()

    engine.speak('First.', { voiceURI: null, rate: 1 }, {
      onBoundary: () => {},
      onEnd: () => {},
      onError: (error) => errors.push(error),
    })
    engine.speak('Second.', { voiceURI: null, rate: 1 }, {
      onBoundary: () => {},
      onEnd: () => {},
      onError: (error) => errors.push(error),
    })

    utterances[0].onerror?.({ error: 'synthesis-failed' })
    expect(cancelCalls()).toBe(0)
    expect(utterances.map((utterance) => utterance.text)).toEqual(['First.', 'Second.'])
    expect(errors).toEqual(['synthesis-failed'])
  })
})

test('read-aloud voice grouping keeps Premium, Enhanced and default voices ahead of the hidden remainder', () => {
  const helpers = speechEngineModule as typeof speechEngineModule & {
    groupReadAloudVoices?: (voices: Array<{
      uri: string
      name: string
      lang: string
      isDefault: boolean
    }>) => {
      featured: Array<{ uri: string }>
      other: Array<{ uri: string }>
    }
    voiceBadges?: (voice: {
      uri: string
      name: string
      lang: string
      isDefault: boolean
    }) => string[]
  }
  expect(typeof helpers.groupReadAloudVoices).toBe('function')
  expect(typeof helpers.voiceBadges).toBe('function')
  if (!helpers.groupReadAloudVoices || !helpers.voiceBadges) return

  const voices = [
    { uri: 'alice', name: 'Alice', lang: 'en-GB', isDefault: false },
    { uri: 'samantha', name: 'Samantha', lang: 'en-US', isDefault: true },
    { uri: 'zoe', name: 'Zoe (Enhanced)', lang: 'en-GB', isDefault: false },
    { uri: 'ava', name: 'Ava (Premium)', lang: 'en-US', isDefault: false },
  ]
  const grouped = helpers.groupReadAloudVoices(voices)

  expect(grouped.featured.map((voice) => voice.uri)).toEqual(['ava', 'zoe', 'samantha'])
  expect(grouped.other.map((voice) => voice.uri)).toEqual(['alice'])
  expect(helpers.voiceBadges(voices[1])).toEqual(['Default'])
  expect(helpers.voiceBadges(voices[2])).toEqual(['Enhanced'])
  expect(helpers.voiceBadges({ ...voices[3], isDefault: true })).toEqual(['Premium', 'Default'])
})

test('a saved voice that is no longer installed resolves to the system default', () => {
  const helpers = speechEngineModule as typeof speechEngineModule & {
    resolveReadAloudVoice?: (
      voices: Array<{ uri: string; name: string; lang: string; isDefault: boolean }>,
      savedVoiceURI: string | null,
    ) => { voiceURI: string | null; name: string }
  }
  expect(typeof helpers.resolveReadAloudVoice).toBe('function')
  if (!helpers.resolveReadAloudVoice) return

  const voices = [
    { uri: 'samantha', name: 'Samantha', lang: 'en-US', isDefault: true },
    { uri: 'ava', name: 'Ava (Premium)', lang: 'en-US', isDefault: false },
  ]

  expect(helpers.resolveReadAloudVoice(voices, 'ava')).toEqual({
    voiceURI: 'ava',
    name: 'Ava (Premium)',
  })
  expect(helpers.resolveReadAloudVoice(voices, 'retired-voice')).toEqual({
    voiceURI: null,
    name: 'Samantha',
  })
})

test('changing the Web Speech rate updates the current and already-queued utterances in place', () => {
  withMockWebSpeech(({ cancelCalls, utterances }) => {
    const engine = webSpeechEngine()
    const handlers = {
      onBoundary: () => {},
      onEnd: () => {},
      onError: () => {},
    }
    engine.speak('Current sentence.', { voiceURI: null, rate: 1 }, handlers)
    engine.speak('Next paragraph.', { voiceURI: null, rate: 1 }, handlers)

    const rateEngine = engine as typeof engine & { setRate?: (rate: number) => void }
    expect(typeof rateEngine.setRate).toBe('function')
    if (!rateEngine.setRate) return
    rateEngine.setRate(1.6)

    expect(utterances.map((utterance) => utterance.rate)).toEqual([1.6, 1.6])
    expect(cancelCalls()).toBe(0)
  })
})
