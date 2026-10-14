import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BoardSource } from '../../src/renderer/src/components/board-projection'
import { SourceCarryHint, SourcesRail, sourceUseLine } from '../../src/renderer/src/components/BoardSources'
import { BoardActivity } from '../../src/renderer/src/components/BoardOffcuts'

// Scraps ticket 03, locked design frames 1, 4, 7 and 8: the Sources rail, its empty state, its
// collapsed strip, and the activity row a source step leaves.

const noop = () => {}
const source = (path: string, title: string, users: string[]): BoardSource => ({
  path, title, usedBy: users.map((user) => ({ path: `c/${user}.md`, title: user })),
})
const sources = [
  source('c/research/hall.md', 'Hall 1976 notes', ['How humans hallucinate']),
  source('c/research/bartlett.md', 'Bartlett, Remembering', ['How humans hallucinate', 'Tools of reason']),
  source('c/research/schank.md', 'Schank & Abelson, Scripts', []),
  source('c/research/minsky.md', 'Minsky, Frames', []),
]
const rail = (props: Partial<Parameters<typeof SourcesRail>[0]> = {}) => renderToStaticMarkup(
  <SourcesRail sources={sources} collapsed={false} selectedKey={null} carryingPath={null}
    onToggle={noop} onSelect={noop} onOpen={noop} onDragStart={noop} onDragEnd={noop} {...props} />,
)

test('the rail lists each source with the pieces that use it; an unused one is dashed', () => {
  const html = rail({ selectedKey: 'source:c/research/schank.md' })
  expect(html).toContain('aria-label="Sources"')
  expect(html).toContain('>Sources · 4<')
  expect(html.match(/class="bsrc[ "]/g)).toHaveLength(4)
  expect(html).toContain('How humans hallucinate · Tools of reason')
  expect(html.match(/class="bsrc unused/g)).toHaveLength(2)
  expect(html).toContain('class="bsrc unused sel"')
  // Only the first unused source carries the drag hint (frame 1).
  expect(html).toContain('not used yet · drag onto a card')
  expect(html.match(/not used yet/g)).toHaveLength(2)
  expect(html).toContain('draggable="true"')
  expect(html).toContain('From research/ in this collection')
  expect(html).toContain('aria-label="Hide sources"')
  expect(sourceUseLine(sources[2], false)).toBe('not used yet')
})

test('with no research notes the rail says where sources come from', () => {
  const html = rail({ sources: [] })
  expect(html).toContain('>Sources · 0<')
  expect(html).toContain('This collection has no research notes yet. Add Markdown notes to a <code>research/</code> folder in it, and they appear here.')
  expect(html).not.toContain('class="bsrc ')
})

test('collapsed, the rail is a strip that shows the count and opens it again', () => {
  const html = rail({ collapsed: true })
  expect(html).toContain('class="bsrc-rail collapsed"')
  expect(html).toContain('aria-label="Show sources (4)"')
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain('>Sources · 4<')
  expect(html).not.toContain('Hall 1976 notes')
})

test('a carried source is marked in the rail and named in the hint', () => {
  expect(rail({ carryingPath: 'c/research/schank.md' })).toContain('class="bsrc unused carrying"')
  const hint = renderToStaticMarkup(<SourceCarryHint source={sources[2]} />)
  expect(hint).toContain('Attaching “Schank &amp; Abelson, Scripts”: choose a card and press <kbd>⏎</kbd> · <kbd>Esc</kbd> cancels')
})

test('a source step leaves "Source attached" with Undo, in the sources blue', () => {
  const html = renderToStaticMarkup(<BoardActivity activity={{ text: 'Source attached', stepId: 'rp1', tone: 'source' }} onUndo={noop} />)
  expect(html).toContain('ba-tick source')
  expect(html).toContain('Source attached')
  expect(html).toContain('Undo <kbd>⌘⇧Z</kbd>')
})
