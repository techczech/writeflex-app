import { expect, test } from 'bun:test'
import { prepareCollectionRows, filterCollectionRows, groupCollectionRows, EMPTY_COLLECTION_FILTERS } from '../../src/renderer/src/components/collection-view-state'
import type { CollectionRow } from '../../src/preload'
import { collectionFooterText, subfolderPiecesText } from '../../src/renderer/src/components/collection-footer'
import { orderDashboard, type DashEntry, type DashSort, type DashSortKey } from '../../src/renderer/src/components/collection-order'

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

test('the footer counts subfolders only when there are some', () => {
  expect(collectionFooterText({ pieces: 1, folderPieces: 0, subfolders: 9, words: 303 })).toBe('1 piece · 9 folders · 0 folder pieces · 303 words')
  expect(collectionFooterText({ pieces: 2, folderPieces: 1, subfolders: 0, words: 1200 })).toBe('2 pieces · 1 folder piece · 1,200 words')
  expect(collectionFooterText({ pieces: 0, folderPieces: 0, subfolders: 1, words: 0 })).toBe('0 pieces · 1 folder · 0 folder pieces · 0 words')
})

test('a subfolder row counts its pieces', () => {
  expect(subfolderPiecesText(1)).toBe('1 piece')
  expect(subfolderPiecesText(12)).toBe('12 pieces')
})

const e = (label: string, isFolder: boolean, extra: Partial<DashEntry<string>> = {}): DashEntry<string> =>
  ({ isFolder, label, purpose: null, status: null, modified: null, item: label, ...extra })

const entries = [
  e('zeta', false, { purpose: 'essay', status: 'draft', modified: 5 }),
  e('Alpha', true, { purpose: '3 pieces', modified: 9 }),
  e('mid', false, { purpose: 'brief', status: 'final', modified: 1 }),
  e('beta', true, { purpose: '10 pieces', status: 'idea', modified: 2 }),
  e('Folio work', true, { purpose: 'report', status: 'draft', modified: 7 }),
  e('bare', false),
]

const keys: DashSortKey[] = ['title', 'purpose', 'status', 'date']
const dirs: Array<'asc' | 'desc'> = ['asc', 'desc']

test('folders come before files under every column and direction', () => {
  for (const key of keys) for (const dir of dirs) {
    const out = orderDashboard(entries, { key, dir })
    const flags = out.map((x) => x.isFolder)
    expect(flags).toEqual([true, true, true, false, false, false])
    expect(out.length).toBe(entries.length)
  }
})

test('title sorts by the shown label, case-insensitive, each group alone', () => {
  const asc = orderDashboard(entries, { key: 'title', dir: 'asc' }).map((x) => x.label)
  expect(asc).toEqual(['Alpha', 'beta', 'Folio work', 'bare', 'mid', 'zeta'])
  const desc = orderDashboard(entries, { key: 'title', dir: 'desc' }).map((x) => x.label)
  expect(desc).toEqual(['Folio work', 'beta', 'Alpha', 'zeta', 'mid', 'bare'])
})

test('missing values go last within their group in both directions', () => {
  for (const dir of dirs) {
    const s: DashSort = { key: 'status', dir }
    const out = orderDashboard(entries, s).map((x) => x.label)
    expect(out[2]).toBe('Alpha') // the folder with no status is last of the folders
    expect(out[5]).toBe('bare') // the file with no status is last of the files
  }
})

test('modified sorts numerically within groups', () => {
  expect(orderDashboard(entries, { key: 'date', dir: 'desc' }).map((x) => x.label)).toEqual(['Alpha', 'Folio work', 'beta', 'zeta', 'mid', 'bare'])
  expect(orderDashboard(entries, { key: 'date', dir: 'asc' }).map((x) => x.label)).toEqual(['beta', 'Folio work', 'Alpha', 'mid', 'zeta', 'bare'])
})

test('purpose uses numeric collation so "3 pieces" precedes "10 pieces"', () => {
  const out = orderDashboard(entries.filter((x) => x.isFolder), { key: 'purpose', dir: 'asc' }).map((x) => x.label)
  expect(out).toEqual(['Alpha', 'beta', 'Folio work'])
})
