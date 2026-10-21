import { expect, test } from 'bun:test'
import type { Change } from '../../src/preload'
import { describeMarginCard, describeSettledCard } from '../../src/renderer/src/app/margin-card'
import { buildMarginModel } from '../../src/renderer/src/app/margin-model'

// 0.23 ticket 05: your own edits, held pairs, quiet fixes and settled items, in the model and the count menu (the head is gone, ticket 10).

const DOC = 'First line. Second line. Third line. Fourth line, mine.'
const NOW = Date.parse('2026-10-14T15:00:00')
const EARLIER = Date.parse('2026-10-13T09:00:00')

function change(id: string, oldText: string, over: Partial<Change> = {}): Change {
  return {
    id, path: 'draft.md', ts: NOW - 1000, provenance: 'agent', editClass: 'content', category: 'wording', summary: id,
    oldText, newText: `${oldText}!`, status: 'pending', isCorrection: false, ...over,
  }
}
const writer = (id: string, over: Partial<Change> = {}): Change =>
  change(id, 'Fourth line.', { provenance: 'writer', newText: 'Fourth line, mine.', ...over })

test('your edits are counted as hidden and become cards only in the My edits view', () => {
  const changes = [change('a', 'First line.'), writer('w1'), writer('w2', { oldText: 'Third', newText: 'Third line.', summary: 'w2' })]
  const closed = buildMarginModel({ changes, document: DOC, view: 'margin', now: NOW })
  expect(closed.cards.map((c) => c.id)).toEqual(['a'])
  expect(closed.hiddenOwnEdits).toBe(2)
  const open = buildMarginModel({ changes, document: DOC, view: 'margin', now: NOW, showOwnEdits: true })
  expect(open.cards.map((c) => c.id)).toContain('w1')
  expect(open.hiddenOwnEdits).toBe(0)
})

test('a card for your edit says Proposed edit from You and offers Accept, Decline and Reply', () => {
  const model = buildMarginModel({ changes: [writer('w1')], document: DOC, view: 'margin', now: NOW, showOwnEdits: true })
  const descriptor = describeMarginCard(model.cards[0], 1, NOW)
  expect(descriptor.name).toBe('You')
  expect(descriptor.roleTag).toBe('you')
  expect(descriptor.primary.map((i) => i.id)).toEqual(['accept', 'decline', 'reply'])
})

test('a held pair keeps its status on the card and answers the Held filter', () => {
  const changes = [change('h', 'Second line.', { status: 'held' }), change('a', 'First line.')]
  const model = buildMarginModel({ changes, document: DOC, view: 'margin', now: NOW })
  expect(model.heldCount).toBe(1)
  expect(describeMarginCard(model.cards.find((c) => c.id === 'h')!, 1, NOW).statusLabel).toBe('Held both')
  const held = buildMarginModel({ changes, document: DOC, view: 'margin', now: NOW, filter: { status: 'held' } })
  expect(held.cards.map((c) => c.id)).toEqual(['h'])
  expect(held.counts.total).toBe(2)
})

test('quiet fixes stay folded out, then show: pending as cards, applied as settled cards', () => {
  const changes = [change('q1', 'Third', { editClass: 'copy' }), change('q2', 'First', { editClass: 'copy', status: 'accepted' }), change('a', 'Second line.')]
  const folded = buildMarginModel({ changes, document: DOC, view: 'margin', now: NOW })
  expect(folded.cards.map((c) => c.id)).toEqual(['a'])
  expect(folded.hiddenQuietFixes).toBe(1)
  expect(folded.quietApplied.map((c) => c.id)).toEqual(['q2'])
  const shown = buildMarginModel({ changes, document: DOC, view: 'margin', now: NOW, showQuietFixes: true })
  expect(shown.cards.map((c) => c.id)).toContain('q1')
  // Since ticket 08 an applied quiet fix is reached in Settled today with Include quiet fixes.
  const settled = buildMarginModel({ changes, document: DOC, view: 'margin', now: NOW, mode: 'settled', showQuietFixes: true })
  expect(settled.settled.map((row) => [row.id, row.outcome])).toEqual([['q2', 'Applied']])
})

test('settled today are accepted and declined records from today, drawn as cards with the way back', () => {
  const changes = [
    change('acc', 'First line.', { status: 'accepted' }),
    change('rej', 'Second line.', { status: 'rejected' }),
    change('old', 'Third line.', { status: 'accepted', ts: EARLIER }),
    change('new', 'Fourth line'),
  ]
  const model = buildMarginModel({ changes, document: DOC, view: 'margin', now: NOW })
  expect(model.settledToday.map((c) => c.id).sort()).toEqual(['acc', 'rej'])
  expect(model.cards.map((c) => c.id)).toEqual(['new'])
  // Ticket 08: Settled today is a mode; its cards sit beside their words (margin-mode.test.tsx draws them).
  const mode = buildMarginModel({ changes, document: DOC, view: 'margin', now: NOW, mode: 'settled' })
  expect(mode.settled.map((row) => row.id).sort()).toEqual(['acc', 'rej'])
  expect(mode.cards).toEqual([])
  expect(describeSettledCard(changes[0], NOW).statusLabel).toBe('Accepted')
  expect(describeSettledCard(changes[1], NOW).statusLabel).toBe('Declined')
})

test('a change that also writes a new file says so on its card', () => {
  const withFile = change('nf', 'First line.', { newFile: { path: 'extra.md', content: 'x', sha256: 'h' } })
  const model = buildMarginModel({ changes: [withFile], document: DOC, view: 'margin', now: NOW })
  expect(describeMarginCard(model.cards[0], 1, NOW).newFilePath).toBe('extra.md')
  const settled = describeSettledCard({ ...withFile, status: 'accepted' }, NOW)
  expect(settled.newFilePath).toBe('extra.md')
  expect(settled.canSendOriginal).toBe(false)
})
