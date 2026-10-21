import { describe, expect, test } from 'bun:test'
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import { composeCommands, deleteBlock } from '../../src/renderer/src/editor/block-actions'
import { makePlainParagraph } from '../../src/renderer/src/editor/block-marks'
import { registryCommand } from '../../src/renderer/src/commands/registry'
import { LAYOUTS, type ChildItem, type LayoutItem } from '../../src/renderer/src/commands/actions-layout'

// The logic of tests/e2e/actions-here-text-commands.spec.ts without Electron: the same chapter, the same
// carets, the same commands the menu rows run, one session carried from step to step so the undo steps
// count as they did in the app. (Which rows the menu shows is the layout data; what a row does is its command.)
const DOC = `# Up on the wold

## The wall builders

Every wall up here was built by hand, stone by stone, without mortar.

A second paragraph that comes after it.

> A quoted line.

## Weather

- first item
  - a child
- second item
`
const SENTENCE = 'Every wall up here was built by hand, stone by stone, without mortar.'

/** A document the commands act on, undo included; each transaction is its own history group (the app's clicks are seconds apart). */
function session(doc: string) {
  let state = EditorState.create({ doc, extensions: [history({ newGroupDelay: 0 })] })
  const api = {
    get text(): string { return state.doc.toString() },
    get anchor(): number { return state.selection.main.anchor },
    caretIn(text: string, offset = 0): void { state = state.update({ selection: EditorSelection.cursor(state.doc.toString().indexOf(text) + offset) }).state },
    select(from: number, to: number): void { state = state.update({ selection: EditorSelection.range(from, to) }).state },
    run(command: StateCommand): boolean { return command({ state, dispatch: (tr) => { state = tr.state } }) },
    undo(): void { undo({ state, dispatch: (tr) => { state = tr.state } }) },
  }
  return api
}
const command = (id: string): StateCommand => registryCommand(id).run as StateCommand
const count = (text: string, needle: string): number => text.split(needle).length - 1

const labelsOf = (children: readonly ChildItem[]): string[] => children.flatMap((kid) => (kid.kind === 'sep' ? [] : [kid.label]))
const openerChildren = (place: keyof typeof LAYOUTS, label: string): string[] => {
  const opener = LAYOUTS[place].find((item: LayoutItem) => item.kind === 'opener' && item.label === label)
  if (!opener || opener.kind !== 'opener') throw new Error(`no ${label} opener at ${place}`)
  return labelsOf(opener.children)
}
const rowLabels = (place: keyof typeof LAYOUTS): string[] => LAYOUTS[place].flatMap((item) => (item.kind === 'sep' || item.kind === 'strip' ? [] : [item.label]))

describe('the drawn rows the e2e spec read off the menu', () => {
  test('a paragraph offers Insert object…, Format, Turn into…, Move block, Duplicate block, Delete block, Comment, Ask, Read aloud', () => {
    expect(rowLabels('paragraph').filter((label) => !label.startsWith('Ask'))).toEqual(
      ['Insert object…', 'Format', 'Turn into…', 'Move block', 'Duplicate block', 'Delete block', 'Comment', 'Read aloud from here'])
    expect(rowLabels('paragraph').some((label) => label.startsWith('Ask the agent'))).toBe(true)
  })
  test('Turn into… at a paragraph lists the eight targets in order, Paragraph being the "now" tag', () => {
    expect(openerChildren('paragraph', 'Turn into…')).toEqual(['Paragraph', 'Heading', 'Heading, one deeper', 'Bullet list', 'Numbered list', 'Task list', 'Quotation', 'Code block'])
  })
  test('Turn into… at a quotation lists Paragraph first and Quotation last', () => {
    expect(openerChildren('quotation', 'Turn into…')).toEqual(['Paragraph', 'Heading', 'Bullet list', 'Numbered list', 'Task list', 'Code block', 'Quotation'])
  })
  test('Format lists seven marks, ending in Clear formatting', () => {
    expect(openerChildren('paragraph', 'Format')).toEqual(['Bold', 'Italic', 'Strikethrough', 'Mark', 'Inline code', 'Link', 'Clear formatting'])
  })
  test('Duplicate block carries ⇧⌘D', () => {
    expect(registryCommand('block.duplicate').keys).toBe('Shift-Mod-d')
  })
})

describe('on the chapter', () => {
  test('a paragraph into a task list and back to a paragraph, one undo step each', () => {
    const s = session(DOC)
    s.caretIn('A second paragraph')
    expect(s.run(command('turn.taskList'))).toBe(true)
    expect(s.text).toContain('\n- [ ] A second paragraph that comes after it.\n')
    expect(s.run(command('outline.makeParagraph'))).toBe(true)
    expect(s.text).toContain('\nA second paragraph that comes after it.\n')
    expect(s.text).not.toContain('- [ ]')
    s.undo()
    expect(s.text).toContain('- [ ] A second paragraph')
    s.undo()
    expect(s.text).not.toContain('- [ ]')
    expect(s.text).toBe(DOC)
  })

  test('Duplicate block then Delete block; the chord ⇧⌘D duplicates again', () => {
    const s = session(DOC)
    s.caretIn('Every wall up here')
    expect(s.run(command('block.duplicate'))).toBe(true)
    expect(count(s.text, SENTENCE)).toBe(2)
    // The caret is in the copy: Delete block removes the copy and leaves the original.
    expect(s.run(deleteBlock)).toBe(true)
    expect(count(s.text, SENTENCE)).toBe(1)
    expect(s.text).toContain(`${SENTENCE}\n\nA second paragraph`)
    s.undo()
    expect(count(s.text, SENTENCE)).toBe(2)
    expect(s.run(command('block.duplicate'))).toBe(true) // what Shift-Mod-d runs
    expect(count(s.text, SENTENCE)).toBe(3)
  })

  test('Bold on a selection, Clear formatting, then Inline code', () => {
    const s = session(DOC)
    const from = DOC.indexOf('stone by stone')
    s.select(from, from + 14)
    expect(s.run(command('edit.bold'))).toBe(true)
    expect(s.text).toContain('**stone by stone**')
    // Clear formatting takes it off again (the marks flanking the selection belong to it).
    s.select(from + 2, from + 2 + 14)
    expect(s.run(command('edit.clearFormatting'))).toBe(true)
    expect(s.text).toContain('built by hand, stone by stone, without mortar.')
    expect(s.text).not.toContain('**')
    s.select(from, from + 14)
    expect(s.run(command('edit.inlineCode'))).toBe(true)
    expect(s.text).toContain('built by hand, `stone by stone`, without mortar.')
  })

  test('a quotation turns into a bullet list in one step; a list item deletes with its children', () => {
    const s = session(DOC)
    s.caretIn('A quoted line')
    expect(s.run(composeCommands(makePlainParagraph, command('list.bullet'), { wholeBlock: true }))).toBe(true)
    expect(s.text).toContain('\n- A quoted line.\n')
    expect(s.text).not.toContain('> A quoted line')
    s.undo()
    expect(s.text).toContain('> A quoted line.')
    s.caretIn('first item')
    expect(s.run(deleteBlock)).toBe(true)
    expect(s.text).not.toContain('first item')
    expect(s.text).not.toContain('a child')
    expect(s.text).toContain('- second item')
  })
})
