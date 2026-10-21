import { expect, test } from 'bun:test'
import { continuesChip, folioHeadingFlow, type FlowPartInput } from '../../src/shared/folio-heading-flow'
import type { PartHeadingMode } from '../../src/shared/folio-part-title'
import { pluralisedSummary } from '../../src/renderer/src/plan/plan-view-model'

type H = { level: number; text: string; line: number }
const part = (path: string, title: string, levels: Array<[number, string]>, extra: { mode?: PartHeadingMode; frontMatter?: boolean } = {}): FlowPartInput<H> => ({
  path, title, mode: extra.mode ?? 'own', frontMatter: extra.frontMatter,
  headings: levels.map(([level, text], at) => ({ level, text, line: at * 4 + 1 })),
})
const roles = (parts: FlowPartInput<H>[]): string[] => folioHeadingFlow(parts).parts.map((p) => p.role)

test('translation Folio: chapters open with ##, "Berlin a Kay" opens with ### and nests under chapter 2', () => {
  const flow = folioHeadingFlow([
    part('k1.md', 'Kapitola 1', [[2, 'Kapitola 1'], [3, 'Kategorie']]),
    part('k2.md', 'Kapitola 2', [[2, 'Kapitola 2'], [3, 'Klasické']]),
    part('berlin-a-kay.md', 'Berlin a Kay', [[3, 'Berlin a Kay'], [3, 'Kay a McDaniel'], [4, 'Ekman']]),
    part('k3.md', 'Kapitola 3', [[2, 'Kapitola 3']]),
    part('doslov.md', 'Doslov', [[2, 'Doslov']]),
  ])
  expect(flow.chapterLevel).toBe(2)
  expect(flow.chapters).toBe(4)
  expect(flow.parts.map((p) => p.role)).toEqual(['chapter', 'chapter', 'continues', 'chapter', 'chapter'])
  const berlin = flow.parts[2]
  expect(berlin.chapterNumber).toBe(2)
  expect(berlin.chapterIndex).toBe(1)
  expect(berlin.depth).toBe(1)
  // its own title heading is the row; headings at its level sit beside it, deeper ones nest by level below the chapter level
  expect(berlin.children.map((h) => [h.text, h.depth])).toEqual([['Kay a McDaniel', 1], ['Ekman', 2]])
  expect(flow.parts[0].children.map((h) => [h.text, h.depth])).toEqual([['Kategorie', 1]])
  expect(flow.parts[3].chapterNumber).toBe(3)
})

test('Pangram shape: parts open with # or ##; # is the chapter level, a ## opener continues', () => {
  const flow = folioHeadingFlow([
    part('front.md', 'Pangram evaluation', [[1, 'Pangram evaluation']], { frontMatter: true }),
    part('01-summary.md', 'Summary', [[2, 'Summary']]),
    part('02-report.md', 'Report', [[1, 'Details'], [2, 'Background']]),
    part('02b-ref.md', 'Full reference list', [[2, 'Full reference list'], [3, 'Research']]),
    part('03-costs.md', 'Costs', [[1, 'Costs']]),
  ])
  expect(flow.chapterLevel).toBe(1)
  expect(flow.parts.map((p) => p.role)).toEqual(['front', 'chapter', 'chapter', 'continues', 'chapter'])
  expect(flow.parts[1].depth).toBe(0)
  expect(flow.parts[3].chapterNumber).toBe(2)
  expect(flow.parts[3].children.map((h) => h.depth)).toEqual([2])
})

test('a tie goes to the shallower level, so an evenly split Folio is never all nested', () => {
  const flow = folioHeadingFlow([
    part('a.md', 'A', [[1, 'A']]), part('b.md', 'B', [[2, 'B']]), part('c.md', 'C', [[1, 'C']]), part('d.md', 'D', [[2, 'D']]),
  ])
  expect(flow.chapterLevel).toBe(1)
  expect(flow.parts.map((p) => p.role)).toEqual(['chapter', 'continues', 'chapter', 'continues'])
  expect(flow.chapters).toBe(2)
})

test('a part with no heading is a chapter titled by its title and is not counted; heading: none likewise', () => {
  const flow = folioHeadingFlow([
    part('a.md', 'A', [[2, 'A']]), part('plain.md', 'Plain notes', []), part('data.md', 'Data', [[3, 'Set 1'], [3, 'Set 2']], { mode: 'none' }),
    part('b.md', 'B', [[2, 'B']]),
  ])
  expect(flow.chapterLevel).toBe(2)
  expect(flow.parts.map((p) => p.role)).toEqual(['chapter', 'chapter', 'chapter', 'chapter'])
  expect(flow.parts[1].title).toBe('Plain notes')
  expect(flow.parts[1].firstLevel).toBeNull()
  // a `heading: none` part lists every heading, the shallowest directly under it
  expect(flow.parts[2].children.map((h) => [h.text, h.depth])).toEqual([['Set 1', 1], ['Set 2', 1]])
})

test('a first heading that is the part title counts at its level and is not listed again', () => {
  const flow = folioHeadingFlow([part('a.md', 'Alpha', [[3, 'Alpha'], [4, 'Sub']]), part('b.md', 'Beta', [[3, 'Beta']])])
  expect(flow.chapterLevel).toBe(3)
  expect(roles([part('a.md', 'Alpha', [[3, 'Alpha']]), part('b.md', 'Beta', [[3, 'Beta']])])).toEqual(['chapter', 'chapter'])
  expect(flow.parts[0].children.map((h) => [h.text, h.depth])).toEqual([['Sub', 1]])
})

test('front matter is outside the count, never nests and has no rows or marks', () => {
  const flow = folioHeadingFlow([
    part('t.md', 'Title', [[3, 'Title']], { frontMatter: true }), part('f.md', 'Foreword', [[3, 'Foreword']], { frontMatter: true }),
    part('a.md', 'A', [[1, 'A']]), part('b.md', 'B', [[1, 'B']]),
  ])
  expect(flow.chapterLevel).toBe(1)
  expect(flow.front).toEqual([0, 1])
  expect(flow.parts[0].role).toBe('front')
  expect(flow.chapters).toBe(2)
  expect(flow.rows.every((row) => row.partIndex >= 2)).toBe(true)
})

test('rows put a mark before each file, then its row, then its headings; the first contents part always opens a chapter', () => {
  const flow = folioHeadingFlow([part('a.md', 'A', [[3, 'A'], [4, 'x']]), part('b.md', 'B', [[2, 'B']]), part('c.md', 'C', [[2, 'C']])])
  expect(flow.chapterLevel).toBe(2)
  expect(flow.parts[0].role).toBe('chapter')
  expect(flow.rows.map((row) => `${row.kind}:${row.partIndex}${row.kind === 'heading' ? ':' + row.depth : ''}`)).toEqual([
    'mark:0', 'part:0', 'heading:0:1', 'mark:1', 'part:1', 'mark:2', 'part:2',
  ])
})

test('no headings anywhere: every part is a chapter at level 1', () => {
  const flow = folioHeadingFlow([part('a.md', 'A', []), part('b.md', 'B', [])])
  expect(flow.chapterLevel).toBe(1)
  expect(flow.chapters).toBe(2)
})

test('the continues chip: "continues 2 · Kapitola 2" on a part that nests, none on chapters or front matter', () => {
  const flow = folioHeadingFlow([
    part('pred.md', 'Předmluva', [], { frontMatter: true }),
    part('k1.md', 'Kapitola 1', [[2, 'Kapitola 1']]),
    part('k2.md', 'Kapitola 2', [[2, 'Kapitola 2']]),
    part('berlin-a-kay.md', 'Berlin a Kay', [[3, 'Berlin a Kay']]),
    part('k3.md', 'Kapitola 3', [[2, 'Kapitola 3']]),
  ])
  expect(flow.parts.map((_, index) => continuesChip(flow, index))).toEqual([null, null, null, 'continues 2 \u00b7 Kapitola 2', null])
})

test('the counts line: parts and chapters in the contents (translation and Pangram shapes), front matter counted apart', () => {
  const translation = folioHeadingFlow([
    part('k1.md', 'Kapitola 1', [[2, 'Kapitola 1']]), part('k2.md', 'Kapitola 2', [[2, 'Kapitola 2']]), part('b.md', 'Berlin a Kay', [[3, 'Berlin a Kay']]),
    part('k3.md', 'Kapitola 3', [[2, 'Kapitola 3']]), part('d.md', 'Doslov', [[2, 'Doslov']]),
  ])
  const sum = (parts: number, frontMatter?: number) => ({ parts, written: parts, unwritten: 0, words: 0, ...(frontMatter ? { frontMatter } : {}) })
  expect(pluralisedSummary(sum(5), translation.chapters)).toBe('5 parts \u00b7 4 chapters in the contents')
  const pangram = folioHeadingFlow([
    part('t.md', 'Pangram evaluation', [], { frontMatter: true }), part('s.md', 'Summary', [[1, 'Summary']]), part('d.md', 'Details', [[1, 'Details']]),
    part('r.md', 'Full reference list', [[2, 'Full reference list']]),
  ])
  expect(pluralisedSummary(sum(3, 1), pangram.chapters)).toBe('1 front matter \u00b7 3 parts \u00b7 2 chapters in the contents')
})
