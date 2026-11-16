import { expect, test } from 'bun:test'
import { recentMenuLabels } from '../../src/main/recent-menu-labels'

test('recent labels show names and the shortest distinguishing parent suffix', () => {
  const roots = ['/Work/Notes', '/Home/Notes', '/Work/Projects/Drafts', '/Home/Projects/Drafts', '/Solo', '/Notes', '/Other/Notes']
  expect([...recentMenuLabels(roots).values()]).toEqual(['Notes — Work', 'Notes — Home', 'Drafts — Work/Projects', 'Drafts — Home/Projects', 'Solo', 'Notes — /', 'Notes — Other'])
  expect(recentMenuLabels(['/A/Notes', '/A/Notes']).get('/A/Notes')).toBe('Notes')
})
