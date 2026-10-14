import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { documentIdentityLabel, Toolbar } from '../../src/renderer/src/components/Toolbar'
import { formatSidebarTabTime, measurementOverflowLabel } from '../../src/renderer/src/components/TabBar'
import { commandRegistry } from '../../src/renderer/src/commands/registry'
import { effectiveSheetChords } from '../../src/renderer/src/commands/chords'

test('toolbar keeps one control per action and gives every control a visible chord', () => {
  const html = renderToStaticMarkup(
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
      onOpenPalette={() => {}}
    />,
  )
  expect(html).not.toContain('aria-label="Snapshots"')
  expect(html).not.toContain('aria-label="Account"')
  expect(html).not.toContain('class="app-name"')
  expect(html).not.toContain('class="searchfield"')
  expect(html).not.toContain('aria-label="Toggle Changes panel"')
  expect(html).not.toContain('aria-label="Toggle agent panel"')
  expect(html).toContain('aria-label="Toggle panels"')
  expect(html.match(/class="chord"/g)?.length).toBe(5)
})

test('document identity remains available for the native window title without duplicating it in the toolbar', () => {
  expect(documentIdentityLabel('agent-skills.md', 'content')).toBe('agent-skills.md — content')
  const html = renderToStaticMarkup(
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
      onOpenPalette={() => {}}
    />,
  )
  expect(html).not.toContain('agent-skills.md')
  expect(html).not.toContain('content')
})

test('the tab measurement row is flex and samples a realistic overflow digit count', async () => {
  const css = await Bun.file(new URL('../../src/renderer/src/styles/app.css', import.meta.url)).text()
  expect(css).toMatch(/\.tab-measure\{[^}]*display:flex/)
  expect(measurementOverflowLabel(9)).toBe('+9')
  expect(measurementOverflowLabel(12)).toBe('+12')
})

test('sidebar tab times match the locked compact minute, hour and yesterday format', () => {
  const now = Date.UTC(2026, 6, 17, 12, 0)
  expect(formatSidebarTabTime(now - 2 * 60_000, now)).toBe('2m')
  expect(formatSidebarTabTime(now - 59 * 60_000, now)).toBe('59m')
  expect(formatSidebarTabTime(now - 60 * 60_000, now)).toBe('1h')
  expect(formatSidebarTabTime(now - 3 * 60 * 60_000, now)).toBe('3h')
  expect(formatSidebarTabTime(now - 25 * 60 * 60_000, now)).toBe('yest')
})

test('mode drawer carries the locked two axes and byte-exact session copy', () => {
  const html = renderToStaticMarkup(<Toolbar sidebarOpen onToggleSidebar={() => {}} panelsOpen onTogglePanels={() => {}} writerMode="drafting" viewMode="clean" modeDrawerOpen onModeDrawerOpenChange={() => {}} onSelectWriterMode={() => {}} onSelectViewMode={() => {}} onOpenPalette={() => {}} />)
  expect(html).toContain('Text is text. Your edits are recorded quietly.')
  expect(html).toContain('Reveals this session — old struck, new highlighted.')
  expect(html).toContain('>Clean</span>')
  expect(html.match(/role="menuitemradio"/g)?.length).toBe(5)
})

test('chrome 0.6 shortcut registry exposes the six provisional chords without the retired Files filter chord', () => {
  const rows = commandRegistry.filter((command) => command.surfaces.includes('sheet')).map((command) => `${command.label}:${effectiveSheetChords(command, {}).join('|')}`)
  for (const chord of ['⌥⌘R', '⌘F', '⌘G', '⇧⌘G', '⌥⌘F', '⌥⌘D']) expect(rows.some((row) => row.includes(chord))).toBe(true)
  expect(rows.some((row) => row.startsWith('Filter Files sidebar:'))).toBe(false)
})

test('renderer copy contains none of the superseded tracking claims', async () => {
  const glob = new Bun.Glob('**/*.{ts,tsx}')
  const hits: string[] = []
  for await (const path of glob.scan(new URL('../../src/renderer/src', import.meta.url).pathname)) {
    const text = await Bun.file(new URL(`../../src/renderer/src/${path}`, import.meta.url)).text()
    if (/your edits are tracked|edits become text|tracked as changes/i.test(text)) hits.push(path)
  }
  expect(hits).toEqual([])
})
