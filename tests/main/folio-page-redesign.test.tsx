// The Folio page redesign (2026-10-19, 0.26): the agent pill's text and menu, the side rail's Selected part and
// Front matter slot, the card's tree, the Cover band and the closable Not in the outline.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { agentPillItemFor, agentPillModel } from '../../src/renderer/src/plan/agent-instructions-pill'
import { FolioFrontMatterSlot, FolioSelectedPanel, partLengthText } from '../../src/renderer/src/components/FolioRail'
import { PlanPartList, PlanUnlistedList } from '../../src/renderer/src/components/PlanView'
import { buildPlanRows } from '../../src/renderer/src/plan/plan-view-model'
import type { FolioAgentInstructionsStatus } from '../../src/shared/folio-agent-files'
import type { Plan } from '../../src/preload'

const status = (over: Partial<FolioAgentInstructionsStatus> = {}): FolioAgentInstructionsStatus => ({ dir: 'r', agentsPath: 'r/AGENTS.md', claudePath: 'r/CLAUDE.md', agents: 'current', claude: 'imports', written: [], ...over })

test('the pill reads as plain text, with nothing to choose, once both files exist', () => {
  const model = agentPillModel(status())
  expect(model.state).toBe('written')
  expect(model.items).toEqual([])
  expect(model.label).toBe('Agent instructions: written')
  expect(model.canOpen).toBe(true)
})

test('neither file: the pill is a menu to write both, or either one', () => {
  const model = agentPillModel(status({ agents: 'missing', claude: 'missing' }))
  expect(model.state).toBe('none')
  expect(model.label).toBe('Agent instructions: not written')
  expect(model.items.map((item) => [item.id, item.label, item.steps])).toEqual([
    ['both', 'Write AGENTS.md and CLAUDE.md', ['restore', 'write-claude']],
    ['agents', 'Write AGENTS.md only', ['restore']],
    ['claude', 'Write CLAUDE.md only', ['write-claude']],
  ])
  expect(model.canOpen).toBe(false)
})

test('one file missing: a menu with that one write, no "both" and no "only"', () => {
  const claude = agentPillModel(status({ claude: 'missing' }))
  expect(claude.state).toBe('partial')
  expect(claude.label).toBe('Agent instructions: CLAUDE.md not written')
  expect(claude.items.map((item) => item.label)).toEqual(['Write CLAUDE.md'])
  const own = agentPillModel(status({ claude: 'own' }))
  expect(own.items.map((item) => item.label)).toEqual(['Add the import line to CLAUDE.md'])
  const agents = agentPillModel(status({ agents: 'missing' }))
  expect(agents.items.map((item) => item.label)).toEqual(['Write AGENTS.md'])
  expect(agentPillItemFor(agents, 'both')).toBeNull()
})

test('an edited AGENTS.md offers Restore in the menu; a damaged or unreadable file is plain text that says so', () => {
  const edited = agentPillModel(status({ agents: 'edited' }))
  expect(edited.state).toBe('edited')
  expect(edited.items.map((item) => item.label)).toEqual(['Restore WriteFlex’s part of AGENTS.md'])
  const damaged = agentPillModel(status({ agents: 'damaged' }))
  expect(damaged.state).toBe('attention')
  expect(damaged.items).toEqual([])
  expect(damaged.title).toContain('marker line')
  expect(agentPillModel(status({ agents: 'unreadable' })).canOpen).toBe(false)
})

const rowsOf = (parts: Plan['parts']) => buildPlanRows({ dir: 'r', indexPath: 'r/I.md', headingLine: 1, parts, unlisted: [] }, [])
const part = (title: string, role: string, path: string | null, extra: Record<string, unknown> = {}) => ({ title, gloss: null, role, tags: [], path, line: 1, ...extra }) as Plan['parts'][number]

test('a card shows its headings as a tree, with its role and words; the front-matter title page is a Cover band', () => {
  const rows = rowsOf([part('Cover title', 'front-matter', 'r/00.md', { titlePage: true }), part('Report', 'section', 'r/02.md')])
  const trees = new Map([['r/02.md', [{ text: 'Proposed policy', depth: 1 }, { text: 'Detail', depth: 2 }]]])
  const html = renderToStaticMarkup(<PlanPartList rows={rows.slice(1)} selected={1} composer={null} endIndex={2} onSelect={() => {}} onOpen={() => {}} onDragStart={() => {}} onDrop={() => {}} trees={trees} />)
  expect(html).toContain('data-plan-tree="r/02.md"')
  expect(html.match(/class="pnode"/g)).toHaveLength(2)
  expect(html).toContain('margin-left:14px')
  expect(html).toContain('Section')
  const band = renderToStaticMarkup(<PlanPartList rows={rows.slice(0, 1)} selected={null} composer={null} label="Front matter" coverIndex={0} onSelect={() => {}} onOpen={() => {}} onDragStart={() => {}} onDrop={() => {}} />)
  expect(band).toContain('data-plan-band="true"')
  expect(band).toContain('>Cover<')
  expect(band).toContain('not in the contents')
})

test('a card flags a title that differs from its heading; the fix buttons are the rail’s', () => {
  const rows = rowsOf([part('Two', 'section', 'r/two.md', { heading: { mode: 'own', title: 'Two', mismatch: true, frontmatterTitle: 'Two', headingText: 'Zwei', fingerprint: 'x' } })])
  const html = renderToStaticMarkup(<PlanPartList rows={rows} selected={null} composer={null} onSelect={() => {}} onOpen={() => {}} onDragStart={() => {}} onDrop={() => {}} />)
  expect(html).toContain('data-plan-card-flag="title-differs"')
  expect(html).not.toContain('data-plan-title-fix')
})

test('the Selected part panel: role, file, length and the heading switch; nothing selected says so', () => {
  const [row] = rowsOf([part('Report', 'section', 'contents/02-report.md')])
  const html = renderToStaticMarkup(<FolioSelectedPanel row={{ ...row, words: 982 }} headingCount={6} roleControl={<i>ROLE</i>} headingControl={<i>SWITCH</i>} />)
  expect(html).toContain('data-plan-selected-panel="true"')
  expect(html).toContain('contents/02-report.md')
  expect(html).toContain('982 words · 6 headings')
  expect(html).toContain('ROLE')
  expect(html).toContain('SWITCH')
  expect(partLengthText(null, null)).toBe('not written yet')
  expect(partLengthText(1, 1)).toBe('1 word · 1 heading')
  expect(renderToStaticMarkup(<FolioSelectedPanel row={null} headingCount={null} roleControl={null} headingControl={null} />)).toContain('Select a part')
})

const noop = () => {}
test('the Front matter slot: "None yet" with Choose a file while empty; a line with Take out once filled', () => {
  const offer = { index: 0, title: 'Cover title', path: 'r/00-front.md', refusal: null }
  const empty = renderToStaticMarkup(<FolioFrontMatterSlot rows={[]} selected={null} offers={[offer]} busy={false} menuOpen={false} onMenuOpen={noop} onSelect={noop} onChoose={noop} onTakeOut={noop} />)
  expect(empty).toContain('None yet')
  expect(empty).toContain('Choose a file')
  expect(empty).toContain('The title page below can go here')
  expect(empty).not.toMatch(/data-plan-choose-front="true"[^>]*disabled/)
  const none = renderToStaticMarkup(<FolioFrontMatterSlot rows={[]} selected={null} offers={[]} busy={false} menuOpen={false} onMenuOpen={noop} onSelect={noop} onChoose={noop} onTakeOut={noop} />)
  expect(none).toMatch(/data-plan-choose-front="true"[^>]*disabled/)
  const open = renderToStaticMarkup(<FolioFrontMatterSlot rows={[]} selected={null} offers={[offer]} busy={false} menuOpen={true} onMenuOpen={noop} onSelect={noop} onChoose={noop} onTakeOut={noop} />)
  expect(open).toContain('data-plan-choose-front-item="r/00-front.md"')
  const rows = rowsOf([part('Cover title', 'front-matter', 'r/00-front.md', { titlePage: true })])
  const filled = renderToStaticMarkup(<FolioFrontMatterSlot rows={rows} selected={0} offers={[]} busy={false} menuOpen={false} onMenuOpen={noop} onSelect={noop} onChoose={noop} onTakeOut={noop} />)
  expect(filled).not.toContain('None yet')
  expect(filled).toContain('data-plan-take-out-front="r/00-front.md"')
  expect(filled).toContain('the export’s cover')
})

test('Not in the outline can be closed: the heading stays, the files go', () => {
  const unlisted = [part('Notes', 'section', 'r/03-notes.md')]
  const open = renderToStaticMarkup(<PlanUnlistedList parts={unlisted} onAdopt={noop} onToggle={noop} />)
  expect(open).toContain('aria-expanded="true"')
  expect(open).toContain('data-plan-put-back="r/03-notes.md"')
  const closed = renderToStaticMarkup(<PlanUnlistedList parts={unlisted} onAdopt={noop} onToggle={noop} closed />)
  expect(closed).toContain('Not in the outline · 1')
  expect(closed).toContain('aria-expanded="false"')
  expect(closed).not.toContain('data-plan-put-back')
})
