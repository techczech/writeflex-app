import { expect, test } from 'bun:test'
import type { Change } from '../../src/preload'
import { categoryOptions, groupByLiveDocumentLocation, locationLabel } from '../../src/renderer/src/components/change-review'

const change = (id: string, category: string | null): Change => ({
  id,
  path: 'draft.md',
  ts: 1,
  provenance: 'agent',
  editClass: 'content',
  category,
  summary: id,
  oldText: 'old',
  newText: 'new',
  status: 'pending',
  isCorrection: false,
})

test('review category options count categories in the panel order', () => {
  expect(categoryOptions([
    change('c_wording', 'wording'),
    change('c_typo', 'typo'),
    change('c_uncat', null),
    change('c_typo2', 'typo'),
  ])).toEqual([
    { key: 'typo', label: 'Typo', count: 2 },
    { key: 'wording', label: 'Wording', count: 1 },
    { key: 'uncategorised', label: 'Uncategorised', count: 1 },
  ])
})

test('review location labels number body paragraphs, not the heading', () => {
  const doc = '# Title\n\nFirst paragraph here.\n\nSecond paragraph carries the change.\n'
  const from = doc.indexOf('carries')

  expect(locationLabel(doc, from)).toEqual({
    mark: '¶2',
    name: 'Second paragraph carries the change.',
  })
})

test('review groups anchor-free agent changes by live document paragraph order', () => {
  const doc = '# Draft\n\nFirst paragraph changes here.\n\nSecond paragraph changes here.\n\nClosing paragraph.\n'
  const second = change('second', 'wording')
  second.oldText = 'Second paragraph changes here.'
  const first = change('first', 'clarity')
  first.oldText = 'First paragraph changes here.'
  const missing = change('missing', 'tone')
  missing.oldText = 'Text no longer present.'

  const groups = groupByLiveDocumentLocation(doc, [second, missing, first])

  expect(groups.map((group) => ({
    mark: locationLabel(doc, group.from).mark,
    ids: group.changes.map((item) => item.id),
  }))).toEqual([
    { mark: '¶1', ids: ['first'] },
    { mark: '¶2', ids: ['second'] },
    { mark: '—', ids: ['missing'] },
  ])
})
