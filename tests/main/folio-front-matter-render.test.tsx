// Folio front matter on screen (ADR-0046, ticket B of 0.25.1): the Plan's Front matter group above the running
// order (numbering counts the contents only), "Add as front matter" (F) on a title page under Not in the outline,
// and the sidebar Outline's Front matter group at the top, marked "not in contents", with no grip.
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlanPartList, PlanUnlistedList, PartRoleControl } from '../../src/renderer/src/components/PlanView'
import { FolioOutlinePart } from '../../src/renderer/src/components/FolioOutline'
import { buildPlanRows, planSummary, pluralisedSummary } from '../../src/renderer/src/plan/plan-view-model'
import { planCommandForEvent } from '../../src/renderer/src/plan/plan-shortcuts'
import type { Plan } from '../../src/preload'
import { TITLE_PAGE_SET_IN_MANIFEST } from '../../src/shared/folio-front-matter'

const TITLE = 'Pangram evaluation: proposal and proof of concept'
const part = (title: string, role: string, path: string | null, line: number, extra: Record<string, unknown> = {}) => ({ title, gloss: null, role, tags: [], path, line, ...extra })

const plan: Plan = {
  dir: 'pangram',
  indexPath: 'pangram/_pangram_INDEX.md',
  headingLine: 3,
  parts: [
    part(TITLE, 'front-matter', 'pangram/contents/00-frontmatter.md', 5, { titlePage: true }),
    part('Summary', 'summary', 'pangram/contents/01-executive-summary.md', 6),
    part('Details', 'section', 'pangram/contents/02-report.md', 7),
  ],
  unlisted: [],
}

test('the Folio outline numbers the contents only; front matter carries no number and is counted apart', () => {
  const rows = buildPlanRows(plan, [])
  expect(rows.map((row) => [row.title, row.number, row.index, row.frontMatter])).toEqual([[TITLE, 0, 0, true], ['Summary', 1, 1, false], ['Details', 2, 2, false]])
  expect(pluralisedSummary(planSummary(rows))).toBe('1 front matter · 2 parts · 2 written · 0 jotted')
  expect(pluralisedSummary(planSummary(rows), 2)).toBe('1 front matter · 2 parts · 2 chapters in the contents')
  expect(pluralisedSummary(planSummary(rows.slice(0, 1)))).toBe('1 front matter · nothing in the contents yet')
})

test('a front-matter card: the title page is the export’s cover and not in the contents; its callbacks name its running-order index', () => {
  const rows = buildPlanRows(plan, [])
  const front = rows.filter((row) => row.frontMatter)
  const contents = rows.filter((row) => !row.frontMatter)
  const frontHtml = renderToStaticMarkup(<PlanPartList rows={front} selected={0} composer={null} label="Front matter" coverIndex={0} onSelect={() => {}} onOpen={() => {}} onDragStart={() => {}} onDrop={() => {}} />)
  expect(frontHtml).toContain('aria-label="Front matter"')
  expect(frontHtml).toContain('data-plan-cover="true"')
  expect(frontHtml).toContain('data-plan-not-in-contents="true"')
  expect(frontHtml).toContain('aria-selected="true"')
  const contentsHtml = renderToStaticMarkup(<PlanPartList rows={contents} selected={0} composer={null} endIndex={3} onSelect={() => {}} onOpen={() => {}} onDragStart={() => {}} onDrop={() => {}} />)
  // Selection 0 is the front-matter card: no contents card is selected, and the contents count from 1.
  expect(contentsHtml).not.toContain('aria-selected="true"')
  expect(contentsHtml).toContain('<span class="num">1</span>')
  expect(contentsHtml).not.toContain('data-plan-cover')
})

test('the role menu offers Front matter', () => {
  const html = renderToStaticMarkup(<PartRoleControl title="Preface" role="front-matter" onChoose={() => {}} />)
  expect(html).toContain('<option value="front-matter" selected="">Front matter</option>')
})

test('the manifest’s title page: its role menu is off and says why; another part’s menu is not', () => {
  const titlePagePlan: Plan = { ...plan, parts: [{ ...plan.parts[0], manifestTitlePage: true }, ...plan.parts.slice(1)] }
  const rows = buildPlanRows(titlePagePlan, [])
  const html = rows.map((row) => renderToStaticMarkup(<PartRoleControl title={row.title} role={row.role} onChoose={() => {}} lockedReason={row.manifestTitlePage ? TITLE_PAGE_SET_IN_MANIFEST : undefined} />)).join('')
  const menus = html.split('class="part-role"').slice(1)
  expect(menus[0]).toContain('data-plan-role-locked="true"')
  expect(menus[0]).toContain(`title="${TITLE_PAGE_SET_IN_MANIFEST}"`)
  expect(menus[0]).toMatch(/<select[^>]*disabled=""/)
  expect(menus[1]).not.toContain('data-plan-role-locked')
  expect(menus[1]).not.toMatch(/<select[^>]*disabled=""/)
})

test('Not in the outline: a title page offers Add as front matter (F) beside Put back; an ordinary file offers Put back only', () => {
  const unlisted = [
    part(TITLE, 'section', 'pangram/contents/00-frontmatter.md', -1, { manifestBacked: false, titlePage: true, frontMatterOffer: true }),
    part('Notes', 'section', 'pangram/contents/03-notes.md', -1, { manifestBacked: false }),
  ]
  const html = renderToStaticMarkup(<PlanUnlistedList parts={unlisted} onAdopt={() => {}} onAdoptFrontMatter={() => {}} />)
  expect(html).toContain('data-plan-add-front-matter="pangram/contents/00-frontmatter.md"')
  expect(html).toContain('Add as front matter <kbd>F</kbd>')
  expect(html).toContain('data-plan-title-page="true"')
  expect(html).not.toContain('data-plan-add-front-matter="pangram/contents/03-notes.md"')
  expect(html).toContain('data-plan-put-back="pangram/contents/00-frontmatter.md"')
  expect(html).toContain('data-plan-put-back="pangram/contents/03-notes.md"')
})

test('F in the Folio outline is Add as front matter', () => {
  expect(planCommandForEvent({ key: 'f', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false } as never, {})).toBe('adopt-front-matter')
})

test('the sidebar Outline lists front matter first, marked not in contents, with no grip and no number; the contents count from 1', () => {
  const outline = {
    dir: 'pangram', name: 'pangram',
    pieces: [
      { path: 'pangram/contents/00-frontmatter.md', title: TITLE, headings: [], frontMatter: true },
      { path: 'pangram/contents/01-executive-summary.md', title: 'Summary', headings: [] },
      { path: 'pangram/contents/02-report.md', title: 'Details', headings: [] },
    ],
    also: [],
  }
  const html = renderToStaticMarkup(
    <FolioOutlinePart
      outline={outline as never}
      openPath="pangram/contents/02-report.md"
      bufferPath={null}
      bufferHeadings={[]}
      activeFrom={null}
      needle=""
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
    />,
  )
  const front = html.indexOf('data-fo-front-group="true"')
  const run = html.indexOf('id="fo-grp-run"')
  expect(front).toBeGreaterThanOrEqual(0)
  expect(front).toBeLessThan(run)
  expect(html.indexOf(TITLE)).toBeLessThan(run)
  expect(html).toContain('data-fo-flag="not-in-contents"')
  expect(html).toContain('Contents · 2 chapters')
  expect(html).toMatch(/data-fo-front-box="0"/)
  expect(html).not.toMatch(/data-fo-box="0"/)
  expect(html).toMatch(/data-fo-box="1"/)
  // The front row has no grip: only the two contents rows do.
  expect(html.match(/class="fo-grip"/g)?.length).toBe(2)
})
