import { test, expect } from 'bun:test'
import { EditorState, EditorSelection, type StateCommand } from '@codemirror/state'
import { indentListItem, outdentListItem } from '../../src/renderer/src/editor/outliner'

// Salvaged verbatim from feature/m1-its-your-editor (tests/outliner.test.ts); only the import
// path moved for the rebuild's tests/main/ layout (import depth ../../src).
function run(command: StateCommand, doc: string, anchor: number, head?: number): { doc: string; handled: boolean } {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head ?? anchor) })
  const handled = command({ state, dispatch: (tr) => { state = tr.state } })
  return { doc: state.doc.toString(), handled }
}

test('Tab indents a bullet line by two spaces', () => {
  const { doc, handled } = run(indentListItem, '- alpha\n- beta\n', 9)
  expect(handled).toBe(true)
  expect(doc).toBe('- alpha\n  - beta\n')
})

test('Tab indents every list line in a multi-line selection', () => {
  const { doc } = run(indentListItem, '- a\n- b\n', 0, 7)
  expect(doc).toBe('  - a\n  - b\n')
})

test('Tab on a prose line is not handled (falls through)', () => {
  const { handled } = run(indentListItem, 'plain paragraph\n', 3)
  expect(handled).toBe(false)
})

test('Shift-Tab outdents up to two spaces, numbered lists too', () => {
  const { doc } = run(outdentListItem, '  1. one\n', 4)
  expect(doc).toBe('1. one\n')
  const { handled } = run(outdentListItem, '- top\n', 2)
  expect(handled).toBe(false)
})
