import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Change } from '../../src/preload'
import { describeMarginCard } from '../../src/renderer/src/app/margin-card'
import { buildMarginModel, marginSource } from '../../src/renderer/src/app/margin-model'
import type { MarginOutside } from '../../src/renderer/src/app/margin-outside'
import { MarginTop, ReviewMarginPanel } from '../../src/renderer/src/components/ReviewMargin'
import { NotPlacedPopover } from '../../src/renderer/src/components/ReviewNotPlacedPopover'
import { reviewLine } from '../../src/renderer/src/components/status-bar-model'

const DOC = 'First line. Second line. Third line.'
const NOON = Date.parse('2026-10-14T14:02:00')

function outsideChange(id: string, oldText: string, over: Partial<Change> = {}): Change {
  return {
    id, path: 'draft.md', ts: NOON, provenance: 'agent', editClass: 'content', category: 'wording', summary: id,
    oldText, newText: `${oldText}!`, status: 'pending', isCorrection: false,
    outsideSource: 'claude-code', outsideRequest: { id: 'req-1', index: 2, count: 5, at: NOON }, ...over,
  } as Change
}

const noop = (): void => {}
const outsideProps = (over: Partial<MarginOutside> = {}): MarginOutside => ({
  summary: null, arrived: [], ...over,
})

test('a change from the command line is an outside source, labelled from the closed list', () => {
  expect(marginSource(outsideChange('o', 'First line.'))).toEqual({ key: 'outside:Claude Code', type: 'outside', label: 'Claude Code' })
  expect(marginSource(outsideChange('o', 'First line.', { outsideSource: 'codex' })).label).toBe('Codex')
})

test('an outside card carries the tag with its place in the request and the hover title, and has no Reply', () => {
  const model = buildMarginModel({ changes: [outsideChange('o', 'Second line.')], document: DOC, view: 'margin' })
  const descriptor = describeMarginCard(model.cards[0], 1, NOON)
  expect(descriptor.name).toBe('Claude Code')
  expect(descriptor.roleTagText).toBe('outside │ 2/5')
  expect(descriptor.title).toBe('From Claude Code, 14:02 today, change 2 of 5')
  expect(descriptor.primary.map((item) => item.id)).toEqual(['accept', 'decline'])
})

test('a one-change request is tagged outside without a count; an in-app agent card has no title', () => {
  const one = buildMarginModel({ changes: [outsideChange('o', 'First line.', { outsideRequest: { id: 'r', index: 1, count: 1, at: NOON } })], document: DOC, view: 'margin' })
  expect(describeMarginCard(one.cards[0], 1, NOON).roleTagText).toBe('outside')
  const agent = buildMarginModel({ changes: [outsideChange('a', 'First line.', { outsideSource: undefined, outsideRequest: undefined })], document: DOC, view: 'margin' })
  expect(describeMarginCard(agent.cards[0], 1, NOON).title).toBeNull()
  expect(describeMarginCard(agent.cards[0], 1, NOON).roleTagText).toBe('agent')
})

test('an outside change whose passage is gone is unplaced, counted once, and still waits', () => {
  const model = buildMarginModel({ changes: [outsideChange('lost', 'Never in the text.'), outsideChange('here', 'First line.')], document: DOC, view: 'margin' })
  expect(model.cards.map((c) => c.id)).toEqual(['here'])
  expect(model.unplaced.map((u) => u.id)).toEqual(['lost'])
  expect(model.counts.shown).toBe(2)
})

test('requests are facets, so one request can be filtered and declined with Decline all', () => {
  const changes = [outsideChange('a', 'First line.'), outsideChange('b', 'Second line.', { outsideRequest: { id: 'req-2', index: 1, count: 1, at: NOON } })]
  const model = buildMarginModel({ changes, document: DOC, view: 'margin', filter: { requests: new Set(['req-2']) } })
  expect(model.cards.map((c) => c.id)).toEqual(['b'])
  expect(model.requestFacets.map((r) => [r.key, r.count])).toEqual([['req-1', 1], ['req-2', 1]])
})

const closed = (id: string, over: Partial<Change> = {}): Change => outsideChange(id, 'Gone words', { status: 'rejected', closedReason: 'The text this change replaces is no longer in the document.', closedAt: NOON, ...over })

test('changes the app closed without applying wait in notPlaced, newest first, until dismissed; never counted as cards or settled', () => {
  const changes = [closed('old', { closedAt: NOON - 1000 }), closed('new'), outsideChange('live', 'First line.')]
  const model = buildMarginModel({ changes, document: DOC, view: 'margin', now: NOON })
  expect(model.notPlaced.map((c) => c.id)).toEqual(['new', 'old'])
  expect(model.cards.map((c) => c.id)).toEqual(['live'])
  expect(model.settledToday).toEqual([])
  const dismissed = buildMarginModel({ changes, document: DOC, view: 'margin', now: NOON, dismissedIds: new Set(['new']) })
  expect(dismissed.notPlaced.map((c) => c.id)).toEqual(['old'])
})

test('waiting items in other pieces are grouped by piece, by source, with the first item to focus', () => {
  const others = [
    outsideChange('x1', 'Alpha', { path: 'b.md', newText: 'Alpha beta' }),
    outsideChange('x2', 'Gamma', { path: 'b.md', outsideSource: 'codex' }),
    outsideChange('y1', 'Delta', { path: 'a.md' }),
    outsideChange('z', 'Done', { path: 'c.md', status: 'accepted' }),
  ]
  const model = buildMarginModel({ changes: [], document: DOC, view: 'margin', others })
  expect(model.otherWaiting).toBe(3)
  expect(model.otherPieces.map((p) => [p.path, p.count, p.firstId])).toEqual([['a.md', 1, 'y1'], ['b.md', 2, 'x1']])
  expect(model.otherPieces[1].bySource.map((s) => [s.label, s.count])).toEqual([['Claude Code', 1], ['Codex', 1]])
})

const summary = (over: Partial<NonNullable<MarginOutside['summary']>> = {}): NonNullable<MarginOutside['summary']> => ({
  limit: 200, limitPerSource: 100, undecided: 3, bySource: [{ source: 'claude-code', label: 'Claude Code', undecided: 3 }], lastLook: null, ...over,
} as NonNullable<MarginOutside['summary']>)

test('the production margin top shows reached limits or access failures, not near-limit or batch notices (ticket 10)', () => {
  const model = buildMarginModel({ changes: [], document: DOC, view: 'margin', now: NOON })
  const shown = (sum: MarginOutside['summary']): string => renderToStaticMarkup(<MarginTop model={model}
    controls={{ state: { filter: {} } } as never} outside={outsideProps({ summary: sum })} />)
  expect(shown(null)).toBe('')
  expect(shown(summary())).toBe('')
  expect(shown(summary({ undecided: 185 }))).toBe('')
  expect(shown(summary({ bySource: [{ source: 'claude-code', label: 'Claude Code', undecided: 95 }] }))).toBe('')
  expect(shown(summary({ lastLook: { left: 4, leftBecause: ['look-limit'] } as never }))).toBe('')
  expect(shown(summary({ undecided: 200, lastLook: { refusedFull: 4 } as never }))).toContain('outside-room')
  expect(shown(summary({ bySource: [{ source: 'claude-code', label: 'Claude Code', undecided: 100 }], lastLook: { refusedFull: 2 } as never }))).toContain('outside-room')
  expect(shown(summary({ lastLook: { left: 4, leftBecause: ['not-held'] } as never }))).toContain('another copy of WriteFlex has this collection open')
  expect(shown(summary({ lastLook: { left: 4, leftBecause: ['ledger-not-writable'] } as never }))).toContain('could not save')
  expect(shown(summary({ lastLook: { left: 0, leftBecause: ['not-held'] } as never }))).toBe('')
})

test('the old head rows are gone: no arrived row and no other-pieces row above the cards; the allowance line only at a limit', () => {
  const others = [outsideChange('x1', 'Alpha', { path: 'b.md' })]
  const model = buildMarginModel({ changes: [outsideChange('a', 'First line.')], document: DOC, view: 'margin', others, now: NOON })
  const props = (outside: MarginOutside) => ({
    model, layout: null, view: 'margin' as const, preferredView: 'margin' as const, onViewChange: noop, selectedId: null, foldedIds: new Set<string>(),
    onFold: noop, onOpen: noop, actions: {} as never, context: {} as never, onSelect: noop, onPick: noop, onHover: noop, onMove: noop, moreOpenId: null, onMoreOpen: noop,
    controls: { state: { filter: {}, showOwnEdits: false, settled: false, showQuiet: false }, onState: noop, picked: new Set<string>(), onClearPicked: noop, onAccept: noop, onDecline: noop, sendBackOpen: false, onSendBackOpen: noop, onReopen: noop },
    outside,
  })
  const quiet = renderToStaticMarkup(<ReviewMarginPanel {...props(outsideProps({ arrived: [outsideChange('x1', 'Alpha')], summary: summary() }))} />)
  expect(quiet).not.toContain('arrived from')
  expect(quiet).not.toContain('other piece')
  expect(quiet).not.toContain('data-margin-top')
  const full = renderToStaticMarkup(<ReviewMarginPanel {...props(outsideProps({ summary: summary({ undecided: 200, lastLook: { refusedFull: 4 } as never }) }))} />)
  expect(full).toContain('data-margin-top')
  expect(full).toContain('the most WriteFlex keeps')
})

test('the review line carries the new arrivals once', () => {
  const base = { shown: 2, filtered: false, kind: 'all' as const, counts: { all: 2, comments: 0, edits: 2 }, position: null, otherPieces: 0, waiting: 2, notPlaced: 0 }
  expect(JSON.stringify(reviewLine({ ...base, newCount: 2 }))).toContain('2 new')
})

// ---- ticket 06: "N could not be placed" in the review line and its popover (frame `stale`) ----

test('the review line says "N could not be placed", also when nothing else waits', () => {
  const base = { shown: 0, filtered: false, kind: 'all' as const, counts: { all: 0, comments: 0, edits: 0 }, position: null, newCount: 0, otherPieces: 0 }
  expect(reviewLine({ ...base, waiting: 0, notPlaced: 0 })).toBeNull()
  const alone = reviewLine({ ...base, waiting: 0, notPlaced: 1 })!
  expect(alone.hereless).toBe(true)
  expect(alone.elsewhereText).toBeNull()
  expect(alone.notPlacedText).toBe('1 could not be placed')
  expect(reviewLine({ ...base, waiting: 3, shown: 3, counts: { all: 3, comments: 0, edits: 3 }, notPlaced: 2 })!.notPlacedText).toBe('2 could not be placed')
})

test('the popover keeps the old head row\'s functions: Try again, Copy intended text, Dismiss, Dismiss all', () => {
  const model = buildMarginModel({ changes: [closed('n'), closed('r', { outsideRefused: true })], document: DOC, view: 'margin', now: NOON })
  const html = renderToStaticMarkup(<NotPlacedPopover controls={{ entries: model.notPlaced, onTryAgain: noop, onCopy: noop, onDismiss: noop }} onClose={noop} />)
  expect(html.toLowerCase()).toContain('could not be placed · nothing in your piece changed')
  expect(html).toContain('data-notplaced-id="n"')
  expect(html).toContain('data-notplaced-id="r"')
  // A request refused at the command line can never be reopened: no Try again on it.
  expect(html.split('data-margin-action="try-again"')).toHaveLength(2)
  expect(html.split('Copy intended text')).toHaveLength(3)
  expect(html.split('data-margin-action="dismiss-notplaced"')).toHaveLength(3)
  expect(html).toContain('Dismiss all 2')
  expect(html).toContain('request of 14:02')
})
