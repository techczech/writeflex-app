import { describe, expect, test } from 'bun:test'
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import { makePlainParagraph, makeTaskList } from '../../src/renderer/src/editor/block-marks'
import { clearFormatting, clearInlineMarks, composeCommands, deleteBlock, duplicateBlock, turnIntoCodeBlock, turnIntoTable } from '../../src/renderer/src/editor/block-actions'
import { toggleInlineCode } from '../../src/renderer/src/editor/commands'
import { makeHeadingAtSurroundingLevel } from '@bridle/outline'
import { registryCommand } from '../../src/renderer/src/commands/registry'
import { toggleBulletList } from '../../src/renderer/src/editor/block-marks'

// Actions here menu, ticket 02: each new text command is one transaction (one undo step) with a defined caret.
type Result = { doc: string; handled: boolean; anchor: number; head: number; undone: string; steps: number }

function run(command: StateCommand, doc: string, anchor: number, head?: number): Result {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head ?? anchor), extensions: [history()] })
  let steps = 0
  const handled = command({ state, dispatch: (tr) => { steps += 1; state = tr.state } })
  const after = state
  let back = state
  undo({ state: back, dispatch: (tr) => { back = tr.state } })
  return { doc: after.doc.toString(), handled, anchor: after.selection.main.anchor, head: after.selection.main.head, undone: back.doc.toString(), steps }
}
/** Run with the caret where `|` stands in the text (and a selection to a second `|`, if there is one). */
function at(command: StateCommand, marked: string): Result {
  const first = marked.indexOf('|')
  const second = marked.indexOf('|', first + 1)
  const doc = marked.replace(/\|/g, '')
  return run(command, doc, first, second === -1 ? first : second - 1)
}
const undoes = (result: Result, original: string): void => { expect(result.undone).toBe(original) }

describe('block.duplicate', () => {
  test('a paragraph is copied after itself as a block of its own, the caret in the copy at the same place', () => {
    const result = at(duplicateBlock, 'One\n\nTwo wor|ds here\n\nThree')
    expect(result.doc).toBe('One\n\nTwo words here\n\nTwo words here\n\nThree')
    expect(result.anchor).toBe('One\n\nTwo words here\n\nTwo wor'.length)
    expect(result.steps).toBe(1)
    undoes(result, 'One\n\nTwo words here\n\nThree')
  })
  test('a list item is copied with its children, as the next sibling', () => {
    const result = at(duplicateBlock, '- a|\n  - a1\n  - a2\n- b')
    expect(result.doc).toBe('- a\n  - a1\n  - a2\n- a\n  - a1\n  - a2\n- b')
    undoes(result, '- a\n  - a1\n  - a2\n- b')
  })
  test('a child item is copied alone', () => {
    expect(at(duplicateBlock, '- a\n  - a|1\n- b').doc).toBe('- a\n  - a1\n  - a1\n- b')
  })
  test('a task item and a quotation', () => {
    expect(at(duplicateBlock, '- [ ] t|ask\n- other').doc).toBe('- [ ] task\n- [ ] task\n- other')
    expect(at(duplicateBlock, '> a quo|te\n> second line\n\nafter').doc).toBe('> a quote\n> second line\n\n> a quote\n> second line\n\nafter')
  })
  test('the last block of a file without a final newline, and an empty document', () => {
    expect(at(duplicateBlock, 'First\n\nLas|t').doc).toBe('First\n\nLast\n\nLast')
    expect(at(duplicateBlock, '|').handled).toBe(false)
  })
  test('a selection spanning blocks copies from the first block to the last', () => {
    expect(at(duplicateBlock, 'A\n\nB|b\n\nC|c\n\nD').doc).toBe('A\n\nBb\n\nCc\n\nBb\n\nCc\n\nD')
  })
  test('the metadata is not a block to duplicate', () => {
    expect(at(duplicateBlock, '---\ntitle: x|\n---\n\nBody').doc).not.toBe('---\ntitle: x\n---\n\n---\ntitle: x\n---\n\nBody')
  })
})

describe('block.delete at prose', () => {
  test('a paragraph between two others goes with the blank line after it', () => {
    const result = at(deleteBlock, 'One\n\nTw|o\n\nThree')
    expect(result.doc).toBe('One\n\nThree')
    expect(result.anchor).toBe('One\n\n'.length)
    expect(result.steps).toBe(1)
    undoes(result, 'One\n\nTwo\n\nThree')
  })
  test('a list item goes with its children and leaves the neighbours a list', () => {
    expect(at(deleteBlock, '- a\n- b|\n  - b1\n- c').doc).toBe('- a\n- c')
    expect(at(deleteBlock, '- a|\n  - a1\n- b').doc).toBe('- b')
  })
  test('the last item of a list before a paragraph keeps the blank line between them', () => {
    expect(at(deleteBlock, '- a\n- b|\n\nPara').doc).toBe('- a\n\nPara')
  })
  test('the last block, the only block, and a quotation', () => {
    expect(at(deleteBlock, 'One\n\nTw|o').doc).toBe('One')
    expect(at(deleteBlock, 'Only| one').doc).toBe('')
    expect(at(deleteBlock, 'One\n\n> quo|te\n> more\n\nTwo').doc).toBe('One\n\nTwo')
  })
  test('an empty document has nothing to delete', () => {
    expect(at(deleteBlock, '|').handled).toBe(false)
  })
})

describe('edit.inlineCode', () => {
  test('wraps a selection and unwraps it again', () => {
    const wrapped = at(toggleInlineCode, 'use the |flag| now')
    expect(wrapped.doc).toBe('use the `flag` now')
    expect(wrapped.steps).toBe(1)
    undoes(wrapped, 'use the flag now')
    expect(at(toggleInlineCode, 'use the `|flag|` now').doc).toBe('use the flag now')
  })
  test('a bare caret wraps the word under it, and unwraps from inside', () => {
    expect(at(toggleInlineCode, 'use the fl|ag now').doc).toBe('use the `flag` now')
    expect(at(toggleInlineCode, 'use the `fl|ag` now').doc).toBe('use the flag now')
  })
  test('a caret between two code spans is outside both', () => {
    expect(at(toggleInlineCode, '`a` and| `b`').doc).toBe('`a` `and` `b`')
  })
  test('a caret on a space with no word inserts an empty pair with the caret inside', () => {
    const result = at(toggleInlineCode, 'a | b')
    expect(result.doc).toBe('a `` b')
    expect(result.anchor).toBe(3)
  })
})

describe('edit.clearFormatting', () => {
  test('the marks come off the selection and nothing else', () => {
    const result = at(clearFormatting, '|**bold** and *it* and ~~gone~~ and ==marked== and `code`| rest **keep**')
    expect(result.doc).toBe('bold and it and gone and marked and code rest **keep**')
    expect(result.steps).toBe(1)
    undoes(result, '**bold** and *it* and ~~gone~~ and ==marked== and `code` rest **keep**')
  })
  test('with no selection the whole block is cleared; block type, links and words stay', () => {
    expect(at(clearFormatting, '## A **big** [**link**](https://a.test/x==y) he|re').doc).toBe('## A big [link](https://a.test/x==y) here')
    expect(at(clearFormatting, '- a **b|** c\n- **d**').doc).toBe('- a b c\n- **d**')
    expect(at(clearFormatting, '* **star** i|tem').doc).toBe('* star item')
  })
  test('markers flanking a selection belong to it', () => {
    expect(at(clearFormatting, 'a **|bold|** b').doc).toBe('a bold b')
  })
  test('arithmetic and code content are left alone, and nothing to clear is not handled', () => {
    expect(clearInlineMarks('2 * 3 = 6')).toBe('2 * 3 = 6')
    expect(clearInlineMarks('`a*b` and *c*')).toBe('a*b and c')
    expect(at(clearFormatting, 'plain te|xt').handled).toBe(false)
  })
})

describe('turn.taskList', () => {
  test('a paragraph becomes one unticked task, and undo is one step', () => {
    const result = at(makeTaskList, 'Buy| string')
    expect(result.doc).toBe('- [ ] Buy string')
    expect(result.anchor).toBe('- [ ] Buy'.length)
    expect(result.steps).toBe(1)
    undoes(result, 'Buy string')
  })
  test('a selection spanning paragraphs becomes one task each', () => {
    expect(at(makeTaskList, '|A\nB\n\nC| d').doc).toBe('- [ ] A\n- [ ] B\n\n- [ ] C d')
  })
  test('a bullet, a numbered item and a heading give up their marker; a task keeps its tick', () => {
    expect(at(makeTaskList, '- bu|llet').doc).toBe('- [ ] bullet')
    expect(at(makeTaskList, '1. num|ber').doc).toBe('- [ ] number')
    expect(at(makeTaskList, '## He|ad').doc).toBe('- [ ] Head')
    expect(at(makeTaskList, '- [x] do|ne').doc).toBe('- [x] done')
  })
  test('and back: Paragraph on a task item leaves no stray checkbox', () => {
    expect(at(makePlainParagraph, '- [ ] ta|sk').doc).toBe('task')
    expect(at(makePlainParagraph, '  - [x] ni|ne').doc).toBe('  nine')
  })
  test('an empty line gets an empty task', () => {
    expect(at(makeTaskList, '|').doc).toBe('- [ ] ')
  })
})

describe('turn.codeBlock', () => {
  test('a paragraph is fenced with its text unchanged, the caret at the start of the code', () => {
    const result = at(turnIntoCodeBlock, 'Before\n\nsome te|xt\n\nAfter')
    expect(result.doc).toBe('Before\n\n```\nsome text\n```\n\nAfter')
    expect(result.anchor).toBe('Before\n\n```\n'.length)
    expect(result.steps).toBe(1)
    undoes(result, 'Before\n\nsome text\n\nAfter')
  })
  test('selected paragraphs go in one fence', () => {
    expect(at(turnIntoCodeBlock, '|a\n\nb| c\n\nz').doc).toBe('```\na\n\nb c\n```\n\nz')
  })
  test('text that holds a fence gets a longer one', () => {
    expect(at(turnIntoCodeBlock, 'x ```y``` |z').doc).toBe('````\nx ```y``` z\n````')
  })
  test('an empty line gives an empty fence', () => {
    expect(at(turnIntoCodeBlock, '|').doc).toBe('```\n\n```')
  })
})

describe('turn.table', () => {
  test('a paragraph becomes the first cell of a 2 by 2 pipe table', () => {
    const result = at(turnIntoTable, 'Intro\n\nStone| wall\n\nOutro')
    expect(result.doc).toBe('Intro\n\n| Stone wall |  |\n| --- | --- |\n|  |  |\n\nOutro')
    expect(result.steps).toBe(1)
    undoes(result, 'Intro\n\nStone wall\n\nOutro')
  })
  test('selected tab-separated lines become rows, the first being the header', () => {
    expect(at(turnIntoTable, '|Stone\tCount\ncope\t12|').doc).toBe('| Stone | Count |\n| --- | --- |\n| cope | 12 |')
  })
  test('selected comma-separated lines become rows, padded to the widest', () => {
    expect(at(turnIntoTable, '|a,b,c\nd,e|').doc).toBe('| a | b | c |\n| --- | --- | --- |\n| d | e |  |')
  })
  test('a selection that is not separated falls back to the single cell, and pipes are escaped', () => {
    expect(run(turnIntoTable, 'one\ntwo x | y', 0, 13).doc).toBe('| one two x \\| y |  |\n| --- | --- |\n|  |  |')
  })
  test('a single selected line of cells gets an empty body row', () => {
    expect(at(turnIntoTable, '|a,b|').doc).toBe('| a | b |\n| --- | --- |\n|  |  |')
  })
})

describe('a quotation’s Turn into (composed)', () => {
  const into = (target: StateCommand, marked: string): Result => at(composeCommands(makePlainParagraph, target, { wholeBlock: true }), marked)
  test('Heading: the quote marker goes and the heading comes, as one undo step', () => {
    const result = at(composeCommands(makePlainParagraph, makeHeadingAtSurroundingLevel), 'Intro\n\n> A quo|ted line\n> second\n\nAfter')
    expect(result.doc).toMatch(/^Intro\n\n#+ A quoted line\n> second\n\nAfter$/)
    expect(result.steps).toBe(1)
    undoes(result, 'Intro\n\n> A quoted line\n> second\n\nAfter')
  })
  test('Bullet list, Task list and Code block', () => {
    expect(into(toggleBulletList, '> a qu|ote').doc).toBe('- a quote')
    expect(into(makeTaskList, '> a qu|ote').doc).toBe('- [ ] a quote')
    expect(into(turnIntoCodeBlock, '> a qu|ote\n> two').doc).toBe('```\na quote\ntwo\n```')
  })
  test('a command that declines declines the pair', () => {
    expect(composeCommands(makePlainParagraph, () => false)({ state: EditorState.create({ doc: '> x' }), dispatch: () => { throw new Error('dispatched') } })).toBe(false)
  })
})

describe('registry', () => {
  test('the six commands are registered, palette-listed, with a task group; ⇧⌘D is block.duplicate and duplicateLine is keyless', () => {
    for (const id of ['block.duplicate', 'edit.inlineCode', 'edit.clearFormatting', 'turn.taskList', 'turn.codeBlock', 'turn.table']) {
      const command = registryCommand(id)
      expect(command.surfaces, id).toContain('palette')
      expect(command.task, id).toBe('Write')
      expect(command.run, id).toBeDefined()
    }
    expect(registryCommand('block.duplicate').keys).toBe('Shift-Mod-d')
    expect(registryCommand('edit.duplicateLine').keys).toBeUndefined()
  })
})
