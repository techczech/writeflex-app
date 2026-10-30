import { test, expect } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FolioOutlinePart } from '../../src/renderer/src/components/FolioOutline'
import { PartRoleControl } from '../../src/renderer/src/components/PlanView'
import { folioKeyAction } from '../../src/shared/folio-outline'

test('sidebar section headings contain nested members and collapse them, without renumbering indexes', () => {
  const render = (expanded: boolean) => renderToStaticMarkup(<FolioOutlinePart outline={{ dir: '', name: 'Book', also: [], pieces: [ { path: 's.md', title: 'Section', headings: [], sectionPage: true }, { path: 'a.md', title: 'Alpha', headings: [] } ] }} openPath={null} bufferPath={null} bufferHeadings={[]} activeFrom={null} needle="" levelLimit={null} expanded={new Map([['piece:0:s.md', expanded]])} onToggle={() => {}} onOpenFile={() => {}} onJumpToFile={() => {}} onJumpOpen={() => {}} listRef={{ current: null }} onMovePiece={() => {}} onAdd={() => {}} busy={false} justAdded={[]} announcement="" touched={null} onFocusedRow={() => {}} onOpenPlan={() => {}} />)
  expect(render(true)).toContain('Contents · 1 section · 1 chapter')
  expect(render(true)).toContain('Section page')
  expect(render(true)).toContain('aria-level="2"')
  expect(render(false)).not.toContain('data-fo-path="a.md"')
  expect(render(true)).toContain('data-fo-box="1"')
})

test('role control offers the file mark with its explanatory sentence', () => {
  const html = renderToStaticMarkup(<PartRoleControl title="Opening" role="section-page" onChoose={() => {}} />)
  expect(html).toContain('value="section-page" selected="">Section page')
  expect(html).toContain('Starts a section: every part after it belongs here until the next section page.')
})

test('sidebar arrows enter a section and return from a nested part', () => {
  const rows = [{ key: 's', file: true, expanded: true }, { key: 'a', file: true, parent: 's' }]
  expect(folioKeyAction(rows, 's', 'ArrowRight', false)).toEqual({ focus: 'a' })
  expect(folioKeyAction(rows, 'a', 'ArrowLeft', false)).toEqual({ focus: 's' })
})

import { FolioRoomOutline } from '../../src/renderer/src/components/FolioRoomOutline'
import type { RoomPart } from '../../src/shared/folio-room'

test('room draws the approved tinted band, counts only section members and preserves running-order indexes', () => {
  const part = (index: number, title: string, words: number, sectionPage = false): RoomPart => ({
    index, title, words, written: true, frontMatter: false, synopsis: null, label: null, priority: null, status: 'draft', tags: [], role: 'section', flags: [], titleClash: null,
    key: { title, path: `${title}.md` }, card: { title, path: `${title}.md`, gloss: null, role: 'section', tags: [] },
    outline: { path: `${title}.md`, title, headings: [], ...(sectionPage ? { sectionPage: true } : {}) },
  })
  const html = renderToStaticMarkup(<FolioRoomOutline parts={[part(1, 'Intro', 10), part(2, 'Opening', 50, true), part(3, 'Alpha', 100), part(4, 'Beta', 200)]} shown={2} listRef={{ current: null }} onSelect={() => {}} onKeyDown={() => {}} drag={{ props: () => ({ draggable: true }) } as never} />)
  expect(html).toContain('fr-section-band')
  expect(html).toContain('fr-section-member')
  expect(html).toContain('2 parts · 300 words')
  expect(html).toContain('Collapse all sections')
  expect(html).toContain('Collapse section Opening')
  expect(html).toContain('data-part-index="4"')
})
