/**
 * The window's side of two review features, pure: a change to the metadata marks the metadata (its field in
 * the panel, its card in words), never the writing; and Accept all / Decline all from one source (the rows,
 * the count menu, the confirm sheet's words and what it reports after).
 */
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Change } from '../../src/preload'
import { frontmatterBlockEdit, frontmatterFieldChanges } from '../../src/shared/markdown/frontmatter-proposal'
import { resolveChangeRange } from '../../src/renderer/src/editor/change-marks'
import { metadataFieldsOf, metadataProposalsOf, metadataSegments } from '../../src/renderer/src/app/metadata-proposal'
import { buildMarginModel } from '../../src/renderer/src/app/margin-model'
import { describeMarginCard } from '../../src/renderer/src/app/margin-card'
import { countMenu, type CountMenuRow } from '../../src/renderer/src/app/margin-count-menu'
import { EMPTY_HEAD_FILTER } from '../../src/renderer/src/app/margin-head-state'
import { acceptResult, declineResult, outsideSourceRows, sourceBulkQuestion } from '../../src/renderer/src/app/outside-source-bulk'
import { SourceBulkSheet } from '../../src/renderer/src/components/ReviewSourceSheet'
import { asFrontmatterForWindow } from '../../src/main/frontmatter-change'

const DOC = '---\ntitle: The talk\nstatus: draft\n---\n# The talk\n\nstatus: draft\n\nThe end.\n'
const NEXT = DOC.replace('status: draft\n---', 'status: final\n---')

const change = (over: Partial<Change>): Change => ({
  id: 'm1', path: 'talk.md', ts: 1, provenance: 'agent', editClass: 'content', category: 'other', summary: 'Set status', oldText: '', newText: '',
  status: 'pending', isCorrection: false, outsideSource: 'claude-code', ...over,
} as Change)

const BLOCK = '---\ntitle: The talk\nstatus: draft\n---\n'

test('a metadata change is the whole old block and the whole new block; null when the writing changes too', () => {
  expect(frontmatterBlockEdit(DOC, NEXT)).toEqual({ from: 0, to: BLOCK.length, oldText: BLOCK, newText: BLOCK.replace('status: draft', 'status: final') })
  expect(frontmatterBlockEdit(DOC, `${NEXT}More.\n`)).toBeNull()
  expect(frontmatterBlockEdit('# No block\n', '---\ntitle: x\n---\n# No block\n')).toBeNull()
  expect(frontmatterBlockEdit(DOC, `\uFEFF${NEXT}`)).toBeNull()
})

test('the fields a change makes, in words', () => {
  expect(frontmatterFieldChanges(DOC, NEXT)).toEqual([{ key: 'status', before: 'draft', after: 'final' }])
  expect(frontmatterFieldChanges(DOC, DOC.replace('status: draft\n---', 'status: draft\ntags: [a, b]\n---'))).toEqual([{ key: 'tags', before: null, after: 'a, b' }])
  expect(metadataSegments([{ key: 'status', before: 'draft', after: 'final' }, { key: 'audience', before: null, after: 'teachers' }])).toEqual([
    { kind: 'text', text: 'Metadata · ' }, { kind: 'text', text: 'status: ' }, { kind: 'del', text: 'draft' }, { kind: 'text', text: ' ' }, { kind: 'ins', text: 'final' },
    { kind: 'text', text: ' · ' }, { kind: 'text', text: 'audience: ' }, { kind: 'ins', text: 'teachers' }, { kind: 'text', text: ' (new)' },
  ])
  expect(metadataSegments([])).toBeNull()
})

test('a metadata change is marked over the frontmatter block only while it is exactly as proposed, never on the writing', () => {
  const filed = change({ oldText: BLOCK, newText: BLOCK.replace('status: draft', 'status: final'), anchor: { from: 0, to: BLOCK.length }, frontmatter: true })
  expect(resolveChangeRange(DOC, filed)).toEqual({ from: 0, to: BLOCK.length })
  // An edit to the writing does not matter.
  expect(resolveChangeRange(DOC.replace('The end.', 'The finish.'), filed)).toEqual({ from: 0, to: BLOCK.length })
  // Any change to the block, and no mark (the card still says the fields, from its own two blocks).
  expect(resolveChangeRange(DOC.replace('title: The talk', 'title: The longer talk'), filed)).toBeNull()
  expect(resolveChangeRange(DOC.replace('status: draft\n---', 'otherstatus: draft\n---'), filed)).toBeNull()
  expect(resolveChangeRange('# The talk\n\nstatus: draft\n', filed)).toBeNull()
})

test('an older whole-document metadata record reads as its block: no mark on the writing, the field named on the card', () => {
  const legacy = asFrontmatterForWindow(change({ oldText: DOC, newText: NEXT, whole: true }))
  const range = resolveChangeRange(DOC, legacy)!
  expect(range).toEqual({ from: 0, to: BLOCK.length })
  expect(metadataFieldsOf(DOC, range, legacy.newText)).toEqual([{ key: 'status', before: 'draft', after: 'final' }])
  const model = buildMarginModel({ changes: [legacy], document: DOC, view: 'margin' })
  expect(model.cards).toHaveLength(1)
  const card = describeMarginCard(model.cards[0], 1, Date.now(), DOC)
  expect(card.segments.map((segment) => segment.text).join('')).toBe('Metadata · status: draft final')
  expect(metadataProposalsOf(DOC, model.cards)).toEqual([{ id: 'm1', key: 'status', before: 'draft', after: 'final', by: 'Claude Code' }])
})

const outside = (id: string, source: Change['outsideSource'], path: string, over: Partial<Change> = {}): Change => change({ id, outsideSource: source, path, oldText: 'a', newText: 'b', ...over })

test('the sources with changes waiting, never readers, most first; the count menu offers Accept all and Decline all for each', () => {
  const rows = outsideSourceRows([
    outside('1', 'claude-code', 'a.md'), outside('2', 'claude-code', 'b.md', { status: 'held' }), outside('3', 'claude-code', 'a.md', { editClass: 'move' }),
    outside('4', 'codex', 'c.md'), outside('5', 'reader', 'a.md'), outside('6', 'codex', 'c.md', { status: 'accepted' }),
  ])
  expect(rows.map((row) => [row.source, row.undecided, row.held, row.moves, row.documents])).toEqual([['claude-code', 3, 1, 1, 2], ['codex', 1, 0, 0, 1]])
  const menu = countMenu({ model: buildMarginModel({ changes: [], document: '', view: 'margin' }), state: EMPTY_HEAD_FILTER, preferredView: 'margin', textRoom: 800, marginHidden: false, outsideSources: rows })
  const items = menu.flatMap((row: CountMenuRow) => (row.kind === 'item' ? [row] : []))
  expect(menu.some((row) => row.kind === 'heading' && row.label === 'From outside, across this collection')).toBe(true)
  expect(items.filter((row) => row.id.startsWith('outside-')).map((row) => [row.label, row.action])).toEqual([
    ['Accept all 2 from Claude Code…', { type: 'outside-source', action: 'accept', source: 'claude-code' }],
    ['Decline all 3 from Claude Code…', { type: 'outside-source', action: 'decline', source: 'claude-code' }],
    ['Accept all 1 from Codex…', { type: 'outside-source', action: 'accept', source: 'codex' }],
    ['Decline all 1 from Codex…', { type: 'outside-source', action: 'decline', source: 'codex' }],
  ])
})

test('the confirm sheet states the count and the whole-collection scope, and reports what was done', () => {
  const [row] = outsideSourceRows([outside('1', 'claude-code', 'a.md'), outside('2', 'claude-code', 'b.md', { status: 'held' }), outside('3', 'claude-code', 'a.md', { editClass: 'move' })])
  const accept = sourceBulkQuestion(row, 'accept', 1)
  expect(accept.title).toBe('Accept all 2 from Claude Code?')
  expect(accept.detail).toBe('Across this collection: 2 changes from Claude Code in 2 documents, including one you held.')
  expect(accept.reassurance).toContain('Moves are not included: 1 move is left for you to accept from its card.')
  expect(accept.reassurance).toContain('1 document is open in this window')
  const decline = sourceBulkQuestion(row, 'decline')
  // Decline all is all of them, the move too (review 2026-10-27): declining writes nothing.
  expect(decline).toMatchObject({ title: 'Decline all 3 from Claude Code?', count: 3, reassurance: 'The text stays as it is. Each one can be reopened from Settled today. The move among them is declined too.' })
  const html = renderToStaticMarkup(<SourceBulkSheet sheet={{ action: 'decline', rows: [row], source: 'claude-code', question: decline, running: false, result: null, onPickSource: () => {}, onConfirm: () => {}, onCancel: () => {} }} />)
  expect(html).toContain('Decline 3')
  expect(html).toContain('Across this collection')
  expect(html).toContain('Esc')
  expect(declineResult('Codex', 4).title).toBe('Declined 4 changes from Codex.')
  const result = acceptResult('Claude Code', { accepted: 3, files: ['a.md', 'b.md'], left: [{ id: 'x', path: 'notes/c.md', reason: 'The text this change replaces is no longer in notes/c.md.' }], closed: [] }, 1, [], ['d.md'])
  expect(result.title).toBe('Accepted 4 changes from Claude Code in 3 documents. 1 is left waiting.')
  expect(result.lines).toEqual(['c.md: The text this change replaces is no longer in notes/c.md.'])
})
