import { expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { updateMovesCards, viewportMovedSince } from '../../src/renderer/src/app/margin-geometry'

// The review margin remembers the viewport it last saw. Showing a version, restoring one or opening Compare replaces
// the editor's whole state with a shorter text, and the next measure reports an update whose change counts in that
// shorter text. Mapping the remembered viewport (or card positions) through it threw "Position 22 is out of range for
// changeset of length 21" and took the window down to the recovery screen.

const CURRENT = '# Draft\n\nSecond text.\n' // 22
const V1 = '# Draft\n\nFirst text.\n' // 21

/** The update CodeMirror's measure reports right after `view.setState(V1)`: no change, in V1's coordinates. */
function measureAfterSwap() {
  const swapped = EditorState.create({ doc: V1 })
  const tr = swapped.update({})
  return { docChanged: false, heightChanged: false, changes: tr.changes, startState: swapped, state: tr.state }
}

test('the remembered viewport of the replaced text is never mapped through the new text\'s change', () => {
  const before = EditorState.create({ doc: CURRENT })
  const was = { from: 0, to: CURRENT.length, doc: before.doc }
  const update = measureAfterSwap()
  expect(update.changes.length).toBe(21)
  // The old inline check: maps 22 through a changeset of length 21.
  expect(() => update.changes.mapPos(was.to, 1)).toThrow('Position 22 is out of range for changeset of length 21')
  // A replaced document draws other lines: it counts as moved, and nothing is mapped.
  expect(viewportMovedSince(was, update, { from: 0, to: V1.length })).toBe(true)
})

test('within one document the viewport is mapped through the edit as before', () => {
  const start = EditorState.create({ doc: CURRENT })
  const tr = start.update({ changes: { from: 9, to: 9, insert: 'x' } })
  const update = { changes: tr.changes, startState: start }
  const was = { from: 0, to: CURRENT.length, doc: start.doc }
  expect(viewportMovedSince(was, update, { from: 0, to: CURRENT.length + 1 })).toBe(false)
  expect(viewportMovedSince(was, update, { from: 0, to: CURRENT.length })).toBe(true)
  expect(viewportMovedSince(null, update, { from: 0, to: CURRENT.length + 1 })).toBe(true)
})

test('card positions read from the replaced text count as moved instead of being mapped', () => {
  // A keystroke in V1 before the margin re-rendered for it: the positions still count in the longer text.
  const start = EditorState.create({ doc: V1 })
  const tr = start.update({ changes: { from: 9, to: 9, insert: 'x' }, userEvent: 'input' })
  const update = { docChanged: true, heightChanged: false, viewportMoved: false, changes: tr.changes, startState: start, state: tr.state }
  expect(() => tr.changes.mapPos(22, 1)).toThrow('out of range')
  expect(updateMovesCards(update, [22])).toBe(true)
  // Positions inside the text are mapped as before: a keystroke on another line moves nothing.
  expect(updateMovesCards(update, [0])).toBe(false)
})
