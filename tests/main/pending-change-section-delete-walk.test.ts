import { expect, test } from 'bun:test'
import { history } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import { changeMarking, changeMarksOf, setChangeMarks } from '../../src/renderer/src/editor/change-marks'
import { inlineChangeRanges, inlineChangesField, setInlineChanges } from '../../src/renderer/src/editor/inline-changes'
import {
  documentTextForPersistence,
  materialiseDraftingChanges,
  pendingWriterChanges,
  setWriterMode,
  skipWriterReviewTracking,
  visibleWriterMarks,
  writerReviewing,
} from '../../src/renderer/src/editor/writer-review'

// The logic of tests/e2e/pending-change-section-delete.spec.ts without Electron: the 2026-10-05 crash shape on
// the e2e's own draft. An agent change pending in section Three (carried by both the inline-change field
// and the margin's marks), a Drafting change typed at the end, section Two cut to the Scratchpad (a removal
// the writer's capture does not record), then section Three, which holds the agent change, deleted outright.
// (writer-pending-change-mapping.test.ts pins the writer-side mapping; this adds the agent side and the
// whole sequence.) What stays in the e2e is the real editor's recovery screen and the renderer error log.
const BODY = 'Plain body text that pads the section out. '.repeat(8).trim()
const DRAFT = [
  `# One\n\nOne opens. ${BODY}\n`,
  `# Two\n\nTwo opens. ${BODY}\n`,
  `# Three\n\nteh cat sat on mat by the door. ${BODY}\n`,
  `# Four\n\nFour opens. ${BODY}\n`,
  `# Five\n\nFive opens. ${BODY}\n`,
].join('\n')

const section = (state: EditorState, name: string): { from: number; to: number } => {
  const doc = state.doc.toString()
  const from = doc.indexOf(`# ${name}\n`)
  if (from < 0) throw new Error(`No section ${name}`)
  const next = doc.indexOf('\n# ', from)
  return { from, to: next < 0 ? doc.length : next + 1 }
}

test('deleting a section that holds a pending agent change never breaks the editor, and the rest stays pinned to its text', () => {
  let state = EditorState.create({
    doc: DRAFT,
    extensions: [markdown({ extensions: [GFM] }), history(), writerReviewing({ initialMode: 'drafting' }), inlineChangesField, changeMarking],
  })

  // A pending agent change inside section Three ("teh cat" -> "the cat"), and a second one in section Five.
  const typo = DRAFT.indexOf('teh cat')
  const five = DRAFT.indexOf('Five opens')
  state = state.update({
    effects: [
      setInlineChanges.of([
        { kind: 'text', id: 'c_typo', from: typo, to: typo + 7, oldText: 'teh cat', newText: 'the cat', category: 'typo', selected: false },
        { kind: 'text', id: 'c_five', from: five, to: five + 'Five opens'.length, oldText: 'Five opens', newText: 'Five begins', category: null, selected: false },
      ]),
      setChangeMarks.of({ selectedId: null, marks: [
        { id: 'c_typo', from: typo, to: typo + 7, pending: true, kind: 'quiet' },
        { id: 'c_five', from: five, to: five + 'Five opens'.length, pending: true },
      ] }),
    ],
  }).state

  // A pending writer change at the very end, recorded quietly in Drafting.
  const end = state.doc.length
  state = state.update({ changes: { from: end, insert: 'Closing words from the writer.' }, selection: { anchor: end + 30 }, userEvent: 'input.type' }).state
  expect(state.doc.toString()).toContain('Closing words from the writer.')

  // Cut section Two to the Scratchpad: the document shrinks by a whole section, untracked.
  state = state.update({ changes: section(state, 'Two'), annotations: skipWriterReviewTracking.of(true) }).state
  expect(state.doc.toString()).not.toContain('# Two')

  // Delete section Three, which holds the pending agent change.
  const three = section(state, 'Three')
  expect(() => { state = state.update({ changes: three, selection: { anchor: three.from }, userEvent: 'delete.selection' }).state }).not.toThrow()
  expect(state.doc.toString()).not.toContain('# Three')

  // The editor still takes the writer's typing.
  state = state.update({ changes: { from: three.from, insert: 'Still writing. ' }, selection: { anchor: three.from + 15 }, userEvent: 'input.type' }).state
  expect(state.doc.toString()).toContain('Still writing. # Four')
  expect(state.doc.toString()).toContain('Closing words from the writer.')

  // The agent change whose words were deleted is gone from both layers; the other still sits on its own words.
  const doc = state.doc.toString()
  expect(changeMarksOf(state).marks.map((mark) => mark.id)).toEqual(['c_five'])
  // The inline layer keeps the deleted change as a collapsed range (nothing left to draw); the other stays on its words.
  expect(inlineChangeRanges(state).map((range) => doc.slice(range.from, range.to)).sort()).toEqual(['', 'Five opens'])
  const five2 = changeMarksOf(state).marks[0]
  expect(doc.slice(five2.from, five2.to)).toBe('Five opens')

  // The writer's change survived on its own text, and the file text still derives cleanly.
  const writer = pendingWriterChanges(state).find((change) => change.newText.includes('Closing words'))
  expect(writer).toBeDefined()
  expect(doc.slice(writer!.anchor.from, writer!.anchor.to)).toBe(writer!.newText)
  expect(documentTextForPersistence(state)).toBe(doc)

  // Reviewing can still reveal the session's changes, each on its own text.
  expect(() => { state = state.update(materialiseDraftingChanges(state)).state }).not.toThrow()
  state = state.update({ effects: setWriterMode.of('reviewing') }).state
  const shown = visibleWriterMarks(state).filter((mark) => mark.role === 'new').map((mark) => state.doc.sliceString(mark.from, mark.to))
  expect(shown.some((text) => text.includes('Closing words from the writer.'))).toBe(true)
})
