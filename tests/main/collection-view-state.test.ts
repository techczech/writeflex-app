import { expect, test } from 'bun:test'
import { prepareCollectionRows, filterCollectionRows, groupCollectionRows, EMPTY_COLLECTION_FILTERS } from '../../src/renderer/src/components/collection-view-state'
import type { CollectionRow } from '../../src/preload'
const now = new Date(2026, 9, 21, 12).getTime()
const row = (path: string, extra: Partial<CollectionRow> = {}): CollectionRow => ({ path, name: path, title: path, purpose: 'Report', status: 'in progress', modified: now, words: 20, bare: false, provenance: { title: 'written', purpose: 'written', status: 'written' }, ...extra })
const rows = [row('a.md', { searchText: 'Students rated feedback as useful. Another sentence.', tags: ['assessment'] }), row('b.md', { title: 'Feedback tools', status: 'idea', purpose: 'Blog post', modified: new Date(2026, 8, 3).getTime(), tags: ['policy'] }), row('c.md', { status: 'published', purpose: null })]
const filter = (extra = {}) => filterCollectionRows(prepareCollectionRows(rows), { ...EMPTY_COLLECTION_FILTERS, ...extra }, now)
test('title and body search returns matching sentence and title-only excludes body hits', () => {
  expect(filter({ query: 'feedback' }).map(x => x.row.path)).toEqual(['a.md', 'b.md'])
  expect(filter({ query: 'feedback' })[0].snippet).toBe('Students rated feedback as useful.')
  expect(filter({ query: 'feedback', searchIn: 'title' }).map(x => x.row.path)).toEqual(['b.md'])
  expect(filter({ query: ' FEEDBACK useful ' }).map(x => x.row.path)).toEqual(['a.md'])
  expect(filter({ query: '[.*' })).toEqual([])
})
test('OR within facets, AND between facets; modified boundaries and missing fields', () => {
  expect(filter({ statuses: ['idea', 'in progress'], purposes: ['Report'], tags: ['assessment'] }).map(x => x.row.path)).toEqual(['a.md'])
  expect(filter({ modified: '7' }).map(x => x.row.path)).toEqual(['a.md', 'c.md'])
  expect(filter({ purposes: ['Unspecified'] }).map(x => x.row.path)).toEqual(['c.md'])
  expect(filter({ query: 'not-here' })).toEqual([])
})
test('group by status, purpose or calendar month preserves sorted row order without mutation', () => {
  const found = filter()
  expect(groupCollectionRows(found, 'status').map(g => g.label)).toEqual(['idea', 'in progress', 'published'])
  expect(groupCollectionRows(found, 'purpose').map(g => g.label)).toEqual(['Blog post', 'Report', 'Unspecified'])
  expect(groupCollectionRows(found, 'month').map(g => g.label)).toEqual(['October 2026', 'September 2026'])
  expect(groupCollectionRows(found, 'none')[0].rows).toEqual(found)
  expect(rows.map(x => x.path)).toEqual(['a.md', 'b.md', 'c.md'])
})
test('4,000 cached documents return every match without IO or a result cap', () => {
  const prepared = prepareCollectionRows(Array.from({ length: 4000 }, (_, i) => row(`${i}.md`, { searchText: 'A common feedback sentence. '.repeat(100) })))
  const start = performance.now()
  for (const query of ['f', 'fe', 'feed', 'feedback']) expect(filterCollectionRows(prepared, { ...EMPTY_COLLECTION_FILTERS, query }, now)).toHaveLength(4000)
  expect(performance.now() - start).toBeLessThan(1000)
})
test('text snippets show a matching prose sentence instead of repeating the document heading', () => {
  const prepared = prepareCollectionRows([row('a.md', { title: 'Feedback tools', searchText: '# Feedback tools\n\nStudents rated feedback as useful.' })])
  expect(filterCollectionRows(prepared, { ...EMPTY_COLLECTION_FILTERS, query: 'feedback' })[0].snippet).toBe('Students rated feedback as useful.')
})
