import { expect, test } from 'bun:test'
import {
  detectWikilinkPickerTarget,
  wikilinkCompletionEdit,
  wikilinkPickerMatches,
} from '../../src/renderer/src/editor/wikilink-autocomplete'

const pieces = [
  { title: 'Zebra Notes', name: 'zebra.md' },
  { title: null, name: 'alpha-draft.markdown' },
  { title: 'Aardvark', name: 'other.mdx' },
]

test('wikilink picker labels Pieces by title with basename fallback and stable sorting', () => {
  expect(wikilinkPickerMatches(pieces, '').map(({ label, detail }) => ({ label, detail }))).toEqual([
    { label: 'Aardvark', detail: 'other' },
    { label: 'alpha-draft', detail: undefined },
    { label: 'Zebra Notes', detail: 'zebra' },
  ])
})

test('wikilink picker target follows an open target on the current line', () => {
  expect(detectWikilinkPickerTarget('See [[', 6)).toEqual({ from: 6, query: '' })
  expect(detectWikilinkPickerTarget('See [[Tar', 9)).toEqual({ from: 6, query: 'Tar' })
  expect(detectWikilinkPickerTarget('See [[Tar]]', 9)).toEqual({ from: 6, query: 'Tar' })
  expect(detectWikilinkPickerTarget('See [[Target]]', 14)).toBeNull()
  expect(detectWikilinkPickerTarget('See [[Target|label', 18)).toBeNull()
  expect(detectWikilinkPickerTarget('See [[Target\nnext', 17)).toBeNull()
  expect(detectWikilinkPickerTarget('See plain text', 14)).toBeNull()
})

test('wikilink picker filters Piece titles and basenames case-insensitively', () => {
  expect(wikilinkPickerMatches(pieces, 'ze').map(({ label }) => label)).toEqual(['Zebra Notes'])
  expect(wikilinkPickerMatches(pieces, 'draft').map(({ label }) => label)).toEqual(['alpha-draft'])
  expect(wikilinkPickerMatches([], 'anything')).toEqual([])
})

test('wikilink completion closes a plain link and preserves an existing display alias', () => {
  expect(wikilinkCompletionEdit('See [[Tar]]', 6, 9, 'Target Piece')).toEqual({
    from: 6,
    to: 11,
    insert: 'Target Piece]]',
    anchor: 20,
  })
  expect(wikilinkCompletionEdit('See [[Tar|short label]]', 6, 9, 'Target Piece')).toEqual({
    from: 6,
    to: 9,
    insert: 'Target Piece',
    anchor: 18,
  })
})
