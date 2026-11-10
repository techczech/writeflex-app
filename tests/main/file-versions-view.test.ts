/**
 * Ticket 19 of Folio versions: the pure parts of the file-versions panel (src/shared/file-versions.ts): what a comparison of two tables says, how a
 * file that is not text is compared, and the words. No window, no disk.
 */
import { expect, test } from 'bun:test'
import {
  COMPARE_ROWS_SHOWN, compareFileBytes, compareTables, linesChangedBetween, readsAsText, suggestedCopyName, usedBySentence, workingSentence,
} from '../../src/shared/file-versions'

const end = (label: string, bytes = 0) => ({ label, bytes })
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

test('two tables compare cell by cell: the first row is the header, a cell counts once, an added row or column counts each of its cells', () => {
  const one = 'Judge,Prefer A,Ties\nJudge 1,51,9\nJudge 2,47,7\n'
  const two = 'Judge,Prefer A,Ties\nJudge 1,49,11\nJudge 2,47,7\nJudge 3,55,7\n'
  const result = compareTables('data/scores.csv', one, two, end('v1'), end('Working copy'))
  expect(result.cellsDiffering).toBe(2 + 3)
  expect(result.header.map((cell) => cell.after)).toEqual(['Judge', 'Prefer A', 'Ties'])
  expect(result.rows[0]!.map((cell) => [cell.before, cell.after])).toEqual([['Judge 1', 'Judge 1'], ['51', '49'], ['9', '11']])
  // A row only on one side has `null` on the other.
  expect(result.rows[2]!.map((cell) => cell.before)).toEqual([null, null, null])
  expect(result.rowsNotShown).toBe(0)
  // A column added counts its cells in every row.
  expect(compareTables('t.csv', 'a,b\n1,2\n', 'a,b,c\n1,2,3\n', end('x'), end('y')).cellsDiffering).toBe(2)
  expect(compareTables('t.csv', 'a,b\n1,2\n', 'a,b\n1,2\n', end('x'), end('y')).cellsDiffering).toBe(0)
})

test('quoted cells, a tab-separated table and a byte-order mark are read as cells', () => {
  expect(compareTables('t.csv', '﻿name,note\n"Smith, J",ok\n', 'name,note\n"Smith, J","ok, mostly"\n', end('x'), end('y')).cellsDiffering).toBe(1)
  expect(compareTables('t.tsv', 'a\tb\n1\t2\n', 'a\tb\n1\t3\n', end('x'), end('y')).cellsDiffering).toBe(1)
})

test('a long table lists its first rows and says how many it did not show; the count is of all of them', () => {
  const rows = (n: number, value: string) => ['h', ...Array.from({ length: n }, (_, i) => `${i},${value}`)].join('\n').replace('h', 'a,b')
  const result = compareTables('big.csv', rows(300, 'x'), rows(300, 'y'), end('x'), end('y'))
  expect(result.rows).toHaveLength(COMPARE_ROWS_SHOWN)
  expect(result.rowsNotShown).toBe(300 - COMPARE_ROWS_SHOWN)
  expect(result.cellsDiffering).toBe(300)
})

test('anything that is not a table is compared by whether it differs, and by lines when it reads as text', () => {
  expect(compareFileBytes('assets/w.html', bytes('<p>a</p>\n<p>b</p>\n'), bytes('<p>a</p>\n<p>B</p>\n'), 'v1', 'Working copy')).toMatchObject({ kind: 'other', fileKind: 'widget', same: false, linesChanged: 1 })
  expect(compareFileBytes('assets/w.html', bytes('same'), bytes('same'), 'v1', 'Working copy')).toMatchObject({ same: true, linesChanged: 0 })
  // An image: no lines are counted, whatever the bytes happen to decode to.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00])
  expect(compareFileBytes('assets/f.png', png, new Uint8Array([0x89, 0x50]), 'v1', 'w')).toMatchObject({ kind: 'other', fileKind: 'image', same: false, linesChanged: null, from: { bytes: 6 }, to: { bytes: 2 } })
  // A .csv that is not text (a mislabelled file) is not parsed as cells.
  expect(compareFileBytes('data/odd.csv', png, new Uint8Array([0x89]), 'a', 'b')).toMatchObject({ kind: 'other', linesChanged: null })
  expect(readsAsText(bytes('ordinary text'))).toBe(true)
  expect(readsAsText(new Uint8Array([0x68, 0x00, 0x69]))).toBe(false)
  expect(readsAsText(new Uint8Array([0xc3, 0x28]))).toBe(false)
  expect(linesChangedBetween('a\nb\nc', 'a\nB\nc')).toBe(1)
  expect(linesChangedBetween('a\nb', 'a\nb')).toBe(0)
})

test('the words: which Folio versions used a file version, what the working copy is, and a name for a copy', () => {
  const use = (name: string, ts: number) => ({ id: `fv_${ts}`, name, ts })
  expect(usedBySentence([])).toBe('not used by any Folio version')
  expect(usedBySentence([use('After pilot numbers', 2)])).toBe('used by Folio “After pilot numbers”')
  expect(usedBySentence([use('Draft for Sam Rowe', 9), use('Second draft', 5), use('First', 1)])).toBe('used by 3 Folio versions, the last “Draft for Sam Rowe”')
  expect(workingSentence({ state: 'unversioned' }, 'table')).toBe('No version holds a copy of this file yet.')
  expect(workingSentence({ state: 'same', as: { id: 'v', number: 2, name: 'x' } }, 'table')).toBe('saved · the same as v2')
  expect(workingSentence({ state: 'changed', since: { id: 'v', number: 2, name: 'x' }, cellsChanged: 3 }, 'table')).toBe('unsaved · 3 cells changed since v2')
  expect(workingSentence({ state: 'changed', since: { id: 'v', number: 2, name: 'x' }, cellsChanged: 1 }, 'table')).toBe('unsaved · 1 cell changed since v2')
  expect(workingSentence({ state: 'changed', since: { id: 'v', number: 1, name: 'x' }, cellsChanged: null }, 'image')).toBe('unsaved · changed since v1')
  expect(workingSentence({ state: 'too-large', bytes: 30_000_000 }, 'image')).toMatch(/Over 25 MiB.*reference/)
  expect(suggestedCopyName('data/scores-3.csv', 1)).toBe('scores-3 (v1).csv')
  expect(suggestedCopyName('assets/pipeline.diagram.png', 12)).toBe('pipeline.diagram (v12).png')
  expect(suggestedCopyName('data/README', 2)).toBe('README (v2)')
})
