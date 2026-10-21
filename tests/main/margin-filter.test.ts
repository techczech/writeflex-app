import { expect, test } from 'bun:test'
import type { Change } from '../../src/preload'
import { filterLine, kindSegmentOf, shownIds, withKindSegment, withoutKinds } from '../../src/renderer/src/app/margin-filter'
import { buildMarginModel, type MarginFilter } from '../../src/renderer/src/app/margin-model'

const DOC = 'Alpha one. Beta two. Gamma three. Delta four. Epsilon five.'
const change = (id: string, oldText: string, newText: string): Change => ({
  id, path: 'draft.md', ts: 1, provenance: 'agent', editClass: 'content', category: 'wording', summary: id, oldText, newText, status: 'pending', isCorrection: false,
})
const changes = [change('e1', 'Alpha one.', 'Alpha 1.'), change('n1', 'Beta two.', 'Beta two.'), change('e2', 'Gamma three.', 'Gamma 3.'), change('n2', 'Delta four.', 'Delta four.'), change('e3', 'Epsilon five.', 'Epsilon 5.')]
const build = (filter?: MarginFilter) => buildMarginModel({ changes, document: DOC, view: 'margin', filter })

test('the kind segment is a view of the filter\'s kinds and toggles back to All', () => {
  expect(kindSegmentOf({})).toBe('all')
  const comments = withKindSegment({}, 'comments')
  expect(kindSegmentOf(comments)).toBe('comments')
  expect(kindSegmentOf(withKindSegment(comments, 'comments'))).toBe('all')
  expect(kindSegmentOf(withKindSegment(comments, 'comments', false))).toBe('comments')
  expect(kindSegmentOf(withKindSegment(comments, 'edits'))).toBe('edits')
  expect(withKindSegment({ sources: new Set(['agent']) }, 'all').sources?.size).toBe(1)
  expect(withoutKinds(comments).kinds).toBeUndefined()
})

test('Comments hides the edits from the model (so from the marks), and the filter line says what is hidden', () => {
  const filter = withKindSegment({}, 'comments')
  const model = build(filter)
  expect([...model.cards].map((c) => c.id)).toEqual(['n1', 'n2'])
  expect(shownIds(model, filter)).toEqual(new Set(['n1', 'n2']))
  expect(shownIds(build(), {})).toBeNull()
  expect(filterLine(model, filter, model.counts.total)).toEqual({ label: 'Comments only', hidden: '3 edits hidden' })
  const edits = withKindSegment({}, 'edits')
  expect(filterLine(build(edits), edits, 5)).toEqual({ label: 'Edits only', hidden: '2 comments hidden' })
  expect(filterLine(build(), {}, 5)).toBeNull()
})

test('the kind counts stay put while a kind is pressed, because they are read with the kind removed', () => {
  const filter = withKindSegment({}, 'comments')
  const counts = build(withoutKinds(filter)).counts
  expect([counts.shown, counts.byKind.note, counts.byKind.edit]).toEqual([5, 2, 3])
})
