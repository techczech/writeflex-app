import { afterEach, beforeEach, expect, spyOn, test, type Mock } from 'bun:test'
import { history, isolateHistory, undo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import {
  pendingWriterChanges,
  skipWriterReviewTracking,
  writerReviewing,
  type WriterPendingChange,
} from '../../src/renderer/src/editor/writer-review'

// The four ways editor/history-snapshot.ts departs from the round-3 brief, one test each. Every test
// joins keystrokes into one undo event (input.type within newGroupDelay) and requires the undo to
// restore exactly the ledger from before the group, silently; all but the first also let a reconcile
// move the history first.

let errors: Mock<typeof console.error>
beforeEach(() => { errors = spyOn(console, 'error').mockImplementation(() => undefined) })
afterEach(() => {
  expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([])
  errors.mockRestore()
})

const draftingState = (doc: string): EditorState => EditorState.create({
  doc,
  extensions: [markdown({ extensions: [GFM] }), history(), writerReviewing({ initialMode: 'drafting' })],
})
const isolated = (state: EditorState, spec: TransactionSpec): EditorState =>
  state.update({ ...spec, userEvent: 'input.type', annotations: isolateHistory.of('full') }).state
const keystroke = (state: EditorState, spec: TransactionSpec): EditorState =>
  state.update({ ...spec, userEvent: 'input.type' }).state
const reconcile = (state: EditorState, spec: TransactionSpec): EditorState =>
  state.update({ ...spec, annotations: [skipWriterReviewTracking.of(true), Transaction.addToHistory.of(false)] }).state
const shifted = (ledger: WriterPendingChange[], by: number): WriterPendingChange[] =>
  ledger.map((change) => ({ ...change, anchor: { from: change.anchor.from + by, to: change.anchor.to + by } }))

function undone(state: EditorState): EditorState {
  let next = state
  expect(undo({ state, dispatch: (tr) => { next = tr.state } })).toBe(true)
  return next
}

test('departure 1: the two history call sites are told apart by type, not length (a same-length step)', () => {
  let state = isolated(draftingState('abc def ghi'), { changes: { from: 0, to: 3, insert: 'ABC' } })
  const before = pendingWriterChanges(state)
  // A deletion leaves a point record; a joined one-for-one replacement keeps the document length, so
  // length alone would read CodeMirror's join (addChanges) as a reconcile mapping (mapEvent) and keep
  // the deletion's record alive after the undo.
  state = state.update({ changes: { from: 4, to: 5 }, userEvent: 'delete.backward' }).state
  state = keystroke(state, { changes: { from: 4, to: 5, insert: 'y' } })

  state = undone(state)
  expect(state.doc.toString()).toBe('ABC def ghi')
  expect(pendingWriterChanges(state)).toEqual(before)
})

test('departure 2: the youngest snapshot of a joined event is the one restored', () => {
  let state = isolated(draftingState('one two three'), { changes: { from: 0, to: 3, insert: 'ONE' } })
  state = isolated(state, { changes: { from: 8, to: 13, insert: 'THREE' } })
  const before = pendingWriterChanges(state)
  // Insert, insert, delete: the oldest step's document has the same length as the youngest's, but
  // its positions differ, so the oldest snapshot still "fits" a later reconcile — wrongly.
  state = keystroke(state, { changes: { from: 7, insert: 'a' } })
  state = keystroke(state, { changes: { from: 8, insert: 'b' } })
  state = state.update({ changes: { from: 6, to: 7 }, userEvent: 'delete.backward' }).state
  state = reconcile(state, { changes: { from: 8, insert: 'Q' } })

  state = undone(state)
  expect(state.doc.toString()).toBe('ONE twoQ THREE')
  expect(pendingWriterChanges(state)).toEqual([before[0]!, ...shifted(before.slice(1), 1)])
})

test('departure 3: a discarded branch never changes what the live branch restores', () => {
  let state = isolated(draftingState('one two'), { changes: { from: 0, to: 3, insert: 'ONE' } })
  const before = pendingWriterChanges(state)
  state = keystroke(state, { changes: { from: 7, insert: 'a' } })
  // A scratch update (a resolution preview, a cached tab) extends the same history, then is dropped.
  keystroke(state, { changes: { from: 8, insert: 'z' } })
  state = keystroke(state, { changes: { from: 8, insert: 'b' } })
  state = reconcile(state, { changes: { from: 0, insert: 'X' } })

  state = undone(state)
  expect(state.doc.toString()).toBe('XONE two')
  expect(pendingWriterChanges(state)).toEqual(shifted(before, 1))
})

test('departure 4: mapping the stale snapshots of a joined event is silent', () => {
  let state = isolated(draftingState('one two'), { changes: { from: 0, to: 3, insert: 'ONE' } })
  const before = pendingWriterChanges(state)
  state = keystroke(state, { changes: { from: 7, insert: 'a' } })
  state = keystroke(state, { changes: { from: 8, insert: 'b' } })
  // Two reconciles: the older effects of the joined event fit neither history call site any more.
  state = reconcile(state, { changes: { from: 0, insert: 'X' } })
  state = reconcile(state, { changes: { from: state.doc.length, insert: '!' } })

  state = undone(state)
  expect(state.doc.toString()).toBe('XONE two!')
  expect(pendingWriterChanges(state)).toEqual(shifted(before, 1))
})
