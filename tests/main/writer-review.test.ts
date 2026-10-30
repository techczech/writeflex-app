import { expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { history, redo, undo } from '@codemirror/commands'
import {
  deriveCleanWriterDocument,
  documentTextForPersistence,
  pendingWriterChanges,
  resolveWriterChangeSpec,
  revisionDecorationsVisible,
  setWriterMode,
  writerReviewing,
  writerReviewModeForContent,
  writerReviewModeOf,
  writerReviewRemovedSpans,
  type WriterReviewMode,
  type WriterPendingChange,
} from '../../src/renderer/src/editor/writer-review'

test('removed spans project the raw Reviewing buffer onto exactly the persistence text', () => {
  const strip = (state: EditorState): string => {
    const raw = state.doc.toString()
    let out = ''
    let kept = 0
    for (const span of writerReviewRemovedSpans(state)) { out += raw.slice(kept, span.from); kept = span.to }
    return out + raw.slice(kept)
  }
  // A pending replacement and a pending deletion, both before later text.
  let state = reviewingState('The old draft goes here.\n\nLater text stays.\n')
  const replaceFrom = state.doc.toString().indexOf('old')
  state = state.update({ changes: { from: replaceFrom, to: replaceFrom + 3, insert: 'new' } }).state
  const deleteFrom = state.doc.toString().indexOf(' goes')
  state = state.update({ changes: { from: deleteFrom, to: deleteFrom + ' goes'.length, insert: '' } }).state
  expect(writerReviewRemovedSpans(state).length).toBeGreaterThan(0)
  expect(strip(state)).toBe(documentTextForPersistence(state))
  expect(documentTextForPersistence(state)).toContain('The new draft here.')
  // Drafting carries no marks: nothing is excluded.
  const drafting = EditorState.create({ doc: 'Plain.\n', extensions: [writerReviewing({ initialMode: 'drafting' })] })
  expect(writerReviewRemovedSpans(drafting)).toEqual([])
})

test('revision decorations are visible only in Reviewing', () => {
  const drafting = EditorState.create({ doc: 'Draft', extensions: [writerReviewing({ initialMode: 'drafting' })] })
  const reviewing = drafting.update({ effects: setWriterMode.of('reviewing') }).state

  expect(revisionDecorationsVisible(drafting)).toBe(false)
  expect(revisionDecorationsVisible(reviewing)).toBe(true)
})

function run(
  mode: WriterReviewMode,
  doc: string,
  change: { from: number; to?: number; insert?: string },
): EditorState {
  let state = EditorState.create({
    doc,
    extensions: [
      writerReviewing(),
    ],
  })
  state = state.update({ effects: setWriterMode.of(mode) }).state
  state = state.update({ changes: { from: change.from, to: change.to, insert: change.insert ?? '' } }).state
  return state
}

function reviewingState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [writerReviewing({ initialMode: 'reviewing' })] })
}

function selectText(state: EditorState, from: number, to: number): EditorState {
  return state.update({ selection: { anchor: from, head: to } }).state
}

function typeText(state: EditorState, text: string): EditorState {
  let next = state
  for (const char of text) {
    const range = next.selection.main
    next = next.update({
      changes: { from: range.from, to: range.to, insert: char },
      selection: { anchor: range.from + char.length },
    }).state
  }
  return next
}

function withMockedNow<T>(fn: (setNow: (time: number) => void) => T): T {
  const original = Date.now
  let now = 0
  Date.now = () => now
  try {
    return fn((time) => { now = time })
  } finally {
    Date.now = original
  }
}

function typeBurstsAt(state: EditorState, bursts: readonly string[], times: readonly number[]): EditorState {
  let next = state
  return withMockedNow((setNow) => {
    for (let index = 0; index < bursts.length; index += 1) {
      const burst = bursts[index]!
      setNow(times[index] ?? times.at(-1) ?? 0)
      const range = next.selection.main
      next = next.update({
        changes: { from: range.from, to: range.to, insert: burst },
        selection: { anchor: range.from + burst.length },
      }).state
    }
    return next
  })
}

test('Reviewing mode keeps deleted text struck and derives clean text without it', () => {
  const state = run('reviewing', 'The old draft.', { from: 4, to: 8 })
  expect(state.doc.toString()).toBe('The old draft.')
  expect(pendingWriterChanges(state)).toMatchObject([
    { oldText: 'old ', newText: '', anchor: { from: 4, to: 8 } },
  ])
  expect(deriveCleanWriterDocument(state.doc.toString(), pendingWriterChanges(state))).toBe('The draft.')
  expect(documentTextForPersistence(state)).toBe('The draft.')
})

test('Reviewing mode marks inserted text and keeps it in derived clean text', () => {
  const state = run('reviewing', 'The draft.', { from: 4, insert: 'new ' })
  expect(state.doc.toString()).toBe('The new draft.')
  expect(pendingWriterChanges(state)).toMatchObject([
    { oldText: '', newText: 'new ', anchor: { from: 4, to: 8 } },
  ])
  expect(documentTextForPersistence(state)).toBe('The new draft.')
})

test('Reviewing mode replacement preserves old and inserts new as one writer change', () => {
  const state = run('reviewing', 'The old draft.', { from: 4, to: 7, insert: 'new' })
  expect(state.doc.toString()).toBe('The oldnew draft.')
  expect(pendingWriterChanges(state)).toMatchObject([
    { oldText: 'old', newText: 'new', anchor: { from: 4, to: 10 } },
  ])
  expect(documentTextForPersistence(state)).toBe('The new draft.')
})

test('Reviewing mode replacing a selected word with one insert keeps full new text after old text', () => {
  const selected = selectText(reviewingState('The summer draft.'), 4, 10)
  const state = selected.update({
    changes: { from: 4, to: 10, insert: 'still' },
    selection: { anchor: 9 },
  }).state

  expect(state.doc.toString()).toBe('The summerstill draft.')
  expect(state.selection.main.head).toBe(15)
  expect(pendingWriterChanges(state)).toMatchObject([
    { oldText: 'summer', newText: 'still', anchor: { from: 4, to: 15 } },
  ])
  expect(documentTextForPersistence(state)).toBe('The still draft.')
})

test('Reviewing mode replacing a selected word by sequential typing grows one new mark', () => {
  const selected = selectText(reviewingState('The summer draft.'), 4, 10)
  const state = typeText(selected, 'still')

  expect(state.doc.toString()).toBe('The summerstill draft.')
  expect(state.selection.main.head).toBe(15)
  expect(pendingWriterChanges(state)).toMatchObject([
    { oldText: 'summer', newText: 'still', anchor: { from: 4, to: 15 } },
  ])
  expect(pendingWriterChanges(state)).toHaveLength(1)
  expect(documentTextForPersistence(state)).toBe('The still draft.')
})

test('Reviewing mode coalesces rapid adjacent typing into one writer change', () => {
  let state = EditorState.create({ doc: '', extensions: [writerReviewing()] })
  state = state.update({ effects: setWriterMode.of('reviewing') }).state
  state = state.update({ changes: { from: 0, insert: 'a' } }).state
  state = state.update({ changes: { from: 1, insert: 'b' } }).state
  state = state.update({ changes: { from: 2, insert: 'c' } }).state
  expect(pendingWriterChanges(state)).toMatchObject([{ oldText: '', newText: 'abc' }])
})

test('Reviewing mode coalesces paused contiguous typing bursts into one writer change', () => {
  const state = typeBurstsAt(reviewingState(''), ['Ano', 'ther te', 'st.'], [1_000, 2_000, 3_000])
  const changes = pendingWriterChanges(state)

  expect(state.doc.toString()).toBe('Another test.')
  expect(changes).toMatchObject([
    { oldText: '', newText: 'Another test.', anchor: { from: 0, to: 13 }, createdAt: 1_000 },
  ])
  expect(changes).toHaveLength(1)
})

test('Reviewing mode coalesces adjacent insertions even when timestamps are far apart', () => {
  const state = typeBurstsAt(reviewingState(''), ['first ', 'second'], [1_000, 60_000])

  expect(pendingWriterChanges(state)).toMatchObject([
    { oldText: '', newText: 'first second', anchor: { from: 0, to: 12 }, createdAt: 1_000 },
  ])
  expect(pendingWriterChanges(state)).toHaveLength(1)
})

test('Reviewing mode coalesces adjacent deletion runs into one old writer change', () => {
  const state = withMockedNow((setNow) => {
    let next = reviewingState('abcdef')
    setNow(1_000)
    next = next.update({ changes: { from: 1, to: 3 } }).state
    setNow(60_000)
    next = next.update({ changes: { from: 3, to: 5 } }).state
    return next
  })

  expect(state.doc.toString()).toBe('abcdef')
  expect(pendingWriterChanges(state)).toMatchObject([
    { oldText: 'bcde', newText: '', anchor: { from: 1, to: 5 }, createdAt: 1_000 },
  ])
  expect(pendingWriterChanges(state)).toHaveLength(1)
})

test('Reviewing mode keeps non-contiguous insertions as separate writer changes', () => {
  const state = withMockedNow((setNow) => {
    let next = reviewingState('middle')
    setNow(1_000)
    next = next.update({ changes: { from: 0, insert: 'Start ' } }).state
    setNow(60_000)
    next = next.update({ changes: { from: next.doc.length, insert: ' end' } }).state
    return next
  })

  expect(state.doc.toString()).toBe('Start middle end')
  expect(pendingWriterChanges(state)).toMatchObject([
    { oldText: '', newText: 'Start ', anchor: { from: 0, to: 6 } },
    { oldText: '', newText: ' end', anchor: { from: 12, to: 16 } },
  ])
  expect(pendingWriterChanges(state)).toHaveLength(2)
})

test('Reviewing mode typing a word character by character creates one new mark', () => {
  const state = typeText(reviewingState(''), 'still')

  expect(state.doc.toString()).toBe('still')
  expect(state.selection.main.head).toBe(5)
  expect(pendingWriterChanges(state)).toMatchObject([
    { oldText: '', newText: 'still', anchor: { from: 0, to: 5 } },
  ])
  expect(pendingWriterChanges(state)).toHaveLength(1)
})

test('Drafting mode applies edits plainly and exposes the captured ledger record', () => {
  const state = run('drafting', 'The old draft.', { from: 4, to: 8, insert: 'new ' })
  expect(state.doc.toString()).toBe('The new draft.')
  expect(pendingWriterChanges(state)).toMatchObject([
    { oldText: 'old ', newText: 'new ', anchor: { from: 4, to: 8 } },
  ])
  expect(documentTextForPersistence(state)).toBe('The new draft.')
})

test('mode defaults to Drafting for every document, blank or existing (ADR-0025 §2)', () => {
  expect(writerReviewModeForContent('Existing text')).toBe('drafting')
  expect(writerReviewModeForContent('  \n\t')).toBe('drafting')
  expect(writerReviewModeForContent('')).toBe('drafting')
  const state = EditorState.create({ doc: 'Existing text', extensions: [writerReviewing()] })
  expect(writerReviewModeOf(state)).toBe('drafting')
})

test('Reviewing mode tracks two replacements from one transaction in original coordinates', () => {
  let state = EditorState.create({ doc: 'abcdef', extensions: [writerReviewing({ initialMode: 'reviewing' })] })
  state = state.update({
    changes: [
      { from: 1, to: 2, insert: 'X' },
      { from: 4, to: 5, insert: 'Y' },
    ],
  }).state

  expect(state.doc.toString()).toBe('abXcdeYf')
  expect(pendingWriterChanges(state)).toMatchObject([
    { oldText: 'b', newText: 'X', anchor: { from: 1, to: 3 } },
    { oldText: 'e', newText: 'Y', anchor: { from: 5, to: 7 } },
  ])
  expect(documentTextForPersistence(state)).toBe('aXcdYf')
})

function reviewingHistoryState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [history(), writerReviewing({ initialMode: 'reviewing' })] })
}

function dispatchUndo(state: EditorState): EditorState {
  let next = state
  const didUndo = undo({ state, dispatch: (tr) => { next = tr.state } })
  expect(didUndo).toBe(true)
  return next
}

function dispatchRedo(state: EditorState): EditorState {
  let next = state
  const didRedo = redo({ state, dispatch: (tr) => { next = tr.state } })
  expect(didRedo).toBe(true)
  return next
}

test('Undo after a tracked insertion restores text and removes writer marks', () => {
  const changed = reviewingHistoryState('abc').update({ changes: { from: 1, insert: 'X' } }).state
  const undone = dispatchUndo(changed)

  expect(undone.doc.toString()).toBe('abc')
  expect(pendingWriterChanges(undone)).toEqual([])
  expect(documentTextForPersistence(undone)).toBe('abc')
})

test('Undo after a tracked deletion restores text and removes writer marks', () => {
  const changed = reviewingHistoryState('abc').update({ changes: { from: 1, to: 2 } }).state
  const undone = dispatchUndo(changed)

  expect(undone.doc.toString()).toBe('abc')
  expect(pendingWriterChanges(undone)).toEqual([])
  expect(documentTextForPersistence(undone)).toBe('abc')
})

test('Undo after a tracked replacement restores text and removes writer marks', () => {
  const changed = reviewingHistoryState('abc').update({ changes: { from: 1, to: 2, insert: 'X' } }).state
  const undone = dispatchUndo(changed)

  expect(undone.doc.toString()).toBe('abc')
  expect(pendingWriterChanges(undone)).toEqual([])
  expect(documentTextForPersistence(undone)).toBe('abc')
})

test('Redo after undo restores a tracked replacement without re-tracking it as a new edit', () => {
  const changed = reviewingHistoryState('abc').update({ changes: { from: 1, to: 2, insert: 'X' } }).state
  const redone = dispatchRedo(dispatchUndo(changed))

  expect(redone.doc.toString()).toBe('abXc')
  expect(pendingWriterChanges(redone)).toHaveLength(1)
  expect(pendingWriterChanges(redone)).toMatchObject([
    { oldText: 'b', newText: 'X', anchor: { from: 1, to: 3 } },
  ])
  expect(documentTextForPersistence(redone)).toBe('aXc')
})

test('Backspacing a writer insertion erases it instead of striking it', () => {
  let state = EditorState.create({ doc: 'ab', extensions: [writerReviewing({ initialMode: 'reviewing' })] })
  state = state.update({ changes: { from: 1, insert: 'X' } }).state
  state = state.update({ changes: { from: 1, to: 2 } }).state

  expect(state.doc.toString()).toBe('ab')
  expect(pendingWriterChanges(state)).toEqual([])
  expect(documentTextForPersistence(state)).toBe('ab')
})

test('Deleting original text strikes it', () => {
  const state = run('reviewing', 'ab', { from: 0, to: 1 })

  expect(state.doc.toString()).toBe('ab')
  expect(pendingWriterChanges(state)).toMatchObject([
    { oldText: 'a', newText: '', anchor: { from: 0, to: 1 } },
  ])
  expect(documentTextForPersistence(state)).toBe('b')
})

test('Deleting across an already struck span reconciles to one old span', () => {
  let state = EditorState.create({ doc: 'abcdef', extensions: [writerReviewing({ initialMode: 'reviewing' })] })
  state = state.update({ changes: { from: 2, to: 4 } }).state
  state = state.update({ changes: { from: 1, to: 5 } }).state

  expect(state.doc.toString()).toBe('abcdef')
  expect(pendingWriterChanges(state)).toMatchObject([
    { oldText: 'bcde', newText: '', anchor: { from: 1, to: 5 } },
  ])
  expect(documentTextForPersistence(state)).toBe('af')
})

test('deriveCleanWriterDocument degrades rather than throwing on overlapping input', () => {
  const overlapping: WriterPendingChange[] = [
    { localId: 'one', oldText: 'bc', newText: '', anchor: { from: 1, to: 3 }, createdAt: 1 },
    { localId: 'two', oldText: 'cd', newText: '', anchor: { from: 2, to: 4 }, createdAt: 2 },
  ]

  expect(() => deriveCleanWriterDocument('abcdef', overlapping)).not.toThrow()
  expect(deriveCleanWriterDocument('abcdef', overlapping)).toBe('aef')
})

// Per-edit resolution (ADR-0016 parity with agent review): a tracked writer edit resolves three ways.
test('resolveWriterChangeSpec: accept keeps the new text and clears that edit', () => {
  const state = run('reviewing', 'the river', { from: 4, to: 9, insert: 'waters' })
  const change = pendingWriterChanges(state)[0]
  const next = state.update(resolveWriterChangeSpec(state, change.localId, 'accept')!).state
  expect(next.doc.toString()).toBe('the waters')
  expect(pendingWriterChanges(next)).toHaveLength(0)
})

test('resolveWriterChangeSpec: reject restores the old text and clears that edit', () => {
  const state = run('reviewing', 'the river', { from: 4, to: 9, insert: 'waters' })
  const change = pendingWriterChanges(state)[0]
  const next = state.update(resolveWriterChangeSpec(state, change.localId, 'reject')!).state
  expect(next.doc.toString()).toBe('the river')
  expect(pendingWriterChanges(next)).toHaveLength(0)
})

test('resolveWriterChangeSpec: hold keeps both readings and drops the tracking', () => {
  const state = run('reviewing', 'the river', { from: 4, to: 9, insert: 'waters' })
  const change = pendingWriterChanges(state)[0]
  const next = state.update(resolveWriterChangeSpec(state, change.localId, 'hold')!).state
  expect(next.doc.toString()).toBe('the riverwaters')
  expect(pendingWriterChanges(next)).toHaveLength(0)
})

test('resolveWriterChangeSpec: resolving one edit leaves the others tracked', () => {
  let state = run('reviewing', 'the quick brown fox', { from: 4, to: 9, insert: 'slow' })
  // A second tracked edit further along the document.
  state = state.update({ changes: { from: state.doc.toString().indexOf('fox'), to: state.doc.toString().indexOf('fox') + 3, insert: 'cat' } }).state
  const changes = pendingWriterChanges(state)
  expect(changes.length).toBe(2)
  const next = state.update(resolveWriterChangeSpec(state, changes[0].localId, 'accept')!).state
  expect(pendingWriterChanges(next)).toHaveLength(1)
})

test('resolveWriterChangeSpec: unknown id resolves to null', () => {
  const state = run('reviewing', 'the river', { from: 4, to: 9, insert: 'waters' })
  expect(resolveWriterChangeSpec(state, 'nope', 'accept')).toBeNull()
})

// 2026-07-11 fragmentation bug: editing your OWN tracked insertion must keep the change's identity —
// a fresh id per edit severed the mark from its flushed ledger record, so every flush ADDED a new
// overlapping record instead of updating the one it already made.
test('typing inside your own insertion keeps the pending change id stable', () => {
  let state = run('reviewing', 'The draft.', { from: 4, insert: 'new ' })
  const before = pendingWriterChanges(state)
  expect(before).toHaveLength(1)
  const id = before[0]!.localId

  // Continue typing INSIDE the tracked insertion (position 6, between 'ne' and 'w ').
  state = state.update({ changes: { from: 6, insert: 'ee' } }).state
  const inside = pendingWriterChanges(state)
  expect(inside).toHaveLength(1)
  expect(inside[0]!.localId).toBe(id)

  // Replace a chunk of the insertion (select part of it and type over).
  state = state.update({ changes: { from: 5, to: 9, insert: 'ic' } }).state
  const replaced = pendingWriterChanges(state)
  expect(replaced).toHaveLength(1)
  expect(replaced[0]!.localId).toBe(id)
})

test('appending at the end of your own insertion keeps the id stable', () => {
  let state = run('reviewing', 'The draft.', { from: 4, insert: 'new' })
  const id = pendingWriterChanges(state)[0]!.localId
  state = state.update({ changes: { from: 7, insert: 'er' } }).state
  const after = pendingWriterChanges(state)
  expect(after).toHaveLength(1)
  expect(after[0]!.localId).toBe(id)
  expect(after[0]!.newText).toBe('newer')
})

// 2026-07-11 walk report: "⌘Z hid all changes; typing again restored it". Real typing is MANY
// transactions that history JOINS into one undo event; the inverted mark-restore effects must stay
// coordinate-correct through that join, or one ⌘Z leaves marks at stale offsets (invalid → skipped →
// every change un-renders while the text stays).
function typeChars(state: EditorState, at: number, text: string): EditorState {
  let next = state
  let pos = at
  for (const ch of text) {
    next = next.update({ changes: { from: pos, insert: ch }, userEvent: 'input.type', selection: { anchor: pos + 1 } }).state
    pos += 1
  }
  return next
}

test('one ⌘Z after a joined typing burst reverts the burst and leaves marks empty and valid', () => {
  const typed = typeChars(reviewingHistoryState('The draft.'), 4, 'brand ')
  expect(typed.doc.toString()).toBe('The brand draft.')
  expect(pendingWriterChanges(typed)).toHaveLength(1)

  const undone = dispatchUndo(typed)
  expect(undone.doc.toString()).toBe('The draft.')
  expect(pendingWriterChanges(undone)).toEqual([])
  expect(documentTextForPersistence(undone)).toBe('The draft.')
})

test('undoing the second burst keeps the first burst tracked at correct coordinates', () => {
  let state = typeChars(reviewingHistoryState('The draft.'), 4, 'brand ')
  // A separate history event: different userEvent boundary (a deliberate pause / different input kind).
  state = state.update({ changes: { from: state.doc.length, insert: ' Later words.' }, userEvent: 'input.paste' }).state
  expect(pendingWriterChanges(state)).toHaveLength(2)

  const undone = dispatchUndo(state)
  expect(undone.doc.toString()).toBe('The brand draft.')
  const remaining = pendingWriterChanges(undone)
  expect(remaining).toHaveLength(1)
  expect(remaining[0]!.newText).toBe('brand ')
  expect(undone.doc.toString().slice(remaining[0]!.anchor.from, remaining[0]!.anchor.to)).toBe('brand ')
  expect(documentTextForPersistence(undone)).toBe('The brand draft.')

  const redone = dispatchRedo(undone)
  expect(redone.doc.toString()).toBe('The brand draft. Later words.')
  expect(pendingWriterChanges(redone)).toHaveLength(2)
})
