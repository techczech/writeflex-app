import { expect, spyOn, test } from 'bun:test'
import { history, isolateHistory, redo, undo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import {
  documentTextForPersistence,
  materialiseDraftingChanges,
  pendingWriterChanges,
  resolveWriterChangeSpec,
  skipWriterReviewTracking,
  visibleWriterMarks,
  writerReviewModeOf,
  writerReviewing,
  type WriterReviewMode,
} from '../../src/renderer/src/editor/writer-review'

// Round 4 (2026-10-06): one contiguous range per record (I6), and an undo whose text change a
// reconcile absorbed keeps the ledger.

function editorState(doc: string, mode: WriterReviewMode): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM] }), history(), writerReviewing({ initialMode: mode })],
  })
}

const writerEdit = (state: EditorState, spec: TransactionSpec): EditorState =>
  state.update({ ...spec, userEvent: 'input.type', annotations: isolateHistory.of('full') }).state

const reconcile = (state: EditorState, spec: TransactionSpec): EditorState =>
  state.update({ ...spec, annotations: [skipWriterReviewTracking.of(true), Transaction.addToHistory.of(false)] }).state

function run(state: EditorState, command: typeof undo): EditorState {
  let next = state
  command({ state, dispatch: (tr) => { next = tr.state } })
  return next
}

function resolveAll(state: EditorState, action: 'accept' | 'reject'): EditorState {
  let next = state
  for (let mark = visibleWriterMarks(next)[0]; mark; mark = visibleWriterMarks(next)[0]) {
    next = next.update(resolveWriterChangeSpec(next, mark.id, action)!).state
  }
  return next
}

function expectOneRangePerRecord(state: EditorState): void {
  const byId = new Map<string, Array<{ role: string; from: number; to: number }>>()
  for (const mark of visibleWriterMarks(state)) byId.set(mark.id, [...(byId.get(mark.id) ?? []), mark])
  for (const group of byId.values()) {
    const olds = group.filter((mark) => mark.role === 'old')
    const news = group.filter((mark) => mark.role === 'new')
    expect(olds.length).toBeLessThanOrEqual(1)
    expect(news.length).toBeLessThanOrEqual(1)
    if (olds[0] && news[0]) expect(olds[0].to).toBe(news[0].from)
  }
  const ids = pendingWriterChanges(state).map((change) => change.localId)
  expect(new Set(ids).size).toBe(ids.length)
}

test('Reviewing: deleting across the end of your own insertion strikes the rest as its own record', () => {
  let state = writerEdit(editorState('one two', 'reviewing'), { changes: { from: 0, to: 3, insert: 'ONE' } })
  expect(state.doc.toString()).toBe('oneONE two')
  // Select "E t" — the end of the writer's insertion and two original characters — and delete.
  state = state.update({ changes: { from: 5, to: 8 }, userEvent: 'delete.selection' }).state

  expect(state.doc.toString()).toBe('oneON two')
  expectOneRangePerRecord(state)
  expect(new Set(visibleWriterMarks(state).map((mark) => mark.id)).size).toBe(2)
  expect(documentTextForPersistence(state)).toBe('ONwo')
  expect(resolveAll(state, 'accept').doc.toString()).toBe('ONwo')
  expect(resolveAll(state, 'reject').doc.toString()).toBe('one two')
})

test('Drafting: one edit inside a record that spans two blocks leaves one record per id', () => {
  // A paste across a paragraph break is one record over two blocks.
  let state = writerEdit(editorState('aa\n\nbb', 'drafting'), { changes: { from: 2, insert: 'X\n\nY' } })
  expect(pendingWriterChanges(state)).toHaveLength(1)
  // One transaction touching that record in both blocks: each part adopts its id.
  state = state.update({
    changes: [{ from: 2, to: 3, insert: 'P' }, { from: 5, to: 6, insert: 'Q' }],
    userEvent: 'input.type',
    annotations: isolateHistory.of('full'),
  }).state

  expect(state.doc.toString()).toBe('aaP\n\nQ\n\nbb')
  expectOneRangePerRecord(state)
  expect(documentTextForPersistence(state)).toBe(state.doc.toString())
  const revealed = state.update(materialiseDraftingChanges(state)).state
  expectOneRangePerRecord(revealed)
  expect(documentTextForPersistence(revealed)).toBe(state.doc.toString())
})

test('an undo whose text change a reconcile absorbed restores only what its own step touched', () => {
  const errors = spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    let state = writerEdit(editorState('abc gap def', 'drafting'), { changes: { from: 0, to: 3, insert: 'ABC' } })
    state = writerEdit(state, { changes: { from: 8, to: 11, insert: 'DEF' } })
    // A command-owned cut leaves the two records touching, each keeping its identity.
    state = state.update({ changes: { from: 3, to: 8 }, annotations: [skipWriterReviewTracking.of(true), isolateHistory.of('full')] }).state
    const beforeTyping = pendingWriterChanges(state)
    expect(beforeTyping).toHaveLength(2)
    // Typing between them touches both, so they merge into one record.
    state = writerEdit(state, { changes: { from: 3, insert: 'Z' } })
    expect(pendingWriterChanges(state)).toHaveLength(1)
    // The disk then removes exactly the typed character: the undo of that keystroke changes no text.
    state = reconcile(state, { changes: { from: 3, to: 4 } })

    let undoChangedNothing: unknown = null
    undo({ state, dispatch: (tr) => { undoChangedNothing = tr.changes.empty; state = tr.state } })
    expect(undoChangedNothing).toBe(true)
    expect(state.doc.toString()).toBe('ABCDEF')
    // The keystroke touched both records (it merged them), so the undo gives both back as they were.
    expect(pendingWriterChanges(state)).toEqual(beforeTyping)
    expect(errors).not.toHaveBeenCalled()
  } finally {
    errors.mockRestore()
  }
})

test('an effect-only undo (hold) still restores the marks', () => {
  let state = writerEdit(editorState('one two', 'reviewing'), { changes: { from: 0, to: 3, insert: 'ONE' } })
  const marks = visibleWriterMarks(state)
  state = state.update(resolveWriterChangeSpec(state, marks[0]!.id, 'hold')!).state
  expect(visibleWriterMarks(state)).toEqual([])
  expect(state.doc.toString()).toBe('oneONE two')

  state = run(state, undo)
  expect(state.doc.toString()).toBe('oneONE two')
  expect(visibleWriterMarks(state)).toEqual(marks)
})

// Round 5 (2026-10-06): review finding four reproductions. An undo restores only the records its own step
// touched; already-struck text is never deleted; established records never merge.

const reviewRecords = (state: EditorState) => pendingWriterChanges(state)

test('P1: an older undo after an absorbed one changes only the record its own step touched', () => {
  let state = writerEdit(editorState('abc gap def', 'reviewing'), { changes: { from: 8, to: 11, insert: 'DEF' } })
  const defId = visibleWriterMarks(state)[0]!.id
  state = writerEdit(state, { changes: { from: 0, to: 3, insert: 'ABC' } })
  expect(state.doc.toString()).toBe('abcABC gap defDEF')
  // The disk removes the inserted ABC, leaving the struck abc.
  state = reconcile(state, { changes: { from: 3, to: 6 } })
  state = run(state, undo)
  const afterFirstUndo = reviewRecords(state).filter((change) => change.localId !== defId)

  // Undoing the earlier def → DEF must leave every other record exactly as it was.
  state = run(state, undo)
  expect(reviewRecords(state).some((change) => change.localId === defId)).toBe(false)
  expect(reviewRecords(state)).toEqual(afterFirstUndo)
  expectOneRangePerRecord(state)
})

test('P1: a deletion point that survived each reconcile survives the undo of an older step', () => {
  let state = writerEdit(editorState('aDEb tail', 'drafting'), { changes: { from: 1, to: 3 } })
  expect(pendingWriterChanges(state)).toMatchObject([{ oldText: 'DE', newText: '', anchor: { from: 1, to: 1 } }])
  // An older step (typing at the end), then a later replacement on top of it.
  state = writerEdit(state, { changes: { from: state.doc.length, insert: 'xy' } })
  state = writerEdit(state, { changes: { from: 3, to: 7, insert: 'TAIL' } })
  // Two reconciles, each stopping exactly at the deletion point: the point survives both. Composed,
  // they delete across it — the mapping CodeMirror applies to the older step's history event.
  state = reconcile(state, { changes: { from: 1, to: 3 } })
  state = reconcile(state, { changes: { from: 0, to: 1 } })
  const point = pendingWriterChanges(state).find((change) => change.oldText === 'DE')!
  expect(point.anchor).toEqual({ from: 0, to: 0 })

  state = run(state, undo) // the replacement
  expect(pendingWriterChanges(state)).toContainEqual(point)
  state = run(state, undo) // the older typing step
  expect(pendingWriterChanges(state)).toContainEqual(point)
})

test('P3: deleting only already-struck text changes nothing and keeps the old reading', () => {
  let state = writerEdit(editorState('abc', 'reviewing'), { changes: { from: 0, to: 3, insert: 'ABC' } })
  expect(state.doc.toString()).toBe('abcABC')
  const before = reviewRecords(state)
  state = state.update({ changes: { from: 0, to: 3 }, selection: { anchor: 0 }, userEvent: 'delete.backward' }).state

  expect(state.doc.toString()).toBe('abcABC')
  expect(reviewRecords(state)).toEqual(before)
  expect(before[0]).toMatchObject({ oldText: 'abc', newText: 'ABC' })
  expect(state.selection.main.head).toBe(0)
})

test('P4: resolving an unrelated record never merges two established records', () => {
  let state = writerEdit(editorState('aa\n\nbb cc', 'reviewing'), { changes: { from: 2, insert: 'X' } })
  state = writerEdit(state, { changes: { from: 5, insert: 'Y' } })
  expect(state.doc.toString()).toBe('aaX\n\nYbb cc')
  // A command-owned cut of the separator leaves X and Y adjacent, still two records.
  state = state.update({ changes: { from: 3, to: 5 }, annotations: [skipWriterReviewTracking.of(true), isolateHistory.of('full')] }).state
  expect(reviewRecords(state).map((change) => change.newText)).toEqual(['X', 'Y'])
  state = writerEdit(state, { changes: { from: 7, to: 9, insert: 'CC' } })
  const cc = reviewRecords(state).find((change) => change.newText === 'CC')!
  state = state.update(resolveWriterChangeSpec(state, cc.localId, 'accept')!).state

  const records = reviewRecords(state)
  expect(records.map((change) => change.newText)).toEqual(['X', 'Y'])
  const rejected = state.update(resolveWriterChangeSpec(state, records[0]!.localId, 'reject')!).state
  expect(rejected.doc.toString()).toBe('aaYbb CC')
})

test('a new strike that joins one established strike never carries it into the next (seed 229654)', () => {
  let state = editorState('aa bb cc xx dd', 'reviewing')
  state = state.update({ changes: { from: 6, to: 8 }, userEvent: 'delete.selection', annotations: isolateHistory.of('full') }).state
  state = state.update({ changes: { from: 12, to: 14 }, userEvent: 'delete.selection', annotations: isolateHistory.of('full') }).state
  // A command-owned cut leaves the two strikes adjacent, still two records.
  state = state.update({ changes: { from: 8, to: 12 }, annotations: [skipWriterReviewTracking.of(true), isolateHistory.of('full')] }).state
  const [, second] = visibleWriterMarks(state)
  expect(visibleWriterMarks(state).map((mark) => [mark.role, mark.from, mark.to])).toEqual([['old', 6, 8], ['old', 8, 10]])

  // Replace "bb c": the new strike over "bb " joins the first strike, which the edit touches.
  state = state.update({ changes: { from: 3, to: 7, insert: 'Q' }, userEvent: 'input.type', annotations: isolateHistory.of('full') }).state
  // The inserted Q sits before the second strike, which keeps its id and its text, one place on.
  expect(visibleWriterMarks(state)).toContainEqual({ ...second!, from: 9, to: 11 })
  expect(state.doc.sliceString(9, 11)).toBe('dd')
  expectOneRangePerRecord(state)
})

// Round 6 (2026-10-06): restore reinstates snapshot spans exactly; an effect leaves the marks it does
// not change exactly as they are; a struck-only deletion moves each cursor across the strike.

test('P1a: redo reinstates a multi-paragraph record exactly (Drafting)', () => {
  let state = writerEdit(editorState('aa\n\nbb', 'drafting'), { changes: { from: 2, insert: 'X\n\nY' } })
  const record = pendingWriterChanges(state)
  expect(record).toMatchObject([{ newText: 'X\n\nY', anchor: { from: 2, to: 6 } }])
  state = run(state, undo)
  state = run(state, redo)
  expect(pendingWriterChanges(state)).toEqual(record)
})

test('P1a: redo reinstates a multi-paragraph record exactly (Reviewing)', () => {
  let state = writerEdit(editorState('aa\n\nbb', 'reviewing'), { changes: { from: 2, insert: 'X\n\nY' } })
  const marks = visibleWriterMarks(state)
  state = run(state, undo)
  state = run(state, redo)
  expect(visibleWriterMarks(state)).toEqual(marks)
})

test('P1b: resolving an unrelated change leaves an untouched insertion exactly as it was', () => {
  let state = writerEdit(editorState('aa\n\nbb cc', 'reviewing'), { changes: { from: 2, insert: 'X\n\nY' } })
  const insertion = visibleWriterMarks(state)[0]!
  state = writerEdit(state, { changes: { from: 11, to: 13, insert: 'CC' } })
  const cc = visibleWriterMarks(state).find((mark) => mark.id !== insertion.id)!
  state = state.update(resolveWriterChangeSpec(state, cc.id, 'accept')!).state
  expect(state.doc.toString()).toBe('aaX\n\nY\n\nbb CC')
  expect(visibleWriterMarks(state)).toEqual([insertion])
  const rejected = state.update(resolveWriterChangeSpec(state, insertion.id, 'reject')!).state
  expect(rejected.doc.toString()).toBe('aa\n\nbb CC')
})

test('P2a: a struck-only deletion moves the cursor across the whole strike', () => {
  let state = writerEdit(editorState('one abc two', 'reviewing'), { changes: { from: 4, to: 7, insert: 'ABC' } })
  expect(state.doc.toString()).toBe('one abcABC two')
  // Backspace at the end of the strike moves to its start.
  let back = state.update({ selection: { anchor: 7 } }).state
  back = back.update({ changes: { from: 6, to: 7 }, selection: { anchor: 6 }, userEvent: 'delete.backward' }).state
  expect(back.doc.toString()).toBe('one abcABC two')
  expect(back.selection.main.head).toBe(4)
  // Delete forward at its start moves to its end.
  let forward = state.update({ selection: { anchor: 4 } }).state
  forward = forward.update({ changes: { from: 4, to: 5 }, selection: { anchor: 4 }, userEvent: 'delete.forward' }).state
  expect(forward.doc.toString()).toBe('one abcABC two')
  expect(forward.selection.main.head).toBe(7)
})

test('P2b: a struck-only deletion keeps every cursor', () => {
  let state = EditorState.create({
    doc: 'ab cd',
    extensions: [markdown({ extensions: [GFM] }), history(), writerReviewing({ initialMode: 'reviewing' }), EditorState.allowMultipleSelections.of(true)],
  })
  state = state.update({ changes: [{ from: 0, to: 2, insert: 'AB' }, { from: 3, to: 5, insert: 'CD' }], userEvent: 'input.type', annotations: isolateHistory.of('full') }).state
  expect(state.doc.toString()).toBe('abAB cdCD')
  // Two cursors, each at the end of a strike; backspace at both.
  state = state.update({ selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(7)]) }).state
  state = state.update({
    changes: [{ from: 1, to: 2 }, { from: 6, to: 7 }],
    selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(5)]),
    userEvent: 'delete.backward',
  }).state
  expect(state.doc.toString()).toBe('abAB cdCD')
  expect(state.selection.ranges.map((range) => range.head)).toEqual([0, 5])
})

// Round 7 (2026-10-06): no block ceiling on any record that already exists. Existing ranges never
// extend by mapping, so the ceiling had nothing left to do but truncate.

for (const mode of ['drafting', 'reviewing'] as const) {
  test(`P1a: a reconcile at the record's edge before redo keeps the whole multi-paragraph record (${mode})`, () => {
    let state = writerEdit(editorState('aa\n\nbb', mode), { changes: { from: 2, insert: 'X\n\nY' } })
    state = run(state, undo)
    state = reconcile(state, { changes: { from: 2, insert: '!' } })
    state = run(state, redo)
    expect(state.doc.toString()).toContain('X\n\nY')
    expect(pendingWriterChanges(state)[0]).toMatchObject({ newText: 'X\n\nY' })
  })
}

test('P1a: rejecting that redone record removes all of it', () => {
  let state = writerEdit(editorState('aa\n\nbb', 'reviewing'), { changes: { from: 2, insert: 'X\n\nY' } })
  state = run(state, undo)
  state = reconcile(state, { changes: { from: 2, insert: '!' } })
  state = run(state, redo)
  const record = pendingWriterChanges(state)[0]!
  expect(state.update(resolveWriterChangeSpec(state, record.localId, 'reject')!).state.doc.toString()).toBe('aa!\n\nbb')
})

test('P1b: revealing two adjacent Drafting records keeps both identities', () => {
  let state = writerEdit(editorState('aa\n\nbb', 'drafting'), { changes: { from: 2, insert: 'X' } })
  state = writerEdit(state, { changes: { from: 5, insert: 'Y' } })
  state = state.update({ changes: { from: 3, to: 5 }, annotations: [skipWriterReviewTracking.of(true), isolateHistory.of('full')] }).state
  const before = pendingWriterChanges(state)
  expect(before.map((change) => change.newText)).toEqual(['X', 'Y'])
  state = state.update(materialiseDraftingChanges(state)).state
  expect(pendingWriterChanges(state)).toEqual(before)
  expect(state.update(resolveWriterChangeSpec(state, before[0]!.localId, 'reject')!).state.doc.toString()).toBe('aaYbb')
})

test('P1b: revealing a multi-paragraph Drafting record keeps its whole span', () => {
  let state = writerEdit(editorState('aa\n\nbb', 'drafting'), { changes: { from: 2, insert: 'X\n\nY' } })
  const before = pendingWriterChanges(state)
  state = state.update(materialiseDraftingChanges(state)).state
  expect(pendingWriterChanges(state)).toEqual(before)
})

test('a mode switch is its own undo step: an adjacent edit right after it is undone alone', () => {
  let state = writerEdit(editorState('abc', 'drafting'), { changes: { from: 1, to: 2, insert: 'B' } })
  state = state.update(materialiseDraftingChanges(state)).state
  expect(state.doc.toString()).toBe('abBc')
  // Typing straight after the reveal, at the edge of the struck text it reinserted.
  state = state.update({ changes: { from: 2, insert: 'Z' }, userEvent: 'input.type' }).state
  state = run(state, undo)
  expect(writerReviewModeOf(state)).toBe('reviewing')
  expect(state.doc.toString()).toBe('abBc')
  expect(documentTextForPersistence(state)).toBe('aBc')
})
