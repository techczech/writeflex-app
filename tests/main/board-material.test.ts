import { expect, test } from 'bun:test'
import {
  addIdeaToTracker,
  appendToPieceText,
  ideaEntryLines,
  ideaTarget,
  planOffcutPromotion,
  planScrapAppend,
} from '../../src/main/board-material'

// Scraps ticket 02, the promote operation as a pure plan: scrap + name → tracker edit + scraps-file
// edit (docs/design/2026-09-27-scraps-and-sources-on-the-board, frame 3).

const SCRAPS = [
  '## s_mtb9yb2s0xq8',
  "Hall's high and low context cultures: every culture has high and low context areas.",
  '',
  '## s_mtb9yb3a1abc',
  'Families share more context than offices.',
  '',
].join('\n')

const TRACKER = [
  '# Schemas and Propositions',
  '',
  'Pieces about how we frame knowledge.',
  '',
  '## Ideas',
  '',
  '- [[frames-and-scripts]]',
  "- [[claude-shannons-list]]",
  '',
  '## Running order',
  '',
  '1. [[tools-of-reason]]',
  '',
].join('\n')

/** Remove exactly `added` from `after`: what is left must be the original, byte for byte. */
function withoutAdded(after: string, added: string[]): string {
  const block = `${added.join('\n')}\n`
  expect(after.split(block)).toHaveLength(2)
  return after.replace(block, '')
}

test('the idea target is the name as a file name, as the locked design writes it', () => {
  expect(ideaTarget('High and low context, everywhere')).toBe('high-and-low-context-everywhere')
  expect(ideaTarget("Claude Shannon's list")).toBe('claude-shannons-list')
  expect(ideaTarget('   ')).toBe('')
  expect(ideaTarget('—')).toBe('')
  expect(ideaEntryLines('x', 'one\n\ntwo\n')).toEqual(['- [[x]]', '  > one', '  >', '  > two'])
})

test('promote writes exactly one idea line plus the quote under Ideas, after the ideas already there', () => {
  const plan = planOffcutPromotion({
    trackerPath: 'c/_c_INDEX.md', tracker: TRACKER, collectionName: 'c',
    scrapsPath: 'c/scraps/how-humans-hallucinate-SCRAPS.md', scraps: SCRAPS, scrapId: 's_mtb9yb2s0xq8',
    name: 'High and low context, everywhere',
  })
  const added = ['- [[high-and-low-context-everywhere]]', "  > Hall's high and low context cultures: every culture has high and low context areas."]
  expect(plan.target).toBe('high-and-low-context-everywhere')
  expect(plan.tracker.after).toContain(`- [[claude-shannons-list]]\n${added.join('\n')}\n\n## Running order`)
  expect(withoutAdded(plan.tracker.after!, added)).toBe(TRACKER)
  expect(plan.tracker.before).toBe(TRACKER)
  // Exactly that scrap leaves; the other section is byte-identical.
  expect(plan.scraps.after).toBe('## s_mtb9yb3a1abc\nFamilies share more context than offices.\n')
})

test('the last scrap leaving empties the scraps file, which is then deleted', () => {
  const plan = planOffcutPromotion({
    trackerPath: 't.md', tracker: TRACKER, collectionName: 'c', scrapsPath: 's/scraps/a-SCRAPS.md',
    scraps: '## s_mtb9yb2s0xq8\nOnly one.\n', scrapId: 's_mtb9yb2s0xq8', name: 'Only one',
  })
  expect(plan.scraps.after).toBeNull()
})

test('a tracker without an Ideas section gains one at the end; no tracker gets a new one', () => {
  const bare = '# Schemas\n\nCover text.'
  const entry = ['- [[x]]', '  > y']
  expect(addIdeaToTracker(bare, 'Schemas', entry)).toBe('# Schemas\n\nCover text.\n\n## Ideas\n\n- [[x]]\n  > y\n')
  expect(addIdeaToTracker('# S\n\n', 'S', entry)).toBe('# S\n\n## Ideas\n\n- [[x]]\n  > y\n')
  expect(addIdeaToTracker(null, 'Schemas', entry)).toBe('# Schemas\n\n## Ideas\n\n- [[x]]\n  > y\n')
})

test('an empty Ideas section, one at the end of the file, and CRLF files keep everything else intact', () => {
  const entry = ['- [[x]]', '  > y']
  expect(addIdeaToTracker('# S\n\n## Ideas\n\n## Next\n', 'S', entry)).toBe('# S\n\n## Ideas\n\n- [[x]]\n  > y\n\n## Next\n')
  expect(addIdeaToTracker('# S\n\n## Ideas\n- [[a]]', 'S', entry)).toBe('# S\n\n## Ideas\n- [[a]]\n- [[x]]\n  > y\n')
  expect(addIdeaToTracker('# S\n\n## Ideas', 'S', entry)).toBe('# S\n\n## Ideas\n\n- [[x]]\n  > y\n')
  const crlf = '# S\r\n\r\n## Ideas\r\n\r\n- [[a]]\r\n\r\n## Next\r\n'
  expect(addIdeaToTracker(crlf, 'S', entry)).toBe('# S\r\n\r\n## Ideas\r\n\r\n- [[a]]\r\n- [[x]]\r\n  > y\r\n\r\n## Next\r\n')
})

test('an "## Ideas" inside a code fence is not the section', () => {
  const fenced = '# S\n\n```\n## Ideas\n```\n\n## Ideas\n\n- [[a]]\n'
  expect(addIdeaToTracker(fenced, 'S', ['- [[x]]'])).toBe('# S\n\n```\n## Ideas\n```\n\n## Ideas\n\n- [[a]]\n- [[x]]\n')
})

test('promote refuses an empty name, a name already in the tracker, and a scrap that is gone', () => {
  const base = { trackerPath: 't.md', tracker: TRACKER, collectionName: 'c', scrapsPath: 's/scraps/a-SCRAPS.md', scraps: SCRAPS, scrapId: 's_mtb9yb2s0xq8' }
  expect(() => planOffcutPromotion({ ...base, name: '  ' })).toThrow(/Give the idea a name/)
  expect(() => planOffcutPromotion({ ...base, name: 'Frames and scripts' })).toThrow(/already in the tracker note/)
  expect(() => planOffcutPromotion({ ...base, name: 'New', scrapId: 's_gone' })).toThrow(/No scrap with id s_gone/)
})

test('append puts the scrap at the end of the piece as its own paragraph and takes it out of its file', () => {
  expect(appendToPieceText('# P\n\nBody.\n', 'Cut text.')).toBe('# P\n\nBody.\n\nCut text.\n')
  expect(appendToPieceText('# P\n\nBody.', 'Cut text.\n')).toBe('# P\n\nBody.\n\nCut text.\n')
  expect(appendToPieceText('# P\n\n', 'Cut text.')).toBe('# P\n\nCut text.\n')
  expect(appendToPieceText('# P\r\n\r\nBody.\r\n', 'a\nb')).toBe('# P\r\n\r\nBody.\r\n\r\na\r\nb\r\n')
  const plan = planScrapAppend({ piecePath: 'p.md', piece: '# P\n\nBody.\n', scrapsPath: 'scraps/p-SCRAPS.md', scraps: SCRAPS, scrapId: 's_mtb9yb3a1abc' })
  expect(plan.piece.after).toBe('# P\n\nBody.\n\nFamilies share more context than offices.\n')
  // The scrap's section (its heading, body and trailing blank line) goes, as ScrapStore.remove does.
  expect(plan.scraps.after).toBe("## s_mtb9yb2s0xq8\nHall's high and low context cultures: every culture has high and low context areas.\n")
})
