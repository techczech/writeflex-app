import { Compartment, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { caretSentence, paragraphAt, type ParagraphRange } from './focus-modes'
import { segmentSentences, type SentenceRange } from './sentences'
import { typewriterScrollSupport } from './typewriter'
import type { WordRange } from './word-range'

type ReadAloudValue = {
  position: number | null
  word: WordRange | null
  deco: DecorationSet
}

const setReadAloudPosition = StateEffect.define<{ position: number | null; word: WordRange | null }>()
const paragraphLine = Decoration.line({ class: 'ra-paragraph' })
const sentenceMark = Decoration.mark({ class: 'ra-sentence' })
const wordMark = Decoration.mark({ class: 'ra-word' })

function rangesAt(
  state: EditorState,
  position: number | null,
): { sentence: SentenceRange | null; paragraph: ParagraphRange | null } {
  if (position === null) return { sentence: null, paragraph: null }
  const clamped = Math.max(0, Math.min(position, state.doc.length))
  const source = state.doc.toString()
  const paragraph = paragraphAt(source, clamped)
  if (!paragraph) return { sentence: null, paragraph: null }
  const sentences = segmentSentences(source.slice(paragraph.from, paragraph.to), paragraph.from)
  return { sentence: caretSentence(sentences, clamped), paragraph }
}

function decorationsAt(state: EditorState, position: number | null, word: WordRange | null): DecorationSet {
  const { sentence, paragraph } = rangesAt(state, position)
  if (!paragraph) return Decoration.none

  const ranges = []
  const firstLine = state.doc.lineAt(paragraph.from)
  const lastLine = state.doc.lineAt(paragraph.to)
  for (let lineNumber = firstLine.number; lineNumber <= lastLine.number; lineNumber++) {
    ranges.push(paragraphLine.range(state.doc.line(lineNumber).from))
  }
  if (sentence && sentence.to > sentence.from) {
    ranges.push(sentenceMark.range(sentence.from, sentence.to))
    // The spoken word sits inside the sentence wash; one outside it (or empty) is never drawn.
    if (word && word.to > word.from && word.from >= sentence.from && word.to <= sentence.to) {
      ranges.push(wordMark.range(word.from, word.to))
    }
  }
  return Decoration.set(ranges, true)
}

function readAloudValue(state: EditorState, position: number | null, word: WordRange | null = null): ReadAloudValue {
  const clamped = position === null ? null : Math.max(0, Math.min(position, state.doc.length))
  const keptWord = clamped === null ? null : word
  return { position: clamped, word: keptWord, deco: decorationsAt(state, clamped, keptWord) }
}

const readAloudField = StateField.define<ReadAloudValue>({
  create: (state) => readAloudValue(state, null),
  update(value, tr) {
    const pushed = tr.effects.find((effect) => effect.is(setReadAloudPosition))
    if (pushed) return readAloudValue(tr.state, pushed.value.position, pushed.value.word)
    if (!tr.docChanged || value.position === null) return value

    // No fresh boundary push: keep both wash levels pinned to their source text through the edit.
    // The next boundary rebuilds exact paragraph/sentence geometry from the newly projected source.
    return {
      position: Math.max(0, Math.min(tr.changes.mapPos(value.position, 1), tr.state.doc.length)),
      word: value.word
        ? { from: tr.changes.mapPos(value.word.from, 1), to: tr.changes.mapPos(value.word.to, -1) }
        : null,
      deco: value.deco.map(tr.changes),
    }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
})

/** Empty by default in setup.ts; the StateField inside owns the doc-wide spoken-position state. */
export const readAloudCompartment = new Compartment()

/**
 * Empty outside a reading session. While the voice runs, this reuses typewriter's scroll-past-end
 * support so either reading mode can place the final screenful at its promised centre/top anchor.
 */
export const readAloudScrollSupportCompartment = new Compartment()

/** Test/setup seam: the compartment's StateField extension. */
export const readAloudExtension: Extension = readAloudField

/**
 * Push the latest spoken source position into the live editor; null removes every mark. `word` is
 * the spoken word's source range when the voice reports word boundaries, otherwise null and only the
 * sentence is marked.
 */
export function setReadAloud(view: EditorView, position: number | null, word: WordRange | null = null): void {
  view.dispatch({ effects: setReadAloudPosition.of({ position, word }) })
}

/** Add or remove the shared typewriter vertical-room support for the voice-owned scroll session. */
export function setReadAloudScrollSupport(view: EditorView, active: boolean): void {
  view.dispatch({
    effects: readAloudScrollSupportCompartment.reconfigure(active ? typewriterScrollSupport : []),
  })
}

/** The paragraph and sentence currently driven by the voice's one source position. */
export function readAloudRanges(
  state: EditorState,
): { sentence: SentenceRange | null; paragraph: ParagraphRange | null } {
  const value = state.field(readAloudField, false)
  return value ? rangesAt(state, value.position) : { sentence: null, paragraph: null }
}

/** The spoken source position, or null when nothing is being read. Cheap: no document scan. */
export function readAloudPositionOf(state: EditorState): number | null {
  return state.field(readAloudField, false)?.position ?? null
}

/** Test seam: inspect the two-level wash without mounting a DOM-backed EditorView. */
export function readAloudDecorations(state: EditorState): DecorationSet {
  return state.field(readAloudField, false)?.deco ?? Decoration.none
}

type VerticalBounds = {
  top: number
  bottom: number
}

export type ReadAloudScrollMode = 'typewriter' | 'page'

/** Typewriter is the safe default: the reader's eye stays in one place rather than hunting. */
export function normaliseReadAloudScrollMode(value: unknown): ReadAloudScrollMode {
  return value === 'page' ? 'page' : 'typewriter'
}

/** The same breathing room the old nearest-edge follow used around the spoken position. */
export const READ_ALOUD_SCROLL_MARGIN_PX = 48

/**
 * Page mode waits until the voice reaches the bottom margin, then moves that position to the top.
 * A null position means CodeMirror has not rendered it in the current viewport, so a page turn is
 * also required. After the jump the position is near the top and this remains false for a screenful.
 */
export function shouldTurnReadAloudPage(
  position: VerticalBounds | null,
  viewport: VerticalBounds,
): boolean {
  return position === null || position.bottom >= viewport.bottom - READ_ALOUD_SCROLL_MARGIN_PX
}

type ReadAloudScrollClock = {
  setTimeout(callback: () => void, delay: number): number
  clearTimeout(handle: number): void
}

export type ReadAloudScrollGuard = {
  beginProgrammaticScroll(): void
  noteUserScrollIntent(): void
  shouldPauseForScroll(): boolean
  dispose(): void
}

// The editor uses instant scrolling, so 120 ms covers CodeMirror's deferred measure pass and the
// resulting scroll event without treating the app's own follow-scroll as manual input. A wheel,
// pointer or scrolling key clears the guard before its scroll event, even inside this interval.
const PROGRAMMATIC_SCROLL_SETTLE_MS = 120

export function createReadAloudScrollGuard(
  clock: ReadAloudScrollClock = {
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (handle) => window.clearTimeout(handle),
  },
): ReadAloudScrollGuard {
  let programmatic = false
  let settleTimer: number | null = null

  const clearProgrammaticScroll = (): void => {
    if (settleTimer !== null) clock.clearTimeout(settleTimer)
    settleTimer = null
    programmatic = false
  }

  const waitForScrollToSettle = (): void => {
    if (settleTimer !== null) clock.clearTimeout(settleTimer)
    settleTimer = clock.setTimeout(clearProgrammaticScroll, PROGRAMMATIC_SCROLL_SETTLE_MS)
  }

  return {
    beginProgrammaticScroll() {
      programmatic = true
      waitForScrollToSettle()
    },
    noteUserScrollIntent() {
      clearProgrammaticScroll()
    },
    shouldPauseForScroll() {
      if (!programmatic) return true
      waitForScrollToSettle()
      return false
    },
    dispose() {
      clearProgrammaticScroll()
    },
  }
}

/** Whether the spoken source position has no visible overlap with the editor's scroll viewport. */
export function isReadAloudPositionOutsideViewport(
  position: VerticalBounds | null,
  viewport: VerticalBounds,
): boolean {
  return position === null || position.bottom <= viewport.top || position.top >= viewport.bottom
}
