import { expect, test } from 'bun:test'
import type { NewChange } from '../../src/engine'
import { minimiseProposedReplacement } from '../../src/main/proposed-replacement'

const proposedReplacement = (overrides: Partial<NewChange> = {}): NewChange => ({
  path: 'draft.md',
  provenance: 'agent',
  editClass: 'content',
  summary: 'Replace a phrase',
  oldText: 'old phrase',
  newText: 'new phrase',
  isCorrection: false,
  ...overrides,
})

test('refuses a move instead of discarding its equal source and destination text', () => {
  const text = 'Paragraph to move.'

  expect(() => minimiseProposedReplacement(proposedReplacement({
    editClass: 'move',
    oldText: text,
    newText: text,
  }))).toThrow(/cannot minimise move changes or changes carrying move ranges/i)
})

test.each([
  ['moveFrom', { moveFrom: { from: 10, to: 20 } }],
  ['moveTo', { moveTo: { from: 30, to: 30 } }],
] as const)('refuses a replacement carrying %s because its ranges cannot be adjusted', (_field, range) => {
  expect(() => minimiseProposedReplacement(proposedReplacement(range))).toThrow(
    /cannot minimise move changes or changes carrying move ranges/i,
  )
})
