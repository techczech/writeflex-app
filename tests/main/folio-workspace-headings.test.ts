import { expect, test } from 'bun:test'
import { outlineHeadingRows, headingRoute, filterOutlinePart, resolveHeadingLine } from '../../src/shared/folio-workspace-headings'
import { DEFAULT_ROOM_STATE, mergeRoomState, readRoomState } from '../../src/shared/folio-room'
import type { FolioOutlineFile } from '../../src/shared/folio-outline'

const file: FolioOutlineFile = { path: 'paper/a.md', title: 'Chapter', heading: 'own', headings: [
  { level: 1, text: 'Chapter', line: 4 }, { level: 2, text: 'Methods', line: 8 },
  { level: 4, text: 'Participants', line: 12 }, { level: 2, text: 'Results', line: 20 },
  { level: 3, text: 'Scores', line: 25 },
] }
test('headings nest under the nearest shallower heading, including skipped levels; the part title is not repeated', () => {
  expect(outlineHeadingRows(file).map(row => [row.text, row.depth])).toEqual([
    ['Methods', 0], ['Participants', 1], ['Results', 0], ['Scores', 1],
  ])
  expect(outlineHeadingRows({ ...file, heading: 'none' })[0].text).toBe('Chapter')
})
test('filter keeps only matching headings and their ancestors, with original lines and nesting', () => {
  expect(outlineHeadingRows(file, '  PARTICIPANTS ').map(row => [row.text, row.line, row.depth])).toEqual([
    ['Methods', 8, 0], ['Participants', 12, 1],
  ])
  expect(outlineHeadingRows(file, 'absent')).toEqual([])
})
test('heading navigation routes to the correct part and one-based line', () => {
  expect(headingRoute(file, file.headings[2])).toEqual({ path: 'paper/a.md', line: 12, level: 4, text: 'Participants' })
})
test('a jump lands on the recorded line when that line is still the heading', () => {
  const doc = ['# Chapter', '', 'Intro', '', '## Methods', 'text']
  const target = { line: 5, level: 2, text: 'Methods' }
  expect(resolveHeadingLine(doc.length, n => doc[n - 1], target)).toBe(5)
})
test('a jump finds the heading when its text has moved down the document', () => {
  const before = ['# Chapter', '', 'Intro', '', '## Methods', 'text']
  const after = ['# Chapter', '', 'New', 'lines', 'added', '', '## Methods', 'text']
  expect(resolveHeadingLine(after.length, n => after[n - 1], { line: 5, level: 2, text: 'Methods' })).toBe(7)
  expect(resolveHeadingLine(before.length, n => before[n - 1], { line: 5, level: 2, text: 'Methods' })).toBe(5)
})
test('a jump falls back to the recorded line, clamped, when the heading is gone', () => {
  const doc = ['# Chapter', 'plain', 'plain']
  expect(resolveHeadingLine(doc.length, n => doc[n - 1], { line: 2, level: 2, text: 'Methods' })).toBe(2)
  expect(resolveHeadingLine(doc.length, n => doc[n - 1], { line: 40, level: 2, text: 'Methods' })).toBe(3)
})
test('a jump requires the same level, not only the same text', () => {
  const doc = ['# Methods', 'x', '## Methods']
  expect(resolveHeadingLine(doc.length, n => doc[n - 1], { line: 2, level: 2, text: 'Methods' })).toBe(3)
})
test('the Outline filter keeps a part whose title matches, with its headings collapsed unless a heading matches', () => {
  const titled = { ...file, title: 'Methodology' }
  const titleOnly = filterOutlinePart('Methodology', titled, 'methodo')
  expect(titleOnly.keep).toBe(true)
  expect(titleOnly.headings).toEqual([])
  const headingToo = filterOutlinePart('Methodology', titled, 'results')
  expect(headingToo.keep).toBe(true)
  expect(headingToo.headings.map(row => row.text)).toEqual(['Results'])
  expect(filterOutlinePart('Chapter', file, 'absent')).toEqual({ keep: false, headings: [] })
})
test('the Outline filter keeps an unwritten part whose title matches and hides it otherwise', () => {
  expect(filterOutlinePart('Afterword', undefined, 'after')).toEqual({ keep: true, headings: [] })
  expect(filterOutlinePart('Afterword', undefined, 'methods')).toEqual({ keep: false, headings: [] })
  expect(filterOutlinePart('Afterword', undefined, '')).toEqual({ keep: true, headings: [] })
})
test('expanded paths survive the app-state round trip and a tab change; invalid patches leave them intact', () => {
  const state = mergeRoomState(DEFAULT_ROOM_STATE, { outlineExpanded: ['paper/a.md', 'paper/a.md', 'paper/b.md'] })
  expect(readRoomState(JSON.parse(JSON.stringify(state))).outlineExpanded).toEqual(['paper/a.md', 'paper/b.md'])
  expect(mergeRoomState(state, { view: 'text' }).outlineExpanded).toEqual(['paper/a.md', 'paper/b.md'])
  expect(mergeRoomState(state, { outlineExpanded: [9] }).outlineExpanded).toEqual(state.outlineExpanded)
  expect(readRoomState({ outlineExpanded: [9] }).outlineExpanded).toBeUndefined()
  expect(mergeRoomState(state, { outlineExpanded: [] }).outlineExpanded).toEqual([])
})

test('heading and disclosure keys are documented locally and never claimed by the app chord table', async () => {
  const { commandRegistry } = await import('../../src/renderer/src/commands/registry')
  for (const id of ['folio.room.toggleHeadings', 'folio.room.openHeading']) {
    expect(commandRegistry.find(command => command.id === id)).toMatchObject({ surfaces: ['sheet'], claimsChord: false })
  }
})
