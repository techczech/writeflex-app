import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Change } from '../../src/preload'
import { countMenu, whoChipLabel, withoutWho, NARROW_REASON, type CountMenuRow } from '../../src/renderer/src/app/margin-count-menu'
import { buildMarginModel, type MarginFilter } from '../../src/renderer/src/app/margin-model'
import { EMPTY_HEAD_FILTER, type HeadFilterState } from '../../src/renderer/src/app/margin-head-state'
import { ReviewCountMenu } from '../../src/renderer/src/components/ReviewCountMenu'

const DOC = 'Alpha one. Beta two. Gamma three. Delta four. Epsilon five. Zeta six.'
const base = (id: string, oldText: string, newText: string): Change => ({
  id, path: 'draft.md', ts: 1, provenance: 'agent', editClass: 'content', category: 'wording', summary: id, oldText, newText, status: 'pending', isCorrection: false,
})
const reader = (c: Change): Change => ({ ...c, provenance: 'reviewer', outsideSource: 'reader', readerNote: { shareId: 's1', key: 'k', link: 'Seminar group', name: 'Marta', kind: 'note', text: 'hm', quote: 'q', anchored: 'unchanged', at: 1 } } as Change)
const claude = (c: Change, session: string): Change => ({ ...c, provenance: 'reviewer', outsideSource: 'claude-code', outsideRequest: { id: session, index: 1, count: 1, at: Date.UTC(2026, 9, 18, 21, 12) } } as Change)
const changes: Change[] = [
  base('e1', 'Alpha one.', 'Alpha 1.'),
  base('n1', 'Beta two.', 'Beta two.'),
  reader(base('rn', 'Gamma three.', 'Gamma three.')),
  claude({ ...base('c1', '', ' More.'), editClass: 'insert', insertAfter: 'Delta four.' } as Change, 'sess-1'),
  { ...base('e2', 'Epsilon five.', ''), category: 'cuts' },
]
const model = (filter: MarginFilter = {}) => buildMarginModel({ changes, document: DOC, view: 'margin', filter })
const shown = (filter: MarginFilter): string[] => { const m = model(filter); return [...m.cards, ...m.unplaced].map((item) => item.id).sort() }
const input = (state: HeadFilterState = EMPTY_HEAD_FILTER, extra: Record<string, unknown> = {}) => ({ model: model(state.filter), state, preferredView: 'margin' as const, textRoom: 800, marginHidden: false, ...extra })
const items = (rows: CountMenuRow[]) => rows.flatMap((row) => (row.kind === 'item' ? [row] : []))
const labels = (rows: CountMenuRow[]): string[] => rows.map((row) => (row.kind === 'item' ? row.label : row.kind === 'heading' ? `# ${row.label}` : '---'))

test('the rows come in the drawn order, with Comments wording and each row only under its condition', () => {
  const rows = countMenu(input())
  expect(labels(rows)).toEqual([
    'Next item', 'Previous item', '---',
    'Accept all 3 edits', 'Mark all 2 comments done', 'Decline all…', 'Send back to the agent…', '---',
    '# Show items from', 'Everyone', 'Agent', 'Readers', 'Through “Seminar group”', 'Claude Code', 'REQUEST', 'Kind of edit', '---',
    'Settled today', 'My edits', 'Show quiet fixes', '---',
    'Margin', 'Inline', 'Hide the margin', 'Save version…',
  ].map((label) => (label === 'REQUEST' ? items(rows).find((row) => row.id.startsWith('who-request'))!.label : label)))
  // Next piece only when something waits elsewhere; Held both only when one is held; Send back only with agent items shown.
  expect(items(rows).some((row) => row.id === 'next-piece' || row.id === 'held')).toBe(false)
  const others = buildMarginModel({ changes, document: DOC, view: 'margin', others: [{ ...base('x', 'a', 'b'), path: 'other.md' }] })
  expect(items(countMenu({ ...input(), model: others })).map((row) => row.id)).toContain('next-piece')
  const heldChanges = changes.map((c) => (c.id === 'e1' ? { ...c, status: 'held' as const } : c))
  const held = buildMarginModel({ changes: heldChanges, document: DOC, view: 'margin' })
  expect(items(countMenu({ ...input(), model: held })).find((row) => row.id === 'held')).toMatchObject({ count: 1, checked: false })
  const readersOnly = input({ ...EMPTY_HEAD_FILTER, filter: { sources: new Set(['readers']) } })
  expect(items(countMenu(readersOnly)).map((row) => row.id)).not.toContain('send-back')
  expect(items(countMenu(readersOnly)).map((row) => row.id)).not.toContain('decline-all')
})

test('who rows count their source, check the chosen one, and choosing sets one source, link or request', () => {
  const rows = items(countMenu(input()))
  const byId = (id: string) => rows.find((row) => row.id === id)!
  expect(byId('who-everyone')).toMatchObject({ count: 5, checked: true })
  expect(byId('who-source:readers')).toMatchObject({ count: 1, checked: false })
  expect(byId('who-link:s1')).toMatchObject({ count: 1, nested: true })
  const action = byId('who-source:readers').action
  expect(action?.type).toBe('state')
  const chosen = (action as { state: HeadFilterState }).state
  expect([...chosen.filter.sources!]).toEqual(['readers'])
  const after = items(countMenu(input(chosen)))
  expect(after.find((row) => row.id === 'who-source:readers')?.checked).toBe(true)
  expect(after.find((row) => row.id === 'who-everyone')?.checked).toBe(false)
  // Counts follow: the margin model under this filter holds the readers' items only, and Everyone clears it.
  expect(model(chosen.filter).counts.shown).toBe(1)
  expect(whoChipLabel(chosen.filter, model(chosen.filter))).toBe('Readers')
  expect(withoutWho(chosen).filter.sources).toBeUndefined()
  const request = (byId(items(countMenu(input())).find((row) => row.id.startsWith('who-request'))!.id).action as { state: HeadFilterState }).state
  expect(whoChipLabel(request.filter, model())).toMatch(/^Request of \d\d:\d\d$/)
  const link = (byId('who-link:s1').action as { state: HeadFilterState }).state
  expect(whoChipLabel(link.filter, model())).toBe('Through “Seminar group”')
  expect(whoChipLabel({}, model())).toBeNull()
})

test('Kind of edit opens a panel whose rows really narrow the model, and who combines with kind', () => {
  const kind = items(countMenu(input())).find((row) => row.id === 'kind-of-edit')!
  const sub = items(kind.submenu!)
  expect(sub.map((row) => row.label)).toEqual(['Insertions only', 'Deletions only', 'Wording', 'Cuts'])
  const pick = (id: string, state = EMPTY_HEAD_FILTER): HeadFilterState => (sub.find((row) => row.id === id)!.action as { state: HeadFilterState }).state
  const deletions = pick('kind-deletions')
  expect(deletions.filter.direction).toBe('deletions')
  expect(shown(deletions.filter)).toEqual(['e2'])
  const insertions = pick('kind-insertions')
  expect(shown(insertions.filter)).toEqual(['c1'])
  const cuts = pick('kind-category:cuts')
  expect(shown(cuts.filter)).toEqual(['e2'])
  // Combined with who: only the Claude Code insertion.
  const both = { ...insertions, filter: { ...insertions.filter, sources: new Set(['outside:Claude Code']) } }
  expect(shown(both.filter)).toEqual(['c1'])
  // The row that is on is checked and pressing it again turns it off.
  const on = items(items(countMenu(input(deletions))).find((row) => row.id === 'kind-of-edit')!.submenu!)
  expect(on.find((row) => row.id === 'kind-deletions')?.checked).toBe(true)
  expect(((on.find((row) => row.id === 'kind-deletions')!.action) as { state: HeadFilterState }).state.filter.direction).toBeNull()
})

test('Margin is off with too little room beside the text, with the reason; Under is ticked; the margin row reads Show when hidden', () => {
  const narrow = items(countMenu(input(EMPTY_HEAD_FILTER, { textRoom: 399 })))
  expect(narrow.find((row) => row.id === 'view-margin')).toMatchObject({ enabled: false, checked: false, reason: NARROW_REASON })
  expect(NARROW_REASON).toBe('Not enough room beside the text: widen the window or close a side pane')
  expect(narrow.find((row) => row.id === 'view-under')?.checked).toBe(true)
  const wide = items(countMenu(input()))
  expect(wide.find((row) => row.id === 'view-margin')).toMatchObject({ enabled: true, checked: true })
  expect(items(countMenu(input(EMPTY_HEAD_FILTER, { marginHidden: true }))).find((row) => row.id === 'toggle-margin')?.label).toBe('Show the margin')
  // 2026-10-19: 400 px of text room keeps the margin, and Margin is a real choice there; unmeasured room counts as room.
  expect(items(countMenu(input(EMPTY_HEAD_FILTER, { textRoom: 400 }))).find((row) => row.id === 'view-margin')).toMatchObject({ enabled: true, checked: true })
  expect(items(countMenu(input(EMPTY_HEAD_FILTER, { textRoom: 400, preferredView: 'under' }))).find((row) => row.id === 'view-margin')).toMatchObject({ enabled: true, checked: false })
  expect(items(countMenu(input(EMPTY_HEAD_FILTER, { textRoom: null }))).find((row) => row.id === 'view-margin')).toMatchObject({ enabled: true, checked: true })
})

test('Settled today, My edits and Show quiet fixes flip today’s head switches', () => {
  const rows = items(countMenu(input({ ...EMPTY_HEAD_FILTER, settled: true, showQuiet: true })))
  expect(rows.find((row) => row.id === 'settled')).toMatchObject({ checked: true, enabled: true })
  expect((rows.find((row) => row.id === 'settled')!.action as { state: HeadFilterState }).state.settled).toBe(false)
  expect((rows.find((row) => row.id === 'quiet')!.action as { state: HeadFilterState }).state.showQuiet).toBe(false)
  const mine = (items(countMenu(input())).find((row) => row.id === 'my-edits')!)
  expect(mine.enabled).toBe(false)
})

test('the menu draws every row as a menu item, checked and disabled states in the markup', () => {
  const html = renderToStaticMarkup(<ReviewCountMenu rows={countMenu(input(EMPTY_HEAD_FILTER, { textRoom: 399 }))} onPick={() => {}} onClose={() => {}} />)
  expect(html).toContain('role="menu"')
  expect(html).toContain('data-menu-id="who-everyone"')
  expect(html).toMatch(/data-menu-id="view-margin"[^>]*>/)
  expect(html).toContain('aria-disabled="true"')
  expect(html).toContain('Not enough room beside the text')
  expect(html).toContain('aria-haspopup="menu"')
  expect(html).toContain('Mark all 2 comments done')
})

test('Save version… sits below the view rows with its chord and runs the existing save-version action', () => {
  const rows = countMenu(input(EMPTY_HEAD_FILTER, { chords: { saveVersion: '⇧⌘S' } }))
  const ids = items(rows).map((row) => row.id)
  expect(ids.slice(-4)).toEqual(['view-margin', 'view-under', 'toggle-margin', 'save-version'])
  const row = items(rows).find((candidate) => candidate.id === 'save-version')!
  expect(row).toMatchObject({ label: 'Save version…', shortcut: '⇧⌘S', enabled: true, action: { type: 'save-version' } })
  // Present with the margin hidden and in a narrow window too: it is there whenever the menu is.
  expect(items(countMenu(input(EMPTY_HEAD_FILTER, { marginHidden: true }))).some((candidate) => candidate.id === 'save-version')).toBe(true)
  expect(items(countMenu(input(EMPTY_HEAD_FILTER, { textRoom: 100 }))).some((candidate) => candidate.id === 'save-version')).toBe(true)
  // Drawn: choosing it hands the action to the one pick handler.
  const picked: unknown[] = []
  const html = renderToStaticMarkup(<ReviewCountMenu rows={rows} onPick={(action) => picked.push(action)} onClose={() => undefined} />)
  expect(html).toContain('data-menu-id="save-version"')
  expect(html).toContain('Save version…')
})
