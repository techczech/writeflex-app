import { expect, test } from 'bun:test'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import {
  documentTextForPersistence,
  pendingWriterChanges,
  writerReviewChanged,
  writerReviewing,
} from '../../src/renderer/src/editor/writer-review'

function draftingState(doc = ''): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM] }), writerReviewing({ initialMode: 'drafting' })],
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

function expectDraftingPersistence(state: EditorState): void {
  expect(documentTextForPersistence(state)).toBe(state.doc.toString())
}

test('Drafting captures one continuously typed paragraph as one stable writer record', () => {
  let state = typeText(draftingState(), 'A paragraph')
  const first = pendingWriterChanges(state)

  expect(first).toHaveLength(1)
  expect(first[0]).toMatchObject({ oldText: '', newText: 'A paragraph' })
  expectDraftingPersistence(state)

  const localId = first[0]!.localId
  state = typeText(state, ' grows.')

  expect(pendingWriterChanges(state)).toMatchObject([
    { localId, oldText: '', newText: 'A paragraph grows.' },
  ])
  expectDraftingPersistence(state)
})

test('Drafting captures a deletion with the removed word only in the ledger record', () => {
  const initial = 'The old draft.'
  const state = draftingState(initial).update({ changes: { from: 4, to: 7 } }).state

  expect(state.doc.toString()).toBe('The  draft.')
  expect(pendingWriterChanges(state)).toMatchObject([
    { oldText: 'old', newText: '', anchor: { from: 4, to: 4 } },
  ])
  expectDraftingPersistence(state)
})

test('Drafting captures a replacement with both readings while keeping only the new text in the buffer', () => {
  const state = draftingState('The old draft.').update({
    changes: { from: 4, to: 7, insert: 'new' },
  }).state

  expect(state.doc.toString()).toBe('The new draft.')
  expect(pendingWriterChanges(state)).toMatchObject([
    { oldText: 'old', newText: 'new', anchor: { from: 4, to: 7 } },
  ])
  expectDraftingPersistence(state)
})

test('Drafting applies the block ceiling to ten continuously typed paragraphs', () => {
  const text = Array.from({ length: 10 }, (_, index) => `Paragraph ${index + 1}.`).join('\n\n')
  const state = typeText(draftingState(), text)

  expect(pendingWriterChanges(state)).toHaveLength(10)
  expectDraftingPersistence(state)
})

test('Drafting treats a continuously typed six-item list as one writer record', () => {
  const text = Array.from({ length: 6 }, (_, index) => `- Item ${index + 1}`).join('\n')
  const state = typeText(draftingState(), text)

  expect(pendingWriterChanges(state)).toHaveLength(1)
  expectDraftingPersistence(state)
})

test('Drafting capture changes fire the writer-review flush seam', () => {
  const state = draftingState()
  const transaction = state.update({ changes: { from: 0, insert: 'Captured.' } })

  expect(writerReviewChanged({ transactions: [transaction] })).toBe(true)
})
