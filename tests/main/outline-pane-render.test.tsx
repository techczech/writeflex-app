import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { OutlinePane } from '../../src/renderer/src/components/OutlinePane'
import type { EditorSnapshot } from '../../src/renderer/src/hooks/useEditorSnapshot'

test('document outline derives a compact H1 through H5 indent and caps deeper levels', () => {
  const snapshot: EditorSnapshot = {
    path: 'outline.md',
    docText: '',
    countText: '',
    outline: [1, 2, 3, 4, 5, 6].map((level, index) => ({
      level,
      from: index * 10,
      text: `Heading ${level}`,
    })),
    selHead: 0,
    selFrom: 0,
    selTo: 0,
    selEmpty: true,
  }

  const html = renderToStaticMarkup(
    <OutlinePane
      editorRef={{ current: null }}
      snapshot={snapshot}
      activePath="outline.md"
      onJumpToFile={() => {}}
      savedTick={0}
      focusTick={0}
      shortcutFor={() => null}
      request={null}
      folioPlace={null}
      folderFileCount={0}
      onOpenFile={() => {}}
      onOpenPlan={() => {}}
      onOpenBoard={() => {}}
      onStatus={() => {}}
    />,
  )

  expect(html).toContain('data-heading-level="1" style="padding-left:8px"')
  expect(html).toContain('data-heading-level="2" style="padding-left:16px"')
  expect(html).toContain('data-heading-level="3" style="padding-left:24px"')
  expect(html).toContain('data-heading-level="4" style="padding-left:32px"')
  expect(html).toContain('data-heading-level="5" style="padding-left:40px"')
  expect(html).toContain('data-heading-level="6" style="padding-left:40px"')
})

test('the header bar reads ↑ ↓ ← → | collapse-all expand-all, then a Levels drop-down at the right', () => {
  const html = renderToStaticMarkup(
    <OutlinePane
      editorRef={{ current: null }}
      snapshot={{ path: 'outline.md', docText: '', countText: '', outline: [{ level: 1, from: 0, text: 'One' }, { level: 3, from: 10, text: 'Deep' }], selHead: 0, selFrom: 0, selTo: 0, selEmpty: true }}
      activePath="outline.md"
      onJumpToFile={() => {}}
      savedTick={0}
      focusTick={0}
      shortcutFor={(id) => (id === 'outline.moveBlockUp' ? '⌥⌘↑' : null)}
      request={null}
      folioPlace={null}
      folderFileCount={0}
      onOpenFile={() => {}}
      onOpenPlan={() => {}}
      onOpenBoard={() => {}}
      onStatus={() => {}}
    />,
  )
  const bar = html.slice(html.indexOf('class="ol-bar"'), html.indexOf('class="facet-row"'))
  const labels = [...bar.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1])
  expect(labels).toEqual(['Outline actions', 'Move up', 'Move down', 'Promote', 'Demote', 'Collapse all', 'Expand all', 'Levels'])
  expect(bar).toContain('title="Move up (⌥⌘↑)"')
  expect(bar.indexOf('ol-bar-sep')).toBeLessThan(bar.indexOf('Collapse all'))
  expect(bar.indexOf('class="ol-levels"')).toBeGreaterThan(bar.indexOf('Expand all'))
  expect(bar).toMatch(/class="ol-levels"[^>]*>All/)
  // every heading row carries the drag grip, none is picked, and word counts are on by default
  expect(html.match(/class="ol-grip"/g)).toHaveLength(2)
  expect(html.match(/class="ol-count"/g)).toHaveLength(2)
  expect(html).not.toContain('ol-hidden')
  expect(html).not.toContain('ol-selbar')
})

const SWITCH_PROPS = {
  editorRef: { current: null },
  snapshot: null,
  onJumpToFile: () => {},
  savedTick: 0,
  focusTick: 0,
  shortcutFor: () => null,
  request: null,
  folderFileCount: 0,
  onOpenFile: () => {},
  onOpenPlan: () => {},
  onOpenBoard: () => {},
  onStatus: () => {},
}

test('the switch reads Document | Folio for a Folio file, Document | Folder otherwise, and Folder is disabled with no file open', () => {
  const inFolio = renderToStaticMarkup(<OutlinePane {...SWITCH_PROPS} activePath="paper/a.md" folioPlace={{ dir: 'paper', name: 'paper', kind: 'piece', position: 1, total: 1, previous: null, next: null }} />)
  expect(inFolio).toMatch(/data-scope="file"[^>]*>\s*Document/)
  expect(inFolio).toMatch(/data-scope="folio"[^>]*>Folio</)
  expect(inFolio).not.toContain('Make a Folio')
  const plain = renderToStaticMarkup(<OutlinePane {...SWITCH_PROPS} activePath="notes/a.md" folioPlace={null} />)
  expect(plain).toMatch(/data-scope="folder"[^>]*>Folder</)
  expect(plain).not.toContain('data-scope="folio"')
  const none = renderToStaticMarkup(<OutlinePane {...SWITCH_PROPS} activePath={null} folioPlace={null} />)
  expect(none).toMatch(/data-scope="folder"[^>]*disabled/)
  expect(none).toContain('No piece is open. Open one to see its outline.')
  expect(inFolio).not.toContain('class="pane-head"')
})

test('a snapshot read from another file than the open one is not drawn: no headings of A under B', () => {
  const stale = { path: 'a.md', docText: '# A heading\n', countText: '', outline: [{ level: 1, from: 0, text: 'A heading' }], selHead: 0, selFrom: 0, selTo: 0, selEmpty: true }
  const html = renderToStaticMarkup(<OutlinePane {...SWITCH_PROPS} snapshot={stale} activePath="b.md" folioPlace={null} />)
  expect(html).not.toContain('A heading')
  const same = renderToStaticMarkup(<OutlinePane {...SWITCH_PROPS} snapshot={stale} activePath="a.md" folioPlace={null} />)
  expect(same).toContain('A heading')
})

const paneHtml = (snapshotPath: string, outline: Array<{ level: number; from: number; text: string }>): string => renderToStaticMarkup(
  <OutlinePane
    editorRef={{ current: null }}
    snapshot={{ path: snapshotPath, docText: '', countText: '', outline, selHead: 0, selFrom: 0, selTo: 0, selEmpty: true }}
    activePath="b.md"
    onJumpToFile={() => {}}
    savedTick={0}
    focusTick={0}
    shortcutFor={() => null}
    request={null}
    folioPlace={null}
    folderFileCount={0}
    onOpenFile={() => {}}
    onOpenPlan={() => {}}
    onOpenBoard={() => {}}
    onStatus={() => {}}
  />,
)

test('a snapshot of another file renders no rows and no "No headings yet", and marks the list busy', () => {
  const html = paneHtml('a.md', [{ level: 1, from: 0, text: 'Old heading' }])
  expect(html).not.toContain('Old heading')
  expect(html).not.toContain('data-heading-level')
  expect(html).not.toContain('No headings yet')
  expect(html).toContain('aria-busy="true"')
})

test('a matching snapshot with zero headings says "No headings yet" and is not busy', () => {
  const html = paneHtml('b.md', [])
  expect(html).toContain('No headings yet')
  expect(html).not.toContain('aria-busy')
})
