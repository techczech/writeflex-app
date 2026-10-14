import { expect, spyOn, test } from 'bun:test'
import { history, redo, undo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { ChangeSet, EditorState, Transaction } from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import {
  documentTextForPersistence,
  mapPendingChange,
  materialiseDraftingChanges,
  pendingWriterChanges,
  setWriterMode,
  skipWriterReviewTracking,
  writerReviewing,
} from '../../src/renderer/src/editor/writer-review'

// The crash of 2026-10-05 (renderer-errors.log, 0.21.0-alpha.21): "Position 36484 is out of range for
// changeset of length 32612", thrown from mapPendingChange. A Drafting record near the end of the
// document kept its old offsets across an edit the capture did not map, so the next ordinary edit
// mapped a position beyond the document.

const SECTIONS = ['One', 'Two', 'Three', 'Four', 'Five']
const BODY = 'Body text of this section that is long enough to matter. '.repeat(6).trim()

function sectionedDocument(): string {
  return SECTIONS.map((name) => `# ${name}\n\n${name} opens. ${BODY}\n`).join('\n')
}

function draftingState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM] }), history(), writerReviewing({ initialMode: 'drafting' })],
  })
}

function section(state: EditorState, name: string): { from: number; to: number } {
  const doc = state.doc.toString()
  const from = doc.indexOf(`# ${name}\n`)
  if (from < 0) throw new Error(`No section ${name}`)
  const next = doc.indexOf('\n# ', from)
  return { from, to: next < 0 ? doc.length : next + 1 }
}

/** The writer replaces a word inside a section: an ordinary tracked Drafting edit. */
function editWordIn(state: EditorState, name: string, word = 'begins'): EditorState {
  const from = state.doc.toString().indexOf(`${name} opens`) + name.length + 1
  return state.update({ changes: { from, to: from + 'opens'.length, insert: word }, userEvent: 'input.type' }).state
}

/** An ordinary deletion of a whole section (select the heading and its text, press Delete). */
function deleteSection(state: EditorState, name: string): EditorState {
  return state.update({ changes: section(state, name), userEvent: 'delete.selection' }).state
}

/** A command-owned removal that prose review must not re-author: ⌘⇧X cut to Scratchpad (scraps.ts). */
function cutSectionUntracked(state: EditorState, name: string): EditorState {
  return state.update({ changes: section(state, name), annotations: skipWriterReviewTracking.of(true) }).state
}

/** A disk reconcile: the file moved under the buffer (EditorPane.reconcileContent). */
function reconcileSectionAway(state: EditorState, name: string): EditorState {
  return state.update({
    changes: section(state, name),
    annotations: [skipWriterReviewTracking.of(true), Transaction.addToHistory.of(false)],
  }).state
}

function run(state: EditorState, command: typeof undo): EditorState {
  let next = state
  command({ state, dispatch: (tr) => { next = tr.state } })
  return next
}

/** Every pending change lies inside the document and, where it has text, points at its own text. */
function expectPendingChangesSound(state: EditorState): void {
  const doc = state.doc.toString()
  for (const change of pendingWriterChanges(state)) {
    expect(change.anchor.from).toBeGreaterThanOrEqual(0)
    expect(change.anchor.to).toBeGreaterThanOrEqual(change.anchor.from)
    expect(change.anchor.to).toBeLessThanOrEqual(doc.length)
    expect(doc.slice(change.anchor.from, change.anchor.to)).toBe(change.newText)
  }
  expect(documentTextForPersistence(state)).toBe(doc)
  // Reviewing must still be able to reveal the session: this throws on any stale or overlapping record.
  expect(() => state.update(materialiseDraftingChanges(state))).not.toThrow()
}

test('an untracked section removal before a pending change, then a section delete, does not throw', () => {
  let state = editWordIn(draftingState(sectionedDocument()), 'Five')
  state = cutSectionUntracked(state, 'Two')
  state = cutSectionUntracked(state, 'Three')

  // The logged shape: the record sat beyond the end of the shortened document; the next edit threw.
  expect(() => { state = deleteSection(state, 'One') }).not.toThrow()

  expect(state.doc.toString()).not.toContain('# One')
  expect(pendingWriterChanges(state).find((change) => change.newText === 'begins')).toMatchObject({ oldText: 'opens' })
  expectPendingChangesSound(state)
})

test('a disk reconcile that removes a section keeps later pending changes on their own text', () => {
  let state = editWordIn(draftingState(sectionedDocument()), 'Five')
  state = reconcileSectionAway(state, 'Two')
  state = reconcileSectionAway(state, 'Three')
  expectPendingChangesSound(state)

  expect(() => { state = deleteSection(state, 'Four') }).not.toThrow()
  expect(pendingWriterChanges(state).find((change) => change.newText === 'begins')).toMatchObject({ oldText: 'opens' })
  expectPendingChangesSound(state)
})

test('undo after a disk reconcile restores pending changes at their mapped positions', () => {
  let state = editWordIn(draftingState(sectionedDocument()), 'Four')
  state = editWordIn(state, 'Five', 'starts')
  // The reconcile is not an undo step, so history must carry the earlier capture across it.
  state = reconcileSectionAway(state, 'One')
  state = reconcileSectionAway(state, 'Two')
  state = run(state, undo)
  expectPendingChangesSound(state)

  expect(() => { state = deleteSection(state, 'Three') }).not.toThrow()
  expectPendingChangesSound(state)
})

test('undoing and redoing an untracked section removal keeps pending changes on their own text', () => {
  let state = editWordIn(draftingState(sectionedDocument()), 'Five')
  state = cutSectionUntracked(state, 'Two')
  state = run(state, undo)
  expect(state.doc.toString()).toContain('# Two')
  expectPendingChangesSound(state)

  state = run(state, redo)
  expect(state.doc.toString()).not.toContain('# Two')
  expectPendingChangesSound(state)

  expect(() => { state = deleteSection(state, 'One') }).not.toThrow()
  expectPendingChangesSound(state)
})

test('a capture that outlives a mode flip is still mapped while Reviewing', () => {
  let state = editWordIn(draftingState(sectionedDocument()), 'Five')
  // EditorPane's prop-sync dispatches the mode alone; if the reveal did not run the capture survives.
  state = state.update({ effects: setWriterMode.of('reviewing') }).state
  state = cutSectionUntracked(state, 'Two')
  state = cutSectionUntracked(state, 'Three')
  state = state.update({ effects: setWriterMode.of('drafting') }).state

  expect(() => { state = deleteSection(state, 'One') }).not.toThrow()
  expectPendingChangesSound(state)
})

for (const [where, edited, removed] of [
  ['inside', 'Three', 'Three'],
  ['after', 'Two', 'Four'],
  ['before', 'Four', 'Two'],
] as const) {
  const removals: Array<[string, (state: EditorState, name: string) => EditorState]> = [
    ['an ordinary delete', deleteSection],
    ['an untracked cut', cutSectionUntracked],
    ['a disk reconcile', reconcileSectionAway],
  ]
  for (const [how, remove] of removals) {
    test(`${how} of a section with a pending change ${where} it leaves the other changes on their text`, () => {
      let state = editWordIn(draftingState(sectionedDocument()), edited)
      state = editWordIn(state, 'Five', 'starts')
      expect(() => { state = remove(state, removed) }).not.toThrow()
      expectPendingChangesSound(state)

      const pending = pendingWriterChanges(state)
      expect(pending.find((change) => change.newText === 'starts')).toMatchObject({ oldText: 'opens' })
      const survivor = pending.find((change) => change.newText === 'begins')
      if (where === 'inside') expect(survivor).toBeUndefined()
      else expect(survivor).toMatchObject({ oldText: 'opens' })

      // A second deletion, as in each logged case.
      expect(() => { state = deleteSection(state, 'One') }).not.toThrow()
      expectPendingChangesSound(state)
    })
  }
}

function pendingAt(from: number, to: number) {
  return { localId: 'wr_stale', oldText: 'old', newText: 'x'.repeat(to - from), anchor: { from, to }, createdAt: 1 }
}

// The three logged cases: the stored position, and the length of the document the edit started from.
for (const [position, length] of [[36484, 32612], [28387, 23087], [16488, 15028]] as const) {
  test(`a pending change at ${position} in a document of ${length} is dropped with a diagnostic, not thrown`, () => {
    const deletion = ChangeSet.of({ from: 100, to: 2000 }, length)
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(mapPendingChange(pendingAt(position - 40, position), deletion)).toBeNull()
      expect(mapPendingChange(pendingAt(position, position), deletion, 'untracked')).toBeNull()
      expect(logged).toHaveBeenCalledTimes(2)
      expect(String(logged.mock.calls[0]?.[0])).toContain(`${position - 40}:${position} — outside a document of length ${length}`)
    } finally {
      logged.mockRestore()
    }
  })
}

test('mapPendingChange shifts, collapses or drops a range according to what the edit did to its text', () => {
  const deletion = ChangeSet.of({ from: 100, to: 200 }, 1000)

  expect(mapPendingChange(pendingAt(300, 310), deletion)?.anchor).toEqual({ from: 200, to: 210 })
  expect(mapPendingChange(pendingAt(50, 60), deletion)?.anchor).toEqual({ from: 50, to: 60 })
  // The writer's own deletion collapses the range to a point; the capture merges it into the new record.
  expect(mapPendingChange(pendingAt(120, 130), deletion)).toMatchObject({ newText: '', anchor: { from: 100, to: 100 } })
  // An edit nothing records leaves the pending change no text of its own.
  expect(mapPendingChange(pendingAt(120, 130), deletion, 'untracked')).toBeNull()
  expect(mapPendingChange(pendingAt(150, 150), deletion, 'untracked')).toBeNull()
  // A deletion that only clips the range keeps what is left of it.
  expect(mapPendingChange(pendingAt(150, 250), deletion, 'untracked')?.anchor).toEqual({ from: 100, to: 150 })
})
