import { expect, test } from 'bun:test'
import type { CollectionRow, Folio, Plan } from '../../src/preload'
import {
  buildPlanRows,
  composerPosition,
  materialisationPreview,
  planSummary,
} from '../../src/renderer/src/plan/plan-view-model'

const plan: Plan = {
  dir: 'reports/assessment',
  indexPath: 'reports/assessment/_assessment_INDEX.md',
  headingLine: 8,
  unlisted: [],
  parts: [
    { title: 'Opening', gloss: 'the claim', role: 'summary', tags: [], path: 'reports/assessment/01-opening.md', line: 10 },
    { title: 'The viva', gloss: 'a worked case', role: 'vignette', tags: [], path: null, line: 11 },
    { title: 'Recommendations', gloss: null, role: 'section', tags: [], path: 'reports/assessment/03-recommendations.md', line: 12 },
  ],
}

const rows: CollectionRow[] = [{
  path: 'reports/assessment/01-opening.md',
  name: '01-opening.md',
  title: 'Opening',
  purpose: null,
  status: 'editing',
  modified: 1,
  words: 610,
  bare: false,
  provenance: { title: 'written', purpose: 'derived', status: 'written' },
}]

test('Folio outline rows keep Folio outline order and join written metadata by path', () => {
  expect(buildPlanRows(plan, rows)).toEqual([
    expect.objectContaining({ number: 1, title: 'Opening', written: true, stage: 'final draft', words: 610 }),
    expect.objectContaining({ number: 2, title: 'The viva', written: false, stage: null, words: null }),
    expect.objectContaining({ number: 3, title: 'Recommendations', written: true, stage: null, words: null }),
  ])
})

test('Folio outline summary distinguishes a wholly unwritten plan', () => {
  expect(planSummary(buildPlanRows(plan, rows))).toEqual({ parts: 3, written: 2, unwritten: 1, words: 610 })
  expect(planSummary(buildPlanRows({ ...plan, parts: plan.parts.map((part) => ({ ...part, path: null })) }, []))).toEqual({
    parts: 3,
    written: 0,
    unwritten: 3,
    words: 0,
  })
})

test('Composer position names both neighbours at the insertion point', () => {
  expect(composerPosition(plan.parts, 1)).toEqual({
    ordinal: 'part 2 of 4',
    between: 'between “Opening” and “The viva”',
  })
  expect(composerPosition(plan.parts, 0).between).toBe('before “Opening”')
  expect(composerPosition(plan.parts, 3).between).toBe('after “Recommendations”')
})

test('Materialisation preview supplies the exact stub input and manifest entry', () => {
  const folio: Folio = { contentRoot: 'contents', titleMatter: 'title.md', files: [] }
  const preview = materialisationPreview(plan, folio, 1)

  expect(preview.path).toBe('reports/assessment/contents/02-the-viva.md')
  expect(preview.stubInput).toEqual({
    dir: 'reports/assessment',
    title: 'The viva',
    gist: 'a worked case',
    path: 'reports/assessment/contents/02-the-viva.md',
    role: 'vignette',
    bodyLead: 'a worked case',
    titleInFrontmatter: true,
    suppressBacklink: true,
  })
  expect(preview.manifestLine).toBe('{ "path": "02-the-viva.md", "role": "vignette" }')
})
