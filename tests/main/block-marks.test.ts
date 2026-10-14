import { expect, test } from 'bun:test'
import { EditorSelection, EditorState, type StateCommand, type Transaction } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { history, historyKeymap, undo } from '@codemirror/commands'
import { keymap } from '@codemirror/view'
import {
  makePlainParagraph,
  toggleBlockquote,
  toggleBulletList,
  toggleOrderedList,
  blocksForSelection,
} from '../../src/renderer/src/editor/block-marks'
import { toggleStrikethrough } from '../../src/renderer/src/editor/commands'
import { insertTable } from '../../src/renderer/src/editor/insert-block-object'
import { buildTable } from '../../src/renderer/src/editor/insert-objects'
import { commandRegistry, registryCommand } from '../../src/renderer/src/commands/registry'
import { DEFAULT_ACTION_BAR_GROUPS } from '../../src/renderer/src/components/action-bar-commands'

/**
 * ADR-0040 ticket A1b — the action bar's drawn verbs, made real.
 *
 * The fixture below is written the way the owner writes: NO blank lines between blocks. That is the
 * case ADR-0039 exists for and the one the old paragraph rule got wrong, so every block claim here
 * is made against it rather than against double-spaced prose.
 */
const RIVER = 'The river rose overnight.\nIt took the low field first.\nThen the lane.'

function run(command: StateCommand, doc: string, anchor: number, head?: number): { doc: string; handled: boolean } {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head ?? anchor) })
  const handled = command({ state, dispatch: (tr) => { state = tr.state } })
  return { doc: state.doc.toString(), handled }
}

/** Apply a command twice over the same span. A toggle must land back on the original bytes. */
function roundTrip(command: StateCommand, doc: string, anchor: number, head?: number): { once: string; twice: string } {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head ?? anchor) })
  command({ state, dispatch: (tr) => { state = tr.state } })
  const once = state.doc.toString()
  command({ state, dispatch: (tr) => { state = tr.state } })
  return { once, twice: state.doc.toString() }
}

const at = (doc: string, needle: string): number => doc.indexOf(needle)
const spanning = (doc: string, from: string, to: string): [number, number] => [doc.indexOf(from), doc.indexOf(to) + to.length]

// ---- the caret's block, and only it ------------------------------------------------------------

test('a list verb marks the caret’s block and leaves its unmarked neighbours byte-identical', () => {
  const result = run(toggleBulletList, RIVER, at(RIVER, 'It took') + 3)
  expect(result.handled).toBe(true)
  expect(result.doc).toBe('The river rose overnight.\n- It took the low field first.\nThen the lane.')
  // The lines the writer did not select are untouched, character for character.
  expect(result.doc.split('\n')[0]).toBe('The river rose overnight.')
  expect(result.doc.split('\n')[2]).toBe('Then the lane.')
})

test('a multi-block selection marks every block it touches — no blank lines needed to separate them', () => {
  const [from, to] = spanning(RIVER, 'The river', 'low field first.')
  expect(run(toggleBulletList, RIVER, from, to).doc)
    .toBe('- The river rose overnight.\n- It took the low field first.\nThen the lane.')
  expect(blocksForSelection(EditorState.create({ doc: RIVER, selection: EditorSelection.single(from, to) })))
    .toHaveLength(2)
})

test('the numbered list numbers the selected blocks in document order', () => {
  expect(run(toggleOrderedList, RIVER, 0, RIVER.length).doc)
    .toBe('1. The river rose overnight.\n2. It took the low field first.\n3. Then the lane.')
})

test('a selection ending exactly at the next block’s first character does not mark that block', () => {
  const to = at(RIVER, 'It took')
  expect(run(toggleBulletList, RIVER, 0, to).doc)
    .toBe('- The river rose overnight.\nIt took the low field first.\nThen the lane.')
})

// ---- toggles round-trip to the exact prior bytes -------------------------------------------------

test('every block toggle returns the original bytes when applied twice', () => {
  for (const [name, command] of [['bullet', toggleBulletList], ['ordered', toggleOrderedList], ['quote', toggleBlockquote]] as const) {
    const trip = roundTrip(command, RIVER, 0, RIVER.length)
    expect(trip.once, name).not.toBe(RIVER)
    expect(trip.twice, name).toBe(RIVER)
  }
})

test('a toggle applied to text that already carries the mark strips it and puts it back', () => {
  const marked = '- alpha\n- bravo'
  const trip = roundTrip(toggleBulletList, marked, 0, marked.length)
  expect(trip.once).toBe('alpha\nbravo')
  expect(trip.twice).toBe(marked)
})

test('strikethrough round-trips and is not confused by a longer run of its own character', () => {
  const trip = roundTrip(toggleStrikethrough, 'alpha bravo charlie', 6, 11)
  expect(trip.once).toBe('alpha ~~bravo~~ charlie')
  expect(trip.twice).toBe('alpha bravo charlie')
  // `~~~` is not a strikethrough pair, so the command wraps rather than unwrapping it.
  expect(run(toggleStrikethrough, '~~~bravo~~~', 3, 8).doc).toBe('~~~~~bravo~~~~~')
})

test('the blockquote nests rather than replacing what it quotes', () => {
  const list = '- alpha\n- bravo'
  const trip = roundTrip(toggleBlockquote, list, 0, list.length)
  expect(trip.once).toBe('> - alpha\n> - bravo')
  expect(trip.twice).toBe(list)
})

test('a list verb replaces the block mark that was there, never stacking two of them', () => {
  expect(run(toggleBulletList, '## The river\n1. alpha', 0, 20).doc).toBe('- The river\n- alpha')
})

test('indentation is the writer’s and survives every verb', () => {
  expect(run(toggleBulletList, '    alpha', 4).doc).toBe('    - alpha')
  expect(run(makePlainParagraph, '    - alpha', 6).doc).toBe('    alpha')
})

// ---- the pilcrow -------------------------------------------------------------------------------

test('plain paragraph strips every block mark and changes nothing when applied again', () => {
  const marked = '### The river\n- alpha\n1. bravo\n> charlie'
  const trip = roundTrip(makePlainParagraph, marked, 0, marked.length)
  expect(trip.once).toBe('The river\nalpha\nbravo\ncharlie')
  expect(trip.twice).toBe(trip.once) // idempotent, not a toggle
})

test('plain paragraph over unmarked prose reports that it changed nothing', () => {
  expect(run(makePlainParagraph, RIVER, 0, RIVER.length).handled).toBe(false)
})

// ---- one undo step -----------------------------------------------------------------------------

test('one verb is one history event: undo restores the exact prior bytes in a single step', () => {
  let state = EditorState.create({
    doc: RIVER,
    selection: EditorSelection.single(0, RIVER.length),
    extensions: [history(), keymap.of(historyKeymap)],
  })
  const apply = (tr: Transaction): void => { state = tr.state }
  toggleOrderedList({ state, dispatch: apply })
  expect(state.doc.toString()).not.toBe(RIVER)
  undo({ state, dispatch: apply })
  expect(state.doc.toString()).toBe(RIVER)
})

// ---- the blank line ----------------------------------------------------------------------------

test('a caret on a blank line starts a list there rather than leaving the button dead', () => {
  const doc = 'The river rose overnight.\n\nThen the lane.'
  const result = run(toggleBulletList, doc, 26)
  expect(result.doc).toBe('The river rose overnight.\n- \nThen the lane.')
  // And it is still a toggle: pressing it again gives the blank line back exactly.
  expect(roundTrip(toggleBulletList, doc, 26).twice).toBe(doc)
})

// ---- the table verb is the menu’s own code ------------------------------------------------------

test('insert.table is a registered command that runs the Insert menu’s own insertion', () => {
  const command = registryCommand('insert.table')
  expect(command.surfaces).toContain('palette')
  expect(command.surfaces).toContain('menu')
  expect(typeof command.run).toBe('function')

  let state = EditorState.create({ doc: 'The river rose overnight.', selection: EditorSelection.cursor(25) })
  let focused = false
  const view = {
    get state() { return state },
    dispatch: (spec: Parameters<EditorView['dispatch']>[0]) => { state = state.update(spec as Parameters<EditorState['update']>[0]).state },
    focus: () => { focused = true },
  } as unknown as EditorView
  expect(insertTable(view)).toBe(true)
  expect(focused).toBe(true)
  // The table is the menu's table, and it landed on its own lines rather than glued to the prose.
  expect(state.doc.toString()).toBe(`The river rose overnight.\n\n${buildTable()}`)
})

// ---- the bar now matches the drawing -------------------------------------------------------------

test('every verb the bar draws is a registered, runnable command — all sixteen of them', () => {
  const runnableIds = new Set(commandRegistry.filter((command) => command.surfaces.includes('palette')).map((command) => command.id))
  // Undo and redo are App-side runners registered without a registry `run`; they are runnable rows.
  const appSide = new Set(['edit.undo', 'edit.redo', 'readAloud.start'])
  const drawn = DEFAULT_ACTION_BAR_GROUPS.flatMap((group) => group.entries.map((entry) => entry.commandId))
  const missing = drawn.filter((id) => !runnableIds.has(id) && !appSide.has(id))
  // EVERY drawn verb runs. The last one out was the aside group's message square: it named a
  // phantom `comment.add` and was dropped at render, and it now runs `edit.toggleComment`, the
  // `// ` line note the app already had.
  expect(missing).toEqual([])
  for (const id of ['edit.strikethrough', 'outline.makeParagraph', 'list.bullet', 'list.ordered', 'block.quote', 'insert.table', 'edit.toggleComment']) {
    expect(runnableIds.has(id), id).toBe(true)
  }
})

test('the new verbs ship keyless, palette-listed and on the ⌘/ sheet, so the chord sweep can place them later', () => {
  for (const id of ['edit.strikethrough', 'outline.makeParagraph', 'list.bullet', 'list.ordered', 'block.quote']) {
    const command = registryCommand(id)
    expect(command.keys, id).toBeUndefined()
    expect(command.surfaces, id).toContain('palette')
    expect(command.surfaces, id).toContain('sheet')
  }
})

// ---- the caret stays in the words ----------------------------------------------------------------

/**
 * THE 2026-09-12 DEFECT. The owner pressed the numbered-list button on an empty line, typed, and
 * the words landed in FRONT of the marker (`dsds1.`): the transaction rewrote the prefix and let
 * CodeMirror map the caret, and an insertion that starts exactly at the caret maps to the near side.
 *
 * The rule these guards hold is one rule for every block verb — the caret ends up in the WORDS,
 * never inside or in front of the punctuation the command just wrote.
 */

/** The document after a command, with `|` at the caret or `[...]` around a real selection. */
function caretAfter(command: StateCommand, doc: string, anchor: number, head?: number): string {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head ?? anchor) })
  command({ state, dispatch: (tr) => { state = tr.state } })
  const text = state.doc.toString()
  const { from, to } = state.selection.main
  return from === to
    ? `${text.slice(0, from)}|${text.slice(from)}`
    : `${text.slice(0, from)}[${text.slice(from, to)}]${text.slice(to)}`
}

/** Press the verb, then TYPE — the thing the owner actually did, and the only proof that matters. */
function typeAfter(command: StateCommand, doc: string, anchor: number, typed: string): string {
  let state = EditorState.create({ doc, selection: EditorSelection.cursor(anchor) })
  command({ state, dispatch: (tr) => { state = tr.state } })
  state = state.update(state.replaceSelection(typed)).state
  return state.doc.toString()
}

test('a list verb on an empty line leaves the caret after the marker, so the next keystroke is the item', () => {
  const doc = 'The river rose overnight.\n\nThen the lane.'
  expect(caretAfter(toggleOrderedList, doc, 26)).toBe('The river rose overnight.\n1. |\nThen the lane.')
  expect(caretAfter(toggleBulletList, doc, 26)).toBe('The river rose overnight.\n- |\nThen the lane.')
  // The defect as the owner met it: press, then type. Before the fix this read `dsds1. `.
  expect(typeAfter(toggleOrderedList, doc, 26, 'dsds')).toBe('The river rose overnight.\n1. dsds\nThen the lane.')
  expect(typeAfter(toggleBulletList, doc, 26, 'dsds')).toBe('The river rose overnight.\n- dsds\nThen the lane.')
})

test('a caret before the first character of a block ends up after the marker, not in front of it', () => {
  expect(caretAfter(toggleBulletList, 'alpha bravo', 0)).toBe('- |alpha bravo')
  expect(caretAfter(toggleBlockquote, 'alpha bravo', 0)).toBe('> |alpha bravo')
  // Indentation is the writer's, so the caret lands after the marker and inside the indent, at the
  // first letter — not back at column zero.
  expect(caretAfter(toggleBulletList, '    alpha', 4)).toBe('    - |alpha')
})

test('a caret in the middle of a word stays in that word, whichever verb runs', () => {
  expect(caretAfter(toggleBulletList, 'alpha bravo', 3)).toBe('- alp|ha bravo')
  expect(caretAfter(toggleOrderedList, 'alpha bravo', 3)).toBe('1. alp|ha bravo')
  expect(caretAfter(toggleBlockquote, 'alpha bravo', 3)).toBe('> alp|ha bravo')
  // Swapping one marker for another shifts the caret by the difference, no more.
  expect(caretAfter(toggleOrderedList, '- alpha bravo', 5)).toBe('1. alp|ha bravo')
})

test('stripping a marker leaves the caret in the words rather than sending it to column zero', () => {
  expect(caretAfter(toggleBulletList, '- alpha bravo', 5)).toBe('alp|ha bravo')
  expect(caretAfter(makePlainParagraph, '### The river', 8)).toBe('The |river')
  expect(caretAfter(toggleBlockquote, '> alpha', 4)).toBe('al|pha')
  // A caret standing inside the marker itself has no word to hold: it lands where the words begin.
  expect(caretAfter(toggleBulletList, '- alpha', 1)).toBe('|alpha')
})

test('a selection across blocks goes on covering the same text, not the markers written around it', () => {
  const [from, to] = spanning(RIVER, 'The river', 'low field first.')
  expect(caretAfter(toggleBulletList, RIVER, from, to))
    .toBe('- [The river rose overnight.\n- It took the low field first.]\nThen the lane.')
  // Dragged the other way, the same text stays covered.
  expect(caretAfter(toggleBulletList, RIVER, to, from))
    .toBe('- [The river rose overnight.\n- It took the low field first.]\nThen the lane.')
})

test('a selection ending at a line start does not swallow the marker added to that line', () => {
  // These lines are ONE block (ADR-0039), so the quote verb marks every one of them — and the
  // selection ends exactly where the second line's marker is inserted.
  const doc = '- alpha\nnext\nmore'
  expect(caretAfter(toggleBlockquote, doc, 4, 8)).toBe('> - al[pha\n]> next\n> more')
})

test('the caret rule costs no extra history step: one undo, and nothing left behind it', () => {
  const doc = 'The river rose overnight.\n\nThen the lane.'
  let state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(26),
    extensions: [history(), keymap.of(historyKeymap)],
  })
  const apply = (tr: Transaction): void => { state = tr.state }
  toggleOrderedList({ state, dispatch: apply })
  expect(state.doc.toString()).toBe('The river rose overnight.\n1. \nThen the lane.')
  expect(state.selection.main.head).toBe(29) // after the marker, which is what put a selection on the transaction

  undo({ state, dispatch: apply })
  expect(state.doc.toString()).toBe(doc)
  expect(state.selection.main.head).toBe(26) // the caret the writer had, restored by the same one step
  // A second press has nothing to undo — the selection did not become a history event of its own.
  expect(undo({ state, dispatch: apply })).toBe(false)
})
