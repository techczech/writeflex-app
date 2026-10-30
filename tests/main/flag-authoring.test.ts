import { expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { history, undo, undoDepth } from '@codemirror/commands'
import { flagSelectionEdit } from '../../src/shared/markdown/flag-edit'
import { findFlags } from '../../src/shared/markdown/flags'
import { flagSelection } from '../../src/renderer/src/editor/flag-actions'

test('flagging trims the selection and round-trips to exactly the chosen words', () => {
  const source = 'Before chosen words after.'
  const edit = flagSelectionEdit(source, 6, 20, 'needs-citation')
  const next = source.slice(0, edit.from) + edit.insert + source.slice(edit.to)
  expect(findFlags(next)).toHaveLength(1)
  expect(findFlags(next)[0]).toMatchObject({ words: 'chosen words', kind: 'needs-citation' })
})
test('flagging refuses code, metadata, tables, overlapping marks and two blocks', () => {
  for (const [source, words] of [
    ['---\ntitle: Secret\n---\n', 'Secret'], ['`code words`', 'words'], ['```\ncode words\n```', 'words'],
    ['| a | b |\n|---|---|\n| cell | text |', 'cell'], ['==marked==', 'marked'], ['first\n\nsecond', 'first\n\nsecond'],
  ]) {
    const from = source.indexOf(words)
    expect(() => flagSelectionEdit(source, from, from + words.length, 'rewrite')).toThrow()
  }
})
test('flag command is one ordinary editor undo event and preserves selected words', () => {
  let state = EditorState.create({ doc: 'Before chosen words after.', selection: { anchor: 7, head: 19 }, extensions: [history()] })
  const dispatch = (transaction: import('@codemirror/state').Transaction) => { state = transaction.state }
  expect(flagSelection('expand')({ state, dispatch })).toBe(true)
  expect(findFlags(state.doc.toString())[0].words).toBe('chosen words')
  expect(undo({ state, dispatch })).toBe(true)
  expect(state.doc.toString()).toBe('Before chosen words after.')
})

test('a selection crossing list items is refused as more than one paragraph', () => {
  const source = '- first item\n- second item'
  expect(() => flagSelectionEdit(source, 2, source.length, 'rewrite')).toThrow()
})

test('flagging stays separate from immediately replacing the selected words in Undo history', () => {
  let state = EditorState.create({ doc: 'Before chosen words after.', selection: { anchor: 7, head: 19 }, extensions: [history()] })
  const dispatch = (transaction: import('@codemirror/state').Transaction) => { state = transaction.state }
  flagSelection('expand')({ state, dispatch })
  const flagged = state.doc.toString()
  state = state.update({ changes: { from: state.selection.main.from, to: state.selection.main.to, insert: 'replacement' }, userEvent: 'input.type' }).state
  expect(undoDepth(state)).toBe(2)
  undo({ state, dispatch })
  expect(state.doc.toString()).toBe(flagged)
  undo({ state, dispatch })
  expect(state.doc.toString()).toBe('Before chosen words after.')
})
