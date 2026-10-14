import { expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { history, redo, undo, undoDepth } from '@codemirror/commands'
import { minimiseProposedReplacement } from '../../src/main/proposed-replacement'
import { reconcileReplace } from '../../src/renderer/src/editor/reconcile'
import { documentTextForPersistence, pendingWriterChanges, writerReviewing } from '../../src/renderer/src/editor/writer-review'
import { inlineChangesField, setInlineChanges } from '../../src/renderer/src/editor/inline-changes'
import { inlineChangeForPendingAgentChange } from '../../src/renderer/src/components/EditorPane'
import {
  resolutionEffectFromTransaction,
  suggestionResolutionHistory,
  suggestionResolutionSpec,
} from '../../src/renderer/src/editor/suggestion-resolution-history'

function applyCommand(state: EditorState, command: typeof undo): { state: EditorState; effect: ReturnType<typeof resolutionEffectFromTransaction> } {
  let next = state
  let effect = null
  const applied = command({
    state,
    dispatch: (transaction) => {
      effect = resolutionEffectFromTransaction(transaction)
      next = transaction.state
    },
  })
  expect(applied).toBe(true)
  return { state: next, effect }
}

test.each(['drafting', 'reviewing'] as const)('minimised accept restores exact document bytes and redoes in %s', (initialMode) => {
  const oldText = 'The opening sentence is sprawling and could be tightened.'
  const newText = 'The opening sentence sprawls.'
  const before = `# Draft\n\n${oldText}\n`
  const after = `# Draft\n\n${newText}\n`
  const proposal = minimiseProposedReplacement({
    path: 'draft.md', provenance: 'agent', editClass: 'content',
    summary: 'Tighten the opening sentence', oldText, newText, isCorrection: false,
    anchor: { from: 9, to: 9 + oldText.length },
  })!
  expect(proposal.oldText).toBe('is sprawling and could be tightened')
  expect(proposal.newText).toBe('sprawls')
  const change = { ...proposal, id: 'minimised', ts: 0, status: 'pending' as const, category: null }
  let state = EditorState.create({ doc: before, extensions: [
    history(), suggestionResolutionHistory(), writerReviewing({ initialMode }), inlineChangesField,
  ] })
  const projectPending = (current: EditorState) => current.update({ effects: setInlineChanges.of([
    inlineChangeForPendingAgentChange(current.doc.toString(), change, null)!,
  ]) }).state
  state = projectPending(state)
  const changes = reconcileReplace(pendingWriterChanges(state), documentTextForPersistence(state), after)!
  state = state.update(suggestionResolutionSpec({
    id: change.id, path: change.path, action: 'accept', beforeContent: before, changes,
  })).state
  state = state.update({ effects: setInlineChanges.of([]) }).state
  expect(state.doc.toString()).toBe(after)
  expect(documentTextForPersistence(state)).toBe(after)

  const undone = applyCommand(state, undo)
  expect(undone.effect).toEqual({ id: change.id, path: change.path, action: 'accept', resolved: false, beforeContent: before })
  state = projectPending(undone.state)
  expect(state.doc.toString()).toBe(before)
  expect(documentTextForPersistence(state)).toBe(before)

  const redone = applyCommand(state, redo)
  expect(redone.effect).toEqual({ id: change.id, path: change.path, action: 'accept', resolved: true, beforeContent: before })
  expect(redone.state.doc.toString()).toBe(after)
  expect(documentTextForPersistence(redone.state)).toBe(after)
})

test('undo and redo an accepted suggestion invert text and ledger resolution together', () => {
  let state = EditorState.create({ doc: 'Old text', extensions: [history(), suggestionResolutionHistory()] })
  state = state.update(suggestionResolutionSpec({
    id: 'change-1',
    path: 'draft.md',
    action: 'accept',
    beforeContent: 'Old text',
    changes: { from: 0, to: 8, insert: 'New text' },
  })).state
  expect(state.doc.toString()).toBe('New text')

  const undone = applyCommand(state, undo)
  expect(undone.state.doc.toString()).toBe('Old text')
  expect(undone.effect).toEqual({ id: 'change-1', path: 'draft.md', action: 'accept', resolved: false, beforeContent: 'Old text' })

  const redone = applyCommand(undone.state, redo)
  expect(redone.state.doc.toString()).toBe('New text')
  expect(redone.effect).toEqual({ id: 'change-1', path: 'draft.md', action: 'accept', resolved: true, beforeContent: 'Old text' })
})

test('reject is a history-visible effect even though it changes no text', () => {
  let state = EditorState.create({ doc: 'Keep this', extensions: [history(), suggestionResolutionHistory()] })
  expect(undoDepth(state)).toBe(0)
  state = state.update(suggestionResolutionSpec({ id: 'change-2', path: 'draft.md', action: 'reject' })).state
  expect(undoDepth(state)).toBe(1)

  const undone = applyCommand(state, undo)
  expect(undone.state.doc.toString()).toBe('Keep this')
  expect(undone.effect).toEqual({ id: 'change-2', path: 'draft.md', action: 'reject', resolved: false })

  const redone = applyCommand(undone.state, redo)
  expect(redone.effect).toEqual({ id: 'change-2', path: 'draft.md', action: 'reject', resolved: true })
})

test('undoing a resolution leaves the prior typing edit as the next undo step', () => {
  let state = EditorState.create({ doc: 'Old text', extensions: [history(), suggestionResolutionHistory()] })
  state = state.update({ changes: { from: 8, insert: '!' }, userEvent: 'input' }).state
  state = state.update(suggestionResolutionSpec({ id: 'change-3', path: 'draft.md', action: 'reject' })).state
  state = applyCommand(state, undo).state
  state = applyCommand(state, undo).state
  expect(state.doc.toString()).toBe('Old text')
})
