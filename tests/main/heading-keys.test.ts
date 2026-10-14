import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { buildEditorChordKeymap, defaultChords, sheetChordClaims } from '../../src/renderer/src/commands/chords'
import { cheatSheetColumns, commandRegistry } from '../../src/renderer/src/commands/registry'

/**
 * Ticket 16: ⌥⌘ + arrows move and re-level headings, ⇧ takes the subtree (the TalkWeaver set).
 * The keymap is the one the editor installs, so these press the chord through the keymap binding
 * and read the document, not the registry row.
 */

function press(key: string, doc: string, cursor: number): string {
  let state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor) })
  const view = { get state() { return state }, dispatch(spec: { state?: EditorState }) { if (spec.state) state = spec.state } } as unknown as EditorView
  const binding = buildEditorChordKeymap({}).find((entry) => entry.key === key)
  expect(binding, key).toBeDefined()
  const run = binding!.run as (view: EditorView) => boolean
  run(view)
  return state.doc.toString()
}

test('⌥⌘↓ moves the heading section down', () => {
  expect(press('Alt-Mod-ArrowDown', '# One\none\n# Two\ntwo', 0)).toBe('one\n# One\n# Two\ntwo')
})

test('⇧⌥⌘↓ moves the heading with everything under it', () => {
  expect(press('Shift-Alt-Mod-ArrowDown', '# One\nbody\n## Child\nchild\n# Two\nlast', 0)).toBe('# Two\nlast\n# One\nbody\n## Child\nchild')
})

test('⌥⌘→ lowers one heading and ⇧⌥⌘→ lowers it with its subtree', () => {
  expect(press('Alt-Mod-ArrowRight', '# One\n## Child\n', 0)).toBe('## One\n## Child\n')
  expect(press('Shift-Alt-Mod-ArrowRight', '# One\n## Child\n', 0)).toBe('## One\n### Child\n')
})

test('⌥⌘← raises a heading', () => {
  expect(press('Alt-Mod-ArrowLeft', '## One\n', 0)).toBe('# One\n')
})

test('the displaced rendered-block and link-trail navigation sit on the freed ⌃⌘ arrows and are not editor keymap entries', () => {
  const chords = (id: string) => defaultChords(commandRegistry.find((command) => command.id === id)!)
  expect(chords('navigation.nextBlock')).toEqual(['⌃⌘↓'])
  expect(chords('navigation.previousBlock')).toEqual(['⌃⌘↑'])
  expect(chords('navigation.linkTrailBack')).toEqual(['⌃⌘←'])
  expect(chords('navigation.linkTrailForward')).toEqual(['⌃⌘→'])
  const keys = buildEditorChordKeymap({}).map((binding) => binding.key)
  for (const key of ['Ctrl-Mod-ArrowUp', 'Ctrl-Mod-ArrowDown', 'Ctrl-Mod-ArrowLeft', 'Ctrl-Mod-ArrowRight']) expect(keys).not.toContain(key)
})

test('no raw ⌥⌘-arrow handler remains in the app or the live-preview keymap', () => {
  const app = readFileSync(new URL('../../src/renderer/src/app/App.tsx', import.meta.url), 'utf8')
  const preview = readFileSync(new URL('../../src/renderer/src/editor/live-preview.ts', import.meta.url), 'utf8')
  expect(preview).not.toContain("'Alt-Mod-ArrowDown'")
  expect(preview).not.toContain("'Alt-Mod-ArrowUp'")
  expect(app).not.toContain("e.code === 'ArrowLeft' || e.code === 'ArrowRight'")
})

test('the cheat sheet shows the new chords and every chord has one claimant', () => {
  const rows = cheatSheetColumns.flat().flatMap((group) => group.rows)
  const keysOf = (label: string) => rows.find((row) => row.label === label)?.keys
  expect(keysOf('Move this block up')).toBe('⌥⌘↑')
  expect(keysOf('Lower the level with everything under it')).toBe('⇧⌥⌘→')
  for (const [chord, labels] of sheetChordClaims({})) expect(labels.size, `${chord}: ${[...labels].join(', ')}`).toBe(1)
})
