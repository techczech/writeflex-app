import { describe, expect, test } from 'bun:test'
import { EditorState, type Extension, type StateCommand } from '@codemirror/state'
import { history, undo, undoDepth } from '@codemirror/commands'
import { insertNewlineContinueMarkup, markdown } from '@codemirror/lang-markdown'
import { markdownDialect } from '../../src/shared/markdown/dialect'
import { taskBoxOnLine } from '../../src/renderer/src/editor/task-items'
import {
  closeTaskBracket,
  continueTaskList,
  taskBoxDecorations,
  tickNote,
  toggleCheckbox,
  toggleCheckboxAt,
} from '../../src/renderer/src/editor/task-boxes'
import { editorViewMode, setEditorViewMode } from '../../src/renderer/src/editor/view-mode'
import { documentTextForPersistence, pendingWriterChanges, writerReviewing } from '../../src/renderer/src/editor/writer-review'
import { inlineChangesField, setInlineChanges } from '../../src/renderer/src/editor/inline-changes'
import { listLineStyle } from '../../src/renderer/src/editor/list-typography'
import { allBindableCommands, registryCommand } from '../../src/renderer/src/commands/registry'
import { buildEditorChordKeymap, chordToCmKey } from '../../src/renderer/src/commands/chords'

function editor(doc: string, cursor = doc.length, extra: Extension[] = []): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [markdown({ extensions: markdownDialect() }), editorViewMode('markup'), writerReviewing(), history(), inlineChangesField, ...extra],
  })
}

function run(command: StateCommand, state: EditorState): { handled: boolean; state: EditorState } {
  let next = state
  const handled = command({ state, dispatch: (tr) => { next = tr.state } })
  return { handled, state: next }
}

/** Positions where two strings differ — a tick must differ in exactly one. */
function differingPositions(a: string, b: string): number[] {
  expect(a.length).toBe(b.length)
  return [...a].flatMap((character, index) => (character === b[index] ? [] : [index]))
}

function boxesOf(state: EditorState, hasFocus = false) {
  const { decorations } = taskBoxDecorations(state, [{ from: 0, to: state.doc.length }], hasFocus)
  const found: Array<{ from: number; to: number; checked: boolean; focused: boolean; changed: boolean }> = []
  const notes: string[] = []
  decorations.between(0, state.doc.length, (from, to, deco) => {
    const widget = deco.spec.widget as { checked: boolean; focused?: boolean; changed?: boolean; createdAt?: number }
    if (from === to) notes.push(tickNote(widget.checked, widget.createdAt!))
    else found.push({ from, to, checked: widget.checked, focused: widget.focused!, changed: widget.changed! })
  })
  return { found, notes }
}

describe('the list marker decoration draws a box for task items and nothing for plain items', () => {
  test('recognises boxes after every list marker, nested, open and ticked', () => {
    const doc = ['- [ ] open', '- [x] done', '* [X] star', '+ [ ] plus', '1. [ ] one', '2) [x] two', '  - [ ] nested', '- [ ] '].join('\n')
    const state = editor(doc)
    const lines = doc.split('\n').map((_, index) => taskBoxOnLine(state, state.doc.line(index + 1)))
    expect(lines.map((box) => box?.checked)).toEqual([false, true, true, false, false, true, false, false])
    // The box replaces the brackets and the space after them; the marker and its space stay as typed.
    expect(state.doc.sliceString(lines[0]!.from, lines[0]!.hideTo)).toBe('[ ] ')
    expect(state.doc.sliceString(lines[6]!.from, lines[6]!.hideTo)).toBe('[ ] ')
    expect(state.doc.sliceString(state.doc.line(7).from, lines[6]!.from)).toBe('  - ')
    expect(boxesOf(state).found).toHaveLength(8)
  })

  test('plain items, prose, a bracket with no space after it, and list-looking code get no box', () => {
    const doc = ['- plain item', '[ ] not a list', '- [ ]', '- [y] not a box', '', '```', '- [ ] in code', '```', '- [link](x)'].join('\n')
    const state = editor(doc)
    for (let number = 1; number <= state.doc.lines; number += 1) expect(taskBoxOnLine(state, state.doc.line(number))).toBeNull()
    expect(boxesOf(state).found).toEqual([])
  })

  test('Raw shows the brackets as typed; Clean and Markup draw boxes', () => {
    let state = editor('- [ ] a')
    expect(boxesOf(state).found).toHaveLength(1)
    state = state.update({ effects: setEditorViewMode.of('clean') }).state
    expect(boxesOf(state).found).toHaveLength(1)
    state = state.update({ effects: setEditorViewMode.of('raw') }).state
    expect(boxesOf(state).found).toEqual([])
  })

  test('the keyboard ring sits on the box the command will tick, and only while the editor has focus', () => {
    const doc = '- [ ] first\n- [ ] second'
    const state = editor(doc, doc.length)
    expect(boxesOf(state, true).found.map((box) => box.focused)).toEqual([false, true])
    expect(boxesOf(state, false).found.map((box) => box.focused)).toEqual([false, false])
  })

  test('a wrapped box item hangs under its words: the box replaces the bracket text in the indent', () => {
    const measure = (prefix: string): number => prefix.length * 10
    expect(listLineStyle('- [ ] words', measure)).toEqual({ paddingLeftPx: 18 + 60, textIndentPx: -60 })
    expect(listLineStyle('- [ ] words', measure, 22)).toEqual({ paddingLeftPx: 18 + 20 + 22, textIndentPx: -(20 + 22) })
    expect(listLineStyle('  1. [x] words', measure, 22)).toEqual({ paddingLeftPx: 36 + 30 + 22, textIndentPx: -(20 + 30 + 22) })
  })
})

describe('Toggle checkbox writes one character as one undo event', () => {
  test('ticks and unticks the cursor line, changing only the bracket character', () => {
    const doc = '- [ ] Add the restaurant script example'
    const ticked = run(toggleCheckbox, editor(doc, 10))
    expect(ticked.handled).toBe(true)
    expect(ticked.state.doc.toString()).toBe('- [x] Add the restaurant script example')
    expect(differingPositions(doc, ticked.state.doc.toString())).toEqual([3])
    const unticked = run(toggleCheckbox, ticked.state)
    expect(unticked.state.doc.toString()).toBe(doc)
    const upper = run(toggleCheckbox, editor('1. [X] shout', 3))
    expect(upper.state.doc.toString()).toBe('1. [ ] shout')
  })

  test('declines off a box line, on a read-only buffer, and on a line holding a pending agent change', () => {
    expect(run(toggleCheckbox, editor('- plain', 3)).handled).toBe(false)
    expect(run(toggleCheckbox, editor('Prose.', 2)).handled).toBe(false)
    expect(run(toggleCheckbox, editor('- [ ] a', 6, [EditorState.readOnly.of(true)])).handled).toBe(false)
    let state = editor('- [ ] old words\n- [ ] other', 8)
    state = state.update({ effects: setInlineChanges.of([{ kind: 'text', id: 'c1', from: 6, to: 9, oldText: 'old', newText: 'new', category: null, selected: false }]) }).state
    expect(run(toggleCheckbox, state).handled).toBe(false) // ⌘↵ falls through to accepting the change
    state = state.update({ selection: { anchor: state.doc.length } }).state
    expect(run(toggleCheckbox, state).handled).toBe(true)
  })

  test('each tick is its own undo step, even straight after typing and after another tick', () => {
    let state = editor('- [ ] one\n- [ ] two', 9)
    state = state.update({ changes: { from: 9, insert: '!' }, selection: { anchor: 10 }, userEvent: 'input.type' }).state
    state = run(toggleCheckbox, state).state
    state = state.update({ selection: { anchor: state.doc.length } }).state
    state = run(toggleCheckbox, state).state
    expect(state.doc.toString()).toBe('- [x] one!\n- [x] two')
    expect(undoDepth(state)).toBe(3)
    state = run(undo, state).state
    expect(state.doc.toString()).toBe('- [x] one!\n- [ ] two')
    state = run(undo, state).state
    expect(state.doc.toString()).toBe('- [ ] one!\n- [ ] two')
    state = run(undo, state).state
    expect(state.doc.toString()).toBe('- [ ] one\n- [ ] two')
  })

  test('a click ticks the box on the line it hits and leaves the caret where it was', () => {
    const state = editor('- [ ] one\n- [ ] two', 0)
    const box = taskBoxOnLine(state, state.doc.line(2))!
    const spec = toggleCheckboxAt(state, box.from)!
    const next = state.update(spec).state
    expect(next.doc.toString()).toBe('- [ ] one\n- [x] two')
    expect(next.selection.main.head).toBe(0)
    expect(toggleCheckboxAt(state, 0)).not.toBeNull()
    expect(toggleCheckboxAt(editor('- plain'), 0)).toBeNull()
  })
})

describe('Reviewing tracks a tick as a writer change', () => {
  function reviewing(doc: string, cursor: number): EditorState {
    return EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [markdown({ extensions: markdownDialect() }), editorViewMode('markup'), writerReviewing({ initialMode: 'reviewing' }), history(), inlineChangesField],
    })
  }

  test('the tick is a pending writer change; the file gets exactly the one character; the box shows ticked and changed', () => {
    const doc = '- [ ] Move the schema definition up\n- [ ] Add the restaurant script example'
    const state = run(toggleCheckbox, reviewing(doc, doc.length)).state
    expect(pendingWriterChanges(state).map(({ oldText, newText }) => ({ oldText, newText }))).toEqual([{ oldText: ' ', newText: 'x' }])
    const saved = documentTextForPersistence(state)
    expect(differingPositions(doc, saved)).toEqual([doc.indexOf('[ ] Add') + 1])
    const box = taskBoxOnLine(state, state.doc.line(2))!
    expect(box.checked).toBe(true)
    expect(box.change).not.toBeNull()
    const { found, notes } = boxesOf(state)
    expect(found.map(({ checked, changed }) => ({ checked, changed }))).toEqual([{ checked: false, changed: false }, { checked: true, changed: true }])
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/^ticked by you, \d\d:\d\d$/)
  })

  test('ticking back and undo keep the box readable and the file one character from the start', () => {
    const doc = '- [ ] item'
    let state = run(toggleCheckbox, reviewing(doc, doc.length)).state
    state = run(toggleCheckbox, state).state
    expect(taskBoxOnLine(state, state.doc.line(1))?.checked).toBe(false)
    expect(documentTextForPersistence(state)).toBe(doc)
    state = run(undo, state).state
    expect(documentTextForPersistence(state)).toBe('- [x] item')
    state = run(undo, state).state
    expect(state.doc.toString()).toBe(doc)
    expect(pendingWriterChanges(state)).toEqual([])
  })
})

describe('typing a box and Return on a box line', () => {
  function typeClose(state: EditorState): EditorState {
    const { from, to } = state.selection.main
    const spec = closeTaskBracket(state, from, to, ']')
    expect(spec).not.toBeNull()
    return state.update(spec!).state
  }

  test('`]` after a list marker and `[` or `[ ` closes a box, with or without the smart-paired bracket', () => {
    for (const [doc, cursor] of [['- [', 3], ['- []', 3], ['- [ ', 4], ['- [ ]', 4], ['1. [', 4], ['  * []', 5]] as const) {
      const state = typeClose(editor(doc, cursor))
      const text = state.doc.toString()
      expect(text.trimStart()).toMatch(/^(?:[-*]|1\.) \[ \] $/)
      expect(state.selection.main.head).toBe(text.length)
      expect(taskBoxOnLine(state, state.doc.line(1))).not.toBeNull()
    }
    const before = typeClose(editor('- []Close on teaching', 3))
    expect(before.doc.toString()).toBe('- [ ] Close on teaching')
    const spaced = typeClose(editor('- [] Close on teaching', 3))
    expect(spaced.doc.toString()).toBe('- [ ] Close on teaching')
    expect(spaced.selection.main.head).toBe(6)
  })

  test('`]` anywhere else types normally', () => {
    expect(closeTaskBracket(editor('Prose [', 7), 7, 7, ']')).toBeNull()
    expect(closeTaskBracket(editor('- item [', 8), 8, 8, ']')).toBeNull()
    expect(closeTaskBracket(editor('- [x', 4), 4, 4, ']')).toBeNull()
    expect(closeTaskBracket(editor('```\n- [\n```', 7), 7, 7, ']')).toBeNull()
    expect(closeTaskBracket(editor('- [', 3), 3, 3, 'a')).toBeNull()
  })

  function pressReturn(state: EditorState): EditorState {
    const continued = run(continueTaskList, state)
    return continued.handled ? continued.state : run(insertNewlineContinueMarkup, state).state
  }

  test('Return on a box line starts a new unticked box after every marker', () => {
    expect(pressReturn(editor('- [ ] one')).doc.toString()).toBe('- [ ] one\n- [ ] ')
    expect(pressReturn(editor('- [x] done')).doc.toString()).toBe('- [x] done\n- [ ] ')
    expect(pressReturn(editor('1. [x] first')).doc.toString()).toBe('1. [x] first\n2. [ ] ')
    expect(pressReturn(editor('  - [ ] nested')).doc.toString()).toBe('  - [ ] nested\n  - [ ] ')
    const next = pressReturn(editor('1. [ ] first'))
    expect(next.selection.main.head).toBe(next.doc.length)
    // Undo takes the whole new item back in one step.
    expect(run(undo, next).state.doc.toString()).toBe('1. [ ] first')
  })

  test('Return on an empty box line ends the list, as lists do today', () => {
    expect(pressReturn(editor('- [ ] one\n- [ ] ')).doc.toString()).toBe('- [ ] one\n\n- [ ] ')
    expect(pressReturn(editor('1. [ ] one\n2. [ ] ')).doc.toString()).toBe('1. [ ] one\n\n2. [ ] ')
    // Today's list rule (lang-markdown): an empty item's first Return loosens the list, the second
    // ends it. A box line follows it step for step, bullets and numbers alike.
    const twice = (state: EditorState): string => pressReturn(pressReturn(state)).doc.toString()
    expect(twice(editor('- one\n- '))).toBe('- one\n\n')
    expect(twice(editor('- [ ] one\n- [ ] '))).toBe('- [ ] one\n\n')
    expect(twice(editor('1. [ ] one\n2. [ ] '))).toBe('1. [ ] one\n\n')
    expect(pressReturn(editor('- [ ] ')).doc.toString()).toBe('')
  })
})

test('Toggle checkbox is a registered, rebindable palette command on the placeholder ⌘↵', () => {
  const command = registryCommand('edit.toggleCheckbox')
  expect(command).toMatchObject({ label: 'Toggle checkbox', keys: '⌘↵', group: 'Writing', run: toggleCheckbox })
  expect(command.surfaces).toEqual(['palette', 'sheet'])
  expect(allBindableCommands().some((entry) => entry.id === 'edit.toggleCheckbox')).toBe(true)
  expect(chordToCmKey('⌘↵')).toBe('Mod-Enter')
  expect(buildEditorChordKeymap({}).some((binding) => binding.key === 'Mod-Enter' && binding.run === toggleCheckbox)).toBe(true)
  // Rebinding moves it; the default retires in the same act.
  const moved = buildEditorChordKeymap({ 'edit.toggleCheckbox': '⌃⌘X' })
  expect(moved.some((binding) => binding.run === toggleCheckbox && binding.key === 'Ctrl-Mod-x')).toBe(true)
  expect(moved.some((binding) => binding.run === toggleCheckbox && binding.key === 'Mod-Enter')).toBe(false)
})
