import { afterEach, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import {
  pendingWriterChanges,
  setWriterMode,
  skipWriterReviewTracking,
  writerReviewing,
} from '../../src/renderer/src/editor/writer-review'

const originalWindow = (globalThis as { window?: unknown }).window

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
})

test('an untracked removal drops its covered record before the next keystroke, without a diagnostic', async () => {
  const reports: Array<{ message: string }> = []
  ;(globalThis as { window?: unknown }).window = {
    location: { href: 'test://writer-review' },
    writeflex: { reportRendererError: async (entry: { message: string }) => { reports.push(entry) } },
  }

  let state = EditorState.create({ doc: 'Alpha beta gamma delta.', extensions: [writerReviewing()] })
  state = state.update({ effects: setWriterMode.of('drafting') }).state
  // One unaffected record at the start and one covered by the removal.
  state = state.update({ changes: { from: 0, insert: 'X' } }).state
  state = state.update({ changes: { from: state.doc.length, insert: ' end' } }).state
  const [inRange, atEnd] = pendingWriterChanges(state)
  expect(inRange.anchor).toEqual({ from: 0, to: 1 })
  expect(atEnd.anchor.to).toBe(state.doc.length)

  // The untracked edit must remove the covered record immediately.
  state = state.update({
    changes: { from: 10, to: state.doc.length, insert: '' },
    annotations: [skipWriterReviewTracking.of(true)],
  }).state
  expect(pendingWriterChanges(state)).toEqual([inRange])

  // An ordinary tracked keystroke must not throw.
  let next = state
  expect(() => { next = state.update({ changes: { from: 5, insert: 'Y' } }).state }).not.toThrow()

  const pending = pendingWriterChanges(next)
  expect(pending.some((change) => change.localId === atEnd.localId)).toBe(false)
  expect(pending.find((change) => change.localId === inRange.localId)).toEqual(inRange)
  expect(pending.some((change) => change.newText === 'Y')).toBe(true)

  // Since the pending-change redesign, the untracked deletion maps (and here removes) the end record
  // instead of leaving it stale, so nothing reaches the stale-range diagnostic.
  await Promise.resolve()
  expect(reports).toHaveLength(0)
})

test('an untracked shortening clips an insertion and later typing keeps its identity', () => {
  ;(globalThis as { window?: unknown }).window = {
    location: { href: 'test://writer-review' },
    writeflex: { reportRendererError: async () => {} },
  }

  let state = EditorState.create({ doc: 'abcdefghij', extensions: [writerReviewing()] })
  state = state.update({ effects: setWriterMode.of('drafting') }).state
  state = state.update({ changes: { from: 5, insert: 'XYZ' } }).state
  const [insertion] = pendingWriterChanges(state)
  expect(insertion.anchor).toEqual({ from: 5, to: 8 })

  // The untracked shortening clips XYZ to XY and maps the live anchor to [5,7].
  state = state.update({
    changes: { from: 7, to: state.doc.length, insert: '' },
    annotations: [skipWriterReviewTracking.of(true)],
  }).state
  expect(state.doc.toString()).toBe('abcdeXY')
  expect(pendingWriterChanges(state)).toEqual([{
    ...insertion, newText: 'XY', anchor: { from: 5, to: 7 },
  }])

  state = state.update({ changes: { from: 6, to: 7, insert: 'Q' } }).state
  expect(state.doc.toString()).toBe('abcdeXQ')
  // Since the pending-change redesign, the untracked shortening maps the record to `XY` [5,7], so
  // the keystroke edits the writer's own insertion: one record, the same id, now reading `XQ`.
  const pending = pendingWriterChanges(state)
  expect(pending).toHaveLength(1)
  expect(pending[0].localId).toBe(insertion.localId)
  expect(pending[0].newText).toBe('XQ')
  expect(pending[0].oldText).toBe('')
})
