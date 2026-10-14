import { expect, test } from 'bun:test'
import { comparePieces, parseQuery, pieceTitle, snippetOf } from '../../src/main/search-query'
import { documentTitle } from '../../src/main/frontmatter'

// The parser seam of ticket 01: matchPiece (piece semantics), matchName (rule 1), the rank
// comparator and the snippet window. Line semantics (matchLine) are covered in workspace.test.ts.

test('matchPiece: every word somewhere in the piece, any order, any lines', () => {
  const m = parseQuery('reader expectation')
  const piece = m.matchPiece(['intro', 'The reader arrives.', 'middle', 'An expectation forms.'])
  expect(piece).toMatchObject({ index: 1, distinct: 1, hits: 2 })
  expect(m.matchPiece(['The reader arrives.', 'nothing else'])).toBeNull()
})

test('matchPiece: the best line holds the most distinct terms, then the most hits, then comes first', () => {
  const m = parseQuery('cat dog')
  expect(m.matchPiece(['cat', 'dog', 'a cat and a dog'])?.index).toBe(2)
  expect(m.matchPiece(['cat', 'cat cat', 'dog'])?.index).toBe(1)
  expect(m.matchPiece(['dog', 'cat'])?.index).toBe(0)
})

test('matchPiece: marks every term span on the best line, merged where they overlap', () => {
  const m = parseQuery('read reader')
  const piece = m.matchPiece(['the reader reads'])
  expect(piece?.marks).toEqual([{ column: 5, length: 6 }, { column: 12, length: 4 }])
  expect(piece?.hit).toEqual({ column: 5, length: 4 }) // the earliest term, first term winning a tie
})

test('matchPiece: OR accepts any term; a negative line counts for nothing', () => {
  const or = parseQuery('cat OR dog')
  expect(or.matchPiece(['only a dog'])?.index).toBe(0)
  const not = parseQuery('cat dog -bird')
  expect(not.matchPiece(['cat', 'dog and bird'])).toBeNull()
  expect(not.matchPiece(['cat', 'dog and bird', 'dog'])?.index).toBe(0)
})

test('a quoted phrase is one term that must sit on one line, in order', () => {
  const m = parseQuery('"reader expectation"')
  expect(m.matchPiece(['reader', 'expectation'])).toBeNull()
  expect(m.matchPiece(['the expectation of the reader'])).toBeNull()
  expect(m.matchPiece(['on Reader\texpectation'])?.hit).toEqual({ column: 4, length: 18 })
  expect(m.matchLine('reader expectation')).toEqual({ column: 1, length: 18 })
  // A negative phrase filters lines like a negative word.
  expect(parseQuery('reader -"no thanks"').matchPiece(['reader, no thanks'])).toBeNull()
  // An empty or unclosed quote does not break the query.
  expect(parseQuery('"" reader').matchPiece(['reader'])?.index).toBe(0)
  expect(parseQuery('"reader exp').matchPiece(['a reader expects'])?.index).toBe(0)
})

test('matchName: the name or the title holds every term; separators in names read as spaces', () => {
  const m = parseQuery('reader expectation')
  expect(m.matchName('reader-expectation.md', '')).toBe(true)
  expect(m.matchName('notes.md', 'On reader expectation')).toBe(true)
  expect(m.matchName('reader.md', 'Expectation')).toBe(false) // split across name and title
  expect(parseQuery('"reader expectation"').matchName('reader_expectation.md', '')).toBe(true)
  expect(parseQuery('tag:draft').matchName('draft.md', 'draft')).toBe(false) // no terms, no rule 1
})

test('comparePieces orders by name/title, distinct, hits, recency; 0 on a full tie', () => {
  const base = { nameMatch: false, distinct: 1, hits: 1, modifiedAt: 0 }
  expect(comparePieces({ ...base, nameMatch: true }, { ...base, distinct: 5, hits: 50, modifiedAt: 9 })).toBeLessThan(0)
  expect(comparePieces({ ...base, distinct: 2 }, { ...base, hits: 50 })).toBeLessThan(0)
  expect(comparePieces({ ...base, hits: 2 }, { ...base, modifiedAt: 9 })).toBeLessThan(0)
  expect(comparePieces({ ...base, modifiedAt: 9 }, base)).toBeLessThan(0)
  expect(comparePieces(base, { ...base })).toBe(0)
})

test('snippetOf: a short line is the whole snippet; a long one is windowed on word boundaries', () => {
  expect(snippetOf('short line', [{ column: 1, length: 5 }])).toEqual({ text: 'short line', marks: [{ column: 1, length: 5 }] })
  const line = `${'alpha beta gamma '.repeat(10)}TARGET ${'delta epsilon '.repeat(12)}`
  const snip = snippetOf(line, [{ column: line.indexOf('TARGET') + 1, length: 6 }], 60)
  expect(snip.text.startsWith('…')).toBe(true)
  expect(snip.text.endsWith('…')).toBe(true)
  expect(snip.text.slice(1, 2)).not.toBe(' ')
  const [mark] = snip.marks
  expect(snip.text.slice(mark.column - 1, mark.column - 1 + mark.length)).toBe('TARGET')
  // A mark that falls outside the window is dropped rather than misplaced.
  const far = snippetOf(line, [{ column: 1, length: 5 }, { column: line.length - 5, length: 5 }], 40)
  expect(far.marks).toHaveLength(1)
})

test('pieceTitle gives the same answer as documentTitle without parsing the whole piece', () => {
  const docs = [
    '# Plain heading\n\nbody',
    '---\ntitle: Legacy key\ntags: [a]\n---\n\n## Second-level *emphasis* [[target|label]]\n\nbody',
    'Setext title\n===\n\nbody\n\n# Later ATX',
    'intro paragraph\n\n---\n\nafter a rule\n\n# Real heading',
    '```\n# not a heading, in a fence\n```\n\n# Fenced before, heading after',
    'no heading at all\njust prose',
    '',
    '#hashtag is not a heading\n\n### Third',
    `${'---\n\n'.repeat(12)}# Past many rules`,
  ]
  for (const doc of docs) expect(pieceTitle(doc, 'folder/the-file.md')).toBe(documentTitle(doc, 'folder/the-file.md'))
})
