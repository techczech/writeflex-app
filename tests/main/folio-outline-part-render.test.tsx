import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FolioOutlinePart } from '../../src/renderer/src/components/FolioOutline'
import { folioKeyAction, folioTabStop, type FolioKeyRow } from '../../src/shared/folio-outline'

const outline = {
  dir: 'p', name: 'p',
  pieces: [
    { path: 'p/a.md', title: 'Alpha', headings: [{ level: 1, text: 'Alpha', line: 1 }, { level: 2, text: 'On disk', line: 3 }] },
    { path: 'p/b.md', title: 'Beta', headings: [{ level: 2, text: 'Other', line: 3 }] },
  ],
  also: [
    { path: 'p/g.md', title: 'Glossary', headings: [], addable: true },
    { path: 'p/h.md', title: 'Huge', headings: [], tooLarge: true, addable: true },
  ],
}
const render = (needle: string, extra: Record<string, unknown> = {}): string => renderToStaticMarkup(
  <FolioOutlinePart
    outline={((extra.outline as unknown) ?? outline) as never}
    openPath="p/a.md"
    bufferPath="p/a.md"
    bufferHeadings={[{ level: 1, from: 0, text: 'Alpha' }, { level: 2, from: 9, text: 'Unsaved heading' }]}
    activeFrom={null}
    needle={needle}
    levelLimit={null}
    expanded={new Map()}
    onToggle={() => {}}
    onOpenFile={() => {}}
    onJumpToFile={() => {}}
    onJumpOpen={() => {}}
    listRef={{ current: null }}
    onMovePiece={() => {}}
    onAdd={() => {}}
    busy={false}
    justAdded={[]}
    announcement=""
    touched={null}
    onFocusedRow={() => {}}
    onOpenPlan={() => {}}
    {...extra}
  />,
)

test('a filter matching an unsaved heading of the open piece keeps that piece, and a disk-only heading no longer matches', () => {
  const kept = render('unsaved')
  expect(kept).toContain('Unsaved heading')
  expect(kept).toContain('Alpha')
  expect(kept).not.toContain('data-fokey="piece:1:p/b.md"')
  expect(render('on disk')).not.toContain('data-fokey="piece:0:p/a.md"')
})

test('the two groups are labelled groups and the sticky headings stay outside them', () => {
  const html = render('')
  expect(html).toContain('id="fo-grp-run"')
  expect(html).toContain('role="group" aria-labelledby="fo-grp-run"')
  expect(html).toContain('role="group" aria-labelledby="fo-grp-also"')
  expect(html).toMatch(/<div class="fo-sec fo-pin" id="fo-grp-run" role="presentation">/)
})

test('a file over the size bound says so in its expanded state', () => {
  const html = render('', { expanded: new Map([['also:p/h.md', true]]) })
  expect(html).toContain('Too large to outline')
})

test('exactly one row is a tab stop when the stored row is filtered out: the open piece, else the first shown row', () => {
  const html = render('')
  expect(html.match(/tabindex="0"/g)?.length).toBe(1)
  expect(folioTabStop(['piece:1:b', 'also:g'], 'piece:0:a:h0', 'piece:0:a')).toBe('piece:1:b')
  expect(folioTabStop(['piece:0:a', 'piece:1:b'], 'piece:1:b:h0', 'piece:0:a')).toBe('piece:0:a')
  expect(folioTabStop(['piece:0:a', 'piece:1:b'], 'piece:0:a', null)).toBe('piece:0:a')
  expect(folioTabStop([], 'x', null)).toBeNull()
})

const ROWS: FolioKeyRow[] = [
  { key: 'piece:0:a', file: true, expanded: true },
  { key: 'piece:0:a:h0', file: false, parent: 'piece:0:a' },
  { key: 'piece:0:a:h1', file: false, parent: 'piece:0:a' },
  { key: 'piece:1:b', file: true, expanded: false },
  { key: 'also:g', file: true },
]

test('Right on a collapsed piece expands it; Right on an expanded piece goes to its first heading', () => {
  expect(folioKeyAction(ROWS, 'piece:1:b', 'ArrowRight', false)).toEqual({ toggle: { key: 'piece:1:b', open: true } })
  expect(folioKeyAction(ROWS, 'piece:0:a', 'ArrowRight', false)).toEqual({ focus: 'piece:0:a:h0' })
  expect(folioKeyAction(ROWS, 'also:g', 'ArrowRight', false)).toEqual({})
})

test('Left on an expanded piece collapses it; Left on a heading goes to its piece, not the previous heading', () => {
  expect(folioKeyAction(ROWS, 'piece:0:a', 'ArrowLeft', false)).toEqual({ toggle: { key: 'piece:0:a', open: false } })
  expect(folioKeyAction(ROWS, 'piece:0:a:h1', 'ArrowLeft', false)).toEqual({ focus: 'piece:0:a' })
  expect(folioKeyAction(ROWS, 'piece:0:a:h1', 'ArrowLeft', true)).toEqual({ focus: 'piece:0:a' })
  expect(folioKeyAction(ROWS, 'piece:1:b', 'ArrowLeft', false)).toEqual({})
})

test('Up, Down, Home and End move through the shown rows and stop at the ends', () => {
  expect(folioKeyAction(ROWS, 'piece:0:a:h1', 'ArrowDown', false)).toEqual({ focus: 'piece:1:b' })
  expect(folioKeyAction(ROWS, 'also:g', 'ArrowDown', false)).toEqual({ focus: 'also:g' })
  expect(folioKeyAction(ROWS, 'piece:0:a', 'ArrowUp', false)).toEqual({ focus: 'piece:0:a' })
  expect(folioKeyAction(ROWS, 'piece:1:b', 'End', false)).toEqual({ focus: 'also:g' })
  expect(folioKeyAction(ROWS, 'piece:1:b', 'a', false)).toBeNull()
})

test('a buffer read from another file is ignored: the open piece shows its disk headings and its click navigates by line', () => {
  // The snapshot is from p/a.md, but p/b.md is open (a tab switch the snapshot has not caught up with).
  const html = render('', { openPath: 'p/b.md', bufferPath: 'p/a.md', expanded: new Map([['piece:1:p/b.md', true]]) })
  expect(html).toContain('Other')
  expect(html).not.toContain('Unsaved heading')
  // The open row's title is B's own, not the first heading of A's buffer.
  expect(html).toMatch(/data-fokey="piece:1:p\/b.md"[^>]*title="Beta"/)
  // Its heading rows are built from disk data (a line, no editor offset), so a click goes to the line of that file.
  // (No DOM here: the e2e tab-switch test clicks one.)
  expect(html).toContain('data-heading-level="2"')
})

test('each piece has a grip and a drag hint; none while a filter is on, and files under Also in this folder have no grip', () => {
  const html = render('')
  expect(html.match(/class="fo-grip"/g)?.length).toBe(2)
  expect(html).toContain('title="Drag to move Alpha in the running order"')
  expect(html).toContain('drag to reorder')
  expect(render('alpha')).not.toContain('class="fo-grip"')
  expect(render('alpha')).not.toContain('drag to reorder')
})

test('an addable file has an Add button with the spec tooltip and name; a file the Folio never admits has none; Add all counts only the addable', () => {
  const mixed = { ...outline, also: [
    { path: 'p/g.md', title: 'Glossary', headings: [], addable: true },
    { path: 'p/_p_INDEX.md', title: 'Index', headings: [], addable: false },
    { path: 'p/s.md', title: 'Snippets', headings: [], addable: true },
  ] }
  const html = render('', { outline: mixed })
  expect(html.match(/class="fo-add"/g)?.length).toBe(2)
  expect(html).toContain('title="Add Snippets to the end of the running order"')
  expect(html).toContain('aria-label="Add Snippets to the running order"')
  expect(html).not.toContain('Add Index')
  expect(html).toContain('Add all 2')
  expect(html).toContain('title="Add all 2 to the end of the running order, in file-name order"')
  const none = render('', { outline: { ...outline, also: [{ path: 'p/_p_INDEX.md', title: 'Index', headings: [], addable: false }] } })
  expect(none).not.toContain('fo-addall')
  expect(none).not.toContain('class="fo-add"')
})

test('the pieces carry a box for the drop maths, the last Add is tinted, and the live region speaks the announcement', () => {
  const html = render('', { justAdded: ['p/b.md'], announcement: '3 pieces added to the running order.' })
  expect(html.match(/data-fo-box="/g)?.length).toBe(2)
  expect(html).toMatch(/fo-piece[^"]* fo-new[^"]*"[^>]*data-fo-path="p\/b.md"/)
  expect(html).toContain('role="status" aria-live="polite" data-fo-live="true">3 pieces added to the running order.</div>')
  expect(html).not.toContain('data-fo-dropline')
})

test('a Folio the Outline cannot change shows no grip, no Add, no Add all and no drag hint; one line sends the owner to the Plan', () => {
  const able = render('')
  expect(able).toContain('data-fo-add="p/g.md"')
  expect(able).toContain('data-fo-addall')
  expect(able).toContain('drag to reorder')
  expect(able).not.toContain('data-fo-plan-only')
  const html = render('', { outline: { ...outline, orderInPlanOnly: true } })
  expect(html).toContain('data-fo-plan-only="true"')
  expect(html).toContain('Change this Folio’s order in the Plan.')
  expect(html).toContain('data-fo-open-plan="true"')
  expect(html).not.toContain('data-fo-add=')
  expect(html).not.toContain('data-fo-addall')
  expect(html).not.toContain('drag to reorder')
  expect(html).not.toMatch(/class="fo-grip" /)
  // The rows themselves are still there to open.
  expect(html).toContain('data-fokey="piece:0:p/a.md"')
})
