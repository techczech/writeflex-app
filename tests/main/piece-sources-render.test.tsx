import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { LISTED_SHOWN, PieceSourcesList, visibleSources, type PieceSourcesListProps } from '../../src/renderer/src/components/PieceSources'
import type { PieceSourceListing, SourceListEntry } from '../../src/shared/piece-sources'
import { sourceStatusLine } from '../../src/shared/piece-sources'

// Scraps ticket 04, locked design frame 5: the list of a piece's sources.

const noop = () => {}
const entry = (title: string, status: SourceListEntry['status'], cited = 0): SourceListEntry => ({
  title, path: `c/research/${title}.md`, status, cited, links: cited, authorYear: 0,
})
const listing = (overrides: Partial<PieceSourceListing> = {}): PieceSourceListing => ({
  piece: 'c/how.md', pieceTitle: 'How humans hallucinate', dir: 'c',
  entries: [
    entry('Hall 1976 notes', 'listed'), entry('Bartlett, Remembering', 'both', 2), entry('Edward T. Hall, Beyond Culture', 'cited', 1),
    entry('a', 'listed'), entry('b', 'listed'), entry('c', 'listed'),
  ],
  ambiguous: [], authorYearMatching: { notesWithMetadata: 3, notesTotal: 3, available: true, message: null },
  ...overrides,
})
const render = (props: Partial<PieceSourcesListProps> = {}) => renderToStaticMarkup(
  <PieceSourcesList listing={listing()} expanded={false} addingPath={null} notice={null} onExpand={noop} onAdd={noop} onOpen={noop} {...props} />,
)

test('each source says listed, listed and cited n times, or cited and not listed with Add to sources', () => {
  const html = render()
  expect(html).toContain('Sources of How humans hallucinate · 6')
  expect(html).toContain('>listed<')
  expect(html).toContain('listed · cited 2×')
  expect(html).toContain('cited in the text, not listed')
  expect(html.match(/Add to sources/g)).toHaveLength(1)
  expect(html).toContain('class="psrc-item unlisted"')
  expect(sourceStatusLine({ status: 'both', cited: 3 })).toBe('listed · cited 3×')
})

test('only the first listed sources show; the rest fold into "+ n more listed" until expanded', () => {
  expect(LISTED_SHOWN).toBe(2)
  const html = render()
  expect(html).toContain('+ 3 more listed')
  expect(html).not.toContain('>c<')
  const all = render({ expanded: true })
  expect(all).not.toContain('more listed')
  expect(all).toContain('>c<')
  expect(visibleSources(listing().entries, false).shown.map((shown) => shown.title)).toEqual(['Hall 1976 notes', 'Bartlett, Remembering', 'Edward T. Hall, Beyond Culture'])
})

test('an ambiguous author–year citation is shown with its candidates and offers no add', () => {
  const html = render({
    listing: listing({ entries: [], ambiguous: [{ text: 'Hall 1976', count: 2, candidates: [{ path: 'c/research/a.md', title: 'Hall A' }, { path: 'c/research/b.md', title: 'Hall B' }] }] }),
  })
  expect(html).toContain('Hall 1976 · 2×')
  expect(html).toContain('ambiguous: fits Hall A or Hall B; not counted')
  expect(html).not.toContain('Add to sources')
})

test('the list says when author–year matching was unavailable, and shows an add notice with Undo', () => {
  const html = render({
    listing: listing({ authorYearMatching: { notesWithMetadata: 0, notesTotal: 2, available: false, message: 'Author–year matching was unavailable: x' } }),
    notice: { text: 'Source attached: Edward T. Hall, Beyond Culture', refused: false, undo: noop },
  })
  expect(html).toContain('Author–year matching was unavailable')
  expect(html).toContain('Source attached: Edward T. Hall, Beyond Culture')
  expect(html).toContain('>Undo<')
  expect(render({ listing: listing({ entries: [] }) })).toContain('lists no sources and cites none')
})
