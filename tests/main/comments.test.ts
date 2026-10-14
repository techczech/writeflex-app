import { test, expect } from 'bun:test'
import { EditorState, EditorSelection, type StateCommand } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { toggleComment, isInsideCodeBlock } from '../../src/renderer/src/editor/comments'

// Headless StateCommand harness (the M1 pattern).
function run(command: StateCommand, doc: string, anchor: number, head?: number): { doc: string; handled: boolean } {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head ?? anchor) })
  const handled = command({ state, dispatch: (tr) => { state = tr.state } })
  return { doc: state.doc.toString(), handled }
}

test('toggleComment prefixes a single line with "// "', () => {
  const r = run(toggleComment, 'draft this later\n', 3)
  expect(r.handled).toBe(true)
  expect(r.doc).toBe('// draft this later\n')
})

test('toggleComment un-comments an already-commented line', () => {
  expect(run(toggleComment, '// draft this later\n', 3).doc).toBe('draft this later\n')
})

test('toggleComment comments every line of a multi-line selection', () => {
  const r = run(toggleComment, 'one\ntwo\n', 0, 7)
  expect(r.doc).toBe('// one\n// two\n')
})

test('toggleComment on a mixed selection comments the uncommented lines', () => {
  // "one" is plain, "// two" already commented → not all commented, so comment the plain line and
  // leave the commented one untouched.
  const r = run(toggleComment, 'one\n// two\n', 0, 10)
  expect(r.doc).toBe('// one\n// two\n')
})

// Fix wave 1: fence-aware comment semantics. A `// code` line inside a ``` fenced block is real
// code, NOT a WriteFlex post-it comment — the render decorator must not paint it (and the count must
// not drop it). `isInsideCodeBlock` is the syntax-tree predicate the decorator resolves at each
// `//` line start; tested headlessly on a Markdown EditorState (no DOM/view needed).
function mdState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown()] })
}

test('isInsideCodeBlock: `//` inside a ``` fence is code, a prose `//` line is not', () => {
  //          L1     L2      L3        L4    L5  L6
  const state = mdState('note\n```js\n// c d\n```\n\n// real comment\n')
  expect(isInsideCodeBlock(state, state.doc.line(3).from)).toBe(true) // "// c d" — fenced code
  expect(isInsideCodeBlock(state, state.doc.line(6).from)).toBe(false) // "// real comment" — prose
})

test('isInsideCodeBlock: every line of an indented code block is flagged as code', () => {
  // The `CodeBlock` node begins past the four spaces that make the block code, so resolving at a
  // line's START put its OPENING line outside the block — the editor greyed out that one line as a
  // note while the export (correctly) kept it. Resolved at the line's first non-blank character,
  // both lines below are code. word-count's pure line scanner still drops an indented `// x` from
  // the COUNT: a documented divergence that loses no text.
  const state = mdState('para\n\n    // indented\n    code here\n\ntext\n')
  expect(isInsideCodeBlock(state, state.doc.line(3).from)).toBe(true) // the block's opening line
  expect(isInsideCodeBlock(state, state.doc.line(4).from)).toBe(true) // an interior line
  expect(isInsideCodeBlock(state, state.doc.line(6).from)).toBe(false) // prose after it
})
