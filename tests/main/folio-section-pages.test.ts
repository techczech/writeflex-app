import { expect, test } from 'bun:test'
import { folioHeadingFlow, folioOutlineFlow } from '../../src/shared/folio-heading-flow'
import { declaresSectionPage, sectionMembership, sectionOutlineRows } from '../../src/shared/folio-sections'

const part = (title: string, level = 1, extra = {}) => ({ path: `${title}.md`, title, mode: 'own' as const, headings: [{ level, text: title }], ...extra })

test('section marks use only the own frontmatter, with case and quoted values', () => {
  for (const key of ['folio', 'FOLIO', 'Folio']) for (const value of ['section', '"Section"', "'SECTION'"]) expect(declaresSectionPage(`---\n${key}: ${value}\n---\n# Opening`)).toBe(true)
  expect(declaresSectionPage('# Title\nfolio: section')).toBe(false)
  expect(declaresSectionPage('---\nrole: section\n---\n')).toBe(false)
})

test('membership follows running order alone; front matter never belongs; consecutive sections are empty', () => {
  const parts = [part('Front', 1, { frontMatter: true, sectionPage: true }), part('Introduction'), part('One', 6, { sectionPage: true }), part('A', 2), part('B', 4), part('Front2', 1, { frontMatter: true }), part('Empty', 1, { sectionPage: true }), part('Two', 3, { sectionPage: true }), part('C', 1)]
  expect(sectionMembership(parts)).toEqual([null, null, null, 2, 2, null, null, null, 7])
  const flow = folioHeadingFlow(parts)
  expect(flow.sections).toEqual([2, 6, 7])
  expect(flow.parts.map(p => p.role)).toEqual(['front', 'chapter', 'section', 'chapter', 'continues', 'front', 'section', 'section', 'chapter'])
  expect(flow.parts.map(p => p.depth)).toEqual([0, 0, 0, 1, 3, 0, 0, 0, 1])
  expect(flow.parts[8].chapterIndex).toBe(8)
})

test('without sections the exact heading-flow shape stays unchanged', () => {
  const flow = folioHeadingFlow([part('A', 2), part('B', 3), part('C', 2)])
  expect(JSON.stringify(flow)).toBe(JSON.stringify(folioHeadingFlow([part('A', 2, { sectionPage: false }), part('B', 3), part('C', 2)])))
  expect(flow).not.toHaveProperty('sections')
  expect(flow.parts.map(p => [p.role, p.depth, p.chapterIndex])).toEqual([['chapter', 0, 0], ['continues', 1, 0], ['chapter', 0, 2]])
})

test('room view model keeps actual indexes when collapsed and counts members and their words', () => {
  const parts = [ { index: 1, words: 10 }, { index: 2, words: 20, outline: { sectionPage: true } }, { index: 3, words: 30 }, { index: 4, words: 40 }, { index: 5, words: 50, outline: { sectionPage: true } } ]
  expect(sectionOutlineRows(parts, new Set([2]))).toEqual([
    { index: 1, sectionIndex: null, sectionPage: false, parts: 0, words: 10 },
    { index: 2, sectionIndex: null, sectionPage: true, parts: 2, words: 70 },
    { index: 5, sectionIndex: null, sectionPage: true, parts: 0, words: 0 },
  ])
})

test('sidebar outline facts carry sections through the shared flow', () => {
  const flow = folioOutlineFlow({ dir: '', name: 'Book', also: [], pieces: [ { path: 's.md', title: 'S', headings: [], sectionPage: true }, { path: 'a.md', title: 'A', headings: [] } ] })
  expect(flow.parts.map(p => [p.role, p.depth])).toEqual([['section', 0], ['chapter', 1]])
  expect(flow.chapters).toBe(1)
})

import { sectionKeyTarget, visibleSectionRange } from '../../src/shared/folio-sections'

test('collapsed navigation and shift ranges use visible indexes, never hidden section members', () => {
  const visible = [0, 1, 4, 5]
  expect(sectionKeyTarget(visible, 1, 'ArrowDown')).toBe(4)
  expect(sectionKeyTarget(visible, 4, 'ArrowUp')).toBe(1)
  expect(sectionKeyTarget(visible, 4, 'Home')).toBe(0)
  expect(sectionKeyTarget(visible, 0, 'End')).toBe(5)
  expect(visibleSectionRange(visible, 1, 4)).toEqual([1, 4])
  expect(visibleSectionRange(visible, 4, 0)).toEqual([0, 1, 4])
})
