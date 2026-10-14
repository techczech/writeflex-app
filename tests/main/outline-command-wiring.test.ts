import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import { cursorDocEnd, cursorDocStart, defaultKeymap, selectDocEnd, selectDocStart, selectLineBoundaryLeft, selectLineBoundaryRight } from '@codemirror/commands'
import { Direction, type EditorView } from '@codemirror/view'
import { allBindableCommands, commandRegistry } from '../../src/renderer/src/commands/registry'
import { conflictsFor } from '../../src/renderer/src/commands/chords'

const OUTLINE_COMMANDS = [
  ['outline.moveBlockUp', 'Move this block up', '⌥⌘↑'],
  ['outline.moveBlockDown', 'Move this block down', '⌥⌘↓'],
  ['outline.moveSubtreeUp', 'Move this with everything under it up', '⇧⌥⌘↑'],
  ['outline.moveSubtreeDown', 'Move this with everything under it down', '⇧⌥⌘↓'],
  ['heading.decrease', 'Raise the level of this line', '⌥⌘←'],
  ['heading.increase', 'Lower the level of this line', '⌥⌘→'],
  ['outline.raiseSubtreeLevel', 'Raise the level with everything under it', '⇧⌥⌘←'],
  ['outline.lowerSubtreeLevel', 'Lower the level with everything under it', '⇧⌥⌘→'],
  ['outline.makeHeadingAtSurroundingLevel', 'Make this line a heading at the surrounding level', '⌃⌘M'],
  ['outline.makeHeadingOneLevelDeeper', 'Make this line a heading one level deeper', '⌃⇧⌘M'],
  ['outline.previousHeading', 'Previous heading', '⌃⌘['],
  ['outline.nextHeading', 'Next heading', '⌃⌘]'],
  ['outline.deleteCurrentSection', 'Delete this section', '⌃⌘⌫'],
  ['outline.selectCurrentSection', 'Select this section', '⌃⌘A'],
  ['outline.indentListItem', 'Indent list item with children', '⇥'],
  ['outline.outdentListItem', 'Outdent list item with children', '⇧⇥'],
] as const

const HEADING_LEVEL_COMMANDS = Array.from({ length: 6 }, (_, index) => [
  `outline.makeHeadingLevel${index + 1}`,
  `Insert heading, level ${index + 1}`,
  `⌃⌘${index + 1}`,
] as const)

const SELECTION_COMMANDS = [
  ['selection.lineStart', 'Select to the start of the line', '⇧⌘←', selectLineBoundaryLeft, { from: 6, to: 9 }],
  ['selection.lineEnd', 'Select to the end of the line', '⇧⌘→', selectLineBoundaryRight, { from: 9, to: 12 }],
  ['selection.documentStart', 'Select to the start of the document', '⇧⌘↑', selectDocStart, { from: 0, to: 9 }],
  ['selection.documentEnd', 'Select to the end of the document', '⇧⌘↓', selectDocEnd, { from: 9, to: 13 }],
] as const

const FOLD_COMMANDS = [
  ['fold.current', 'Fold Current Heading', ['⌘8', '⌃⇧[']],
  ['fold.all', 'Fold All Headings', ['⌘9', '⌃⇧]']],
  ['fold.none', 'Unfold All', '⌃⌘0'],
] as const

test('outline commands are palette-surfaced, sheet-generated, bindable, and use the fixed defaults', () => {
  const bindable = new Set(allBindableCommands().map((command) => command.id))
  const sheetIds = commandRegistry.filter((command) => command.surfaces.includes('sheet')).map((command) => command.id)
  for (const [id, label, keys] of [...OUTLINE_COMMANDS, ...HEADING_LEVEL_COMMANDS]) {
    const command = commandRegistry.find((entry) => entry.id === id)
    expect(command, id).toMatchObject({ label, group: id.endsWith('Heading') ? 'Navigation' : 'Writing' })
    expect(command?.keys, id).toEqual(keys)
    expect(command?.surfaces, id).toEqual(['palette', 'sheet'])
    expect(typeof command?.run, id).toBe('function')
    expect(bindable.has(id), id).toBe(true)
    expect(sheetIds.filter((sheetId) => sheetId === id), id).toEqual([id])
  }
})

test('fold commands keep their defaults, add the TalkWeaver aliases, and come from registry rows', () => {
  const bindable = new Set(allBindableCommands().map((command) => command.id))
  for (const [id, label, keys] of FOLD_COMMANDS) {
    const command = commandRegistry.find((entry) => entry.id === id)
    expect(command, id).toMatchObject({ label, group: 'Writing' })
    expect(command?.keys, id).toEqual(keys)
    expect(command?.surfaces, id).toEqual(['palette', 'sheet'])
    expect(command?.sheetColumn, id).toBe(1)
    expect(typeof command?.run, id).toBe('function')
    expect(bindable.has(id), id).toBe(true)
  }
})

test('the fixed outline defaults do not collide with another command', () => {
  for (const [id, , keys] of [...OUTLINE_COMMANDS, ...HEADING_LEVEL_COMMANDS]) {
    if (!keys) continue
    for (const chord of Array.isArray(keys) ? keys : [keys]) {
      expect(conflictsFor(chord, id, {}), `${id}: ${chord}`).toEqual([])
    }
  }
})

test('the standard macOS selection actions are palette-surfaced, bindable, and select ordinary prose', () => {
  const bindable = new Set(allBindableCommands().map((command) => command.id))
  for (const [id, label, keys, codeMirrorCommand, expectedRange] of SELECTION_COMMANDS) {
    const command = commandRegistry.find((entry) => entry.id === id)
    expect(command, id).toMatchObject({ label, keys, group: 'Writing' })
    expect(command?.surfaces, id).toEqual(['palette', 'sheet'])
    expect(command?.run, id).toBe(codeMirrorCommand)
    expect(bindable.has(id), id).toBe(true)
    const result = runSelection(command!.run!, 'first\nsecond\n', 9)
    expect({ from: result.state.selection.main.from, to: result.state.selection.main.to }, id).toEqual(expectedRange)
  }
})

test('the retired static heading shifter no longer claims Control-Command brackets', () => {
  const source = readFileSync(new URL('../../src/renderer/src/editor/heading-shifter.ts', import.meta.url), 'utf8')
  expect(source).not.toContain("key: 'Ctrl-Mod-['")
  expect(source).not.toContain("key: 'Ctrl-Mod-]'")
})

test('table cells keep contextual Shift-Command arrow precedence', () => {
  const source = readFileSync(new URL('../../src/renderer/src/editor/object-editors/table-editor.ts', import.meta.url), 'utf8')
  expect(source).toContain('const modMove = event.shiftKey && event.metaKey')
  expect(source).toContain("if (modMove && (event.key === 'ArrowLeft' || event.key === 'ArrowRight'))")
  expect(source).toContain("if (modMove && (event.key === 'ArrowUp' || event.key === 'ArrowDown'))")
})

function run(command: StateCommand, doc: string, cursor: number): { handled: boolean; state: EditorState } {
  let state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) })
  const handled = command({ state, dispatch: (transaction) => { state = transaction.state } })
  return { handled, state }
}

function runSelection(command: NonNullable<(typeof commandRegistry)[number]['run']>, doc: string, cursor: number): { handled: boolean; state: EditorState } {
  let state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) })
  const view = {
    get state() { return state },
    dispatch(transaction: { state?: EditorState }) {
      if (!transaction.state) throw new Error('Selection command did not dispatch a transaction')
      state = transaction.state
    },
    textDirectionAt: () => Direction.LTR,
    lineBlockAt(position: number) {
      const line = state.doc.lineAt(position)
      return { from: line.from, to: line.to, length: line.length }
    },
    moveToLineBoundary(range: { head: number }, forward: boolean) {
      const line = state.doc.lineAt(range.head)
      return EditorSelection.cursor(forward ? line.to : line.from)
    },
  } as unknown as EditorView
  const handled = (command as (editorView: EditorView) => boolean)(view)
  return { handled, state }
}

test('Tab and Shift-Tab outline commands decline outside a list', () => {
  const indent = commandRegistry.find((entry) => entry.id === 'outline.indentListItem')?.run
  const outdent = commandRegistry.find((entry) => entry.id === 'outline.outdentListItem')?.run
  expect(indent).toBeDefined()
  expect(outdent).toBeDefined()
  expect(run(indent!, 'plain paragraph\n', 4)).toMatchObject({ handled: false })
  expect(run(outdent!, 'plain paragraph\n', 4)).toMatchObject({ handled: false })
})

test('Command-Up and Command-Down are left to CodeMirror document navigation', () => {
  const source = readFileSync(new URL('../../src/renderer/src/editor/live-preview.ts', import.meta.url), 'utf8')
  expect(source).not.toContain("{ key: 'Mod-ArrowDown', run: (view) => jump(view, 'heading', 1) }")
  expect(source).not.toContain("{ key: 'Mod-ArrowUp', run: (view) => jump(view, 'heading', -1) }")

  const start = defaultKeymap.find((binding) => binding.mac === 'Cmd-ArrowUp')
  const end = defaultKeymap.find((binding) => binding.mac === 'Cmd-ArrowDown')
  expect(start?.run).toBe(cursorDocStart)
  expect(end?.run).toBe(cursorDocEnd)

  expect(run(start!.run!, 'first\nsecond\n', 9).state.selection.main.head).toBe(0)
  expect(run(end!.run!, 'first\nsecond\n', 2).state.selection.main.head).toBe(13)
})
