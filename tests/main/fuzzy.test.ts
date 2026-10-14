import { test, expect } from 'bun:test'
import { fuzzyScore, fuzzyFilter } from '../../src/renderer/src/fuzzy'

test('subsequence required', () => {
  expect(fuzzyScore('abc', 'a-b-c.md')).not.toBeNull()
  expect(fuzzyScore('abx', 'a-b-c.md')).toBeNull()
})

test('segment starts and runs beat scattered matches', () => {
  const paths = ['notes/random-ideas.md', 'notes/river.md', 'archive/reviewed.md']
  expect(fuzzyFilter('riv', paths)[0]).toBe('notes/river.md')
  expect(fuzzyFilter('ri', paths).length).toBe(3)
})

test('empty query returns input order, limited', () => {
  expect(fuzzyFilter('', ['a.md', 'b.md'], 1)).toEqual(['a.md'])
})

test('diacritic folding matches Czech names without changing raw candidate positions', () => {
  expect(fuzzyScore('kolac', 'a-piece-of-koláč.md')).not.toBeNull()
  expect(fuzzyScore('myty', 'mýty-a-pověry.md')).not.toBeNull()
  expect(fuzzyScore('river', 'notes/river.md')).not.toBeNull()

  // `b` is raw position 2 and therefore a segment start after `-`. Whole-string NFD would insert a
  // combining mark after `á`, shift `b` to position 3, and score against the wrong raw character.
  expect(fuzzyScore('ab', 'á-b')).toBe(4)
})

// Requirement: "no fuzzy matching on file names: schemas-and-propositions must be matched
// by `prop schem`." Whitespace splits the query into tokens; every token must match, in any order.
const SCHEMAS = 'blogs/schemas-and-propositions/why-schemas-matter.md'

test('a multi-word query matches when every token is a subsequence, in any order', () => {
  expect(fuzzyScore('prop schem', SCHEMAS)).not.toBeNull()
  expect(fuzzyScore('schem prop', SCHEMAS)).not.toBeNull()
  expect(fuzzyScore('zzz schem', SCHEMAS)).toBeNull()
})

test('hyphens and underscores in the query read as spaces', () => {
  expect(fuzzyScore('prop-schem', SCHEMAS)).not.toBeNull()
  expect(fuzzyScore('prop_schem', SCHEMAS)).not.toBeNull()
  expect(fuzzyScore('  prop   schem  ', SCHEMAS)).not.toBeNull()
})

test('multi-word ranking prefers word-boundary hits', () => {
  const paths = ['notes/proposal-schematic.md', 'notes/apropos-of-scheming.md']
  expect(fuzzyFilter('prop schem', paths)).toEqual(['notes/proposal-schematic.md', 'notes/apropos-of-scheming.md'])
  expect(fuzzyFilter('prop schem', paths)[0]).toBe('notes/proposal-schematic.md')
})

test('a whitespace-only query behaves as an empty query', () => {
  expect(fuzzyFilter('   ', ['a.md', 'b.md'], 1)).toEqual(['a.md'])
})
