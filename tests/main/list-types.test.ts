import { describe, expect, test } from 'bun:test'
import { EditorState, type StateCommand } from '@codemirror/state'
import { history, undo, undoDepth } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { markdownDialect } from '../../src/shared/markdown/dialect'
import { linesOf, listRunAt, relist } from '../../src/renderer/src/editor/list-lines'
import {
  continueLetteredList,
  indentLetteredListItem,
  isLetteredItem,
  outdentLetteredListItem,
  setListType,
} from '../../src/renderer/src/editor/list-types'
import { writerReviewing } from '../../src/renderer/src/editor/writer-review'
import { listLineIndent } from '../../src/renderer/src/editor/list-typography'
import { registryCommand } from '../../src/renderer/src/commands/registry'

/**
 * Lettered and roman lists in the editor, and changing a list's type
 * (docs/plans/2026-09-27-checkbox-lists/tickets/02; design hifi-direction-1, frames 5–6).
 */

/** A buffer; `|` in `doc` marks the caret. */
function editor(doc: string): EditorState {
  const caret = doc.indexOf('|')
  const text = caret < 0 ? doc : doc.slice(0, caret) + doc.slice(caret + 1)
  return EditorState.create({
    doc: text,
    selection: { anchor: caret < 0 ? text.length : caret },
    extensions: [markdown({ extensions: markdownDialect() }), writerReviewing(), history()],
  })
}

function run(command: StateCommand, state: EditorState): { handled: boolean; state: EditorState } {
  let next = state
  const handled = command({ state, dispatch: (tr) => { next = tr.state } })
  return { handled, state: next }
}

/** The document with `|` at the caret. */
function shown(state: EditorState): string {
  const at = state.selection.main.head
  const doc = state.doc.toString()
  return doc.slice(0, at) + '|' + doc.slice(at)
}

const enter = (doc: string): string => {
  const result = run(continueLetteredList, editor(doc))
  expect(result.handled).toBe(true)
  return shown(result.state)
}

describe('Return continues a lettered or roman list', () => {
  test('with the next letter or numeral, nested too', () => {
    expect(enter('a. one|')).toBe('a. one\nb. |')
    expect(enter('Three kinds:\na. decoded\nb. understood\n   i. nobody asked|')).toBe('Three kinds:\na. decoded\nb. understood\n   i. nobody asked\n   ii. |')
    expect(enter('A) first|')).toBe('A) first\nB) |')
    expect(enter('ii. two|')).toBe('ii. two\niii. |')
  })

  test('z → aa and xxxix → xl', () => {
    expect(enter('y. one\nz. two|')).toBe('y. one\nz. two\naa. |')
    expect(enter('xxxviii. one\nxxxix. two|')).toBe('xxxviii. one\nxxxix. two\nxl. |')
  })

  test('a letter the list counts in is read in its numbering: i after h is the ninth letter', () => {
    expect(enter('h. eight\ni. nine|')).toBe('h. eight\ni. nine\nj. |')
  })

  test('a capital that would read as an initial gets the two spaces that keep it a list item', () => {
    expect(enter('I.  Introduction|')).toBe('I.  Introduction\nII.  |')
    expect(enter('III. three\nIV. four|')).toBe('III. three\nIV. four\nV.  |')
  })

  test('a box carries on unticked; the words after the caret move to the new item', () => {
    expect(enter('a. [x] done|')).toBe('a. [x] done\nb. [ ] |')
    expect(enter('a. one |two')).toBe('a. one\nb. |two')
  })

  test('the items after a new one move on a letter, so the list still reads in order', () => {
    expect(enter('a. one|\nb. two\nc. three')).toBe('a. one\nb. |\nc. two\nd. three')
  })

  test('an empty item loosens a tight list, then ends it — as numbered items do', () => {
    const loosened = enter('a. one\nb. |')
    expect(loosened).toBe('a. one\n\nb. |')
    expect(enter(loosened)).toBe('a. one\n\n|')
    // An empty nested item steps back out into the list it hangs from.
    expect(enter('a. one\n   i. |')).toBe('a. one\nb. |')
  })

  test('declines on numbered and bullet items, on prose, and with the caret in the marker', () => {
    for (const doc of ['1. one|', '- one|', 'I. M. Pei designed it.|', 'etc. and so on|', 'a|. one', '```\na. code|\n```']) {
      expect(run(continueLetteredList, editor(doc)).handled).toBe(false)
    }
  })
})

describe('typing never reformats', () => {
  test('prose starting "I. " at the top of a paragraph is not a list item, so nothing hangs or continues', () => {
    const state = editor('I. M. Pei designed the pyramid.|')
    expect(isLetteredItem(state, 1)).toBe(false)
    expect(run(continueLetteredList, state).handled).toBe(false)
    // Typing is plain insertion: no command runs until Return, and the text is exactly what was typed.
    const typed = state.update({ changes: { from: state.doc.length, insert: ' I. ' } }).state
    expect(typed.doc.toString()).toBe('I. M. Pei designed the pyramid. I. ')
  })
})

describe('the list type rewrite (pure)', () => {
  test('rewrites only the items’ markers, renumbers them, and keeps every tick', () => {
    const lines = ['1. one', '2. [x] two', '   - child', '   continued', '3. three']
    expect(relist(lines, 'lower-alpha')).toEqual(['a. one', 'b. [x] two', '   - child', '   continued', 'c. three'])
    expect(relist(lines, 'lower-roman')).toEqual(['i. one', 'ii. [x] two', '   - child', '   continued', 'iii. three'])
    expect(relist(['a. one', 'b. [x] two'], 'checkboxes')).toEqual(['- [ ] one', '- [x] two'])
    expect(relist(['- [ ] one', '- [x] two'], 'decimal')).toEqual(['1. [ ] one', '2. [x] two'])
    expect(relist(['i. one', 'ii. [x] two'], 'bullet')).toEqual(['- one', '- [x] two'])
  })

  test('a list that starts at 3 keeps its start; `)` stays `)`; bullets keep their own character', () => {
    expect(relist(['3. c', '4. d'], 'lower-alpha')).toEqual(['c. c', 'd. d'])
    expect(relist(['1) one', '2) two'], 'lower-roman')).toEqual(['i) one', 'ii) two'])
    expect(relist(['* one', '* two'], 'checkboxes')).toEqual(['* [ ] one', '* [ ] two'])
    expect(relist(['- one', '- two'], 'lower-alpha')).toEqual(['a. one', 'b. two'])
  })

  test('the run is the list at the item’s indent: children inside it, other lists outside it', () => {
    const lines = linesOf(['Intro', '', 'a. one', '   i. child', 'b. two', '', 'c. three', '', 'Between', '', 'a. other'])
    expect(listRunAt(lines, 4)).toEqual({ level: 0, members: [2, 4, 6], from: 2, to: 6 })
    expect(listRunAt(lines, 3)).toEqual({ level: 3, members: [3], from: 3, to: 3 })
    // A lettered list followed by a roman one at the same indent is two lists, as the parser reads it.
    expect(listRunAt(linesOf(['c. three', 'd. four', 'iv. four', 'v. five']), 3)?.members).toEqual([2, 3])
  })
})

describe('List type commands', () => {
  const lettered = setListType('lower-alpha')

  test('change the list the cursor is in, and only that list, as one undo step', () => {
    const before = '1. one\n2. [x] two|\n   - child\n3. three\n\nProse.\n\n1. other'
    const result = run(lettered, editor(before))
    expect(result.handled).toBe(true)
    expect(result.state.doc.toString()).toBe('a. one\nb. [x] two\n   - child\nc. three\n\nProse.\n\n1. other')
    expect(undoDepth(result.state)).toBe(1)
    const undone = run(undo, result.state)
    expect(undone.state.doc.toString()).toBe(before.replace('|', ''))
  })

  test('work from a continuation line and from inside a nested list', () => {
    expect(run(lettered, editor('1. one\n   more|\n2. two')).state.doc.toString()).toBe('a. one\n   more\nb. two')
    expect(run(setListType('lower-roman'), editor('- one\n  - nested|\n  - nested two\n- two')).state.doc.toString())
      .toBe('- one\n  i. nested\n  ii. nested two\n- two')
  })

  test('checkboxes box every item and keep the ticked ones ticked', () => {
    expect(run(setListType('checkboxes'), editor('a. one|\nb. [x] two')).state.doc.toString()).toBe('- [ ] one\n- [x] two')
  })

  test('decline off a list and when the list is already that type', () => {
    expect(run(lettered, editor('Just prose.|')).handled).toBe(false)
    expect(run(lettered, editor('a. one|\nb. two')).handled).toBe(false)
    expect(run(lettered, editor('```\n1. code|\n```')).handled).toBe(false)
  })

  test('are registered palette commands with the drawn labels', () => {
    expect(['list.type.lettered', 'list.type.roman', 'list.type.numbered', 'list.type.bullet', 'list.type.checkboxes']
      .map((id) => registryCommand(id).label)).toEqual([
      'List type: a. b. c.', 'List type: i. ii. iii.', 'List type: 1. 2. 3.', 'List type: bullet', 'List type: checkboxes',
    ])
    const state = editor('1. one|\n2. two')
    let next = state
    registryCommand('list.type.roman').run?.({ state, dispatch: (tr) => { next = tr.state } } as never)
    expect(next.doc.toString()).toBe('i. one\nii. two')
  })
})

describe('Tab nests lettered and roman items as numbered ones nest', () => {
  test('two columns with its children; the list it joins restarts, the list it leaves renumbers', () => {
    const nested = run(indentLetteredListItem, editor('a. one\nb. two|\n   i. child\nc. three'))
    expect(nested.handled).toBe(true)
    expect(nested.state.doc.toString()).toBe('a. one\n  a. two\n     i. child\nb. three')
    const back = run(outdentLetteredListItem, nested.state)
    expect(back.state.doc.toString()).toBe('a. one\nb. two\n   i. child\nc. three')
  })

  test('joining an existing sublist continues it', () => {
    expect(run(indentLetteredListItem, editor('a. one\n  a. inner\nb. two|')).state.doc.toString()).toBe('a. one\n  a. inner\n  b. two')
  })

  test('declines off lettered items so Bridle nests numbered and bullet ones', () => {
    expect(run(indentLetteredListItem, editor('1. one\n2. two|')).handled).toBe(false)
    expect(run(outdentLetteredListItem, editor('a. top|')).handled).toBe(false)
    const tabbed = editor('1. one\n2. two|')
    let next = tabbed
    registryCommand('outline.indentListItem').run?.({ state: tabbed, dispatch: (tr) => { next = tr.state } } as never)
    expect(next.doc.toString()).toBe('1. one\n  1. two')
  })
})

describe('lettered markers hang like numbered ones', () => {
  test('same indent and hanging-wrap geometry as a numbered item of the same width', () => {
    expect(listLineIndent('a. item')).toEqual(listLineIndent('1. item'))
    expect(listLineIndent('   ii. nested')).toEqual({ nestingPx: 36, leadingColumns: 3, markerColumns: 4 })
    expect(listLineIndent('b. [x] done')).toEqual(listLineIndent('1. [x] done'))
  })
})
