import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FolioLine, folioPositionText } from '../../src/renderer/src/components/FolioLine'
import { Toolbar } from '../../src/renderer/src/components/Toolbar'
import type { FolioPlace } from '../../src/shared/folio-place'

const place = (over: Partial<FolioPlace> = {}): FolioPlace => ({
  dir: 'paper', name: 'UnityBC Paper', kind: 'piece', position: 3, total: 31,
  previous: { path: 'paper/2.md', title: '2. Related work' }, next: { path: 'paper/4.md', title: '4. Participants' }, ...over,
})
const noop = (): void => {}
const line = (p: FolioPlace): string => renderToStaticMarkup(<FolioLine place={p} onOpenPlan={noop} onOpenPiece={noop} />)

test('the line holds the Folio name, the position and both neighbours with full accessible names', () => {
  const html = line(place())
  expect(html).toContain('<nav class="folio-line" aria-label="Folio"')
  expect(html).toContain('aria-label="Open the Plan for UnityBC Paper"')
  expect(html).toContain('3 of 31')
  expect(html).toContain('aria-label="Previous piece: 2. Related work"')
  expect(html).toContain('aria-label="Next piece: 4. Participants"')
  expect(html.match(/<button type="button"/g)?.length).toBe(3)
})

test('an absent neighbour leaves its place empty and the other in place', () => {
  const first = line(place({ position: 1, previous: null }))
  expect(first).not.toContain('Previous piece')
  expect(first).toContain('<span class="fl-slot prev"></span>')
  expect(first).toContain('Next piece: 4. Participants')
  expect(line(place({ position: 31, next: null }))).toContain('<span class="fl-slot next"></span>')
})

test('the Index Note and an unlisted file say so in place of a position', () => {
  expect(folioPositionText({ kind: 'index', position: null, total: 5 })).toBe('Index Note')
  expect(line(place({ kind: 'index', position: null, previous: null }))).toContain('Index Note')
  expect(line(place({ kind: 'unlisted', position: null, previous: null, next: null }))).toContain('Not in the running order')
})

const toolbar = (folioName?: string | null): string =>
  renderToStaticMarkup(
    <Toolbar
      sidebarOpen onToggleSidebar={noop} panelsOpen onTogglePanels={noop} writerMode="drafting" viewMode="clean"
      modeDrawerOpen={false} onModeDrawerOpenChange={noop} onSelectWriterMode={noop} onSelectViewMode={noop}
      readingRoomOpen={false} readingRoomShortcut="⌃⌘R" onToggleReadingRoom={noop} onOpenPalette={noop}
      actionBarVisible onToggleActionBar={noop} folioName={folioName} onOpenFolioPlan={noop}
    />,
  )

test('the title bar adds nothing without a Folio and the Plan button with one, before the mode control', () => {
  expect(toolbar(null)).not.toContain('planbtn')
  expect(toolbar(undefined)).toBe(toolbar(null))
  const html = toolbar('UnityBC Paper')
  expect(html).toContain('aria-label="Open the Plan for UnityBC Paper"')
  expect(html).toContain('<span class="pb-plan">Plan</span><span class="pb-name">UnityBC Paper</span>')
  expect(html.indexOf('planbtn')).toBeLessThan(html.indexOf('modebtn'))
  expect(html.indexOf('planbtn')).toBeGreaterThan(html.indexOf('class="tabstrip"'))
})
