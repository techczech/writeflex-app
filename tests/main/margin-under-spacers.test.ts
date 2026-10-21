import { expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { paragraphEnd, effectiveMarginView, marginFits, MARGIN_MIN_TEXT_WIDTH, textRoomBesideMargin } from '../../src/renderer/src/app/margin-geometry'
import { sameSpacers, setUnderSpacers, underSpacerField } from '../../src/renderer/src/editor/margin-under-spacers'

const DOC = 'First paragraph, two lines\nstill the first.\n\nSecond one.\n\nThird.'

test('a paragraph ends before its blank line, or at the end of the document', () => {
  expect(paragraphEnd(DOC, 3)).toBe(DOC.indexOf('\n\nSecond'))
  expect(paragraphEnd(DOC, DOC.indexOf('Second') + 2)).toBe(DOC.indexOf('\n\nThird'))
  expect(paragraphEnd(DOC, DOC.length - 2)).toBe(DOC.length)
  expect(paragraphEnd(`${DOC}\n\n`, DOC.length - 2)).toBe(DOC.length)
})

test('under-the-passage room follows the text through edits and is replaced by the margin', () => {
  let state = EditorState.create({ doc: DOC, extensions: [underSpacerField] })
  const end = paragraphEnd(DOC, 3)
  state = state.update({ effects: setUnderSpacers.of([{ pos: end, height: 160 }]) }).state
  // The writer types at the end of that paragraph: the room stays after the new text.
  state = state.update({ changes: { from: end, insert: ' and more' }, userEvent: 'input.type' }).state
  expect(state.field(underSpacerField)).toEqual([{ pos: end + 9, height: 160 }])
  // Typing earlier in the document moves it along.
  state = state.update({ changes: { from: 0, insert: 'XX' } }).state
  expect(state.field(underSpacerField)[0].pos).toBe(end + 11)
  expect(sameSpacers(state.field(underSpacerField), [{ pos: end + 11, height: 160 }])).toBe(true)
  state = state.update({ effects: setUnderSpacers.of([]) }).state
  expect(state.field(underSpacerField)).toEqual([])
})

test('the fallback is decided by the room left for the text: Margin while 400 px fit beside the 372 px margin, else Inline (was: windows from 1150 px)', () => {
  expect(MARGIN_MIN_TEXT_WIDTH).toBe(400)
  // The room is the editor pane's width less the margin.
  expect(textRoomBesideMargin(772)).toBe(400)
  expect(textRoomBesideMargin(771.6)).toBe(400)
  expect(textRoomBesideMargin(771)).toBe(399)
  expect(effectiveMarginView('margin', textRoomBesideMargin(771))).toBe('under')
  expect(effectiveMarginView('margin', textRoomBesideMargin(772))).toBe('margin')
  // 1440 window, both side panes open: an 832 px editor leaves 460 px. 1000 window, both panes: 392 px editor, 20 px.
  expect(effectiveMarginView('margin', textRoomBesideMargin(832))).toBe('margin')
  expect(effectiveMarginView('margin', textRoomBesideMargin(392))).toBe('under')
  // Not measured yet: the writer's choice stands. Inline chosen stays Inline whatever the room.
  expect(marginFits(null)).toBe(true)
  expect(effectiveMarginView('margin', null)).toBe('margin')
  expect(effectiveMarginView('under', 2000)).toBe('under')
})
