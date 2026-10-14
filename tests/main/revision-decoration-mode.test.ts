import { expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { EditorView, type DecorationSet } from '@codemirror/view'
import { appliedFlash, showAppliedFlash } from '../../src/renderer/src/editor/applied-flash'
import { compareHighlights, setCompareHighlights } from '../../src/renderer/src/editor/compare-highlights'
import { setSuggestionAnchors, suggestionAnchoring } from '../../src/renderer/src/editor/suggestion-anchor'
import { setWriterMode, writerReviewing } from '../../src/renderer/src/editor/writer-review'

function decorationCount(state: EditorState): number {
  const view = { state } as EditorView
  return state.facet(EditorView.decorations).reduce((count, layer) => {
    const decorations = typeof layer === 'function' ? layer(view) : layer as DecorationSet
    return count + decorations.size
  }, 0)
}

test.each([
  ['version comparison', compareHighlights, setCompareHighlights.of({ marks: [{ id: 'c1', from: 0, to: 4, provenance: 'writer' }] })],
  ['suggestion target', suggestionAnchoring, setSuggestionAnchors.of([{ id: 'c1', oldText: 'Text' }])],
  ['applied-change flash', appliedFlash, showAppliedFlash.of({ from: 0, to: 4 })],
] as const)('%s decorations are absent in Drafting and return in Reviewing', (_name, extension, effect) => {
  let state = EditorState.create({
    doc: 'Text in the draft.',
    extensions: [writerReviewing({ initialMode: 'drafting' }), extension],
  })
  state = state.update({ effects: effect }).state
  expect(decorationCount(state)).toBe(0)

  state = state.update({ effects: setWriterMode.of('reviewing') }).state
  expect(decorationCount(state)).toBeGreaterThan(0)
})
