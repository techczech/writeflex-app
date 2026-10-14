import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { SearchExcerpt, SearchResultList } from '../../src/renderer/src/components/SearchResultList'
import { capNote, markSegments, piecesLabel } from '../../src/renderer/src/search-hits'
import type { SearchMatch } from '../../src/preload'

function match(path: string, text: string, marks: SearchMatch['snippet']['marks']): SearchMatch {
  return {
    path, line: 4, column: marks[0]?.column ?? 1, length: marks[0]?.length ?? 0,
    preview: text, marks, context: { before: [], after: [] }, snippet: { text, marks },
  }
}

test('one row per piece: file name, folder path, and the snippet with every term marked', () => {
  const html = renderToStaticMarkup(
    <SearchResultList
      results={{
        query: 'reader expectation',
        total: 2,
        matches: [
          match('talks/ai/parts/01-opening.md', 'what the reader already expects; that expectation…', [
            { column: 10, length: 6 },
            { column: 39, length: 11 },
          ]),
          match('priming.md', 'a reader here', [{ column: 3, length: 6 }]),
        ],
      }}
      selected={0}
      onHover={() => {}}
      onOpen={() => {}}
    />,
  )
  expect(html.match(/class="search-hit"/g)).toHaveLength(2)
  expect(html).toContain('<span class="search-hit-name">01-opening.md</span><span class="search-hit-folder">talks/ai/parts/</span>')
  expect(html).toContain('<mark>reader</mark>')
  expect(html).toContain('<mark>expectation</mark>')
  expect(html).toContain('2 pieces for')
  // A root-level file has no folder segment.
  expect(html).toContain('<span class="search-hit-name">priming.md</span></span>')
  expect(html).not.toContain('search-capnote')
})

test('over the cap the list says how many pieces there are in total', () => {
  const html = renderToStaticMarkup(
    <SearchResultList
      results={{ query: 'river', total: 1240, matches: [match('a.md', 'river', [{ column: 1, length: 5 }])] }}
      selected={0}
      onHover={() => {}}
      onOpen={() => {}}
    />,
  )
  expect(html).toContain('1,240 pieces for')
  expect(html).toContain('Showing 1 of 1,240 pieces — narrow the query')
})

test('capNote and piecesLabel read naturally; markSegments splits text around marks', () => {
  expect(capNote(300, 300)).toBeNull()
  expect(capNote(300, 1240)).toBe('Showing 300 of 1,240 pieces — narrow the query')
  expect(piecesLabel(1)).toBe('1 piece')
  expect(markSegments('a reader here', [{ column: 3, length: 6 }])).toEqual([
    { text: 'a ', marked: false },
    { text: 'reader', marked: true },
    { text: ' here', marked: false },
  ])
  // A mark past the end is clipped; a zero-length mark is not drawn.
  expect(markSegments('abc', [{ column: 1, length: 0 }, { column: 3, length: 9 }])).toEqual([
    { text: 'ab', marked: false },
    { text: 'c', marked: true },
  ])
})

test('the preview marks every term of a multi-word query on the full line, not just the first', () => {
  const line = 'Here the reader meets an expectation, and the reader adjusts.'
  const hit: SearchMatch = {
    path: 'talks/piece.md', line: 6, column: 10, length: 6, preview: line,
    marks: [{ column: 10, length: 6 }, { column: 26, length: 11 }, { column: 47, length: 6 }],
    context: { before: ['Before it.'], after: ['After it.'] },
    snippet: { text: line, marks: [{ column: 10, length: 6 }] },
  }
  const html = renderToStaticMarkup(<SearchExcerpt hit={hit} />)
  expect(html.match(/<mark>[^<]*<\/mark>/g)).toEqual(['<mark>reader</mark>', '<mark>expectation</mark>', '<mark>reader</mark>'])
  expect(html).toContain('piece.md · line 6')
  expect(html).toContain('Before it.')
  expect(html).toContain('After it.')
  // The line reads whole around the marks.
  expect(html.replace(/<[^>]+>/g, '')).toContain(line)
})

test('the preview clips a mark past its 200-char cap and shows the empty state with no hit', () => {
  const preview = `${'x'.repeat(195)}river`
  const hit: SearchMatch = {
    path: 'long.md', line: 1, column: 196, length: 5, preview,
    marks: [{ column: 196, length: 5 }, { column: 230, length: 5 }],
    context: { before: [], after: [] },
    snippet: { text: 'river', marks: [{ column: 1, length: 5 }] },
  }
  expect(renderToStaticMarkup(<SearchExcerpt hit={hit} />).match(/<mark>/g)).toHaveLength(1)
  expect(renderToStaticMarkup(<SearchExcerpt hit={undefined} />)).toContain('no hit selected')
})
