import { expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import {
  citationUpgradeField,
  clearTrackedCitation,
  trackCitation,
  trackedCitationRange,
} from '../../src/renderer/src/editor/citation-upgrade'

const CITATION =
  '> “Radial categories are not defined by shared properties.”\n>\n'
  + '> [⟨Lakoff 1987, p. 1⟩](zotero://open-pdf/library/items/LAKOFFPDF?page=1)'

test('the citation range maps through surrounding edits without adding identity text to the document', () => {
  const id = 'internal-only'
  const source = `Before\n${CITATION}\nAfter`
  const from = source.indexOf(CITATION)
  let state = EditorState.create({
    doc: source,
    extensions: [citationUpgradeField],
  })
  state = state.update({
    effects: trackCitation.of({
      from,
      id,
      original: CITATION,
      to: from + CITATION.length,
    }),
  }).state

  expect(state.doc.toString()).toBe(source)
  expect(state.doc.toString()).not.toContain(id)

  state = state.update({ changes: { from: 0, insert: 'New lead\n' } }).state
  const mapped = trackedCitationRange(state, id)
  expect(mapped).not.toBeNull()
  expect(state.sliceDoc(mapped!.from, mapped!.to)).toBe(CITATION)
})

test('editing the tracked citation makes its one-shot upgrade ineligible forever', () => {
  const id = 'internal-only'
  let state = EditorState.create({
    doc: CITATION,
    extensions: [citationUpgradeField],
  })
  state = state.update({
    effects: trackCitation.of({
      from: 0,
      id,
      original: CITATION,
      to: CITATION.length,
    }),
  }).state
  state = state.update({
    changes: { from: CITATION.indexOf('Lakoff'), to: CITATION.indexOf('Lakoff') + 6, insert: 'L.' },
  }).state

  expect(trackedCitationRange(state, id)).toBeNull()
  state = state.update({
    changes: {
      from: CITATION.indexOf('Lakoff'),
      to: CITATION.indexOf('Lakoff') + 2,
      insert: 'Lakoff',
    },
  }).state
  expect(state.doc.toString()).toBe(CITATION)
  expect(trackedCitationRange(state, id)).toBeNull()
  state = state.update({ effects: clearTrackedCitation.of(id) }).state
  expect(trackedCitationRange(state, id)).toBeNull()
})
