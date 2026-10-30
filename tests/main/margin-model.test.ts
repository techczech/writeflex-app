import { expect, test } from 'bun:test'
import type { Change } from '../../src/preload'
import { ReviewCursor } from '../../src/renderer/src/app/review-cursor'
import { buildMarginModel, marginVisible, type MarginModel } from '../../src/renderer/src/app/margin-model'

const DOC = 'First line. Second line.! Third line. Fourth line, mine.'

function change(id: string, oldText: string, over: Partial<Change> = {}): Change {
  return {
    id, path: 'draft.md', ts: 1, provenance: 'agent', editClass: 'content', category: 'wording', summary: id,
    oldText, newText: `${oldText}!`, status: 'pending', isCorrection: false, ...over,
  }
}

const mixed = (): Change[] => [
  change('c', 'Third line.'),
  change('a', 'First line.'),
  change('o', 'Second line.', { provenance: 'reviewer', reviewerLabel: 'Claude Code' }),
  change('w', 'Fourth line.', { provenance: 'writer', newText: 'Fourth line, mine.' }),
  change('n', 'Fourth', { oldText: 'Fourth', newText: 'Fourth' }),
  change('lost', 'Never in the text.'),
  change('done', 'First', { status: 'accepted' }),
]

function everyId(model: MarginModel): string[] {
  return [...model.cards, ...model.unplaced].map((item) => item.id)
}

test('every eligible change appears once, as a card or as unplaced, never both', () => {
  const model = buildMarginModel({ changes: mixed(), document: DOC, view: 'margin', showOwnEdits: true })
  const ids = everyId(model)
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids.sort()).toEqual(['a', 'c', 'lost', 'n', 'o', 'w'])
  expect(model.unplaced.map((u) => u.id)).toEqual(['lost'])
  expect(model.cards.every((card) => card.anchor !== null)).toBe(true)
})

test('cards come in the order the review cursor walks them', () => {
  const changes = mixed()
  const model = buildMarginModel({ changes, document: DOC, view: 'margin', showOwnEdits: true })
  const visited: string[] = []
  const cursor = new ReviewCursor((e) => { if (e.id) visited.push(e.id) })
  cursor.sync(changes, DOC)
  while (cursor.move(1)) { /* walk */ }
  const placedWalk = visited.filter((id) => model.cards.some((c) => c.id === id))
  expect(model.cards.map((c) => c.id)).toEqual(placedWalk)
})

test('own edits and quiet fixes stay out until asked for, and are counted', () => {
  const changes = [...mixed(), change('q', 'Third', { editClass: 'copy' })]
  const base = buildMarginModel({ changes, document: DOC, view: 'margin' })
  expect(everyId(base)).not.toContain('w')
  expect(everyId(base)).not.toContain('q')
  expect(base.hiddenOwnEdits).toBe(1)
  expect(base.hiddenQuietFixes).toBe(1)
  const all = buildMarginModel({ changes, document: DOC, view: 'margin', showOwnEdits: true, showQuietFixes: true })
  expect(everyId(all)).toContain('w')
  expect(everyId(all)).toContain('q')
})

test('settled and snapshot changes are never cards', () => {
  const model = buildMarginModel({
    changes: [change('s', 'First line.', { snapshotId: 'v1' }), change('r', 'First', { status: 'rejected' }), change('ok', 'Third line.')],
    document: DOC, view: 'under',
  })
  expect(everyId(model)).toEqual(['ok'])
  expect(model.view).toBe('under')
})

test('head counts by source and kind match the cards under every filter', () => {
  const changes = mixed()
  const filters = [
    undefined,
    { sources: new Set(['agent']) },
    { sources: new Set(['outside:Claude Code']) },
    { sources: new Set(['you']) },
    { kinds: new Set(['note'] as const) },
    { kinds: new Set(['edit'] as const), sources: new Set(['agent', 'you']) },
  ]
  for (const filter of filters) {
    const model = buildMarginModel({ changes, document: DOC, view: 'margin', showOwnEdits: true, filter })
    const items = [...model.cards, ...model.unplaced]
    expect(model.counts.shown).toBe(items.length)
    expect(model.counts.byKind.edit).toBe(items.filter((i) => i.kind === 'edit').length)
    expect(model.counts.byKind.note).toBe(items.filter((i) => i.kind === 'note').length)
    for (const entry of model.counts.bySource) expect(entry.count).toBe(items.filter((i) => i.source.key === entry.key).length)
    expect(model.counts.bySource.reduce((n, e) => n + e.count, 0)).toBe(items.length)
    expect(model.counts.total).toBe(6)
  }
})

test('source counts list Agent, then outside sources, then You, and facets ignore the filter', () => {
  const model = buildMarginModel({ changes: mixed(), document: DOC, view: 'margin', showOwnEdits: true, filter: { kinds: new Set(['note']) } })
  expect(model.sourceFacets.map((s) => s.label)).toEqual(['Agent', 'Claude Code', 'You'])
  expect(model.sourceFacets.map((s) => s.count)).toEqual([4, 1, 1])
  expect(model.counts.shown).toBe(1)
})

test('the position reads the selected card among the cards, then the items that could not be placed', () => {
  const model = buildMarginModel({ changes: mixed(), document: DOC, view: 'margin', selectedId: 'o' })
  expect(model.position).toEqual({ index: 2, of: model.cards.length + model.unplaced.length })
  expect(buildMarginModel({ changes: mixed(), document: DOC, view: 'margin', selectedId: 'zzz' }).position).toBeNull()
})

test('a move keeps its words but is an edit with Accept and Decline, not a note', () => {
  const moved = change('mv', 'Second line.', { editClass: 'move', newText: 'Second line.', moveFrom: { from: 12, to: 24 }, moveTo: { from: 40, to: 40 } })
  const model = buildMarginModel({ changes: [moved], document: DOC, view: 'margin', showOwnEdits: false })
  expect([...model.cards, ...model.unplaced].map((item) => [item.id, item.kind])).toEqual([['mv', 'edit']])
})

test('the margin is drawn only when something is waiting', () => {
  const build = (changes: Change[]): MarginModel => buildMarginModel({ changes, document: DOC, view: 'margin', showOwnEdits: true })
  const none = { arrived: [] as Change[] }
  expect(marginVisible(build([]), none)).toBe(false)
  expect(marginVisible(build([]))).toBe(false)
  // Settled history alone does not raise it.
  expect(marginVisible(build([change('done', 'First', { status: 'accepted' })]), none)).toBe(false)
  expect(marginVisible(build([change('a', 'First line.')]), none)).toBe(true)
  const unplacedOnly = build([change('lost', 'Never in the text.')])
  expect(unplacedOnly.cards.length).toBe(0)
  expect(marginVisible(unplacedOnly, none)).toBe(true)
  // Arrivals and work elsewhere live in status-bar popovers; they must not reserve an empty column.
  expect(marginVisible(build([]), { arrived: [change('x', 'First')] })).toBe(false)
  expect(marginVisible(buildMarginModel({ changes: [], document: DOC, view: 'margin', others: [change('elsewhere', 'First', { path: 'other.md' })] }))).toBe(false)
  expect(marginVisible({ ...build([]), notPlaced: [change('closed', 'Gone')] })).toBe(false)
})

test('quiet fixes hidden from the margin still say where they wait, for the faint marker in the text (ticket 13)', () => {
  const changes = [...mixed(), change('q', 'Third', { editClass: 'copy' }), change('qa', 'Third', { editClass: 'copy', status: 'accepted' })]
  const hidden = buildMarginModel({ changes, document: DOC, view: 'margin' })
  expect(hidden.quietWaiting).toEqual([{ id: 'q', anchor: { from: DOC.indexOf('Third'), to: DOC.indexOf('Third') + 5 } }])
  const shown = buildMarginModel({ changes, document: DOC, view: 'margin', showQuietFixes: true })
  expect(shown.quietWaiting).toEqual([])
  expect(shown.cards.map((c) => c.id)).toContain('q')
})

// ---- ticket 06: stale items, items that could not be placed, settled this visit ----
import { staleRange, trackSettledHere } from '../../src/renderer/src/app/margin-model'
import { marginEntriesOf, layoutEntriesFor, TOP_PARAGRAPH } from '../../src/renderer/src/app/margin-geometry'

const PIECE = 'Most reading lists.\n\nA list does one job: it tells a person where to begin.\n\nThe last paragraph.\n'
const at = (text: string): { from: number; to: number } => ({ from: PIECE.indexOf(text), to: PIECE.indexOf(text) + text.length })

test('an item whose words changed under it sits beside what stands there now, marked changed', () => {
  // Written on "where to start"; the writer has since made it "where to begin". Its recorded span still lies over those words.
  const written = 'it tells a person where to start'
  const span = at('it tells a person where to begin')
  const drift = change('d', written, { newText: 'it says where to start', anchor: { from: span.from, to: span.from + written.length } })
  expect(staleRange(PIECE, drift)).toEqual(span)
  const model = buildMarginModel({ changes: [drift], document: PIECE, view: 'margin' })
  expect(model.cards.map((card) => [card.id, card.stale, card.anchor])).toEqual([['d', 'changed', span]])
  expect(model.unplaced).toEqual([])
})

test('an item whose words are gone sits at the paragraph they were in; one with no recorded place at the top', () => {
  const span = at('one job')
  const gone = change('g', 'a different thing', { anchor: { from: span.from, to: span.from + 17 } })
  const nowhere = change('n', 'never anywhere')
  const model = buildMarginModel({ changes: [gone, nowhere], document: PIECE, view: 'margin' })
  expect(model.cards).toEqual([])
  expect(model.unplaced.map((item) => [item.id, item.stale, item.at])).toEqual([['g', 'gone', PIECE.indexOf('A list')], ['n', 'gone', null]])
  // Laid out: the one with no paragraph first, at the top of the margin; the other with its paragraph.
  const entries = marginEntriesOf(model)
  expect(entries).toEqual([{ id: 'n', pos: null }, { id: 'g', pos: PIECE.indexOf('A list') }])
  const laid = layoutEntriesFor(entries, PIECE, { anchorTops: new Map([['g', 200]]), heights: new Map(), floor: 40, foldedIds: new Set() })
  expect(laid.map((card) => [card.id, card.paragraph, card.anchorTop])).toEqual([['n', TOP_PARAGRAPH, 40], ['g', PIECE.indexOf('A list') - 2, 200]])
})

test('words that resolve as written are never stale; a writer\'s edit never drifts', () => {
  expect(staleRange(PIECE, change('ok', 'one job'))).toBeNull()
  const span = at('one job')
  expect(staleRange(PIECE, change('w', 'one task', { provenance: 'writer', anchor: span }))).toBeNull()
})

test('the review cursor walks a changed item where its card is drawn', () => {
  const written = 'it tells a person where to start'
  const span = at('it tells a person where to begin')
  const drift = change('d', written, { anchor: { from: span.from, to: span.from + written.length } })
  const first = change('f', 'Most reading lists.')
  const events: Array<string | null> = []
  const cursor = new ReviewCursor((event) => events.push(event.id))
  cursor.sync([drift, first], PIECE)
  cursor.move(1)
  cursor.move(1)
  expect(events.filter((id) => id !== null).slice(-2)).toEqual(['f', 'd'])
})

test('settled this visit: only items seen waiting since the piece opened, settled by the writer, never one the app closed', () => {
  let state = { seen: new Set<string>() as ReadonlySet<string>, settled: new Set<string>() as ReadonlySet<string> }
  const waiting = [change('a', 'Most reading lists.'), change('b', 'one job')]
  state = trackSettledHere(state, ['a', 'b'], waiting)
  expect([...state.settled]).toEqual([])
  const after = [
    change('a', 'Most reading lists.', { status: 'accepted' }),
    change('b', 'one job', { status: 'rejected', closedReason: 'gone' }),
    change('old', 'x', { status: 'rejected' }),
  ]
  state = trackSettledHere(state, [], after)
  // 'b' was closed by the app, not settled by the writer; 'old' was never seen waiting this visit.
  expect([...state.settled]).toEqual(['a'])
  // Reopened: waiting again, and no longer a settled row.
  state = trackSettledHere(state, ['a'], [change('a', 'Most reading lists.')])
  expect([...state.settled]).toEqual([])
})

test('a settled row sits beside its words now, keeps its number, carries no card, and the filter hides it like a card', () => {
  const accepted = change('acc', 'Most reading lists.', { newText: 'Most lists.', status: 'accepted' })
  const declined = change('dec', 'one job', { status: 'rejected' })
  const waiting = change('w', 'The last paragraph.')
  const doc = PIECE.replace('Most reading lists.', 'Most lists.')
  const model = buildMarginModel({ changes: [accepted, declined, waiting], document: doc, view: 'margin', settledHere: new Set(['acc', 'dec']) })
  expect(model.cards.map((card) => card.id)).toEqual(['w'])
  expect(model.settled.map((row) => [row.id, row.outcome, row.anchor?.from])).toEqual([['acc', 'Accepted', 0], ['dec', 'Declined', doc.indexOf('one job')]])
  expect([...model.markers]).toEqual([['acc', 1], ['dec', 2], ['w', 3]])
  expect(model.counts.shown).toBe(1)
  const notes = buildMarginModel({ changes: [accepted, declined, waiting], document: doc, view: 'margin', settledHere: new Set(['acc', 'dec']), filter: { kinds: new Set(['note']) } })
  expect(notes.settled).toEqual([])
  // Settled rows alone do not keep the margin: nothing waiting, no margin (frame `none`).
  expect(marginVisible({ ...model, cards: [], unplaced: [] }, null)).toBe(false)
})
