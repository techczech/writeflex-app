import { expect, test } from 'bun:test'
import { outsideReviewKind, groupOutsideReview } from '../../src/shared/outside-batch-review'
import type { Change } from '../../src/preload'

const proposal = (fields: Partial<Change> = {}): Change => ({
  id: 'one', path: 'notes/one.md', ts: 1, status: 'pending', provenance: 'agent',
  editClass: 'content', category: 'other', summary: 'A proposed change', oldText: 'Before',
  newText: 'After', isCorrection: false, outsideSource: 'claude-code', ...fields,
})

test('kind uses structured metadata and explicit descriptions, with prose as fallback', () => {
  expect(outsideReviewKind(proposal({ frontmatter: true }))).toBe('Summary / front matter')
  expect(outsideReviewKind(proposal({ editClass: 'copy' }))).toBe('Copy-edit')
  expect(outsideReviewKind(proposal({ summary: 'Copy-edit first sentence' }))).toBe('Copy-edit')
  expect(outsideReviewKind(proposal({ summary: 'Fix reference for the survey' }))).toBe('Reference')
  expect(outsideReviewKind(proposal())).toBe('Prose / research')
})

test('source grouping distinguishes runs and missing documents are grouped in every view', () => {
  const request = { id: 'run-1', index: 1, count: 2, at: 2 }
  const changes = [
    proposal({ outsideRequest: request }),
    proposal({ id: 'two', outsideRequest: { ...request, index: 2 } }),
    proposal({ id: 'three', outsideRequest: { ...request, id: 'run-2' } }),
    proposal({ id: 'four', path: 'old.md', outsideRequest: request }),
  ]
  const missing = new Set(['old.md'])
  expect(groupOutsideReview(changes, 'source', missing).map(group => group.changes.length)).toEqual([2, 1, 1])
  expect(groupOutsideReview(changes, 'folder', missing).map(group => group.title)).toEqual(['notes', 'Documents no longer found'])
})

test('group counts omit proposals which require individual review, even at a missing path', () => {
  const changes = [proposal(), proposal({ id: 'snapshot', snapshotId: 'saved' }),
    proposal({ id: 'writer', provenance: 'writer', path: 'missing.md' }), proposal({ id: 'held', status: 'held' })]
  expect(groupOutsideReview(changes, 'kind', new Set(['missing.md'])).flatMap(group => group.changes.map(change => change.id))).toEqual(['one'])
})
