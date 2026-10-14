import { expect, test } from 'bun:test'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import {
  documentTextForPersistence,
  pendingWriterChanges,
  writerReviewing,
} from '../../src/renderer/src/editor/writer-review'

function reviewingState(doc = ''): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM] }), writerReviewing({ initialMode: 'reviewing' })],
  })
}

function typeText(state: EditorState, text: string): EditorState {
  let next = state
  for (const char of text) {
    const at = next.selection.main.head
    next = next.update({
      changes: { from: at, insert: char },
      selection: { anchor: at + char.length },
      userEvent: 'input.type',
    }).state
  }
  return next
}

function insertChunk(state: EditorState, text: string): EditorState {
  const at = state.selection.main.head
  return state.update({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    userEvent: 'input.paste',
  }).state
}

test('a letter fix inside a word is one writer change', () => {
  let state = reviewingState('A sentance.')
  state = state.update({ changes: { from: 6, to: 7, insert: 'e' } }).state

  expect(pendingWriterChanges(state)).toHaveLength(1)
  expect(documentTextForPersistence(state)).toBe('A sentence.')
})

test('two typo fixes in different paragraphs remain two writer changes', () => {
  let state = reviewingState('First mistka.\n\nSecond eror.')
  state = state.update({ changes: { from: 10, to: 12, insert: 'ake' } }).state
  const secondTypo = state.doc.toString().indexOf('eror')
  state = state.update({ changes: { from: secondTypo + 1, insert: 'r' } }).state

  expect(pendingWriterChanges(state)).toHaveLength(2)
  expect(documentTextForPersistence(state)).toBe('First mistake.\n\nSecond error.')
})

test('a sentence added inside an existing paragraph is one writer change', () => {
  const initial = 'The opening sentence. The closing sentence.'
  const at = initial.indexOf(' The closing')
  let state = reviewingState(initial).update({ selection: { anchor: at } }).state
  state = typeText(state, ' A new sentence.')

  expect(pendingWriterChanges(state)).toHaveLength(1)
  expect(documentTextForPersistence(state)).toBe('The opening sentence. A new sentence. The closing sentence.')
})

test('pauses do not split continuous typing within one paragraph', () => {
  const originalNow = Date.now
  let now = 1_000
  Date.now = () => now
  try {
    let state = reviewingState()
    state = insertChunk(state, 'A paragraph ')
    now = 60_000
    state = insertChunk(state, 'written after a pause.')

    expect(pendingWriterChanges(state)).toHaveLength(1)
    expect(documentTextForPersistence(state)).toBe('A paragraph written after a pause.')
  } finally {
    Date.now = originalNow
  }
})

test('same-block edge typing keeps the established writer-change identity', () => {
  let state = insertChunk(reviewingState('The draft.'), 'word')
  const establishedId = pendingWriterChanges(state)[0]!.localId

  state = insertChunk(state, 's')

  expect(pendingWriterChanges(state)).toHaveLength(1)
  expect(pendingWriterChanges(state)[0]!.localId).toBe(establishedId)
})

test('ten continuously typed paragraphs become ten writer changes', () => {
  const text = Array.from({ length: 10 }, (_, index) => `Paragraph ${index + 1}.`).join('\n\n')
  const state = typeText(reviewingState(), text)

  expect(pendingWriterChanges(state)).toHaveLength(10)
  expect(documentTextForPersistence(state)).toBe(text)
})

test('a continuously typed six-item list remains one writer change', () => {
  const text = Array.from({ length: 6 }, (_, index) => `- Item ${index + 1}`).join('\n')
  const state = typeText(reviewingState(), text)

  expect(pendingWriterChanges(state)).toHaveLength(1)
  expect(documentTextForPersistence(state)).toBe(text)
})

test('adjacent table, Mermaid, and SVG objects remain three block-sized writer changes', () => {
  let state = insertChunk(reviewingState(), '| A | B |\n|---|---|\n| 1 | 2 |')
  state = insertChunk(state, '\n\n```mermaid\ngraph TD\n  A --> B\n```')
  state = insertChunk(state, '\n\n```svg\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>\n```')

  expect(pendingWriterChanges(state)).toHaveLength(3)
  expect(documentTextForPersistence(state)).toBe(state.doc.toString())
})
