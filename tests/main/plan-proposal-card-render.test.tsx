import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PlanProposalCard, type PlanProposalCardActions } from '../../src/renderer/src/components/PlanProposalCard'
import { AgentReply } from '../../src/renderer/src/components/AgentPanel'
import { emptyPlanCard, latestUndoableCard, latestUndoTarget, reducePlanCard, type PlanCard } from '../../src/renderer/src/hooks/plan-proposal-cards'
import type { PlanProposalView, ProposalBasis } from '../../src/shared/plan-proposal'

const noop = () => {}
const actions: PlanProposalCardActions = {
  onLoad: noop, onAccept: noop, onEdit: noop, onCancelEdit: noop, onDiscard: noop,
  onDrop: noop, onRestore: noop, onDrag: noop, onUndo: noop, onProposeAgain: noop,
}

const dir = 'notes-towards-ai-strategy'
const basis: ProposalBasis = {
  dir,
  hasIndexNote: true,
  indexPath: `${dir}/_notes-towards-ai-strategy_INDEX.md`,
  parts: [],
  strays: [
    { path: `${dir}/00_strategy-framework-Studio Mac.md`, title: 'Framework for Community Garden Planning', words: 629 },
    { path: `${dir}/00_strategy-framework.md`, title: 'Framework for Community Garden Planning', words: 840 },
    { path: `${dir}/01_shared-language.md`, title: 'Shared language for garden planning', words: 154 },
    { path: `${dir}/02_key-strategic-moves.md`, title: 'Key strategic moves', words: 12 },
  ],
}
const view: PlanProposalView = {
  id: 'p1',
  status: 'pending',
  dir,
  summary: 'The copy stays in the folder, outside the order: nothing to change.',
  basis,
  changes: [
    { op: 'insert', title: 'Framework for Community Garden Planning', role: 'summary' },
    { op: 'insert', title: 'Shared language for garden planning' },
    { op: 'insert', title: 'Key strategic moves' },
  ],
  stale: [],
}

const loaded = (next: PlanProposalView = view): PlanCard => reducePlanCard(emptyPlanCard('p1'), { type: 'loaded', view: next })
const render = (card: PlanCard) => renderToStaticMarkup(<PlanProposalCard card={card} actions={actions} />)

test('frame 2 · the proposal: every change marked, the copy listed outside, three buttons', () => {
  const html = render(loaded())
  expect(html).toContain('Proposed running order <span>3 changes</span>')
  expect(html.match(/class="mk add"/g)?.length).toBe(3)
  expect(html).toContain('840 w')
  expect(html).toContain('<span class="role">summary</span>')
  expect(html).toContain('Not in the order')
  expect(html).toContain('00_strategy-framework-Studio Mac')
  expect(html).toContain('file stays')
  expect(html).toContain('Use this order <kbd class="k">⌘↵</kbd>')
  expect(html).toContain('Edit first')
  expect(html).toContain('Discard')
  expect(html).not.toContain('Create the Index Note')
})

test('a folder with no Index Note: the proposal\'s first line is "Create the Index Note"', () => {
  const html = render(loaded({ ...view, basis: { ...basis, hasIndexNote: false } }))
  const first = html.indexOf('Create the Index Note')
  expect(first).toBeGreaterThan(0)
  expect(first).toBeLessThan(html.indexOf('Framework for Community Garden Planning'))
  expect(html).toContain('3 changes')
})

test('frame 3 · Edit first: grips, × on each change, ↺ on the dropped one, the button counts', () => {
  let card = reducePlanCard(loaded(), { type: 'edit' })
  card = reducePlanCard(card, { type: 'drop', ids: ['c2'] })
  card = reducePlanCard(card, { type: 'drag', title: 'Key strategic moves', to: 1 })
  const html = render(card)
  expect(html).toContain('Proposed running order <span>editing</span>')
  expect(html).toContain('lucide-grip-vertical grip')
  expect(html).toContain('class="mk mov"')
  expect(html).toContain('class="ln drop"')
  expect(html).toContain('aria-label="Restore the change to Shared language for garden planning"')
  expect(html.match(/aria-label="Drop the change to/g)?.length).toBe(2)
  expect(html).toContain('Use this order · 2 changes')
  expect(html).toContain('Cancel edit')
  expect(html).toContain('You moved Key strategic moves up and dropped Shared language for garden planning: it stays in the folder, outside the order, for now.')
  // Key strategic moves now sits above the dropped row.
  expect(html.indexOf('Key strategic moves')).toBeLessThan(html.indexOf('Shared language for garden planning'))
})

const accepted = reducePlanCard(loaded(), {
  type: 'accept-result',
  at: 1000,
  result: {
    ok: true,
    paths: [],
    accepted: {
      count: 2,
      folderName: dir,
      parts: [
        { title: 'Framework for Community Garden Planning', path: `${dir}/00_strategy-framework.md` },
        { title: 'Key strategic moves', path: `${dir}/02_key-strategic-moves.md` },
      ],
      outside: [
        { title: 'Shared language for garden planning', path: `${dir}/01_shared-language.md` },
        { title: 'Framework for Community Garden Planning', path: `${dir}/00_strategy-framework-Studio Mac.md` },
      ],
      createdIndexNote: false,
      manifest: true,
      undoable: true,
    },
  },
})

test('frame 4 · accepted: one activity row with Undo ⌘⇧Z, and the Folio outline as it now stands', () => {
  const html = render(accepted)
  expect(html).toContain('Running order set · 2 changes')
  expect(html).toContain('Undo<kbd class="k">⌘⇧Z</kbd>')
  expect(html).toContain('The Folio outline pane now shows two parts in your order. The Index Note gained the running-order list, and _report-structure.json follows from it.')
  expect(html).toContain('Folio outline <span>notes-towards-ai-strategy</span>')
  expect(html).toContain('In the folder, not in the order')
  expect(html).toContain('Shared language for garden planning')
  expect(html).toContain('00_strategy-framework-Studio Mac')
  expect(latestUndoableCard({ p1: accepted })?.id).toBe('p1')
})

test('frame 5 · undo refused: the Undo fades and the refusal names what is in the way', () => {
  const message = "Can't put the order back: you have since renamed Key strategic moves to Moves for 2027, and undoing would bring back the old name in the plan. Undo the rename first, or change the order in the Folio outline pane."
  const card = reducePlanCard(accepted, { type: 'undo-result', ok: false, message })
  const html = render(card)
  expect(html).toContain('Running order set · 2 changes')
  expect(html).toContain('class="b u dim"')
  expect(html).toContain('class="act warn"')
  expect(html).toContain(message.replace("'", '&#x27;'))
  expect(latestUndoableCard({ p1: card })).toBeNull()
})

test('frame 6 · stale: the card dims, names the changed file, and offers Propose again', () => {
  const stale = loaded({ ...view, status: 'stale', stale: [{ path: `${dir}/02_key-strategic-moves.md`, kind: 'renamed', to: `${dir}/02_moves.md` }] })
  expect(stale.phase).toBe('stale')
  const html = render(stale)
  expect(html).toContain('class="card plan-proposal dim"')
  expect(html).toContain('The folder changed after this was proposed: 02_key-strategic-moves.md was renamed.')
  expect(html).toContain('Propose again')
  expect(html).toContain('Discard')
  expect(html).not.toContain('Use this order')
})

test('an accept that finds the folder changed turns the card stale instead of writing', () => {
  const card = reducePlanCard(loaded(), {
    type: 'accept-result',
    at: 1,
    result: { ok: false, message: 'The folder changed after this was proposed.', stale: [{ path: `${dir}/01_shared-language.md`, kind: 'missing' }] },
  })
  expect(card.phase).toBe('stale')
  expect(render(card)).toContain('01_shared-language.md was moved or deleted.')
})

test('the Agent pane renders a plan.propose staged row as the proposal card', () => {
  const html = renderToStaticMarkup(
    <AgentReply
      turn={{
        kind: 'agent', id: 't1', text: 'Here is an order.', at: 0, running: false, undoable: false,
        activity: [{ id: 'r1', kind: 'staged', text: 'Proposed a running order', suggestionId: 'p1', capability: 'plan.propose', pending: true, at: 0 }],
      }}
      isLatest
      onUndo={noop}
      onView={noop}
      planCards={{ p1: loaded() }}
      planActions={actions}
    />,
  )
  expect(html).toContain('Proposed running order')
  expect(html).not.toContain('Waiting for your review')
})


test('shared keyboard and reply undo choose the most recent change by time', () => {
  const turn = { turnId: 'written', startedAt: 10, endedAt: 20, counts: { read: 0, created: 1, modified: 0, moved: 0, trashed: 0, deleted: 0 }, undo: { available: true } } as import('@bridle/core').TurnActivity
  expect(latestUndoTarget({ p1: { ...accepted, acceptedAt: 30 } }, [turn])).toEqual({ kind: 'plan', id: accepted.id })
  expect(latestUndoTarget({ p1: { ...accepted, acceptedAt: 15 } }, [turn])).toEqual({ kind: 'turn', id: 'written' })
  expect(latestUndoTarget({ p1: { ...accepted, acceptedAt: 30 } }, [])).toEqual({ kind: 'plan', id: accepted.id })
})
