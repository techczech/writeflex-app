import { test, expect } from 'bun:test'
import { EditorState } from '@codemirror/state'
import {
  appliedFlashField,
  clearAppliedFlash,
  minimisedAppliedRange,
  showAppliedFlash,
} from '../../src/renderer/src/editor/applied-flash'

// Ship 1 fix: the post-accept applied-edit flash field, driven headlessly (the suggestion-anchor
// precedent). The scroll + focus half of flashApplied needs a live view, so it is covered by the
// suggestions e2e; here we prove the field's decoration lifecycle: set, clear, and self-retire on edit.

const DOC = '# Draft\n\nThe opening sentence sprawls.\n'

function stateWithFlash(from: number, to: number): EditorState {
  const state = EditorState.create({ doc: DOC, extensions: [appliedFlashField] })
  return state.update({ effects: showAppliedFlash.of({ from, to }) }).state
}

test('showAppliedFlash marks the applied range', () => {
  const state = stateWithFlash(11, 40)
  expect(state.field(appliedFlashField).size).toBe(1)
})

test('clearAppliedFlash retires the flash', () => {
  const flashed = stateWithFlash(11, 40)
  const cleared = flashed.update({ effects: clearAppliedFlash.of(null) }).state
  expect(cleared.field(appliedFlashField).size).toBe(0)
})

test('a doc edit under the flash retires it (a momentary confirmation, not a tracked range)', () => {
  const flashed = stateWithFlash(11, 40)
  const edited = flashed.update({ changes: { from: 0, to: 0, insert: 'PREFACE ' } }).state
  expect(edited.field(appliedFlashField).size).toBe(0)
})

test('a bare selection move leaves the flash showing', () => {
  const flashed = stateWithFlash(11, 40)
  const moved = flashed.update({ selection: { anchor: 0 } }).state
  expect(moved.field(appliedFlashField).size).toBe(1)
})

test('the flash narrows a whole-sentence proposal to the minimised word it changed', () => {
  // DOC holds the accepted sentence at offset 9; the proposal replaced the whole sentence.
  const from = DOC.indexOf('The opening')
  const range = minimisedAppliedRange('The opening sentence is sprawling and could be tightened.', 'The opening sentence sprawls.', from)
  expect(DOC.slice(range.from, range.to)).toBe('sprawls')
})

test('a pure insertion flashes the inserted words; a pure deletion keeps the whole applied range', () => {
  const doc = 'teh cat sat on the mat.'
  const inserted = minimisedAppliedRange('sat on mat', 'sat on the mat', doc.indexOf('sat'))
  expect(doc.slice(inserted.from, inserted.to)).toBe('the ')
  const deletion = minimisedAppliedRange('sat on the mat', 'sat on mat', 8)
  expect(deletion).toEqual({ from: 8, to: 8 + 'sat on mat'.length })
})
