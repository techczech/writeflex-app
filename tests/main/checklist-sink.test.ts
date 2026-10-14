import { describe, expect, test } from 'bun:test'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { markdownDialect } from '../../src/shared/markdown/dialect'
import { checklistSink, checklistSinkPlan, isChecklistDocument } from '../../src/renderer/src/editor/checklist-sink'
import { toggleCheckboxAt } from '../../src/renderer/src/editor/task-boxes'
import { editorViewMode, setEditorViewMode } from '../../src/renderer/src/editor/view-mode'
import { setWriterMode, writerReviewing } from '../../src/renderer/src/editor/writer-review'

// Checkbox-lists ticket 03, frame 7: in a checklist note the ticked items sink below "Done · n"
// ON SCREEN ONLY. The seam is the decoration: the document text is never reordered.

const TALK_PREP = [
  '# Before York',
  '',
  '- [ ] Check the room has HDMI',
  '- [x] Send slides to the organiser',
  '- [ ] Rehearse part 3',
  '- [x] Print the handout',
  '',
  'Bring the adapter.',
].join('\n')

function editor(doc: string, cursor = 0, extra: Extension[] = []): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [markdown({ extensions: markdownDialect() }), editorViewMode('markup'), writerReviewing(), history(), checklistSink, ...extra],
  })
}

const lineText = (state: EditorState, from: number, to: number): string[] =>
  state.doc.sliceString(from, to).split('\n')

/** What the decoration field hands the view: hidden runs and where the Done section stands. */
function drawn(state: EditorState): { hidden: string[][]; sections: Array<{ at: number; items: number[] }> } {
  const hidden: string[][] = []
  const sections: Array<{ at: number; items: number[] }> = []
  for (const source of state.facet(EditorView.decorations)) {
    const set = typeof source === 'function' ? null : source
    set?.between(0, state.doc.length, (from, to, deco) => {
      const widget = deco.spec.widget as { done?: Array<{ line: number }> } | undefined
      if (from < to) hidden.push(lineText(state, from, to))
      if (widget?.done) sections.push({ at: to, items: widget.done.map((item) => item.line) })
    })
  }
  return { hidden, sections }
}

describe('a checklist note sinks its ticked items on screen only', () => {
  test('the drawn note is a checklist note, and a piece with a short list at the end is not', () => {
    expect(isChecklistDocument(editor(TALK_PREP))).toBe(true)
    const piece = ['A paragraph of the essay.', 'Another paragraph.', 'A third.', '', '- [ ] fix the opening', '- [x] cut the aside', '- [ ] add an example'].join('\n')
    expect(isChecklistDocument(editor(piece))).toBe(false)
    expect(checklistSinkPlan(editor(piece))).toEqual([])
  })

  test('with the cursor outside the list, ticked lines hide in place and the Done section lists them in file order', () => {
    const state = editor(TALK_PREP, 0)
    const [plan] = checklistSinkPlan(state)
    expect(plan.done.map((item) => item.line)).toEqual([4, 6])
    expect(plan.hidden.map((range) => lineText(state, range.from, range.to))).toEqual([
      ['- [x] Send slides to the organiser'],
      ['- [x] Print the handout'],
    ])
    // The last ticked item ends the list, so the section is drawn in its place, after the open items.
    const { hidden, sections } = drawn(state)
    expect(hidden).toEqual([['- [x] Send slides to the organiser'], ['- [x] Print the handout']])
    expect(sections).toEqual([{ at: state.doc.line(6).to, items: [4, 6] }])
  })

  test('with the cursor in the list, the list shows in file order: nothing hidden, no section', () => {
    const inList = editor(TALK_PREP, TALK_PREP.indexOf('Rehearse'))
    expect(checklistSinkPlan(inList)).toEqual([])
    expect(drawn(inList)).toEqual({ hidden: [], sections: [] })
    // Moving the cursor back out sinks again, with no edit in between.
    const out = inList.update({ selection: { anchor: inList.doc.length } }).state
    expect(drawn(out).sections).toHaveLength(1)
    expect(out.doc.toString()).toBe(TALK_PREP)
  })

  test('a tick is one character; the document keeps its order and the item moves only on screen', () => {
    const state = editor(TALK_PREP, 0)
    const before = state.doc.toString()
    const hdmi = state.doc.line(3)
    const after = state.update(toggleCheckboxAt(state, hdmi.from)!).state
    const text = after.doc.toString()
    expect(text.length).toBe(before.length)
    expect([...text].flatMap((character, index) => (character === before[index] ? [] : [index]))).toEqual([hdmi.from + 3])
    expect(text).toBe(before.replace('- [ ] Check the room', '- [x] Check the room'))
    // On screen the HDMI item has joined the Done section; on disk it is still line 3.
    expect(checklistSinkPlan(after)[0].done.map((item) => item.line)).toEqual([3, 4, 6])
    expect(after.doc.line(3).text).toBe('- [x] Check the room has HDMI')
  })

  test('an open item after the last ticked one puts the section after the list, and loose lists lose no gap', () => {
    const loose = ['- [x] one', '', '- [ ] two', '', '- [x] three', '', '- [ ] four', '- [ ] five'].join('\n')
    const state = editor(loose, loose.length + 0)
    // The cursor at the very end is inside the list; start it before the list instead.
    const outside = EditorState.create({ doc: `Note\n\n${loose}`, selection: { anchor: 0 }, extensions: [markdown({ extensions: markdownDialect() }), editorViewMode('markup'), writerReviewing(), checklistSink] })
    expect(checklistSinkPlan(state)).toEqual([])
    const [plan] = checklistSinkPlan(outside)
    expect(plan.hidden.map((range) => lineText(outside, range.from, range.to))).toEqual([
      ['- [x] one', ''],
      ['', '- [x] three'],
    ])
    expect(drawn(outside).sections).toEqual([{ at: outside.doc.length, items: [3, 7] }])
  })

  test('Raw shows the file as typed, and Reviewing keeps a tick beside its note on its own line', () => {
    const state = editor(TALK_PREP, 0)
    const raw = state.update({ effects: setEditorViewMode.of('raw') }).state
    expect(drawn(raw)).toEqual({ hidden: [], sections: [] })
    const reviewing = state.update({ effects: setWriterMode.of('reviewing') }).state
    expect(drawn(reviewing)).toEqual({ hidden: [], sections: [] })
  })

  test('nested items travel with their ticked parent; an open parent keeps its ticked children in place', () => {
    const doc = ['Trip', '', '- [x] book', '  - [x] train', '  - [x] hotel', '- [ ] pack', '  - [x] charger', '- [ ] go'].join('\n')
    const state = editor(doc, 0)
    const [plan] = checklistSinkPlan(state)
    expect(plan.done).toEqual([{ line: 3, rows: [
      { line: 3, text: '- [x] book', box: { checked: true, from: 2, hideTo: 6 } },
      { line: 4, text: '  - [x] train', box: { checked: true, from: 4, hideTo: 8 } },
      { line: 5, text: '  - [x] hotel', box: { checked: true, from: 4, hideTo: 8 } },
    ] }])
  })
})
