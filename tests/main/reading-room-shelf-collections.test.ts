import { describe, expect, test } from 'bun:test'
import type { ShelfItem } from '@readflex/zotero-bridge'
import { shelfPage } from '../../src/main/reading-room-shelf'
import {
  collectionNodes,
  collectionRows,
  descendantIds,
  itemsInCollection,
  knownCollectionId,
  matchCollectionRows,
  resolveStoredCollection,
  type ShelfCollectionData,
} from '../../src/shared/shelf-collections'

function item(key: string, libraryId = 1): ShelfItem {
  return { attachments: [], citationKey: key, creators: [], itemKey: key, libraryId, tags: [], title: key, year: '2020' }
}

// Project A > (01 Intro, Methods), Project B > Methods; a group library (2) has its own COLLA01-keyed one.
const data: ShelfCollectionData = {
  collections: [
    { key: 'PRJA', libraryId: 1, name: 'Project A', parentKey: null },
    { key: 'A01', libraryId: 1, name: '01 Intro', parentKey: 'PRJA' },
    { key: 'AM', libraryId: 1, name: 'Methods', parentKey: 'PRJA' },
    { key: 'PRJB', libraryId: 1, name: 'Project B', parentKey: null },
    { key: 'BM', libraryId: 1, name: 'Methods', parentKey: 'PRJB' },
    { key: 'A01', libraryId: 2, name: 'Group intro', parentKey: null },
  ],
  itemCollections: {
    '1:I1': ['A01'],
    '1:I2': ['AM', 'A01'],
    '1:I3': ['BM'],
    '1:I4': ['PRJB'],
    '2:I1': ['A01'],
  },
}
const items = [item('I1'), item('I2'), item('I3'), item('I4'), item('I5'), item('I1', 2)]
const keys = (list: ShelfItem[]): string[] => list.map((entry) => `${entry.libraryId}:${entry.itemKey}`)

describe('collection membership', () => {
  test('a collection includes every descendant, and only its own library', () => {
    expect([...descendantIds(data.collections, '1:PRJA')].sort()).toEqual(['1:A01', '1:AM', '1:PRJA'])
    expect(keys(itemsInCollection(items, data, '1:PRJA'))).toEqual(['1:I1', '1:I2'])
    // same key in another library is a different collection
    expect(keys(itemsInCollection(items, data, '2:A01'))).toEqual(['2:I1'])
  })

  test('same-named collections stay separate', () => {
    expect(keys(itemsInCollection(items, data, '1:AM'))).toEqual(['1:I2'])
    expect(keys(itemsInCollection(items, data, '1:BM'))).toEqual(['1:I3'])
  })

  test('a cycle in the data does not loop', () => {
    const cyclic: ShelfCollectionData['collections'] = [
      { key: 'X', libraryId: 1, name: 'X', parentKey: 'Y' },
      { key: 'Y', libraryId: 1, name: 'Y', parentKey: 'X' },
    ]
    expect([...descendantIds(cyclic, '1:X')].sort()).toEqual(['1:X', '1:Y'])
  })

  test('counts are distinct items in the subtree', () => {
    const counts = new Map(collectionNodes(items, data).map((node) => [node.id, node.count]))
    expect(counts.get('1:PRJA')).toBe(2) // I2 is in two children but counts once
    expect(counts.get('1:A01')).toBe(2)
    expect(counts.get('1:PRJB')).toBe(2)
    expect(counts.get('2:A01')).toBe(1)
  })
})

describe('the collection argument is untrusted', () => {
  test('only a known qualified id is accepted', () => {
    expect(knownCollectionId('1:PRJA', data)).toBe('1:PRJA')
    for (const bad of ['PRJA', '9:PRJA', '', null, undefined, 7, { id: '1:PRJA' }, ['1:PRJA']]) {
      expect(knownCollectionId(bad, data)).toBeNull()
    }
  })
})

describe('the page', () => {
  const many = Array.from({ length: 200 }, (_, index) => item(`M${index}`))
  const big: ShelfCollectionData = {
    collections: [{ key: 'BIG', libraryId: 1, name: 'Big', parentKey: null }],
    itemCollections: Object.fromEntries(many.slice(120).map((entry) => [`1:${entry.itemKey}`, ['BIG']])),
  }

  test('filters before the row limit, so items past the first page are reachable', () => {
    const page = shelfPage(many, big, '1:BIG')
    expect(page.matched).toBe(80)
    expect(page.items[0]?.itemKey).toBe('M120')
    expect(page.items.length).toBe(80)
    const small = shelfPage(many, big, '1:BIG', 10)
    expect(small.matched).toBe(80)
    expect(small.items.length).toBe(10)
  })

  test('an unknown id is ignored and the unfiltered page is returned', () => {
    const page = shelfPage(many, big, 'nonsense')
    expect(page.matched).toBe(200)
    expect(page.items.length).toBe(80)
    expect(page.items[0]?.itemKey).toBe('M0')
  })
})

describe('the picker logic', () => {
  const nodes = collectionNodes(items, data)

  test('rows are depth-first and alphabetical with parent paths', () => {
    const rows = collectionRows(nodes.filter((node) => node.id.startsWith('1:')))
    expect(rows.map((row) => `${row.depth}:${row.path}`)).toEqual([
      '0:Project A',
      '1:Project A › 01 Intro',
      '1:Project A › Methods',
      '0:Project B',
      '1:Project B › Methods',
    ])
  })

  test('typing matches the parent path too, so duplicate names can be told apart', () => {
    const rows = collectionRows(nodes)
    expect(matchCollectionRows(rows, 'methods').length).toBe(2)
    expect(matchCollectionRows(rows, 'project b methods').map((row) => row.id)).toEqual(['1:BM'])
    expect(matchCollectionRows(rows, '').length).toBe(rows.length)
  })

  test('a remembered choice that no longer exists falls back to all', () => {
    expect(resolveStoredCollection('1:AM', nodes)).toBe('1:AM')
    expect(resolveStoredCollection('1:GONE', nodes)).toBeNull()
    expect(resolveStoredCollection('AM', nodes)).toBeNull()
    expect(resolveStoredCollection(null, nodes)).toBeNull()
  })
})
