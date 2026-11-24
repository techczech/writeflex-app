import { expect, test } from 'bun:test'
import { collectionName, collectionNamingPattern, collectionNamingTitle, newCollectionTitle } from '../../src/main/collection-auto-name'

test('infers only consistent patterns from at least three named siblings', () => {
  expect(collectionNamingPattern(['2026-01-01-one.md', '2026-01-02-two.md', '2026-01-03-three.md', 'untitled-2.md'])).toEqual({ kind: 'date' })
  expect(collectionNamingPattern(['001-one.md', '002-two.md', '004-four.md'])).toEqual({ kind: 'number', width: 3, next: 3 })
  expect(collectionNamingPattern(['one.md', 'two.md', 'three.md'])).toEqual({ kind: 'plain' })
  expect(collectionNamingPattern(['001-one.md', '002-two.md'])).toEqual({ kind: 'plain' })
  expect(collectionNamingPattern(['001-one.md', '002-two.md', 'three.md'])).toEqual({ kind: 'plain' })
})

test('uses the collection title field, skips placeholders and only takes a new title', () => {
  const before = '# untitled\n'
  const after = '---\ntitle: A printed title\n---\n# A working heading\n'
  expect(newCollectionTitle(before, after, 'metadata')).toBe('A printed title')
  expect(newCollectionTitle(before, after, 'heading')).toBe('A working heading')
  expect(newCollectionTitle(before, '## A subheading\n\nA setext title\n==============\n', 'heading')).toBe('A setext title')
  expect(newCollectionTitle(before, '# untitled\n', 'heading')).toBeNull()
  expect(newCollectionTitle('# Already titled\n', after, 'heading')).toBeNull()
})

test('uses a date from metadata or creation and disambiguates names', () => {
  expect(collectionName('Fresh Draft', '---\ndate: 2026-01-02\n---\n', '2026-11-19', { kind: 'date' }, ['2026-01-02-fresh-draft.md'])).toBe('2026-01-02-fresh-draft-2.md')
  expect(collectionName('Fresh Draft', '', '2026-11-19', { kind: 'date' }, [])).toBe('2026-11-19-fresh-draft.md')
  expect(collectionName('Fresh Draft', '', '2026-11-19', { kind: 'number', width: 3, next: 3 }, [])).toBe('003-fresh-draft.md')
  expect(collectionName('Fresh Draft', '', '2026-11-19', { kind: 'plain' }, ['Fresh-Draft.md'])).toBe('fresh-draft-2.md')
  expect(collectionName('京都 日記', '', '2026-11-19', { kind: 'plain' }, [])).toBe('京都-日記.md')
})

test('locates the heading or metadata title in the saved editor text', () => {
  const body = '---\ntitle: A printed title\n---\n\n## Lower heading\n\n# The history of printing\n\nBody.\n'
  const metadata = collectionNamingTitle('', body, 'metadata')!
  const heading = collectionNamingTitle('', body, 'heading')!
  expect(body.slice(metadata.range!.from, metadata.range!.to)).toBe('title: A printed title')
  expect(body.slice(heading.range!.from, heading.range!.to)).toBe('# The history of printing')
  expect(collectionNamingTitle('', '# On the last line', 'heading')!.range).toEqual({ from: 0, to: 18 })
  expect(collectionNamingTitle('', '# untitled\n', 'either')).toBeNull()
})
