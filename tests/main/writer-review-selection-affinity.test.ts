import { expect, test } from 'bun:test'
import { EditorSelection, EditorState } from '@codemirror/state'
import { history, redo, undo } from '@codemirror/commands'
import {
  documentTextForPersistence,
  pendingWriterChanges,
  writerReviewing,
} from '../../src/renderer/src/editor/writer-review'

function reviewingState(doc = 'old draft.'): EditorState {
  return EditorState.create({
    doc,
    extensions: [history(), writerReviewing({ initialMode: 'reviewing' })],
  })
}

function typeCharacter(state: EditorState, char: string, assoc: -1 | 0 | 1): EditorState {
  const range = state.selection.main
  return state.update({
    changes: { from: range.from, to: range.to, insert: char },
    selection: EditorSelection.create([EditorSelection.cursor(range.from + char.length, assoc)]),
    userEvent: 'input.type',
  }).state
}

for (const assoc of [-1, 0, 1] as const) {
  test(`Reviewing keeps sequential typing after the insertion with cursor association ${assoc}`, () => {
    let state = reviewingState()
    let typed = ''
    let insertionId: string | undefined
    for (const char of 'New ') {
      state = typeCharacter(state, char, assoc)
      typed += char
      expect(state.selection.main.head).toBe(typed.length)
      expect(state.selection.main.assoc).toBe(assoc)
      expect(state.doc.toString()).toBe(`${typed}old draft.`)
      expect(documentTextForPersistence(state)).toBe(`${typed}old draft.`)
      const changes = pendingWriterChanges(state)
      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({ oldText: '', newText: typed })
      insertionId ??= changes[0]!.localId
      expect(changes[0]!.localId).toBe(insertionId)
    }

    // Shift+Right three times selects original text from the post-typing caret.
    const anchor = state.selection.main.head
    state = state.update({ selection: EditorSelection.range(anchor, anchor + 3) }).state
    state = state.update({
      changes: { from: state.selection.main.from, to: state.selection.main.to },
      selection: EditorSelection.create([EditorSelection.cursor(anchor, assoc)]),
      userEvent: 'delete.backward',
    }).state
    expect(state.doc.toString()).toBe('New old draft.')
    expect(documentTextForPersistence(state)).toBe('New  draft.')
    expect(pendingWriterChanges(state)).toEqual(expect.arrayContaining([
      expect.objectContaining({ oldText: '', newText: 'New ', localId: insertionId }),
      expect.objectContaining({ oldText: 'old', newText: '' }),
    ]))
  })

  test(`Reviewing deleting own insertion cancels it with cursor association ${assoc}`, () => {
    let state = reviewingState()
    for (const char of 'New ') state = typeCharacter(state, char, assoc)
    state = state.update({
      changes: { from: 0, to: state.selection.main.head },
      selection: EditorSelection.create([EditorSelection.cursor(0, assoc)]),
      userEvent: 'delete.backward',
    }).state
    expect(state.doc.toString()).toBe('old draft.')
    expect(documentTextForPersistence(state)).toBe('old draft.')
    expect(pendingWriterChanges(state)).toEqual([])
  })

  test(`Reviewing replacement typing stays after preserved original text with association ${assoc}`, () => {
    let state = reviewingState().update({ selection: EditorSelection.range(0, 3) }).state
    for (const [index, char] of [...'New'].entries()) {
      state = typeCharacter(state, char, assoc)
      expect(state.doc.toString()).toBe(`old${'New'.slice(0, index + 1)} draft.`)
      expect(state.selection.main.head).toBe(3 + index + 1)
    }
    expect(documentTextForPersistence(state)).toBe('New draft.')
    expect(pendingWriterChanges(state)).toMatchObject([{ oldText: 'old', newText: 'New' }])
  })
}

for (const assoc of [-1, 0, 1] as const) {
  test(`Reviewing maps adjacent same-point insertions as one ordered span with association ${assoc}`, () => {
    const state = reviewingState().update({
      changes: [{ from: 0, insert: 'N' }, { from: 0, insert: 'ew ' }],
      selection: EditorSelection.create([EditorSelection.cursor(4, assoc)]),
      userEvent: 'input.type',
    }).state
    expect(state.doc.toString()).toBe('New old draft.')
    expect(state.selection.main.head).toBe(4)
    expect(pendingWriterChanges(state)).toMatchObject([{ oldText: '', newText: 'New ' }])
  })

  test(`Reviewing maps selection endpoints over two replacement spans with association ${assoc}`, () => {
    const state = reviewingState('old mid end').update({
      changes: [{ from: 0, to: 3, insert: 'New' }, { from: 8, to: 11, insert: 'last' }],
      selection: EditorSelection.create([EditorSelection.range(3, 12, undefined, undefined, assoc)]),
      userEvent: 'input.type',
    }).state
    expect(state.doc.toString()).toBe('oldNew mid endlast')
    expect(state.selection.main.anchor).toBe(6)
    expect(state.selection.main.head).toBe(18)
    expect(documentTextForPersistence(state)).toBe('New mid last')
  })
}

test('Reviewing preserves negative-association insertion-start selection', () => {
  const state = reviewingState().update({
    changes: { from: 0, to: 3, insert: 'New' },
    selection: EditorSelection.create([EditorSelection.cursor(0, -1)]),
    userEvent: 'input.type',
  }).state
  expect(state.doc.toString()).toBe('oldNew draft.')
  expect(state.selection.main.head).toBe(3)
  expect(state.selection.main.assoc).toBe(-1)
})

test('Reviewing negative-association typing restores document and change identity through undo and redo', () => {
  let state = reviewingState()
  for (const char of 'New ') state = typeCharacter(state, char, -1)
  const changes = pendingWriterChanges(state)
  expect(state.doc.toString()).toBe('New old draft.')
  expect(undo({ state, dispatch: (tr) => { state = tr.state } })).toBe(true)
  expect(state.doc.toString()).toBe('old draft.')
  expect(pendingWriterChanges(state)).toEqual([])
  expect(redo({ state, dispatch: (tr) => { state = tr.state } })).toBe(true)
  expect(state.doc.toString()).toBe('New old draft.')
  expect(state.selection.main.head).toBe(4)
  expect(pendingWriterChanges(state)).toEqual(changes)
})
