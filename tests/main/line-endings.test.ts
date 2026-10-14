import { expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { EditorBaselines, dominantLineEnding, editorTextOf, isTextChange, textForSave } from '../../src/shared/line-endings'

// Bug 01 (2026-09-27): opening a CRLF file rewrote it with LF. The editor (CodeMirror) holds LF text, and
// the save path's "is this a change?" compared that text with the raw disk bytes. These are the pure
// halves of the fix: the change decision and the line-ending/BOM restoration.

const BOM = '﻿'
const FIXTURES = {
  crlf: '# Windows note\r\n\r\nalpha line\r\nsecond line\r\n',
  bom: `${BOM}# BOM note\n\nalpha line\n`,
  bomCrlf: `${BOM}# BOM and CRLF\r\n\r\nalpha line\r\n`,
  noTrailing: '# No trailing newline\n\nalpha line',
  mixed: '# Mixed\r\n\r\nalpha line\nbeta line\r\ngamma line\r\n',
  loneCr: '# Old Mac\r\ralpha line\r',
}

/** What the editor actually holds after opening these bytes. */
const opened = (disk: string): string => EditorState.create({ doc: disk }).doc.toString()

test('an opened, untouched file is not a change, whatever its line endings, BOM or trailing newline', () => {
  for (const [name, disk] of Object.entries(FIXTURES)) {
    expect(isTextChange(disk, opened(disk)), name).toBe(false)
    expect(textForSave(opened(disk), disk), name).toBe(disk)
  }
})

test('editorTextOf is exactly what CodeMirror stores', () => {
  for (const disk of Object.values(FIXTURES)) expect(editorTextOf(disk)).toBe(opened(disk))
})

test('a real edit is a change', () => {
  expect(isTextChange(FIXTURES.crlf, opened(FIXTURES.crlf).replace('alpha', 'alpha EDIT'))).toBe(true)
  expect(isTextChange(FIXTURES.noTrailing, `${opened(FIXTURES.noTrailing)}\n`)).toBe(true)
  expect(isTextChange(undefined, 'anything')).toBe(true)
})

test('an edited CRLF file saves CRLF', () => {
  const edited = opened(FIXTURES.crlf).replace('alpha line', 'alpha line EDIT')
  expect(textForSave(edited, FIXTURES.crlf)).toBe('# Windows note\r\n\r\nalpha line EDIT\r\nsecond line\r\n')
})

test('an edited BOM file keeps the BOM, with or without CRLF, even if the buffer lost it', () => {
  const edited = opened(FIXTURES.bom).replace('alpha line', 'alpha line EDIT')
  expect(textForSave(edited, FIXTURES.bom)).toBe(`${BOM}# BOM note\n\nalpha line EDIT\n`)
  expect(textForSave(edited.slice(1), FIXTURES.bom)).toBe(`${BOM}# BOM note\n\nalpha line EDIT\n`)
  const editedCrlf = opened(FIXTURES.bomCrlf).replace('alpha line', 'alpha line EDIT')
  expect(textForSave(editedCrlf, FIXTURES.bomCrlf)).toBe(`${BOM}# BOM and CRLF\r\n\r\nalpha line EDIT\r\n`)
})

test('an edited file without a trailing newline stays without one', () => {
  const edited = `${opened(FIXTURES.noTrailing)} EDIT`
  expect(textForSave(edited, FIXTURES.noTrailing)).toBe('# No trailing newline\n\nalpha line EDIT')
})

test('a mixed-ending file is written only when edited, and then takes its dominant style', () => {
  expect(dominantLineEnding(FIXTURES.mixed)).toBe('\r\n')
  expect(textForSave(opened(FIXTURES.mixed), FIXTURES.mixed)).toBe(FIXTURES.mixed)
  const edited = opened(FIXTURES.mixed).replace('alpha line', 'alpha line EDIT')
  expect(textForSave(edited, FIXTURES.mixed)).toBe('# Mixed\r\n\r\nalpha line EDIT\r\nbeta line\r\ngamma line\r\n')
})

test('dominantLineEnding: most frequent wins, a tie goes to the first seen, none counts as LF', () => {
  expect(dominantLineEnding('a\nb\r\nc\r\n')).toBe('\r\n')
  expect(dominantLineEnding('a\nb\r\n')).toBe('\n')
  expect(dominantLineEnding('a\r\nb\n')).toBe('\r\n')
  expect(dominantLineEnding('a\rb\r')).toBe('\r')
  expect(dominantLineEnding('one line')).toBe('\n')
})

test('text that already carries explicit endings is kept as given; a missing file takes the text as is', () => {
  expect(textForSave('a\r\nb EDIT\n', 'a\r\nb\r\n')).toBe('a\r\nb EDIT\n')
  expect(textForSave('new\n', null)).toBe('new\n')
})

test('LF files are untouched by the restoration', () => {
  const disk = '# Plain\n\nalpha\n'
  expect(textForSave('# Plain\n\nalpha EDIT\n', disk)).toBe('# Plain\n\nalpha EDIT\n')
})

test('EditorBaselines stores the editor form of a disk read', () => {
  const baselines = new EditorBaselines()
  baselines.set('a.md', FIXTURES.crlf)
  expect(baselines.get('a.md')).toBe(opened(FIXTURES.crlf))
})
