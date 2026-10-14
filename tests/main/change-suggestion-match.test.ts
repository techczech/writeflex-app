import { test, expect } from 'bun:test'
import { findLiveSuggestionForChange } from '../../src/renderer/src/app/change-suggestion-match'
import type { Change, Suggestion } from '../../src/preload'

function change(over: Partial<Change>): Change {
  return {
    id: 'c1',
    path: 'draft.md',
    ts: 0,
    provenance: 'agent',
    editClass: 'move',
    category: 'structure',
    summary: 'Move the paragraph',
    oldText: 'Move me.',
    newText: 'Move me.',
    status: 'pending',
    isCorrection: false,
    ...over,
  }
}

function suggestion(id: string, insertAfter: string): Suggestion {
  return {
    id,
    capabilityName: 'prose.move',
    input: { path: 'draft.md', text: 'Move me.', insertAfter, summary: `Move after ${insertAfter}` },
    stagedAt: 0,
  }
}

test('ambiguous live prose.move matches defer to the exact main resolver', () => {
  const c = change({ id: 'second-change' })
  const live = [
    suggestion('first-suggestion', 'Anchor one.'),
    suggestion('second-suggestion', 'Anchor two.'),
  ]

  expect(findLiveSuggestionForChange([c], live, 'second-change')).toBeUndefined()
})

test('a unique live prose.move match still reconciles through the renderer', () => {
  const c = change({ id: 'only-change' })
  const live = [suggestion('only-suggestion', 'Anchor two.')]

  expect(findLiveSuggestionForChange([c], live, 'only-change')?.id).toBe('only-suggestion')
})

const fullTextEdit: Suggestion = {
  id: 'live-edit',
  capabilityName: 'prose.edit',
  input: {
    path: 'draft.md', oldText: 'The city spreads along the river.',
    newText: 'The city sprawls along the river.', category: 'style', summary: 'Tighten the verb',
  },
  stagedAt: 0,
}

test('a full-text proposal matches its minimised record with shared prefix and suffix', () => {
  const c = change({ editClass: 'style', oldText: 'spreads', newText: 'sprawls' })
  expect(findLiveSuggestionForChange([c], [fullTextEdit], c.id)).toBe(fullTextEdit)
})

test('an unrelated minimised record does not match the live proposal', () => {
  const c = change({ editClass: 'style', oldText: 'spreads', newText: 'stretches' })
  expect(findLiveSuggestionForChange([c], [fullTextEdit], c.id)).toBeUndefined()
})

test('a minimised record in another file does not match the live proposal', () => {
  const c = change({ path: 'other.md', editClass: 'style', oldText: 'spreads', newText: 'sprawls' })
  expect(findLiveSuggestionForChange([c], [fullTextEdit], c.id)).toBeUndefined()
})

test('a ledger-only record has no live match', () => {
  const c = change({ editClass: 'style', oldText: 'spreads', newText: 'sprawls' })
  expect(findLiveSuggestionForChange([c], [], c.id)).toBeUndefined()
})
