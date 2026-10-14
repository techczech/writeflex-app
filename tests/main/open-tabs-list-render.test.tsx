import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TabBar, type OpenTabsSort } from '../../src/renderer/src/components/TabBar'
import { tabStripView, type TabState } from '../../src/renderer/src/hooks/tab-state'

// The Open tabs list (direction D, frames D1–D3): By folder is the default sort; Pinned first, the
// strip group next labelled "on the strip", then the rest by last activity. Other sorts keep today's
// Pinned / Recent / "Not in the strip" grouping.
const TALK = 'talks/ai-foundations-2026'
const groupOf = (path: string): string => path.startsWith(`${TALK}/`) ? TALK : path.slice(0, Math.max(0, path.lastIndexOf('/')))
const state: TabState = {
  tabs: ['reading/wolf.md', 'notebooks/reading/dyslexia.md', 'metaphor-series/machine.md', `${TALK}/parts/01.md`, `${TALK}/parts/02.md`, 'drafts/reading/other.md'],
  active: `${TALK}/parts/01.md`,
  pinned: ['reading/wolf.md'],
  recent: [`${TALK}/parts/01.md`, 'metaphor-series/machine.md', 'drafts/reading/other.md', `${TALK}/parts/02.md`, 'notebooks/reading/dyslexia.md', 'reading/wolf.md'],
}
const view = tabStripView(state, groupOf)

const render = (sort?: OpenTabsSort): string => renderToStaticMarkup(
  <TabBar
    orientation="sidebar"
    tabs={state.tabs}
    active={state.active}
    pinned={state.pinned}
    recent={state.recent}
    groups={view.groups}
    rootName="writing"
    visibleInStrip={view.strip}
    dirtyPaths={new Set()}
    onActivate={() => {}}
    onClose={() => {}}
    onNew={() => {}}
    onPin={() => {}}
    {...(sort ? { initialSort: sort } : {})}
  />,
)

/** Group headings and row names in document order. */
function outline(html: string): string[] {
  const out: string[] = []
  for (const match of html.matchAll(/<div class="open-tabs-group([^"]*)"[^>]*>(.*?)<\/div>|<span class="name">(.*?)<\/span>/g)) {
    if (match[3] !== undefined) out.push(`  ${match[3]}`)
    else out.push(`[${match[2].replace(/<svg.*?<\/svg>/g, '').replace(/<span class="on-strip-label">(.*?)<\/span>/, ' ($1)').replace(/<[^>]+>/g, '')}]${match[1].includes('on-strip') ? '*' : ''}`)
  }
  return out
}

test('By folder is the default sort and lists Pinned, the strip group, then the rest by last activity', () => {
  const html = render()
  expect(html).toContain('aria-label="Sort tabs: By folder"')
  expect(outline(html)).toEqual([
    '[Pinned]',
    '  wolf.md',
    '[ai-foundations-2026 (on the strip)]*',
    '  01.md',
    '  02.md',
    '[metaphor-series]',
    '  machine.md',
    '[drafts / reading]',
    '  other.md',
    '[notebooks / reading]',
    '  dyslexia.md',
  ])
  expect(html).not.toContain('Not in the strip')
  expect(html).not.toContain('>Recent<')
})

test('the other sorts still group by Pinned, Recent and Not in the strip', () => {
  for (const sort of ['changed', 'opened', 'name'] as const) {
    const html = render(sort)
    expect(html).toContain('>Recent<')
    expect(html).toContain('Not in the strip · 3')
    expect(html).not.toContain('on the strip</span>')
  }
})

test('every open tab is still listed exactly once as a clickable tab row in By folder', () => {
  const rows = [...render().matchAll(/role="tab"[^>]*title="([^"]+)"/g)].map((match) => match[1])
  expect(rows.sort()).toEqual([...state.tabs].sort())
})
