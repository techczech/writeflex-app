import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { TABLE_COLUMN_COMMANDS, applyColumnCommand, columnAt, isTableColumnCommand, pendingTableEdit, tableColumnEdit } from '../../src/renderer/src/editor/table-column-actions'
import { parseTable } from '../../src/shared/object-markup'
import { actionsAt } from '../../src/renderer/src/commands/place'

const TABLE = '| Stone | Count | Place |\n| :--- | :--- | :--- |\n| cope | 12 | wall |'
const DOC = `Before.\n\n${TABLE}\n\nAfter.\n`
const at = (offset: number): EditorState => EditorState.create({ doc: DOC, selection: { anchor: offset } })
const apply = (state: EditorState, command: typeof TABLE_COLUMN_COMMANDS[number]): string => {
  const edit = tableColumnEdit(state, command)
  if (!edit) throw new Error('no edit')
  return state.update({ changes: edit }).state.doc.toString()
}
const inCell = (cell: string): number => DOC.indexOf(cell) + 1

describe('the column the caret is in', () => {
  test('counts the dividers before the caret on its line', () => {
    expect(columnAt('| Stone | Count | Place |', 3, 3)).toBe(0)
    expect(columnAt('| Stone | Count | Place |', 11, 3)).toBe(1)
    expect(columnAt('| Stone | Count | Place |', 20, 3)).toBe(2)
    expect(columnAt('| a \\| b | c |', 8, 2)).toBe(0)
    expect(columnAt('', 0, 3)).toBe(0)
  })
})

describe('the six column commands on the table at the caret', () => {
  test('alignment applies to the caret column only', () => {
    expect(parseTable(apply(at(inCell('Count')), 'table.alignRight').split('\n\n')[1])!.alignments).toEqual(['left', 'right', 'left'])
    expect(parseTable(apply(at(inCell('wall')), 'table.alignCentre').split('\n\n')[1])!.alignments).toEqual(['left', 'left', 'center'])
    expect(parseTable(apply(at(inCell('12')), 'table.alignLeft').split('\n\n')[1])!.alignments).toEqual(['left', 'left', 'left'])
  })

  test('a column is inserted on the chosen side, with empty cells', () => {
    const left = parseTable(apply(at(inCell('Count')), 'table.insertLeft').split('\n\n')[1])!
    expect(left.cells).toEqual([['Stone', '', 'Count', 'Place'], ['cope', '', '12', 'wall']])
    const right = parseTable(apply(at(inCell('Count')), 'table.insertRight').split('\n\n')[1])!
    expect(right.cells).toEqual([['Stone', 'Count', '', 'Place'], ['cope', '12', '', 'wall']])
  })

  test('a column is deleted, never the last one', () => {
    expect(parseTable(apply(at(inCell('Count')), 'table.delete').split('\n\n')[1])!.cells).toEqual([['Stone', 'Place'], ['cope', 'wall']])
    expect(applyColumnCommand({ cells: [['a']], alignments: ['left'] }, 'table.delete', 0)).toBeNull()
  })

  test('the text around the table is untouched', () => {
    const next = apply(at(inCell('Count')), 'table.insertRight')
    expect(next.startsWith('Before.\n\n')).toBe(true)
    expect(next.endsWith('\n\nAfter.\n')).toBe(true)
  })

  test('with the caret on the first line of the table block, the first column is used', () => {
    expect(parseTable(apply(at(DOC.indexOf('| Stone')), 'table.alignRight').split('\n\n')[1])!.alignments).toEqual(['right', 'left', 'left'])
  })

  test('no table at the caret is no edit', () => {
    expect(tableColumnEdit(at(2), 'table.delete')).toBeNull()
  })
})

describe('every table command Actions here lists at the table place can be run', () => {
  test('the six ids are the ones listed', () => {
    const listed = actionsAt('table', EditorState.create({ doc: DOC })).map((command) => command.id).filter((id) => id.startsWith('table.'))
    expect(listed.sort()).toEqual([...TABLE_COLUMN_COMMANDS].sort())
    for (const id of listed) expect(isTableColumnCommand(id)).toBe(true)
  })
})

describe('a column delete confirmed after the document changed (Sol S1)', () => {
  const deleteAtCount = () => {
    const state = at(inCell('Count'))
    const edit = tableColumnEdit(state, 'table.delete')!
    return { state, edit, pending: pendingTableEdit(state, edit) }
  }
  const step = (pending: ReturnType<typeof pendingTableEdit>, state: EditorState, changes: { from: number; to?: number; insert?: string }) => {
    const tr = state.update({ changes })
    pending.observe({ startState: state, state: tr.state, changes: tr.changes, docChanged: tr.docChanged })
    return tr.state
  }

  test('an insert above the table moves the edit with the table, and the prose stays', () => {
    const { state, pending } = deleteAtCount()
    const later = step(pending, state, { from: 0, insert: 'An agent wrote this. ' })
    const mapped = pending.resolve(later)!
    const result = later.update({ changes: mapped }).state.doc.toString()
    expect(result.startsWith('An agent wrote this. Before.\n\n')).toBe(true)
    expect(result.endsWith('\n\nAfter.\n')).toBe(true)
    expect(parseTable(result.split('\n\n')[1])!.cells).toEqual([['Stone', 'Place'], ['cope', 'wall']])
  })

  test('the stale offsets alone would have replaced prose; the mapped edit does not', () => {
    const { state, edit, pending } = deleteAtCount()
    const later = step(pending, state, { from: 0, insert: 'Twelve more characters of prose. ' })
    expect(later.sliceDoc(edit.from, edit.to)).not.toBe(state.sliceDoc(edit.from, edit.to))
    expect(later.sliceDoc(pending.resolve(later)!.from, pending.resolve(later)!.to)).toBe(state.sliceDoc(edit.from, edit.to))
  })

  test('a table edited, or removed, while the card was open is refused', () => {
    const { state, pending } = deleteAtCount()
    expect(pending.resolve(step(pending, state, { from: DOC.indexOf('cope'), insert: 'x' }))).toBeNull()
    const again = deleteAtCount()
    expect(again.pending.resolve(step(again.pending, again.state, { from: DOC.indexOf('| Stone'), to: DOC.indexOf('\n\nAfter') }))).toBeNull()
  })

  test('another document in the editor (a state set without a transaction) is refused', () => {
    const { pending } = deleteAtCount()
    expect(pending.resolve(EditorState.create({ doc: DOC }))).toBeNull()
  })

  test('no change at all applies the edit as it was asked', () => {
    const { state, edit, pending } = deleteAtCount()
    expect(pending.resolve(state)).toEqual(edit)
  })
})
