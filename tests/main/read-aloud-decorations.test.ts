import { expect, test } from 'bun:test'
import { EditorState, type TransactionSpec } from '@codemirror/state'
import { EditorView, type DecorationSet } from '@codemirror/view'
import { effectiveFocusMode, focusExtension } from '../../src/renderer/src/editor/focus-modes'
import {
  readAloudCompartment,
  readAloudDecorations,
  readAloudExtension,
  readAloudRanges,
  setReadAloud,
} from '../../src/renderer/src/editor/read-aloud'
import { projectSpeakable, sourceOffsetAt } from '../../src/renderer/src/editor/speakable'

test('segment-marking modes are suppressed while the voice speaks', () => {
  expect(effectiveFocusMode('sentence', true)).toBe('')
  expect(effectiveFocusMode('segment', true)).toBe('')
  expect(effectiveFocusMode('breakup', true)).toBe('')
})

test('anchored reading combines untouched', () => {
  expect(effectiveFocusMode('anchored', true)).toBe('anchored')
})

test('fade combines and survives, re-anchored by the caller', () => {
  expect(effectiveFocusMode('fade', true)).toBe('fade')
})

test('nothing is suppressed when the voice is not speaking', () => {
  for (const mode of ['', 'fade', 'sentence', 'segment', 'breakup', 'anchored'] as const) {
    expect(effectiveFocusMode(mode, false)).toBe(mode)
  }
})

function stateHarness(doc: string): {
  view: EditorView
  state: () => EditorState
  update: (spec: TransactionSpec) => void
} {
  let state = EditorState.create({
    doc,
    extensions: [readAloudCompartment.of(readAloudExtension)],
  })
  const view = {
    get state() {
      return state
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state
    },
  } as unknown as EditorView
  return {
    view,
    state: () => state,
    update: (spec) => {
      state = state.update(spec).state
    },
  }
}

function decorationClasses(state: EditorState): string[] {
  const classes: string[] = []
  readAloudDecorations(state).between(0, state.doc.length, (_from, _to, value) => {
    const spec = value.spec as { class?: string; attributes?: { class?: string } }
    classes.push(spec.class ?? spec.attributes?.class ?? '')
  })
  return classes
}

test('one spoken position drives the current typed-line block wash and sentence wash', () => {
  const source = 'First sentence. Second sentence.\nStill the same paragraph.\n\nAnother paragraph.'
  const harness = stateHarness(source)
  setReadAloud(harness.view, source.indexOf('Second'))

  expect(readAloudRanges(harness.state())).toEqual({
    sentence: { from: source.indexOf('Second'), to: source.indexOf('\nStill') },
    paragraph: { from: 0, to: source.indexOf('\nStill') },
  })
  expect(decorationClasses(harness.state()).filter((name) => name === 'ra-paragraph')).toHaveLength(1)
  expect(decorationClasses(harness.state()).filter((name) => name === 'ra-sentence')).toHaveLength(1)
})

test('the read-aloud StateField maps its position and decorations through document changes', () => {
  const source = 'First sentence. Second sentence.'
  const harness = stateHarness(source)
  setReadAloud(harness.view, source.indexOf('Second'))
  harness.update({ changes: { from: 0, insert: 'New opening. ' } })

  const shifted = source.indexOf('Second') + 'New opening. '.length
  expect(readAloudRanges(harness.state()).sentence?.from).toBe(shifted)
  expect(decorationClasses(harness.state())).toContain('ra-sentence')
})

test('clearing read-aloud removes both wash levels', () => {
  const harness = stateHarness('First sentence. Second sentence.')
  setReadAloud(harness.view, 2)
  setReadAloud(harness.view, null)

  expect(readAloudRanges(harness.state())).toEqual({ sentence: null, paragraph: null })
  expect(readAloudDecorations(harness.state()).size).toBe(0)
})

test('the highlighted sentence equals its true source range after stripped inline Markdown', () => {
  const source = [
    'Opening context.',
    '',
    'This *first sentence* cites [[target|a wikilink]] and [a normal link](https://example.com). The true second sentence is here.',
  ].join('\n')
  const paragraphFrom = source.indexOf('This')
  const sentenceFrom = source.indexOf('The true second')
  const speakable = projectSpeakable(
    source.slice(paragraphFrom),
    { announce: 'silent' },
    paragraphFrom,
  )
  const spokenSentenceFrom = speakable.text.indexOf('The true second')
  const mapped = sourceOffsetAt(speakable, spokenSentenceFrom)
  const harness = stateHarness(source)
  setReadAloud(harness.view, mapped)

  let spokenCursor = 0
  for (const piece of speakable.pieces) {
    expect(piece.spokenFrom).toBe(spokenCursor)
    if (piece.sourceFrom !== piece.sourceTo) {
      expect(piece.spokenTo - piece.spokenFrom).toBe(piece.sourceTo - piece.sourceFrom)
    } else {
      for (let index = piece.spokenFrom; index < piece.spokenTo; index++) {
        expect(sourceOffsetAt(speakable, index)).toBeNull()
      }
    }
    spokenCursor = piece.spokenTo
  }
  expect(spokenCursor).toBe(speakable.text.length)
  expect(mapped).toBe(sentenceFrom)
  expect(readAloudRanges(harness.state()).sentence).toEqual({
    from: sentenceFrom,
    to: source.length,
  })
})

test('the sentence decoration keeps its true range while Anchored Reading is active', () => {
  const source = 'Opening sentence. Anchored reading must not move either wash boundary.'
  const sentenceFrom = source.indexOf('Anchored')
  let state = EditorState.create({
    doc: source,
    extensions: [
      focusExtension('anchored', 'contrast'),
      readAloudCompartment.of(readAloudExtension),
    ],
  })
  const view = {
    get state() {
      return state
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state
    },
  } as unknown as EditorView

  setReadAloud(view, sentenceFrom)

  const rangesWithClass = (
    layers: readonly (DecorationSet | ((view: EditorView) => DecorationSet))[],
    className: string,
  ): Array<{ from: number; to: number }> => {
    const ranges: Array<{ from: number; to: number }> = []
    for (const layer of layers) {
      if (typeof layer === 'function') continue
      layer.between(0, state.doc.length, (from, to, value) => {
        const spec = value.spec as { class?: string; attributes?: { class?: string } }
        if ((spec.class ?? spec.attributes?.class) === className) ranges.push({ from, to })
      })
    }
    return ranges
  }

  expect(rangesWithClass(state.facet(EditorView.decorations), 'wf-lead').length).toBeGreaterThan(0)
  expect(rangesWithClass([readAloudDecorations(state)], 'ra-sentence')).toEqual([
    { from: sentenceFrom, to: source.length },
  ])
})

test('the spoken word is marked inside the sentence mark, punctuation outside it', () => {
  const source = 'First sentence. A schema is the shape of a situation we already know, and more.'
  const harness = stateHarness(source)
  const word = { from: source.indexOf('know'), to: source.indexOf('know') + 4 }
  setReadAloud(harness.view, word.from, word)

  const marks: Array<{ from: number; to: number; cls: string }> = []
  readAloudDecorations(harness.state()).between(0, source.length, (from, to, value) => {
    marks.push({ from, to, cls: (value.spec as { class?: string }).class ?? '' })
  })
  const sentence = marks.find((mark) => mark.cls === 'ra-sentence')!
  const spoken = marks.find((mark) => mark.cls === 'ra-word')!
  expect(source.slice(spoken.from, spoken.to)).toBe('know')
  expect(spoken.from).toBeGreaterThanOrEqual(sentence.from)
  expect(spoken.to).toBeLessThanOrEqual(sentence.to)
})

test('without a word only the sentence is marked', () => {
  const source = 'First sentence. Second sentence.'
  const harness = stateHarness(source)
  setReadAloud(harness.view, source.indexOf('Second'), null)
  expect(decorationClasses(harness.state())).toContain('ra-sentence')
  expect(decorationClasses(harness.state())).not.toContain('ra-word')
})

test('a word outside the current sentence is not drawn', () => {
  const source = 'First sentence. Second sentence.'
  const harness = stateHarness(source)
  setReadAloud(harness.view, source.indexOf('Second'), { from: 0, to: 5 })
  expect(decorationClasses(harness.state())).not.toContain('ra-word')
})

test('the word mark follows document edits and clearing removes it with the sentence', () => {
  const source = 'First sentence. Second sentence.'
  const harness = stateHarness(source)
  const from = source.indexOf('Second')
  setReadAloud(harness.view, from, { from, to: from + 6 })
  harness.update({ changes: { from: 0, insert: 'New opening. ' } })
  const marks: Array<[number, number]> = []
  readAloudDecorations(harness.state()).between(0, harness.state().doc.length, (a, b, value) => {
    if ((value.spec as { class?: string }).class === 'ra-word') marks.push([a, b])
  })
  expect(marks).toEqual([[from + 13, from + 19]])
  setReadAloud(harness.view, null)
  expect(readAloudDecorations(harness.state()).size).toBe(0)
})
