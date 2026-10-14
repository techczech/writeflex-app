import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PlanPartList,
  PlanEmptyState,
  PlanProjectionNav,
  PlanUnlistedList,
  planActionFailure,
  type PlanPartListProps,
} from '../../src/renderer/src/components/PlanView'
import { CollectionFolioStatus } from '../../src/renderer/src/components/CollectionView'

const props: PlanPartListProps = {
  rows: [
    { title: 'Written opening', gloss: 'the claim', role: 'summary', tags: [], path: '01-opening.md', line: 4, number: 1, written: true, stage: 'final draft', words: 610 },
    { title: 'Only planned', gloss: 'the case', role: 'vignette', tags: [], path: null, line: 5, number: 2, written: false, stage: null, words: null },
  ],
  selected: 1,
  composer: null,
  onSelect: () => {},
  onOpen: () => {},
  onDragStart: () => {},
  onDrop: () => {},
}

test('Plan rows use the locked class names and dashed treatment for unwritten parts', () => {
  const html = renderToStaticMarkup(<PlanPartList {...props} />)

  expect(html).toContain('class="parts"')
  expect(html).toContain('class="part s-final"')
  expect(html).toContain('class="part s-idea unwritten sel"')
  expect(html).toContain('Written opening')
  expect(html).toContain('final draft')
  expect(html).toContain('610 words')
  expect(html).toContain('not written')
  expect(html).toContain('⌥↑↓')
  expect(html).toContain('⌘⌫')
})

test('Plan empty states distinguish no Plan from a Plan with no parts', () => {
  const absent = renderToStaticMarkup(<PlanEmptyState kind="absent" onStart={() => {}} />)
  const empty = renderToStaticMarkup(<PlanEmptyState kind="empty" onStart={() => {}} />)

  expect(absent).toContain('Start a plan')
  expect(absent).toContain('Index Note')
  expect(empty).toContain('Add the first part')
  expect(empty).toContain('running order')
})

test('unlisted parts are clearly separated and each offers Add to plan', () => {
  const html = renderToStaticMarkup(<PlanUnlistedList
    parts={[
      { title: 'Beta', gloss: 'two', role: 'appendix', tags: [], path: '02-beta.md', line: -1, manifestBacked: true },
      { title: 'Sources', gloss: null, role: 'section', tags: [], path: '03-sources.md', line: -1, manifestBacked: false },
    ]}
    onAdopt={() => {}}
  />)

  expect(html).toContain('In the compiled report, not in your running order')
  expect(html).toContain('In the folder, not yet part of the report')
  expect(html).not.toContain('These parts stay in the compiled report until you add them to the running order.')
  expect(html.match(/Add to plan/g)).toHaveLength(2)
  expect(html).toContain('Beta')
  expect(html).toContain('two')
  expect(html).toContain('appendix')
  expect(html).toContain('Add a part to include it in the running order. Written parts also join an existing report manifest.')
})

test('the Plan projection navigation exposes Board, active Plan, and disabled Outline states', () => {
  const html = renderToStaticMarkup(<PlanProjectionNav onOpenBoard={() => {}} />)

  expect(html).toContain('class="plan-projection-nav"')
  expect(html).toContain('aria-label="Collection projection"')
  expect(html).toContain('aria-pressed="false"')
  expect(html).toContain('aria-pressed="true"')
  expect(html).toContain('disabled=""')
  expect(html).toContain('Outline comes in a later release')
})

test('an unreadable Folio manifest is named and Make Folio is not offered', () => {
  const html = renderToStaticMarkup(<CollectionFolioStatus
    manifestUnreadable
    onMakeFolio={() => {}}
  />)

  expect(html).toContain('Folio manifest unreadable')
  expect(html).toContain('Fix or move _report-structure.json before changing this Folio.')
  expect(html).toContain('Plan edits cannot reach the compiled report until it is fixed.')
  expect(html).not.toContain('Make a Folio')

  const styles = readFileSync(new URL('../../src/renderer/src/styles/app.css', import.meta.url), 'utf8')
  expect(styles).toContain('.plan-manifest-warning')
})

test('all eight Plan action failures preserve a main-process refusal before their reassurance', () => {
  const source = readFileSync(new URL('../../src/renderer/src/components/PlanView.tsx', import.meta.url), 'utf8')

  expect(source.match(/catch \(error\)/g)).toHaveLength(8)
  expect(source.match(/planActionFailure\(error,/g)).toHaveLength(8)
  expect(source).not.toContain('catch {\n      onStatus(')

  const fallback = 'Could not add that part. Check the title and try again; nothing else was changed.'
  expect(planActionFailure(
    new Error("Error invoking remote method 'plan:insert-part': Error: Cannot write an unreadable Folio manifest: report/_report-structure.json"),
    fallback,
  )).toBe('Cannot write an unreadable Folio manifest: report/_report-structure.json Nothing else was changed.')
  expect(planActionFailure(null, fallback)).toBe(fallback)
})
