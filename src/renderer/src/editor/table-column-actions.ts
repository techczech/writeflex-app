// The six column commands of a table (table.alignLeft ... table.delete), run from the document at the
// caret: Actions here lists them at the table place, where no cell editor is open to hold them. The
// cell editor's own column menu (object-editors/table-editor.ts) does the same six things to its
// model; this does them to the table's markdown, in the column the caret is in.
import type { EditorState } from '@codemirror/state'
import { parseTable, serialiseTable, type TableModel } from '../../../shared/object-markup'

export const TABLE_COLUMN_COMMANDS = ['table.alignLeft', 'table.alignCentre', 'table.alignRight', 'table.insertLeft', 'table.insertRight', 'table.delete'] as const
export type TableColumnCommand = typeof TABLE_COLUMN_COMMANDS[number]
export const isTableColumnCommand = (id: string): id is TableColumnCommand => (TABLE_COLUMN_COMMANDS as readonly string[]).includes(id)

export type TableEdit = { from: number; to: number; insert: string }

/** The pipe-delimited lines the caret's line belongs to, as one range of the document. */
function tableLines(state: EditorState, head: number): { from: number; to: number } | null {
  const { doc } = state
  const isRow = (number: number): boolean => doc.line(number).text.includes('|')
  const here = doc.lineAt(head).number
  if (!isRow(here)) return null
  let first = here
  let last = here
  while (first > 1 && isRow(first - 1)) first -= 1
  while (last < doc.lines && isRow(last + 1)) last += 1
  return { from: doc.line(first).from, to: doc.line(last).to }
}

/** The column the caret is in: the number of cell dividers before it on its line. */
export function columnAt(lineText: string, offset: number, columns: number): number {
  const before = lineText.slice(0, offset)
  let pipes = 0
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] === '\\') index += 1
    else if (before[index] === '|') pipes += 1
  }
  const column = lineText.trimStart().startsWith('|') ? pipes - 1 : pipes
  return Math.max(0, Math.min(columns - 1, column))
}

/** Apply a column command to a parsed table. Null when it cannot be done (the last column is never deleted). */
export function applyColumnCommand(model: TableModel, command: TableColumnCommand, column: number): TableModel | null {
  const next: TableModel = { cells: model.cells.map((row) => [...row]), alignments: [...model.alignments] }
  if (command === 'table.alignLeft') next.alignments[column] = 'left'
  else if (command === 'table.alignCentre') next.alignments[column] = 'center'
  else if (command === 'table.alignRight') next.alignments[column] = 'right'
  else if (command === 'table.insertLeft' || command === 'table.insertRight') {
    const at = column + (command === 'table.insertRight' ? 1 : 0)
    next.alignments.splice(at, 0, 'left')
    next.cells.forEach((row) => row.splice(at, 0, ''))
  } else {
    if (next.alignments.length < 2) return null
    next.alignments.splice(column, 1)
    next.cells.forEach((row) => row.splice(column, 1))
  }
  return next
}

/** The edit that runs `command` on the table at the caret, or null when there is none or it does not apply. */
export function tableColumnEdit(state: EditorState, command: TableColumnCommand, block?: { from: number; to: number } | null): TableEdit | null {
  const head = state.selection.main.head
  const range = block ?? tableLines(state, head)
  if (!range) return null
  const model = parseTable(state.sliceDoc(range.from, range.to))
  if (!model) return null
  const line = state.doc.lineAt(Math.max(range.from, Math.min(head, range.to)))
  const column = columnAt(line.text, Math.max(0, Math.min(head, line.to) - line.from), model.alignments.length)
  const next = applyColumnCommand(model, command, column)
  return next ? { from: range.from, to: range.to, insert: serialiseTable(next) } : null
}
