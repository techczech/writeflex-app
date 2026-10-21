import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PartRoleControl,
  PlanPartList,
  PlanEmptyState,
  PlanProjectionNav,
  PlanUnlistedList,
  planActionFailure,
  planKeysYieldTo,
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

test('Folio outline rows use the locked class names and dashed treatment for unwritten parts', () => {
  const html = renderToStaticMarkup(<PlanPartList {...props} />)

  expect(html).toContain('class="parts"')
  expect(html).toContain('class="part s-final"')
  expect(html).toContain('class="part s-idea unwritten sel"')
  expect(html).toContain('Written opening')
  expect(html).toContain('final draft')
  expect(html).toContain('610 words')
  expect(html).toContain('not written')
  // The card carries no key hints and no role menu: the selected part's settings are in the side rail.
  expect(html).not.toContain('kbhint')
  expect(html).not.toContain('<select')
  expect(html).toContain('Summary')
})

test('Folio outline empty states distinguish no Folio outline from a Folio outline with no parts', () => {
  const absent = renderToStaticMarkup(<PlanEmptyState kind="absent" onStart={() => {}} />)
  const empty = renderToStaticMarkup(<PlanEmptyState kind="empty" onStart={() => {}} />)

  expect(absent).toContain('Start a Folio outline')
  expect(absent).toContain('Index Note')
  expect(empty).toContain('Add the first part')
  expect(empty).toContain('running order')
})

test('unlisted parts form one group, Not in the outline, and each offers Open and Put back; an unwritable title has Put back off with its reason', () => {
  const html = renderToStaticMarkup(<PlanUnlistedList
    parts={[
      { title: 'Beta', gloss: 'two', role: 'appendix', tags: [], path: '02-beta.md', line: -1, manifestBacked: true },
      { title: 'Sources', gloss: null, role: 'section', tags: [], path: 'sub/03-sources.md', line: -1, manifestBacked: false, under: 'sub' },
      { title: 'C# notes', gloss: null, role: 'section', tags: [], path: '04-c.md', line: -1, manifestBacked: false, putBackRefusal: 'Its title has a character a running-order line cannot hold.' },
    ]}
    onAdopt={() => {}}
    onOpenFile={() => {}}
  />)

  expect(html).toContain('Not in the outline · 3')
  expect(html).not.toContain('Also in this folder')
  expect(html.match(/Put back <kbd>/g)).toHaveLength(3)
  expect(html.match(/data-plan-open-file=/g)).toHaveLength(3)
  expect(html.match(/disabled=""/g)).toHaveLength(1)
  expect(html).toContain('data-plan-putback-why="true"')
  expect(html).toContain('data-plan-under="sub"')
  expect(html).toContain('two')
  expect(html).toContain('appendix')
})

test('the selected part’s role menu (Section, Vignette, Appendix, Summary) is set to the part’s role', () => {
  const html = renderToStaticMarkup(<PartRoleControl title="Alpha" role="vignette" onChoose={() => {}} />)
  expect(html).toContain('aria-label="Role of Alpha"')
  expect(html).toMatch(/<option value="vignette" selected="">Vignette<\/option>/)
  for (const name of ['Section', 'Appendix', 'Summary']) expect(html).toContain(`>${name}</option>`)
})

test('the Folio outline projection navigation exposes Board, active Folio outline, and disabled Outline states', () => {
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
  expect(html).toContain('Folio outline edits cannot reach the compiled report until it is fixed.')
  expect(html).not.toContain('Make a Folio')

  const styles = readFileSync(new URL('../../src/renderer/src/styles/app.css', import.meta.url), 'utf8')
  expect(styles).toContain('.plan-manifest-warning')
})

test('all ten Folio outline action failures preserve a main-process refusal before their reassurance', () => {
  const source = readFileSync(new URL('../../src/renderer/src/components/PlanView.tsx', import.meta.url), 'utf8')

  expect(source.match(/catch \(error\)/g)).toHaveLength(10)
  expect(source.match(/planActionFailure\(error,/g)).toHaveLength(10)
  expect(source).not.toContain('catch {\n      onStatus(')

  const fallback = 'Could not add that part. Check the title and try again; nothing else was changed.'
  expect(planActionFailure(
    new Error("Error invoking remote method 'plan:insert-part': Error: Cannot write an unreadable Folio manifest: report/_report-structure.json"),
    fallback,
  )).toBe('Cannot write an unreadable Folio manifest: report/_report-structure.json Nothing else was changed.')
  expect(planActionFailure(null, fallback)).toBe(fallback)
})

test('the Folio outline shortcuts leave the role menu its own keys: a focused select, like a text field, is never intercepted', () => {
  const html = renderToStaticMarkup(<PartRoleControl title="Written opening" role="summary" onChoose={() => {}} />)
  expect(html).toContain('<select aria-label="Role of Written opening"')
  // The capture handler's guard (PlanView keydown): Arrow, Enter and Space on these stay with the control.
  for (const tagName of ['SELECT', 'select', 'INPUT', 'TEXTAREA']) expect(planKeysYieldTo({ tagName } as unknown as EventTarget)).toBe(true)
  expect(planKeysYieldTo({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true)
  for (const tagName of ['BUTTON', 'DIV']) expect(planKeysYieldTo({ tagName, isContentEditable: false } as unknown as EventTarget)).toBe(false)
  expect(planKeysYieldTo(null)).toBe(false)
  // The handler itself asks the guard first.
  const source = readFileSync(new URL('../../src/renderer/src/components/PlanView.tsx', import.meta.url), 'utf8')
  expect(source).toMatch(/if \(planKeysYieldTo\(target\)\) return/)
})
