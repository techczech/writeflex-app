import { expect, test } from 'bun:test'
import { digitTarget, moveCursor, OVERLAY_ROWS, PICKER_COLUMNS, READABILITY_ROWS, rowDigit } from '../../src/renderer/src/components/focus-picker-model'

test('every option of the old picker is in its column: six readability rows, Off plus two overlays', () => {
  expect(READABILITY_ROWS.map((row) => row.label)).toEqual(['Off', 'Fade other paragraphs', 'Highlight sentence', 'Segment focus', 'Sentence breakup', 'Anchored reading'])
  expect(OVERLAY_ROWS.map((row) => row.label)).toEqual(['Off', 'Line focus', 'Ruler'])
})

test('digits 0-5 pick readability rows and 6-7 pick Line focus and Ruler; other keys are not digits', () => {
  expect(digitTarget('0')).toEqual({ column: 0, row: 0 })
  expect(digitTarget('5')).toEqual({ column: 0, row: 5 })
  expect(digitTarget('6')).toEqual({ column: 1, row: 1 })
  expect(digitTarget('7')).toEqual({ column: 1, row: 2 })
  expect(PICKER_COLUMNS[1][digitTarget('6')!.row].kind).toBe('lineFocus')
  expect(PICKER_COLUMNS[1][digitTarget('7')!.row].kind).toBe('ruler')
  expect(digitTarget('8')).toBeNull()
  expect(digitTarget('a')).toBeNull()
})

test('the digits shown match the digits that work; the right Off has none', () => {
  expect([0, 1, 2, 3, 4, 5].map((row) => rowDigit(0, row))).toEqual(['0', '1', '2', '3', '4', '5'])
  expect([0, 1, 2].map((row) => rowDigit(1, row))).toEqual(['', '6', '7'])
})

test('up and down wrap within a column and never cross it', () => {
  expect(moveCursor({ column: 0, row: 5 }, 'ArrowDown')).toEqual({ column: 0, row: 0 })
  expect(moveCursor({ column: 0, row: 0 }, 'ArrowUp')).toEqual({ column: 0, row: 5 })
  expect(moveCursor({ column: 1, row: 2 }, 'ArrowDown')).toEqual({ column: 1, row: 0 })
  expect(moveCursor({ column: 1, row: 0 }, 'ArrowUp')).toEqual({ column: 1, row: 2 })
  expect(moveCursor({ column: 1, row: 1 }, 'End')).toEqual({ column: 1, row: 2 })
  expect(moveCursor({ column: 0, row: 3 }, 'Home')).toEqual({ column: 0, row: 0 })
})

test('left and right switch columns, keeping the row where the other column has it', () => {
  expect(moveCursor({ column: 0, row: 1 }, 'ArrowRight')).toEqual({ column: 1, row: 1 })
  expect(moveCursor({ column: 0, row: 4 }, 'ArrowRight')).toEqual({ column: 1, row: 2 })
  expect(moveCursor({ column: 1, row: 2 }, 'ArrowLeft')).toEqual({ column: 0, row: 2 })
  expect(moveCursor({ column: 1, row: 0 }, 'ArrowLeft')).toEqual({ column: 0, row: 0 })
})

test('Enter, Escape and letters are not cursor moves', () => {
  expect(moveCursor({ column: 0, row: 0 }, 'Enter')).toBeNull()
  expect(moveCursor({ column: 0, row: 0 }, 'Escape')).toBeNull()
})
