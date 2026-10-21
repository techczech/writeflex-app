import { expect, test } from 'bun:test'
import type { Change } from '../../src/preload'
import { batchProgress, bulkTargets, declineQuestion, EMPTY_BATCH, nextBatch, runTargets, sendBackScope, showingLine, visibleSelection, waitingEditIds } from '../../src/renderer/src/app/margin-bulk'
import { cardKeyAction, describeMarginCard } from '../../src/renderer/src/app/margin-card'
import { buildMarginModel, isUnfiltered, type MarginFilter } from '../../src/renderer/src/app/margin-model'

const DOC = 'Alpha one. Beta two. Gamma three. Delta four. Epsilon five. Zeta six.'
const NOW = new Date('2026-10-14T15:00:00').getTime()

function change(id: string, oldText: string, over: Partial<Change> = {}): Change {
  return {
    id, path: 'draft.md', ts: NOW - 1000, provenance: 'agent', editClass: 'content', category: 'wording', summary: id,
    oldText, newText: `${oldText}!`, status: 'pending', isCorrection: false, ...over,
  }
}

const outside = { provenance: 'reviewer' as const, reviewerLabel: 'Claude Code' }
const set = <T,>(...values: T[]): ReadonlySet<T> => new Set(values)

const fixture = (): Change[] => [
  change('agent-edit', 'Alpha one.'),
  change('agent-ins', 'Beta two.', { editClass: 'insert', oldText: '', newText: 'Beta two.', insertAfter: 'Alpha one. ', category: 'clarity' }),
  change('cc-1', 'Gamma three.', { ...outside, sessionId: 's1', category: 'structure' }),
  change('cc-del', 'Delta four.', { ...outside, sessionId: 's1', newText: '' }),
  change('cc-note', 'Epsilon five.', { ...outside, sessionId: 's2', newText: 'Epsilon five.' }),
  change('held', 'Zeta six.', { status: 'held', category: null }),
  change('mine', 'Alpha', { provenance: 'writer', newText: 'Alpha!' }),
  change('yesterday', 'Beta', { status: 'accepted', ts: NOW - 86_400_000 * 2 }),
  change('today-done', 'Gamma', { status: 'accepted', ts: NOW - 5000 }),
  change('today-no', 'Delta', { status: 'rejected', ts: NOW - 4000 }),
]

const build = (filter?: MarginFilter, showOwnEdits = false) => buildMarginModel({ changes: fixture(), document: DOC, view: 'margin', filter, showOwnEdits, now: NOW })
const shown = (filter?: MarginFilter): string[] => { const m = build(filter); return [...m.cards, ...m.unplaced].map((i) => i.id).sort() }

test('every filter narrows the cards and the counts agree with what is drawn', () => {
  expect(shown()).toEqual(['agent-edit', 'agent-ins', 'cc-1', 'cc-del', 'cc-note', 'held'])
  expect(shown({ sources: set('agent') })).toEqual(['agent-edit', 'agent-ins', 'held'])
  expect(shown({ sources: set('outside:Claude Code') })).toEqual(['cc-1', 'cc-del', 'cc-note'])
  expect(shown({ kinds: set('note') })).toEqual(['cc-note'])
  expect(shown({ kinds: set('edit'), sources: set('outside:Claude Code') })).toEqual(['cc-1', 'cc-del'])
  expect(shown({ direction: 'insertions' })).toEqual(['agent-ins'])
  expect(shown({ direction: 'deletions' })).toEqual(['cc-del'])
  expect(shown({ categories: set('structure') })).toEqual(['cc-1'])
  expect(shown({ categories: set('structure', 'clarity') })).toEqual(['agent-ins', 'cc-1'])
  expect(shown({ status: 'held' })).toEqual(['held'])
  expect(shown({ status: 'waiting' })).toEqual(['agent-edit', 'agent-ins', 'cc-1', 'cc-del', 'cc-note'])
  expect(shown({ requests: set('s2') })).toEqual(['cc-note'])
  const model = build({ sources: set('outside:Claude Code') })
  expect(model.counts.shown).toBe(3)
  expect(model.counts.total).toBe(6)
  expect(model.counts.byKind).toEqual({ edit: 2, note: 1 })
  expect(showingLine(model, { sources: set('outside:Claude Code') })).toEqual({ text: 'Showing 3 of 6', because: 'from Claude Code', filtered: true })
})

test('the facets stay put while another filter is on, and the own edits appear only when asked for', () => {
  const model = build({ sources: set('agent') })
  expect(model.sourceFacets.map((s) => [s.key, s.count])).toEqual([['agent', 3], ['outside:Claude Code', 3]])
  expect(model.hiddenOwnEdits).toBe(1)
  expect(model.heldCount).toBe(1)
  expect(model.directionFacets).toEqual({ insertions: 1, deletions: 1 })
  expect(model.categoryFacets.map((c) => c.key)).toEqual(['wording', 'structure', 'clarity', 'uncategorised'])
  expect(model.requestFacets.map((r) => [r.key, r.count])).toEqual([['s1', 2], ['s2', 1]])
  expect(shown({ sources: set('you') })).toEqual([])
  const own = build({ sources: set('you') }, true)
  expect([...own.cards, ...own.unplaced].map((c) => c.id)).toEqual(['mine'])
  expect(isUnfiltered({})).toBe(true)
  expect(isUnfiltered({ sources: set('agent') })).toBe(false)
})

test('settled today lists what was accepted or declined today and nothing older', () => {
  expect(build().settledToday.map((c) => c.id)).toEqual(['today-no', 'today-done'])
})

test('accept all and decline all touch only what the filter shows', () => {
  const filter: MarginFilter = { sources: set('outside:Claude Code') }
  const model = build(filter)
  const targets = bulkTargets(model, new Set(), filter)
  expect(targets.scope).toBe('filter')
  expect(targets.ids.sort()).toEqual(['cc-1', 'cc-del', 'cc-note'])
  expect(targets.declinable.sort()).toEqual(['cc-1', 'cc-del'])
  expect(bulkTargets(model, new Set(), filter, 'note').ids).toEqual(['cc-note'])
  // Nothing hidden by the filter, and nothing held, is ever in the list.
  expect(targets.ids).not.toContain('agent-edit')
  expect(targets.ids).not.toContain('held')
  expect(bulkTargets(build(), new Set(), undefined).ids).not.toContain('held')
  expect(bulkTargets(build({ status: 'held' }), new Set(), { status: 'held' }).ids).toEqual(['held'])
  expect(bulkTargets(build({ kinds: set('note') }), new Set(), { kinds: set('note') })).toMatchObject({ edits: 0, notes: 1, declinable: [] })
})

test('a selection wins over the filter, and a card the filter hides drops out of it', () => {
  const filter: MarginFilter = { sources: set('outside:Claude Code') }
  const model = build(filter)
  const picked = set('cc-1', 'agent-edit')
  expect(visibleSelection(model, picked)).toEqual(['cc-1'])
  const targets = bulkTargets(model, picked, filter)
  expect(targets).toMatchObject({ scope: 'selection', ids: ['cc-1'], declinable: ['cc-1'] })
  // Selected held items are included: the writer chose them.
  expect(bulkTargets(build(), set('held'), undefined).ids).toEqual(['held'])
})

test('A, D and R act on a focused card only as far as the card offers them', () => {
  const m = build()
  const describe = (id: string) => describeMarginCard([...m.cards, ...m.unplaced].find((c) => c.id === id)! as never, 1, NOW)
  expect(cardKeyAction('a', describe('agent-edit'))).toBe('accept')
  expect(cardKeyAction('D', describe('agent-edit'))).toBe('decline')
  expect(cardKeyAction('r', describe('agent-edit'))).toBe('reply')
  expect(cardKeyAction('d', describe('cc-note'))).toBeNull()
  expect(cardKeyAction('r', describe('cc-1'))).toBeNull()
  expect(cardKeyAction('x', describe('agent-edit'))).toBeNull()
})

// ── Ticket 04 (review margin as comments): what the run-level keys and rows act on, the Decline all question,
// Send back's scope, and the batch behind "M of N settled". ─────────────────────────────────────────────────
const reader = (id: string, oldText: string, name: string, over: Partial<Change> = {}): Change => change(id, oldText, {
  provenance: 'reviewer', outsideSource: 'reader',
  readerNote: { shareId: 'share-1', key: `k.${id}`, link: 'Seminar group', name, kind: 'edit', text: `${oldText}!`, quote: oldText, anchored: 'unchanged', at: NOW - 500 },
  ...over,
} as Partial<Change>)

test('runTargets: with a filter on, Accept all and Decline all take only the shown edits; picked cards win over the filter', () => {
  const filter: MarginFilter = { sources: set('outside:Claude Code') }
  const model = build(filter)
  // Accept all (⇧⌘A, "Accept all N"): the shown edits only, never the hidden agent's or the shown comment.
  expect(runTargets(model, new Set(), filter, 'accept').ids.sort()).toEqual(['cc-1', 'cc-del'])
  expect(runTargets(model, new Set(), filter, 'done').ids).toEqual(['cc-note'])
  expect(runTargets(model, new Set(), filter, 'decline').declinable.sort()).toEqual(['cc-1', 'cc-del'])
  for (const what of ['accept', 'done', 'decline'] as const) {
    const ids = runTargets(model, new Set(), filter, what).ids
    expect(ids).not.toContain('agent-edit')
    expect(ids).not.toContain('agent-ins')
    expect(ids).not.toContain('held')
  }
  // Picked: both kinds, only the picked that are still shown (a picked card the filter hides is never touched).
  const picked = set('cc-1', 'cc-note', 'agent-edit')
  const pickedTargets = runTargets(model, picked, filter, 'accept')
  expect(pickedTargets).toMatchObject({ scope: 'selection', declinable: ['cc-1'] })
  expect(pickedTargets.ids.sort()).toEqual(['cc-1', 'cc-note'])
  expect(runTargets(model, picked, filter, 'decline').declinable).toEqual(['cc-1'])
})

test('the Decline all question names the readers who will see it and counts the rest', () => {
  const changes = [
    change('a1', 'Alpha one.'),
    reader('j1', 'Beta two.', 'Jonas'),
    change('c1', 'Gamma three.', { ...outside }),
  ]
  const model = buildMarginModel({ changes, document: DOC, view: 'margin', now: NOW })
  const q = declineQuestion(model, ['a1', 'j1', 'c1'])
  expect(q.title).toBe('Decline 3 edits?')
  expect(q.count).toBe(3)
  expect(q.readersSee).toBe(true)
  expect(q.detail).toBe('One is Jonas’s proposed edit: Jonas will see it declined on the reader page. One is the agent’s, one is Claude Code’s.')
  expect(q.reassurance).toBe('The text stays as it is. Each one can be reopened from Settled today.')
  const agentOnly = declineQuestion(model, ['a1'])
  expect(agentOnly).toMatchObject({ title: 'Decline 1 edit?', detail: 'It is the agent’s.', readersSee: false, count: 1 })
  const two = buildMarginModel({ changes: [change('a1', 'Alpha one.', outside), change('a2', 'Beta two.', outside)], document: DOC, view: 'margin', now: NOW })
  expect(declineQuestion(two, ['a1', 'a2']).detail).toBe('All 2 are Claude Code’s.')
  // Only the ids asked about: a shown card that is not among them is not counted.
  expect(declineQuestion(model, ['j1']).detail).toBe('One is Jonas’s proposed edit: Jonas will see it declined on the reader page.')
})

test('Send back covers the agent’s shown waiting items only and says who is left out', () => {
  const changes = [
    change('a1', 'Alpha one.'),
    change('an', 'Beta two.', { newText: 'Beta two.' }),
    reader('m1', 'Gamma three.', 'Marta'),
    change('c1', 'Delta four.', { ...outside }),
  ]
  const all = sendBackScope(buildMarginModel({ changes, document: DOC, view: 'margin', now: NOW }))
  expect(all.ids.sort()).toEqual(['a1', 'an'])
  expect(all).toMatchObject({ edits: 1, comments: 1 })
  expect(all.text).toBe('Goes back: the agent’s 2 waiting items (1 edit, 1 comment), with this note. They stay in the margin marked Sent back until the agent answers. Readers and Claude Code are not included.')
  // A filter narrows it further: Edits only leaves the agent's comment out.
  const edits = sendBackScope(buildMarginModel({ changes, document: DOC, view: 'margin', now: NOW, filter: { kinds: set('edit') } }))
  expect(edits.ids).toEqual(['a1'])
  expect(sendBackScope(buildMarginModel({ changes: [changes[3]], document: DOC, view: 'margin', now: NOW })).ids).toEqual([])
})

test('a batch of six or more: progress once one is settled; a new piece or an empty piece starts again; arrivals join', () => {
  const ids = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']
  let batch = nextBatch(EMPTY_BATCH, 'a.md', ids)
  expect(batch.ids.size).toBe(7)
  expect(batchProgress(batch, ids)).toBeNull()
  batch = nextBatch(batch, 'a.md', ids.slice(1))
  expect(batch.ids.size).toBe(7)
  expect(batchProgress(batch, ids.slice(1))).toEqual({ settled: 1, total: 7 })
  batch = nextBatch(batch, 'a.md', [...ids.slice(1), 'e8'])
  expect(batchProgress(batch, [...ids.slice(1), 'e8'])).toEqual({ settled: 1, total: 8 })
  // Under six: never.
  const small = nextBatch(EMPTY_BATCH, 'b.md', ['x1', 'x2', 'x3', 'x4', 'x5'])
  expect(batchProgress(small, ['x1'])).toBeNull()
  // Another piece, or nothing left waiting, starts a new batch.
  expect(nextBatch(batch, 'b.md', ['y1']).ids).toEqual(new Set(['y1']))
  expect(nextBatch(batch, 'a.md', []).ids.size).toBe(0)
  // The waiting edits of a piece, before any filter: no comments, no held? held edits still wait.
  expect(waitingEditIds(build()).sort()).toEqual(['agent-edit', 'agent-ins', 'cc-1', 'cc-del', 'held'])
})
