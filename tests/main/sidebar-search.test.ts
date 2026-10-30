import { expect, test } from 'bun:test'
import { buildTree } from '../../src/renderer/src/sidebar-tree'
import { createSidebarSearch, searchResultRows } from '../../src/renderer/src/sidebar-search'
import { tokenizeFileQuery, hasSearchTerms } from '../../src/renderer/src/file-query'
import { completionAt, applyCompletion } from '../../src/renderer/src/file-prefix-assist'

const file = (path: string) => ({ path, name: path.split('/').at(-1)!, directory: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', modifiedAt: new Date(2026, 6, 22).getTime(), size: 0 })
const tree = buildTree(['papers/UnityBC/river.md', 'papers/UnityBC/nested/notes.md', 'archive/river-old.md', 'river.md', 'mýty/koláč.md'].map(file))
const search = createSidebarSearch(tree, ['papers/UnityBC/river.md', 'papers/UnityBC/nested/notes.md', 'archive/river-old.md', 'river.md', 'mýty/koláč.md'].map(file))

test('query grammar preserves prefixes, quoted phrases, plain words and incomplete typing', () => {
  expect(tokenizeFileQuery('FO:"AI Agent Workshops" fi:report "two words" xx:value fo:').map(({ prefix, value }) => ({ prefix, value }))).toEqual([
    { prefix: 'fo', value: 'AI Agent Workshops' }, { prefix: 'fi', value: 'report' }, { prefix: null, value: 'two words' }, { prefix: null, value: 'xx:value' }, { prefix: 'fo', value: '' },
  ])
  expect(hasSearchTerms('fo:')).toBe(false)
  expect(tokenizeFileQuery('fo:"still typing')[0].value).toBe('still typing')
})

test('flat ranking puts a named folder before its descendants and exact files before partial names', () => {
  const hits = search.search('fo:UnityBC')
  expect(hits[0].path).toBe('papers/UnityBC')
  expect(hits.map((n) => n.path)).toContain('papers/UnityBC/nested/notes.md')
  expect(search.search('fi:river')[0].path).toBe('river.md')
  expect(search.search('fo:UnityBC fi:river').map((n) => n.path)).toEqual(['papers/UnityBC/river.md'])
  expect(search.search('myty kolac').map((n) => n.path)).toEqual(['mýty/koláč.md'])
  expect(search.search('fi:UnityBC')).toEqual([])
})

test('date prefix searches already listed file modification dates', () => {
  expect(search.search('da:july fi:river')).toHaveLength(3)
  expect(search.search('da:2025')).toEqual([])
})

test('search collapse hides descendants without mutating saved tree expansion or ranked hits', () => {
  const hits = search.search('fo:UnityBC')
  const original = hits.map((node) => node.path)
  const collapsed = new Set(['papers/UnityBC'])
  expect(searchResultRows(hits, collapsed).map((n) => n.path)).toEqual(['papers/UnityBC'])
  collapsed.delete('papers/UnityBC')
  expect(searchResultRows(hits, collapsed)).toEqual(hits)
  expect(hits.map((node) => node.path)).toEqual(original)
  expect(search.search('fo:UnityBC').map((node) => node.path)).toEqual(original)
})

test('assist offers prefixes and real folders and completes quoted folder names', () => {
  expect(completionAt('f', 1, search.folders)?.items.map((i) => i.label)).toEqual(['fo:', 'fi:'])
  const c = completionAt('fo:Unit', 7, search.folders)!
  expect(c.items[0].insert).toBe('UnityBC')
  expect(applyCompletion('fo:Unit', c, c.items[0]).query).toBe('fo:UnityBC ')
})

test('search honours the view projection, titles, hidden paths and cached metadata', () => {
  const projected = [{ kind: 'file' as const, path: 'visible.md', name: 'visible.md', label: 'The river paper', isIndex: false, isScrap: false }]
  const listing = [file('visible.md'), file('hidden.md')]
  const index = createSidebarSearch(projected, listing, { works: [{ path: 'visible.md', title: 'The river paper', status: 'editing' }] })
  expect(index.search('met:editing').map((n) => n.path)).toEqual(['visible.md'])
  expect(index.search('river')[0].label).toBe('The river paper')
  expect(index.search('fi:hidden')).toEqual([])
})

test('cached search over 3,500 files stays within an interactive budget', () => {
  const files = Array.from({ length: 3500 }, (_, i) => file(`papers/group-${i % 50}/note-${i}.md`))
  const index = createSidebarSearch(buildTree(files), files)
  const start = performance.now()
  for (const q of ['n', 'no', 'not', 'note', 'fi:note-3499', 'fo:group-49']) expect(index.search(q).length).toBeGreaterThan(0)
  expect(performance.now() - start).toBeLessThan(1000)
})

test('folder completion counts each file once, including nested matches', () => {
  const c = completionAt('fo:Unit', 7, search.folders)!
  expect(c.items[0].kind === 'folder' && c.items[0].count).toBe(2)
})
