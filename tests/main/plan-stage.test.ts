import { expect, test } from 'bun:test'
import { PLAN_STAGE_ALIASES, planStageForStatus } from '../../src/shared/plan-stage'

test('Plan stage aliases map existing statuses onto the approved vocabulary', () => {
  expect(PLAN_STAGE_ALIASES).toEqual({
    idea: 'idea',
    jottings: 'jottings',
    'note gathering': 'jottings',
    drafting: 'jottings',
    'in progress': 'partial draft',
    'partial draft': 'partial draft',
    'rough draft': 'rough draft',
    editing: 'final draft',
    ready: 'final draft',
    'final draft': 'final draft',
    published: 'published',
  })
})

test('Plan stage mapping is display-only, case-insensitive, and does not invent unknown stages', () => {
  expect(planStageForStatus(' Editing ')).toBe('final draft')
  expect(planStageForStatus('DRAFTING')).toBe('jottings')
  expect(planStageForStatus('custom review')).toBeNull()
  expect(planStageForStatus(null)).toBeNull()
})
