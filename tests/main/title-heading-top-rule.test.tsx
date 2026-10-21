import { expect, test } from 'bun:test'
import { partChildHeadings, partTitle, withoutOwnHeading, withTopHeading } from '../../src/shared/folio-part-title'
import { partTitleFix } from '../../src/main/folio-part-proposals'
import { withTitleFixed } from '../../src/shared/title-conflict'
import { titleFixTargetOf, titleFixUnavailable } from '../../src/renderer/src/components/PlanView'

// Fix round 1 on the top-of-body rule (2026-10-21): only a heading on the body's first line is ever the title.

test('export: a heading that repeats the title below opening text is kept; only the top heading goes', () => {
  const source = '---\ntitle: T\n---\n\n# T\n\nIntroduction.\n\n## T\n\nDetails.\n'
  expect(withoutOwnHeading(source, 'p.md')).toBe('---\ntitle: T\n---\n\nIntroduction.\n\n## T\n\nDetails.\n')
  // Written twice with only blank lines between: both still go, as before.
  expect(withoutOwnHeading('# T\n\n## T\n\nDetails.\n', 'p.md')).toBe('Details.\n')
})

test('the Plan offers no title fix for a part that opens with text, and says the waiting change adds the heading', () => {
  const source = '---\ntitle: T\n---\n\nIntroduction.\n\n## TLDR;\n'
  const heading = partTitle(source, 'p.md')
  expect(heading).toMatchObject({ mode: 'missing', mismatch: false })
  const part = { path: 'p.md', heading }
  expect(titleFixTargetOf(part)).toBeNull()
  expect(titleFixUnavailable(part)).toBe('This part does not start with a heading. The change that adds its title as the heading is waiting in the Changes.')
  expect(titleFixUnavailable({ heading: { ...heading, mode: 'own' } })).toBe('The selected part’s title and heading already match.')
})

test('a title that is not one line never reaches the text: the shared insert refuses it for every caller', () => {
  // An escaped frontmatter string decodes to a line break and a fence.
  const source = '---\ntitle: "T\\n\\n```"\n---\n\nIntroduction.\n'
  expect(partTitle(source, 'p.md').title).toBe('T\n\n```')
  expect(partTitleFix(source, 'p.md')).toBeNull()
  expect(withTopHeading(source, 'T\n\n```')).toBeNull()
  expect(withTitleFixed(source, 'p.md', 'title-to-heading', { part: true }).ok).toBe(false)
  expect(withTitleFixed(source, 'p.md', 'title-to-heading', { part: false }).ok).toBe(false)
  // A title that would read as no heading at all (only marks) is refused too.
  expect(withTopHeading('---\ntitle: x\n---\n\nText.\n', '```')).toBeNull()
})

test('the Folio outline lists a heading saying the title when it sits below opening text', () => {
  const source = '---\ntitle: Cost\n---\n\nIntroduction.\n\n## Cost\n\n## Items\n'
  const { mode, title } = partTitle(source, 'p.md')
  expect(mode).toBe('missing')
  const headings = [{ level: 2, text: 'Cost' }, { level: 2, text: 'Items' }]
  expect(partChildHeadings(headings, mode, title).map((h) => h.text)).toEqual(['Cost', 'Items'])
})

test('a part that opens with a setext heading gets nothing inserted above it', () => {
  for (const source of ['---\ntitle: New\n---\n\nOld\n===\n\nText.\n', '---\ntitle: New\n---\n\nOld\n---\n\nText.\n']) {
    expect([source, partTitleFix(source, 'p.md')]).toEqual([source, null])
    expect([source, withTitleFixed(source, 'p.md', 'title-to-heading', { part: true }).ok]).toEqual([source, false])
    expect([source, withTopHeading(source, 'New')]).toEqual([source, null])
  }
})
