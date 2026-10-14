import { expect, spyOn, test } from 'bun:test'
import { history, isolateHistory, redo, undo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import { toggleBold } from '../../src/renderer/src/editor/commands'
import { reconcileReplace } from '../../src/renderer/src/editor/reconcile'
import {
  documentTextForPersistence,
  foldReviewingChanges,
  materialiseDraftingChanges,
  pendingWriterChanges,
  resolveWriterChangeSpec,
  skipWriterReviewTracking,
  writerReviewing,
} from '../../src/renderer/src/editor/writer-review'

// Review findings on the pending-change crash fix (2026-10-06), one regression test each.

function draftingState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM] }), history(), writerReviewing({ initialMode: 'drafting' })],
  })
}

/** A tracked writer edit that is its own undo step. */
function writerEdit(state: EditorState, spec: TransactionSpec): EditorState {
  return state.update({ ...spec, userEvent: 'input.type', annotations: isolateHistory.of('full') }).state
}

/** A disk reconcile: untracked and outside undo history (EditorPane.reconcileContent). */
function reconcile(state: EditorState, spec: TransactionSpec): EditorState {
  return state.update({ ...spec, annotations: [skipWriterReviewTracking.of(true), Transaction.addToHistory.of(false)] }).state
}

function run(state: EditorState, command: typeof undo): EditorState {
  let next = state
  command({ state, dispatch: (tr) => { next = tr.state } })
  return next
}

function expectRevealable(state: EditorState): void {
  expect(() => state.update(materialiseDraftingChanges(state))).not.toThrow()
}

test('finding 1: undo after an unrelated reconcile restores the record the undo target held', () => {
  let state = writerEdit(draftingState('abc def'), { changes: { from: 0, to: 3, insert: 'ABCDEFGHIJ' } })
  const [record] = pendingWriterChanges(state)
  state = writerEdit(state, { changes: { from: 1, to: 10 } })
  state = reconcile(state, { changes: { from: state.doc.length, insert: '!' } })
  const beforeUndo = pendingWriterChanges(state)

  state = run(state, undo)
  expect(state.doc.toString()).toBe('ABCDEFGHIJ def!')
  expect(pendingWriterChanges(state)).toEqual([{ ...record!, anchor: { from: 0, to: 10 } }])
  expectRevealable(state)

  state = run(state, redo)
  expect(state.doc.toString()).toBe('A def!')
  expect(pendingWriterChanges(state)).toEqual(beforeUndo)
  expectRevealable(state)
})

test('finding 2: a restored record that a reconcile shifted still points at its own text', () => {
  let state = writerEdit(draftingState('abc def'), { changes: { from: 0, to: 3, insert: 'ABCDE' } })
  state = writerEdit(state, { changes: { from: state.doc.length, insert: '!' } })
  state = reconcile(state, { changes: { from: 0, insert: 'X' } })

  state = run(state, undo)
  expect(state.doc.toString()).toBe('XABCDE def')
  expect(pendingWriterChanges(state)).toMatchObject([{ oldText: 'abc', newText: 'ABCDE', anchor: { from: 1, to: 6 } }])
  expectRevealable(state)
})

test('finding 3: a disk replacement of exactly the writer\'s new text supersedes the writer record', () => {
  let state = writerEdit(draftingState('abc def'), { changes: { from: 0, to: 3, insert: 'ABC' } })
  const spec = reconcileReplace(pendingWriterChanges(state), documentTextForPersistence(state), 'XYZ def')
  expect(spec).toEqual({ from: 0, to: 3, insert: 'XYZ' })
  state = reconcile(state, { changes: spec! })

  expect(state.doc.toString()).toBe('XYZ def')
  expect(pendingWriterChanges(state)).toEqual([])
  expectRevealable(state)
})

test('finding 4: punctuation a command inserts between two records joins neither of them', () => {
  let state = writerEdit(draftingState('aa\n\nbb'), { changes: { from: 0, to: 2, insert: 'AA' } })
  state = writerEdit(state, { changes: { from: 4, to: 6, insert: 'BB' } })
  // A Scratchpad cut of the separator (scraps.ts): untracked, but an undo step.
  state = state.update({ changes: { from: 2, to: 4 }, annotations: skipWriterReviewTracking.of(true) }).state
  expect(state.doc.toString()).toBe('AABB')
  state = state.update({ selection: EditorSelection.cursor(2) }).state
  toggleBold({ state, dispatch: (tr) => { state = tr.state } })

  expect(state.doc.toString()).toBe('AA****BB')
  const pending = pendingWriterChanges(state)
  expect(pending.map((change) => [change.anchor, change.newText])).toEqual([
    [{ from: 0, to: 2 }, 'AA'],
    [{ from: 6, to: 8 }, 'BB'],
  ])
  expectRevealable(state)
})

// Round 2 (2026-10-06): two disjoint reconciles between a snapshot and the undo that restores it.
// Restoring by text diff merged them into one window, losing the record in Drafting and moving its
// marks onto unrelated text in Reviewing. Reconciles here go through the app's own reconcileReplace.

function reconcileTo(state: EditorState, next: string): EditorState {
  const spec = reconcileReplace(pendingWriterChanges(state), documentTextForPersistence(state), next)
  expect(spec).not.toBeNull()
  return reconcile(state, { changes: spec! })
}

function reviewingState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM] }), history(), writerReviewing({ initialMode: 'reviewing' })],
  })
}

test('round 2, Drafting: two disjoint reconciles before an undo leave the untouched record in place', () => {
  let state = writerEdit(draftingState('left\n\nabc\n\nright'), { changes: { from: 6, to: 9, insert: 'ABC' } })
  const [record] = pendingWriterChanges(state)
  state = writerEdit(state, { changes: { from: state.doc.length, insert: '!' } })
  state = reconcileTo(state, 'Left\n\nABC\n\nright!')
  state = reconcileTo(state, 'Left\n\nABC\n\nrighT!')

  state = run(state, undo)
  expect(state.doc.toString()).toBe('Left\n\nABC\n\nrighT')
  expect(pendingWriterChanges(state)).toEqual([{ ...record!, anchor: { from: 6, to: 9 } }])
  expectRevealable(state)
})

test('round 2, Reviewing: rejecting the restored record restores only its own text', () => {
  let state = writerEdit(reviewingState('left\n\nabc\n\nright'), { changes: { from: 6, to: 9, insert: 'ABC' } })
  expect(state.doc.toString()).toBe('left\n\nabcABC\n\nright')
  const id = pendingWriterChanges(state)[0]!.localId
  state = writerEdit(state, { changes: { from: state.doc.length, insert: '!' } })
  state = reconcileTo(state, 'Left\n\nABC\n\nright!')
  state = reconcileTo(state, 'Left\n\nABC\n\nrighT!')

  state = run(state, undo)
  expect(documentTextForPersistence(state)).toBe('Left\n\nABC\n\nrighT')
  expect(pendingWriterChanges(state)).toMatchObject([{ localId: id, oldText: 'abc', newText: 'ABC', anchor: { from: 6, to: 12 } }])

  const rejected = state.update(resolveWriterChangeSpec(state, id, 'reject')!).state
  expect(rejected.doc.toString()).toBe('Left\n\nabc\n\nrighT')
})

test('a typing group joined in undo history survives a reconcile before the undo', () => {
  const errors = spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    let state = writerEdit(draftingState('one two three'), { changes: { from: 3, to: 3, insert: ' and' } })
    const beforeGroup = pendingWriterChanges(state)
    // Two keystrokes within newGroupDelay: CodeMirror joins them into one undo event.
    state = state.update({ changes: { from: 7, insert: 'a' }, userEvent: 'input.type' }).state
    state = state.update({ changes: { from: 8, insert: 'b' }, userEvent: 'input.type' }).state
    state = reconcile(state, { changes: { from: 0, insert: 'X' } })

    expect(() => { state = run(state, undo) }).not.toThrow()
    expect(state.doc.toString()).toBe('Xone and two three')
    expect(pendingWriterChanges(state)).toEqual(beforeGroup.map((change) => ({
      ...change,
      anchor: { from: change.anchor.from + 1, to: change.anchor.to + 1 },
    })))
    expectRevealable(state)
    expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([])
  } finally {
    errors.mockRestore()
  }
})

// Round 8 (2026-10-06), from review finding round-7 probes.

test('round 8: a disk replacement of the whole struck text supersedes the Reviewing record', () => {
  let state = reviewingState('abc')
  state = state.update({ changes: { from: 0, to: 3, insert: 'ABC' }, userEvent: 'input.type' }).state
  expect(state.doc.toString()).toBe('abcABC')
  // The disk text becomes XYZ: reconcileReplace replaces the record's struck AND new text.
  state = reconcileTo(state, 'XYZ')

  expect(state.doc.toString()).toBe('XYZ')
  expect(pendingWriterChanges(state)).toEqual([])
})

test('round 8: a discarded effect-only fold never changes what a later undo restores', () => {
  let state = reviewingState('z')
  state = state.update({ changes: { from: 0, to: 1, insert: 'zz' }, userEvent: 'input.type' }).state
  state = state.update({ changes: { from: 0, to: 3, insert: ' ' }, annotations: skipWriterReviewTracking.of(true) }).state
  // A scratch fold of this state (changing no text) is computed — its state read — and dropped.
  expect(state.update(foldReviewingChanges(state)).state.doc.toString()).toBe(' ')
  state = state.update({ changes: { from: 1, insert: ' ' }, userEvent: 'input.type' }).state

  state = run(state, undo)
  expect(state.doc.toString()).toBe('z')
  expect(pendingWriterChanges(state)).toEqual([])
})

// Round 8b (2026-10-06): an untracked replacement that covers part of a record's new text should stay
// outside the record. KNOWN LIMITATION, shared with the alpha.22 hotfix (see
// docs/plans/2026-10-06-real-use-fixes/01-…md): CodeMirror maps a replaced range's endpoints to the
// replacement's ends, so the new mark absorbs it. Needs span-set records; kept as todo, not deleted.

for (const [from, to] of [[3, 6], [2, 6]] as const) {
  test.todo(`round 8b: an untracked replacement of raw ${from}:${to} never becomes the writer's new text`, () => {
    let state = reviewingState('abc')
    state = state.update({ changes: { from: 0, to: 3, insert: 'ABC' }, userEvent: 'input.type' }).state
    expect(state.doc.toString()).toBe('abcABC')
    state = state.update({ changes: { from, to, insert: 'XYZ' }, annotations: skipWriterReviewTracking.of(true) }).state

    for (const change of pendingWriterChanges(state)) expect(change.newText).not.toContain('XYZ')
    // Rejecting every record restores the writer's old reading and keeps the untracked text.
    let rejected = state
    for (let change = pendingWriterChanges(rejected)[0]; change; change = pendingWriterChanges(rejected)[0]) {
      rejected = rejected.update(resolveWriterChangeSpec(rejected, change.localId, 'reject')!).state
    }
    expect(rejected.doc.toString()).toContain('XYZ')
  })
}

test('round 8b: a pure insertion exactly at the struck/new junction still joins the new reading', () => {
  let state = reviewingState('abc')
  state = state.update({ changes: { from: 0, to: 3, insert: 'ABC' }, userEvent: 'input.type' }).state
  const [record] = pendingWriterChanges(state)
  state = state.update({ changes: { from: 3, insert: 'Q' }, annotations: skipWriterReviewTracking.of(true) }).state

  expect(state.doc.toString()).toBe('abcQABC')
  expect(pendingWriterChanges(state)).toEqual([{ ...record!, newText: 'QABC', anchor: { from: 0, to: 7 } }])
})
