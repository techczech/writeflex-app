import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup, renderToString } from 'react-dom/server'
import type { Change } from '../../src/preload'
import { cardKeyAction, describeSettledModeCard, runMarginAction, type MarginActionContext } from '../../src/renderer/src/app/margin-card'
import { countMenu, viewCountsOf, type CountMenuRow } from '../../src/renderer/src/app/margin-count-menu'
import { layoutEntriesFor, marginEntriesOf } from '../../src/renderer/src/app/margin-geometry'
import { layoutMargin } from '../../src/renderer/src/app/margin-layout'
import { modeLineOf, myEditsSessionIds, reviewModeOf, toggleMode, trackWaitingAgain, withMode } from '../../src/renderer/src/app/margin-mode'
import { buildMarginModel, marginVisible } from '../../src/renderer/src/app/margin-model'
import { useReviewActions, type ReviewActionDeps, type ReviewActions } from '../../src/renderer/src/app/review-actions'
import { acceptWriterSessionChanges } from '../../src/renderer/src/app/writer-mode'
import { EMPTY_HEAD_FILTER, type HeadFilterState } from '../../src/renderer/src/app/margin-head-state'
import { ReviewMarginPanel, type MarginPanelProps } from '../../src/renderer/src/components/ReviewMargin'
import { reviewLine } from '../../src/renderer/src/components/status-bar-model'

// Ticket 08: Settled today and My edits as modes (frames `settled`, `my-edits`, `none`).

const DOC = 'First line here.\n\nSecond line here.\n\nThird line here.\n\nFourth line, mine.\n'
const NOW = Date.parse('2026-10-18T21:45:00')
const TODAY = NOW - 60_000
const YESTERDAY = NOW - 86_400_000

function change(id: string, oldText: string, over: Partial<Change> = {}): Change {
  return { id, path: 'draft.md', ts: TODAY, provenance: 'agent', editClass: 'content', category: 'wording', summary: id, oldText, newText: `${oldText}!`, status: 'pending', isCorrection: false, ...over }
}
const writer = (id: string, oldText: string, newText: string, over: Partial<Change> = {}): Change => change(id, oldText, { provenance: 'writer', newText, ...over })

const pile = (): Change[] => [
  change('acc', 'First line', { status: 'accepted', newText: 'First line' + ' here' }),
  change('rej', 'Second line', { status: 'rejected' }),
  change('done', 'Third', { status: 'accepted', newText: 'Third', summary: 'Say more.' }),
  change('old', 'Third line', { status: 'accepted', ts: YESTERDAY }),
  change('q', 'Fourth', { editClass: 'copy', status: 'accepted' }),
  change('wait', 'Third line here.'),
  writer('w1', 'Fourth line.', 'Fourth line, mine.'),
  writer('w2', 'Second line', 'Second line here'),
]

const ids = (list: Array<{ id: string }>): string[] => list.map((item) => item.id).sort()

test('the mode lives in the head state; entering and leaving keep the rest of it', () => {
  expect(reviewModeOf(EMPTY_HEAD_FILTER)).toBe('review')
  const kinds: HeadFilterState = { ...EMPTY_HEAD_FILTER, filter: { kinds: new Set(['note']) } }
  const settled = withMode(kinds, 'settled')
  expect(reviewModeOf(settled)).toBe('settled')
  expect(settled.filter.kinds?.has('note')).toBe(true)
  const mine = withMode(settled, 'mine')
  expect(reviewModeOf(mine)).toBe('mine')
  expect([...(mine.filter.sources ?? [])]).toEqual(['you'])
  const back = withMode(mine, 'review')
  expect(reviewModeOf(back)).toBe('review')
  expect(back.filter.sources).toBeUndefined()
  expect(back.filter.kinds?.has('note')).toBe(true)
  // The count menu and palette rows are switches.
  expect(reviewModeOf(toggleMode(settled, 'settled'))).toBe('review')
  expect(reviewModeOf(toggleMode(EMPTY_HEAD_FILTER, 'mine'))).toBe('mine')
})

test('Settled today: today’s settled items beside their words, nothing waiting in sight, quiet fixes only when included', () => {
  const model = buildMarginModel({ changes: pile(), document: DOC, view: 'margin', now: NOW, mode: 'settled' })
  expect(model.mode).toBe('settled')
  expect(model.cards).toEqual([])
  expect(model.unplaced).toEqual([])
  expect(ids(model.settled)).toEqual(['acc', 'done', 'rej'])
  expect(model.settled.find((row) => row.id === 'rej')?.outcome).toBe('Declined')
  expect(model.settled.find((row) => row.id === 'done')?.outcome).toBe('Done')
  expect(model.settledQuiet).toBe(1)
  // The filter does not apply in a mode.
  const filtered = buildMarginModel({ changes: pile(), document: DOC, view: 'margin', now: NOW, mode: 'settled', filter: { kinds: new Set(['note']) } })
  expect(ids(filtered.settled)).toEqual(['acc', 'done', 'rej'])
  const withQuiet = buildMarginModel({ changes: pile(), document: DOC, view: 'margin', now: NOW, mode: 'settled', showQuietFixes: true })
  expect(withQuiet.settled.find((row) => row.id === 'q')?.outcome).toBe('Applied')
  // Drawn as full cards, not one-line rows; the margin is drawn with nothing waiting.
  expect(marginEntriesOf(model).every((entry) => !entry.row)).toBe(true)
  expect(marginVisible(buildMarginModel({ changes: [pile()[0]], document: DOC, view: 'margin', now: NOW, mode: 'settled' }))).toBe(true)
  expect(marginVisible(buildMarginModel({ changes: [pile()[0]], document: DOC, view: 'margin', now: NOW }))).toBe(false)
  expect(modeLineOf(model, false)).toMatchObject({ label: 'Settled today', text: '3 items', quiet: 1 })
})

test('an item reopened in Settled today stays there as an Open card, waiting again', () => {
  const before = pile()
  let state = trackWaitingAgain({ seen: new Set(), again: new Set() }, ['acc', 'rej', 'done'], before)
  expect(state.again.size).toBe(0)
  const after = before.map((c) => (c.id === 'rej' ? { ...c, status: 'pending' as const } : c))
  state = trackWaitingAgain(state, ['acc', 'done'], after)
  expect([...state.again]).toEqual(['rej'])
  const model = buildMarginModel({ changes: after, document: DOC, view: 'margin', now: NOW, mode: 'settled', waitingAgain: state.again })
  expect(model.cards.map((card) => [card.id, card.again])).toEqual([['rej', true]])
  expect(ids(model.settled)).toEqual(['acc', 'done'])
  expect(modeLineOf(model, false)?.text).toBe('3 items')
  // Settled again: back among the settled.
  const settledAgain = after.map((c) => (c.id === 'rej' ? { ...c, status: 'accepted' as const } : c))
  expect(trackWaitingAgain(state, ['acc', 'done', 'rej'], settledAgain).again.size).toBe(0)
})

test('My edits: your recorded edits as cards, the rest out of sight and counted, the filter set aside', () => {
  const model = buildMarginModel({ changes: pile(), document: DOC, view: 'margin', now: NOW, mode: 'mine', filter: { kinds: new Set(['note']) } })
  expect(ids([...model.cards, ...model.unplaced])).toEqual(['w1', 'w2'])
  expect(model.othersWaiting).toBe(1)
  expect(modeLineOf(model, false)).toMatchObject({ label: 'My edits', text: '2 recorded in this piece. The 1 waiting item is out of sight until you go back.' })
  expect(myEditsSessionIds(pile()).sort()).toEqual(['w1', 'w2'])
})

test('the review line names the mode, as drawn', () => {
  const base = { waiting: 0, shown: 0, filtered: false, kind: 'all' as const, counts: { all: 0, comments: 0, edits: 0 }, position: null, newCount: 0, otherPieces: 0 }
  const settled = reviewLine({ ...base, mode: { kind: 'settled', settled: 5, again: 1 } })!
  expect(settled.mode).toMatchObject({ label: 'Settled today', text: '5 settled, 1 waiting again', acceptAllText: null })
  expect(reviewLine({ ...base, mode: { kind: 'settled', settled: 5, again: 0 } })!.mode?.text).toBe('5 settled')
  const mine = reviewLine({ ...base, mode: { kind: 'mine', recorded: 3, others: 5 } })!
  expect(mine.mode).toMatchObject({ label: 'My edits', text: '3 recorded', acceptAllText: 'Accept all 3', othersText: '5 others waiting' })
  expect(reviewLine(base)).toBeNull()
})

test('the count menu’s Settled today and My edits switch the modes, counted from the review model', () => {
  const review = buildMarginModel({ changes: pile(), document: DOC, view: 'margin', now: NOW })
  const counts = viewCountsOf(review)
  expect(counts).toMatchObject({ settled: 3, mine: 2 })
  const settledModel = buildMarginModel({ changes: pile(), document: DOC, view: 'margin', now: NOW, mode: 'settled' })
  const state = withMode(EMPTY_HEAD_FILTER, 'settled')
  const rows = countMenu({ model: settledModel, state, preferredView: 'margin', textRoom: 800, marginHidden: false, viewCounts: counts }).flatMap((row: CountMenuRow) => (row.kind === 'item' ? [row] : []))
  const settled = rows.find((row) => row.id === 'settled')!
  expect(settled).toMatchObject({ checked: true, count: 3 })
  expect(reviewModeOf((settled.action as { state: HeadFilterState }).state)).toBe('review')
  const mine = rows.find((row) => row.id === 'my-edits')!
  expect(mine).toMatchObject({ checked: false, count: 2, enabled: true })
  expect(reviewModeOf((mine.action as { state: HeadFilterState }).state)).toBe('mine')
})

// ---- the ledger calls: the real review actions over a fake ledger ----
function harness(changes: Change[]) {
  const calls: string[] = []
  let actions!: ReviewActions
  const deps: ReviewActionDeps = {
    ledger: {
      resolveChange: async (id, action) => { calls.push(`ledger.${action}:${id}`); return { applied: true } },
      setChangeStatus: async (id, status) => { calls.push(`ledger.status:${id}:${status}`) },
    },
    changes, dockChanges: changes, suggestions: [],
    editorRef: { current: null }, recordedWriterChanges: { current: new Map() },
    acceptSuggestion: async () => false, rejectSuggestion: async () => false, savePath: async () => true,
    reloadChanges: async () => undefined, refreshInlineChangesAfterReconcile: async () => undefined,
    flash: () => undefined, handleAgentWorkspaceChange: () => undefined, reconcileAppliedFile: () => undefined,
    acceptThroughOwner: async (_path, _id, resolve) => ({ status: 'acted', result: await resolve(), recorded: false }),
    inDocumentQueue: (_path, run) => run(),
    documentWrittenByMain: () => undefined,
    focusComposer: () => undefined, setChangesOpen: () => undefined, selectChange: () => undefined,
    settleChange: () => undefined,
  }
  function Harness(): null { actions = useReviewActions(deps); return null }
  renderToString(createElement(Harness))
  const context: MarginActionContext = {
    sendOriginalToScratchpad: (c) => { calls.push(`scratchpad:${c.id}`) },
    showInText: (id) => { calls.push(`show:${id}`) },
    reopen: (id) => actions.reopenChange(id),
  }
  return { calls, actions, context }
}

test('Return to review and Reopen in Settled today are the existing reopen action; O answers both', async () => {
  const model = buildMarginModel({ changes: pile(), document: DOC, view: 'margin', now: NOW, mode: 'settled' })
  const accepted = describeSettledModeCard(model.settled.find((row) => row.id === 'acc')!, 1, NOW)
  const declined = describeSettledModeCard(model.settled.find((row) => row.id === 'rej')!, 2, NOW)
  expect(accepted.primary.map((item) => [item.label, item.key])).toEqual([['Return to review', 'O']])
  expect(declined.primary.map((item) => item.label)).toEqual(['Reopen'])
  expect(accepted.more.map((item) => item.label)).toEqual(['Show in text', 'Send original to Scratchpad'])
  expect(cardKeyAction('o', accepted)).toBe('reopen')
  expect(cardKeyAction('a', accepted)).toBeNull()
  const h = harness(pile())
  await runMarginAction('reopen', model.settled.find((row) => row.id === 'acc')!.change, h.actions, h.context)
  await runMarginAction('reopen', model.settled.find((row) => row.id === 'rej')!.change, h.actions, h.context)
  expect(h.calls).toEqual(['ledger.status:acc:pending', 'ledger.status:rej:pending'])
})

test('My edits’ Accept all is the Accept session: status only, exactly your pending recorded edits', async () => {
  const calls: string[] = []
  const changes = [...pile(), writer('w3', 'First', 'First', { editClass: 'copy' }), writer('w4', 'x', 'y', { status: 'accepted' })]
  await acceptWriterSessionChanges(changes, { setChangeStatus: async (id, status) => { calls.push(`${id}:${status}`) } })
  expect(calls).toEqual(['w1:accepted', 'w2:accepted'])
  expect(myEditsSessionIds(changes)).toEqual(['w1', 'w2'])
})

test('the panel in Settled today: the mode line with Include quiet fixes, settled cards beside their words, a reopened card Open', () => {
  const changes = pile().map((c) => (c.id === 'rej' ? { ...c, status: 'pending' as const } : c))
  const model = buildMarginModel({ changes, document: DOC, view: 'margin', now: NOW, mode: 'settled', waitingAgain: new Set(['rej']) })
  const entries = marginEntriesOf(model)
  const layout = layoutMargin({ cards: layoutEntriesFor(entries, DOC, { anchorTops: new Map(entries.map((entry, i) => [entry.id, 100 + i * 220])), heights: new Map(), floor: 0, foldedIds: new Set() }) })
  const { actions, context } = harness(changes)
  const props: MarginPanelProps = {
    model, layout, view: 'margin', preferredView: 'margin', onViewChange: () => undefined, selectedId: null,
    foldedIds: new Set(), onFold: () => undefined, onOpen: () => undefined, actions, context, onSelect: () => undefined, onPick: () => undefined,
    controls: { state: withMode(EMPTY_HEAD_FILTER, 'settled'), onState: () => undefined, picked: new Set<string>(), onClearPicked: () => undefined, onAccept: () => undefined, onDecline: () => undefined, sendBackOpen: false, onSendBackOpen: () => undefined, onReopen: () => undefined },
    onHover: () => undefined, onMove: () => undefined, moreOpenId: null, onMoreOpen: () => undefined, now: NOW, document: DOC,
  }
  const html = renderToStaticMarkup(createElement(ReviewMarginPanel, props))
  expect(html).toContain('data-margin-mode="settled"')
  expect(html).toContain('Include quiet fixes')
  expect(html).toContain('data-margin-settled-card="acc"')
  expect(html).toContain('Return to review')
  expect(html).toContain('data-margin-card="rej"')
  expect(html).toContain('Reopened just now')
  // Nothing of the review head in a mode.
  expect(html).not.toContain('data-margin-chip')
  expect(html).not.toContain('data-margin-settled-row')
})
