import { expect, test } from 'bun:test'
import { FOLIO_CONFIRM_FALLBACK, folioConfirmSummary, folioConfirmSummaryFromDraft } from '../../src/shared/folio-confirm-summary'

const many = (n: number) => Array.from({ length: n }, (_, i) => `Piece ${i + 1}.md`)

test('zero pieces', () => {
  expect(folioConfirmSummary([])).toBe('This folder has no pieces yet. The Folio starts empty.')
})
test('one piece', () => {
  expect(folioConfirmSummary(['Start here.md'])).toBe('1 piece will go into the Folio:\n1. Start here')
})
test('eight pieces have no "more" line', () => {
  const lines = folioConfirmSummary(many(8)).split('\n')
  expect(lines).toHaveLength(9)
  expect(lines[0]).toBe('8 pieces will go into the Folio, in this order:')
  expect(lines[8]).toBe('8. Piece 8')
})
test('nine pieces', () => {
  const lines = folioConfirmSummary(many(9)).split('\n')
  expect(lines).toHaveLength(10)
  expect(lines[9]).toBe('and 1 more.')
})
test('500 pieces give exactly 10 lines', () => {
  const lines = folioConfirmSummary(many(500)).split('\n')
  expect(lines).toHaveLength(10)
  expect(lines[0]).toBe('500 pieces will go into the Folio, in this order:')
  expect(lines[9]).toBe('and 492 more.')
})
test('a long name is cut to 60 characters', () => {
  const line = folioConfirmSummary([`${'a'.repeat(200)}.md`]).split('\n')[1]
  expect(Array.from(line)).toHaveLength(60)
  expect(line.endsWith('…')).toBe(true)
})
test('nested path shows the bare name', () => {
  expect(folioConfirmSummary(['parts/02 Methods.md']).split('\n')[1]).toBe('1. 02 Methods')
})
test('a non-.md name is unchanged', () => {
  expect(folioConfirmSummary(['notes.txt']).split('\n')[1]).toBe('1. notes.txt')
})
test('from a drafted manifest', () => {
  const draft = JSON.stringify({ files: [{ path: 'a.md' }, { path: 'b.md' }] }, null, 2)
  expect(folioConfirmSummaryFromDraft(draft)).toBe('2 pieces will go into the Folio, in this order:\n1. a\n2. b')
})
test('bad draft falls back without a list', () => {
  expect(folioConfirmSummaryFromDraft('not json')).toBe(FOLIO_CONFIRM_FALLBACK)
  expect(folioConfirmSummaryFromDraft('{"files":3}')).toBe(FOLIO_CONFIRM_FALLBACK)
  expect(folioConfirmSummaryFromDraft('{"files":[{"path":1}]}')).toBe(FOLIO_CONFIRM_FALLBACK)
})
