import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BoardCardChips, BoardCardDrawer, startDrawerScrapDrag } from '../../src/renderer/src/components/BoardCardMaterial'
import { SCRAP_DRAG_MIME, writeScrapDrag } from '../../src/renderer/src/editor/scraps'

const drawer = {
  scraps: [
    { id: 's_one', text: "Hall's high and low context cultures: every culture has both.", firstWords: "Hall's high and low context cultures…" },
    { id: 's_two', text: 'Families share more context.', firstWords: 'Families share more context.' },
  ],
  moreScraps: 0,
  sources: [
    { title: 'Hall 1976 notes', path: 'research/hall-1976-notes.md' },
    { title: 'Bartlett, Remembering', path: 'research/bartlett-remembering.md' },
  ],
  moreSources: 3,
}

test('a card shows a scraps chip and a sources chip with singular and plural counts', () => {
  const html = renderToStaticMarkup(<BoardCardChips row={{ title: 'How humans hallucinate', scrapCount: 2, sourceCount: 1 }} drawerOpen={false} onToggleDrawer={() => {}} />)
  expect(html).toContain('class="bc-chip scraps"')
  expect(html).toContain('>2 scraps<')
  expect(html).toContain('class="bc-chip sources"')
  expect(html).toContain('>1 source<')
  expect(html).toContain('aria-expanded="false"')
})

test('a card with neither scraps nor sources shows no chip, and a zero kind has no chip of its own', () => {
  expect(renderToStaticMarkup(<BoardCardChips row={{ title: 'Bare', scrapCount: 0, sourceCount: 0 }} drawerOpen={false} onToggleDrawer={() => {}} />)).toBe('')
  const onlySources = renderToStaticMarkup(<BoardCardChips row={{ title: 'Tools', scrapCount: 0, sourceCount: 2 }} drawerOpen onToggleDrawer={() => {}} />)
  expect(onlySources).not.toContain('scraps')
  expect(onlySources).toContain('>2 sources<')
  expect(onlySources).toContain('aria-expanded="true"')
})

test('the drawer lists scraps by first words, sources by title, and "+ n more"', () => {
  const html = renderToStaticMarkup(<BoardCardDrawer row={{ title: 'How humans hallucinate', drawer }} />)
  expect(html).toContain('class="bc-drawer"')
  expect(html.match(/class="bc-dr-it scrap"/g)).toHaveLength(2)
  expect(html).toContain('draggable="true"')
  expect(html).toContain('Hall&#x27;s high and low context cultures…')
  expect(html).toContain('Hall 1976 notes')
  expect(html).toContain('Bartlett, Remembering')
  expect(html).toContain('+ 3 more sources')
  expect(html).not.toContain('more scrap')
  expect(renderToStaticMarkup(<BoardCardDrawer row={{ title: 'Bare' }} />)).toBe('')
})

test('dragging a drawer scrap writes the Scratchpad payload and never starts the card drag', () => {
  const fakeTransfer = (): { data: Map<string, string>; effectAllowed: string; setData: (type: string, value: string) => void } => {
    const data = new Map<string, string>()
    return { data, effectAllowed: 'none', setData: (type, value) => { data.set(type, value) } }
  }
  const fromDrawer = fakeTransfer()
  let stopped = false
  startDrawerScrapDrag({ dataTransfer: fromDrawer as unknown as DataTransfer, stopPropagation: () => { stopped = true } }, drawer.scraps[0])

  const fromScratchpad = fakeTransfer()
  writeScrapDrag(fromScratchpad as unknown as DataTransfer, { id: 's_one', text: drawer.scraps[0].text })

  expect(stopped).toBe(true)
  expect(JSON.parse(fromDrawer.data.get(SCRAP_DRAG_MIME)!)).toEqual({ id: 's_one', text: drawer.scraps[0].text })
  expect([...fromDrawer.data]).toEqual([...fromScratchpad.data])
  expect(fromDrawer.effectAllowed).toBe('move')
})
