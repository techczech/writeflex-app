import { caretSentence, paragraphAt, type ParagraphRange } from './focus-modes'
import { segmentSentences, type SentenceRange } from './sentences'
import type { SpeechEngine } from './speech-engine'
import { wordRangeAt, type WordRange } from './word-range'
import {
  projectSpeakable,
  sourceOffsetAt,
  type PendingChange,
  type Speakable,
  type SpeakableOptions,
} from './speakable'

export type PlayerState = {
  speaking: boolean
  paused: boolean
  sourceOffset: number | null
  /** The word being spoken, in source offsets. null when the voice sends no word boundaries. */
  word: WordRange | null
  rate: number
}

export type Player = {
  start(source: string, fromOffset: number, opts: SpeakableOptions): void
  pause(): void
  continuePaused(): void
  resume(source: string, caretOffset: number, opts: SpeakableOptions): void
  stop(): void
  setRate(rate: number): void
  nudgeRate(delta: number): void
  skipSentence(direction: 1 | -1): void
  skipParagraph(direction: 1 | -1): void
  state(): PlayerState
}

type PreparedParagraph = {
  range: ParagraphRange
  speakable: Speakable
}

type ActiveParagraph = PreparedParagraph & {
  source: string
  opts: SpeakableOptions
  spokenFrom: number
  cancelledDeliberately: boolean
}

const MIN_RATE = 0.5
const MAX_RATE = 2.5
const RATE_STEP = 0.1

export const READ_ALOUD_RATES: readonly number[] = Array.from(
  { length: Math.round((MAX_RATE - MIN_RATE) / RATE_STEP) + 1 },
  (_, index) => Math.round((MIN_RATE + index * RATE_STEP) * 10) / 10,
)

export function normaliseReadAloudRate(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return 1
  return Math.max(MIN_RATE, Math.min(MAX_RATE, Math.round(numeric * 10) / 10))
}

function localChanges(changes: PendingChange[] | undefined, range: ParagraphRange): PendingChange[] {
  if (!changes) return []
  return changes
    .filter((change) => change.from <= range.to && change.to >= range.from)
    .map((change) => ({
      ...change,
      from: Math.max(0, change.from - range.from),
      to: Math.min(range.to - range.from, change.to - range.from),
    }))
}

function prepareParagraph(source: string, range: ParagraphRange, opts: SpeakableOptions): PreparedParagraph {
  return {
    range,
    speakable: projectSpeakable(source.slice(range.from, range.to), {
      ...opts,
      changes: localChanges(opts.changes, range),
    }, range.from),
  }
}

function adjacentParagraph(source: string, range: ParagraphRange, direction: 1 | -1): ParagraphRange | null {
  if (direction === 1) {
    for (let pos = range.to + 1; pos < source.length; pos++) {
      if (/\s/.test(source[pos])) continue
      return paragraphAt(source, pos)
    }
    return null
  }

  for (let pos = range.from - 1; pos >= 0; pos--) {
    if (/\s/.test(source[pos])) continue
    return paragraphAt(source, pos)
  }
  return null
}

function spokenOffsetAt(speakable: Speakable, sourceOffset: number): number {
  for (const piece of speakable.pieces) {
    if (piece.sourceFrom === piece.sourceTo) {
      const projected = speakable.text.slice(piece.spokenFrom, piece.spokenTo)
      if (piece.sourceFrom >= sourceOffset && !/^\s+$/.test(projected)) return piece.spokenFrom
      continue
    }
    if (sourceOffset <= piece.sourceFrom) return piece.spokenFrom
    if (sourceOffset < piece.sourceTo) return piece.spokenFrom + sourceOffset - piece.sourceFrom
  }
  return speakable.text.length
}

function sentencesIn(source: string, range: ParagraphRange): SentenceRange[] {
  return segmentSentences(source.slice(range.from, range.to), range.from)
}

function sentenceAt(source: string, range: ParagraphRange, sourceOffset: number): SentenceRange | null {
  return caretSentence(sentencesIn(source, range), sourceOffset)
}

function firstSourceOffsetAtOrAfter(speakable: Speakable, spokenIndex: number): number | null {
  for (let index = spokenIndex; index < speakable.text.length; index++) {
    const mapped = sourceOffsetAt(speakable, index)
    if (mapped !== null) return mapped
  }
  return null
}

export function createPlayer(engine: SpeechEngine, onState: (state: PlayerState) => void): Player {
  let currentState: PlayerState = {
    speaking: false,
    paused: false,
    sourceOffset: null,
    word: null,
    rate: 1,
  }
  let active: ActiveParagraph | null = null
  let queued: ActiveParagraph | null = null

  const publish = (): void => {
    onState({ ...currentState })
  }

  const finish = (): void => {
    active = null
    queued = null
    currentState = {
      ...currentState,
      speaking: false,
      paused: false,
      sourceOffset: null,
      word: null,
    }
    publish()
  }

  const preparePlayback = (
    source: string,
    opts: SpeakableOptions,
    prepared: PreparedParagraph,
    fromOffset: number,
  ): ActiveParagraph => {
    const sentence = sentenceAt(source, prepared.range, fromOffset)
    const sentenceFrom = sentence?.from ?? prepared.range.from
    return {
      ...prepared,
      source,
      opts,
      spokenFrom: spokenOffsetAt(prepared.speakable, sentenceFrom),
      cancelledDeliberately: false,
    }
  }

  const publishPlayback = (playback: ActiveParagraph): void => {
    currentState = {
      ...currentState,
      speaking: true,
      paused: false,
      sourceOffset: firstSourceOffsetAtOrAfter(playback.speakable, playback.spokenFrom),
      // A new paragraph or restart: no word is known until the voice reports one.
      word: null,
    }
    publish()
  }

  const enqueue = (playback: ActiveParagraph): void => {
    engine.speak(
      playback.speakable.text.slice(playback.spokenFrom),
      { voiceURI: null, rate: currentState.rate },
      {
        onBoundary(charIndex, name) {
          if (active !== playback) return
          const mapped = sourceOffsetAt(playback.speakable, playback.spokenFrom + charIndex)
          // Only a 'word' boundary marks a word; nothing is estimated for voices that send none.
          // Any other boundary, or a spoken index with no source text, drops the old word.
          const word = name === 'word' && mapped !== null ? wordRangeAt(playback.source, mapped) : null
          currentState = {
            ...currentState,
            sourceOffset: mapped !== null ? mapped : currentState.sourceOffset,
            word,
          }
          publish()
        },
        onEnd() {
          if (active !== playback) return
          if (!queued) {
            finish()
            return
          }
          active = queued
          queued = null
          publishPlayback(active)
          queueFollowing(active)
        },
        onError(error) {
          if (
            playback.cancelledDeliberately &&
            (error === 'interrupted' || error === 'canceled')
          ) {
            return
          }
          if (active !== playback) return
          playback.cancelledDeliberately = true
          if (queued) queued.cancelledDeliberately = true
          engine.cancel()
          finish()
        },
      },
    )
  }

  const queueFollowing = (playback: ActiveParagraph): void => {
    const nextRange = adjacentParagraph(playback.source, playback.range, 1)
    if (!nextRange) return
    queued = preparePlayback(
      playback.source,
      playback.opts,
      prepareParagraph(playback.source, nextRange, playback.opts),
      nextRange.from,
    )
    enqueue(queued)
  }

  const playFrom = (source: string, fromOffset: number, opts: SpeakableOptions): void => {
    if (active) active.cancelledDeliberately = true
    if (queued) queued.cancelledDeliberately = true
    engine.cancel()
    active = null
    queued = null
    const range = paragraphAt(source, Math.max(0, Math.min(source.length, fromOffset)))
    if (!range) {
      finish()
      return
    }
    active = preparePlayback(source, opts, prepareParagraph(source, range, opts), fromOffset)
    publishPlayback(active)
    enqueue(active)
    queueFollowing(active)
  }

  const jumpToSentence = (direction: 1 | -1): void => {
    if (!active) return
    const offset = currentState.sourceOffset ?? active.range.from
    const sentences = sentencesIn(active.source, active.range)
    const current = caretSentence(sentences, offset)
    const index = current ? sentences.findIndex((sentence) => sentence.from === current.from) : -1
    const target = index >= 0 ? sentences[index + direction] : null
    if (target) {
      playFrom(active.source, target.from, active.opts)
      return
    }

    const range = adjacentParagraph(active.source, active.range, direction)
    if (!range) return
    const adjacentSentences = sentencesIn(active.source, range)
    const adjacent = direction === 1 ? adjacentSentences[0] : adjacentSentences.at(-1)
    if (adjacent) playFrom(active.source, adjacent.from, active.opts)
  }

  const applyRate = (rate: number): void => {
    const next = normaliseReadAloudRate(rate)
    if (next === currentState.rate) return
    currentState = { ...currentState, rate: next }
    engine.setRate(next)
    publish()
  }

  return {
    start(source, fromOffset, opts) {
      playFrom(source, fromOffset, opts)
    },

    pause() {
      if (!currentState.speaking || currentState.paused) return
      engine.pause()
      currentState = { ...currentState, paused: true }
      publish()
    },

    continuePaused() {
      if (!currentState.speaking || !currentState.paused) return
      engine.resume()
      currentState = { ...currentState, paused: false }
      publish()
    },

    resume(source, caretOffset, opts) {
      playFrom(source, caretOffset, opts)
    },

    stop() {
      if (active) active.cancelledDeliberately = true
      if (queued) queued.cancelledDeliberately = true
      engine.cancel()
      finish()
    },

    setRate(rate) {
      applyRate(rate)
    },

    nudgeRate(delta) {
      if (delta === 0) return
      applyRate(currentState.rate + Math.sign(delta) * RATE_STEP)
    },

    skipSentence(direction) {
      jumpToSentence(direction)
    },

    skipParagraph(direction) {
      if (!active) return
      const range = adjacentParagraph(active.source, active.range, direction)
      if (range) playFrom(active.source, range.from, active.opts)
    },

    state() {
      return { ...currentState }
    },
  }
}
