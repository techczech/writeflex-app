import { expect, test } from 'bun:test'
import { digestSummaryLine } from '../../src/renderer/src/components/Digest'

const digest = (statuses: Record<string, number>, pieces = 69) => ({ collection: 'unitybc-paper', summary: { pieces, statuses }, pieces: [], readThisTurn: [] }) as never

test('the Digest is one line: name, piece count, and the three largest status groups in the writer\'s own words', () => {
  const line = digestSummaryLine(digest({ draft: 11, Unsorted: 23, 'thematic-synthesis': 3, proposed: 3, working: 4 }))
  expect(line).toBe('unitybc-paper · 69 pieces · 23 Unsorted · 11 draft · 4 working')
  expect(line.split('\n')).toHaveLength(1)
})

test('one piece is a piece, and empty groups are left out', () => {
  expect(digestSummaryLine(digest({ draft: 1, idea: 0 }, 1))).toBe('unitybc-paper · 1 piece · 1 draft')
})
