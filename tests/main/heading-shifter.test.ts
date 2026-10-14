import { test, expect } from 'bun:test'
import { EditorState, EditorSelection, type StateCommand } from '@codemirror/state'
import { increaseHeading, decreaseHeading } from '../../src/renderer/src/editor/heading-shifter'

// Salvaged verbatim from feature/m1-its-your-editor (tests/heading-shifter.test.ts); only the
// import path moved for the rebuild's tests/main/ layout (import depth ../../src).
function run(command: StateCommand, doc: string, anchor: number, head?: number): { doc: string; handled: boolean } {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head ?? anchor) })
  const handled = command({ state, dispatch: (tr) => { state = tr.state } })
  return { doc: state.doc.toString(), handled }
}

test('increase turns prose into H1 and deepens headings up to H6', () => {
  expect(run(increaseHeading, 'title line\n', 2).doc).toBe('# title line\n')
  expect(run(increaseHeading, '## section\n', 2).doc).toBe('### section\n')
  const capped = run(increaseHeading, '###### deep\n', 2)
  expect(capped.doc).toBe('###### deep\n')
})

test('decrease lifts headings and removes H1 marker', () => {
  expect(run(decreaseHeading, '### x\n', 2).doc).toBe('## x\n')
  expect(run(decreaseHeading, '# x\n', 2).doc).toBe('x\n')
  expect(run(decreaseHeading, 'plain\n', 2).handled).toBe(false)
})

test('applies across a selection, skipping blank lines', () => {
  expect(run(increaseHeading, '# a\n\nb\n', 0, 7).doc).toBe('## a\n\n# b\n')
})
