import { expect, test } from 'bun:test'
import { reviseSuggestionWithWarning } from '../../src/renderer/src/app/revise-suggestion'

test('Revise flashes a path-named note-write warning and still sends the revision prompt', async () => {
  const prompts: string[] = []
  const flashes: string[] = []

  await reviseSuggestionWithWarning({
    suggestionId: 'suggestion-1',
    note: 'Use only drafting pieces',
    discard: async () => ({
      suggestions: [],
      settlementWarning: 'Could not write Agent note at Essays/agent-notes/failed.md: forced createFile failure',
    }),
    prompt: (text) => { prompts.push(text) },
    flash: (text) => { flashes.push(text) },
  })

  expect(prompts).toEqual(['Revise your suggestion: Use only drafting pieces'])
  expect(flashes).toEqual([
    'Change rejected, but its Agent note failed: Could not write Agent note at Essays/agent-notes/failed.md: forced createFile failure',
  ])
})
