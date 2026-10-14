import { expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { buildEditorChordKeymap } from '../../src/renderer/src/commands/chords'
import { outlineSelectionExtension, outlineSelectionField, runSectionAction, setOutlineSelection } from '../../src/renderer/src/editor/outline-selection'
import { commandRegistry } from '../../src/renderer/src/commands/registry'

/** A target the structure chords run against: the real keymap binding, the picked sections in the real field. */
function press(key: string, doc: string, picked: number[], cursor = 0): { doc: string; picked: number[] } {
  let state = EditorState.create({ doc, selection: { anchor: cursor }, extensions: [outlineSelectionExtension] })
  state = state.update({ effects: setOutlineSelection.of(picked) }).state
  const view = { get state() { return state }, dispatch(spec: unknown) { state = state.update(spec as never).state } } as unknown as EditorView
  const binding = buildEditorChordKeymap({}).find((entry) => entry.key === key)!
  ;(binding.run as (view: EditorView) => boolean)(view)
  return { doc: state.doc.toString(), picked: state.field(outlineSelectionField) }
}

const DOC = '# P\np\n# S1\ns1\n# S2\ns2\n# X\nx\n'
const picks = [DOC.indexOf('# S1'), DOC.indexOf('# S2')]

test('⌥⌘↓ with several sections picked moves them together and keeps them picked', () => {
  const result = press('Alt-Mod-ArrowDown', DOC, picks)
  expect(result.doc).toBe('# P\np\n# X\nx\n# S1\ns1\n# S2\ns2\n')
  expect(result.picked.map((from) => result.doc.slice(from, from + 4))).toEqual(['# S1', '# S2'])
})

test('⌥⌘↑ moves picked sections up; with one or none picked the single-heading command runs', () => {
  expect(press('Alt-Mod-ArrowUp', DOC, picks).doc).toBe('# S1\ns1\n# S2\ns2\n# P\np\n# X\nx\n')
  expect(press('Alt-Mod-ArrowDown', '# One\none\n# Two\ntwo', [], 0).doc).toBe('one\n# One\n# Two\ntwo')
})

test('⌥⌘← and ⌥⌘→ promote and demote every picked section with what is under it', () => {
  const doc = '## A\n### A1\n## B\n'
  const both = [0, doc.indexOf('## B')]
  expect(press('Alt-Mod-ArrowRight', doc, both).doc).toBe('### A\n#### A1\n### B\n')
  expect(press('Alt-Mod-ArrowLeft', doc, both).doc).toBe('# A\n## A1\n# B\n')
})

test('the picks follow edits made while they are held, and a stale pick is dropped by the next effect', () => {
  let state = EditorState.create({ doc: '# A\n# B\n', extensions: [outlineSelectionExtension] })
  state = state.update({ effects: setOutlineSelection.of([4]) }).state
  state = state.update({ changes: { from: 0, insert: 'intro\n' } }).state
  expect(state.field(outlineSelectionField)).toEqual([10])
  state = state.update({ effects: setOutlineSelection.of([]) }).state
  expect(state.field(outlineSelectionField)).toEqual([])
})

test('one transaction: a section action is a single undo step', () => {
  let transactions = 0
  const state = EditorState.create({ doc: DOC, extensions: [outlineSelectionExtension] })
  const target = { state, dispatch: () => { transactions += 1 } }
  runSectionAction(target, 'moveDown', picks, true)
  runSectionAction(target, 'delete', picks, false)
  expect(transactions).toBe(2)
})

test('every outline extra is a keyless palette command, so the right-click menu is reachable without the mouse', () => {
  const ids = ['outline.newHeadingBefore', 'outline.newSubheading', 'outline.expandAll', 'outline.collapseAll', 'outline.showAllLevels', 'outline.toggleWordCounts', ...[1, 2, 3, 4, 5, 6].map((n) => `outline.showLevel${n}`)]
  for (const id of ids) {
    const command = commandRegistry.find((entry) => entry.id === id)
    expect(command, id).toBeDefined()
    expect(command!.surfaces, id).toContain('palette')
    expect(command!.keys, id).toBeUndefined()
  }
  // the menu's other items are existing commands
  for (const id of ['heading.decrease', 'heading.increase', 'outline.moveSubtreeUp', 'outline.moveSubtreeDown', 'outline.selectCurrentSection', 'outline.deleteCurrentSection']) {
    expect(commandRegistry.some((entry) => entry.id === id), id).toBe(true)
  }
})
