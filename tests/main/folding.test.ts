import { test, expect } from 'bun:test'
import { EditorState, EditorSelection, type StateCommand } from '@codemirror/state'
import { foldedRanges } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import {
  foldCurrentHeading,
  foldAllHeadings,
  unfoldAll,
  headingFolding,
} from '../../src/renderer/src/editor/folding'

// # A[0..3]  alpha[5..10]  ## B[12..16]  bravo[18..23]  # C[25..28]  charlie[30..37]  len 38
const DOC = '# A\n\nalpha\n\n## B\n\nbravo\n\n# C\n\ncharlie\n'

function mk(doc: string, cursor = 0): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(cursor),
    extensions: [markdown({ extensions: [GFM] }), headingFolding],
  })
}

/** The folded ranges of a state, in document order. */
function ranges(state: EditorState): [number, number][] {
  const out: [number, number][] = []
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    out.push([from, to])
  })
  return out
}

/** Drive a StateCommand and return the resulting state (or the input, if it declined). */
function run(command: StateCommand, state: EditorState): EditorState {
  let next = state
  command({ state, dispatch: (tr) => { next = tr.state } })
  return next
}

test('foldCurrentHeading folds the section the cursor sits in', () => {
  const next = run(foldCurrentHeading, mk(DOC, 20)) // inside "bravo", under ## B
  expect(ranges(next)).toEqual([[16, 24]])
})

test('foldCurrentHeading on a top heading folds to the next same-or-higher heading', () => {
  const next = run(foldCurrentHeading, mk(DOC, 1)) // on "# A"; closes before "# C"
  expect(ranges(next)).toEqual([[3, 24]])
})

test('foldCurrentHeading toggles: a second run on the same section unfolds it', () => {
  const folded = run(foldCurrentHeading, mk(DOC, 1))
  expect(ranges(folded)).toEqual([[3, 24]])
  const unfolded = run(foldCurrentHeading, folded)
  expect(ranges(unfolded)).toEqual([])
})

test('foldCurrentHeading declines when there is no heading', () => {
  const state = mk('just some prose\nand more prose\n', 4)
  let handled = false
  handled = foldCurrentHeading({ state, dispatch: () => {} })
  expect(handled).toBe(false)
})

test('foldAllHeadings folds every top-level section', () => {
  const next = run(foldAllHeadings, mk(DOC, 0))
  expect(ranges(next)).toEqual([
    [3, 24], // # A → before # C
    [28, 38], // # C → end of document
  ])
})

test('foldAllHeadings cycles: a second run unfolds everything', () => {
  const folded = run(foldAllHeadings, mk(DOC, 0))
  const unfolded = run(foldAllHeadings, folded)
  expect(ranges(unfolded)).toEqual([])
})

test('foldAllHeadings declines a document with no headings', () => {
  const state = mk('no headings here\n', 0)
  expect(foldAllHeadings({ state, dispatch: () => {} })).toBe(false)
})

test('unfoldAll clears every fold and declines when nothing is folded', () => {
  const folded = run(foldAllHeadings, mk(DOC, 0))
  expect(ranges(run(unfoldAll, folded))).toEqual([])
  expect(unfoldAll({ state: mk(DOC, 0), dispatch: () => {} })).toBe(false)
})
