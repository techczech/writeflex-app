import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Toolbar } from '../../src/renderer/src/components/Toolbar'
import { normaliseLeftPaneTab } from '../../src/renderer/src/app/pane-layout'

test('a saved layout whose left tab was the old Tabs tab opens on Files', () => {
  expect(normaliseLeftPaneTab('open')).toBe('files')
  expect(normaliseLeftPaneTab('outline')).toBe('outline')
  expect(normaliseLeftPaneTab('search')).toBe('search')
  expect(normaliseLeftPaneTab('files')).toBe('files')
  expect(normaliseLeftPaneTab(undefined)).toBe('files')
  expect(normaliseLeftPaneTab('nonsense')).toBe('files')
})

const toolbar = (open: boolean) => renderToStaticMarkup(
  <Toolbar
    sidebarOpen
    onToggleSidebar={() => {}}
    panelsOpen
    onTogglePanels={() => {}}
    writerMode="drafting"
    viewMode="clean"
    modeDrawerOpen={false}
    onModeDrawerOpenChange={() => {}}
    onSelectWriterMode={() => {}}
    onSelectViewMode={() => {}}
    readingRoomOpen={false}
    readingRoomShortcut="⌃⌘R"
    onToggleReadingRoom={() => {}}
    onOpenPalette={() => {}}
    onToggleTabsList={() => {}}
    tabsListOpen={open}
    tabsShortcut="⌘2"
    tabsPopover={<div className="open-tabs-section">list</div>}
    actionBarVisible
    onToggleActionBar={() => {}}
  >
    <button className="tab">one.md</button>
  </Toolbar>,
)

test('the toolbar reads: sidebar toggle, book, Tabs button, tabs', () => {
  const html = toolbar(false)
  const order = ['aria-label="Toggle sidebar"', 'Reading Room"', 'aria-label="Tabs"', 'class="tabstrip"']
  const at = order.map((needle) => html.indexOf(needle))
  expect(at.every((index) => index >= 0)).toBe(true)
  expect([...at].sort((a, b) => a - b)).toEqual(at)
  expect(html).toContain('title="Tabs (⌘2)"')
  expect(html).not.toContain('tabs-popover')
})

test('the popover renders under the Tabs button only while open, with the list inside', () => {
  const html = toolbar(true)
  expect(html).toContain('aria-expanded="true"')
  const popover = html.indexOf('class="tabs-popover"')
  expect(popover).toBeGreaterThan(html.indexOf('aria-label="Tabs"'))
  expect(popover).toBeLessThan(html.indexOf('class="tabstrip"'))
  expect(html).toContain('open-tabs-section')
})
