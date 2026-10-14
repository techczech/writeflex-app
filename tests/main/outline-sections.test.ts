import { expect, test } from 'bun:test'
import { ChangeSet, EditorState } from '@codemirror/state'
import { extractOutline } from '../../src/renderer/src/editor/outline'
import {
  deleteSections,
  deepestLevel,
  dropHeadingEdit,
  dropSection,
  hiddenBeneath,
  levelVisibility,
  moveSections,
  newHeadingEdit,
  sectionRoots,
  sectionSpan,
  sectionWordCounts,
  shiftSections,
  wordsInSections,
  type DropEdit,
} from '../../src/renderer/src/editor/outline-sections'

const apply = (doc: string, edit: { changes: unknown } | null): string =>
  edit ? EditorState.create({ doc }).update({ changes: (edit as DropEdit).changes as never }).state.doc.toString() : doc
const applySet = (doc: string, edit: { changes: ChangeSet } | null): string => (edit ? edit.changes.apply(EditorState.create({ doc }).doc).toString() : doc)

const DOC = '# One\none\n## One-a\nsub\n# Two\ntwo\n# Three\nthree\n'

test('a section spans its heading to the next heading of the same or a higher level', () => {
  const two = DOC.indexOf('# Two')
  expect(sectionSpan(DOC, 0)).toMatchObject({ from: 0, to: two, level: 1 })
  expect(sectionSpan(DOC, DOC.indexOf('## One-a'))).toMatchObject({ to: two, level: 2 })
})

test('dropping a section before a later heading moves it with its subsections and keeps levels', () => {
  const edit = dropSection(DOC, 0, DOC.indexOf('# Three'))
  expect(apply(DOC, edit)).toBe('# Two\ntwo\n# One\none\n## One-a\nsub\n# Three\nthree\n')
  expect(edit!.movedFrom).toBe('# Two\ntwo\n'.length)
})

test('dropping a section before an earlier heading', () => {
  const edit = dropSection(DOC, DOC.indexOf('# Three'), 0)
  expect(apply(DOC, edit)).toBe('# Three\nthree\n# One\none\n## One-a\nsub\n# Two\ntwo\n')
  expect(edit!.movedFrom).toBe(0)
})

test('a drop onto its own subtree, itself, or the heading that already follows changes nothing', () => {
  expect(dropSection(DOC, 0, DOC.indexOf('## One-a'))).toBeNull()
  expect(dropSection(DOC, 0, 0)).toBeNull()
  expect(dropSection(DOC, 0, DOC.indexOf('# Two'))).toBeNull()
})

test('a drop at the end of the document, and the last section of a file with no final newline', () => {
  expect(apply(DOC, dropSection(DOC, 0, null))).toBe('# Two\ntwo\n# Three\nthree\n# One\none\n## One-a\nsub\n')
  const bare = '# A\na\n# B\nb'
  expect(apply(bare, dropSection(bare, bare.indexOf('# B'), 0))).toBe('# B\nb\n# A\na')
  expect(apply(bare, dropSection(bare, 0, null))).toBe('# B\nb\n# A\na')
})

test('row index to edit, with the end as index === length', () => {
  const headings = extractOutline(DOC)
  expect(apply(DOC, dropHeadingEdit(DOC, headings, 3, 0))).toBe('# Three\nthree\n# One\none\n## One-a\nsub\n# Two\ntwo\n')
  expect(apply(DOC, dropHeadingEdit(DOC, headings, 0, headings.length))).toBe('# Two\ntwo\n# Three\nthree\n# One\none\n## One-a\nsub\n')
  expect(dropHeadingEdit(DOC, headings, 9, 0)).toBeNull()
})

test('a section carries its trailing blank lines when it moves', () => {
  const doc = '# A\na\n\n# B\nb\n\n# C\nc\n'
  expect(apply(doc, dropSection(doc, 0, doc.indexOf('# C')))).toBe('# B\nb\n\n# A\na\n\n# C\nc\n')
})

test('promote and demote take the subtree along and are one change set', () => {
  const demoted = shiftSections(DOC, [0], 1)!
  expect(applySet(DOC, demoted)).toBe('## One\none\n### One-a\nsub\n# Two\ntwo\n# Three\nthree\n')
  const promoted = shiftSections('## One\n### a\n# Two\n', [0], -1)!
  expect(applySet('## One\n### a\n# Two\n', promoted)).toBe('# One\n## a\n# Two\n')
  expect(shiftSections('# One\n', [0], -1)).toBeNull()
})

test('sideways drag of several levels is one composed change set', () => {
  const edit = shiftSections('# A\n## B\n# C\n', [0], 1, 2)!
  expect(applySet('# A\n## B\n# C\n', edit)).toBe('### A\n#### B\n# C\n')
})

test('several selected sections promote together, nested picks counted once', () => {
  const doc = '## A\na\n### A1\n## B\nb\n## C\nc\n'
  const froms = [doc.indexOf('## A'), doc.indexOf('### A1'), doc.indexOf('## C')]
  expect(sectionRoots(doc, froms)).toEqual([doc.indexOf('## A'), doc.indexOf('## C')])
  expect(applySet(doc, shiftSections(doc, froms, -1))).toBe('# A\na\n## A1\n## B\nb\n# C\nc\n')
})

test('selected sections move together as a block, up and down', () => {
  const doc = '# P\np\n# S1\ns1\n# S2\ns2\n# X\nx\n'
  const froms = [doc.indexOf('# S1'), doc.indexOf('# S2')]
  const up = moveSections(doc, froms, 'up')!
  expect(applySet(doc, up)).toBe('# S1\ns1\n# S2\ns2\n# P\np\n# X\nx\n')
  const down = moveSections(doc, froms, 'down')!
  expect(applySet(doc, down)).toBe('# P\np\n# X\nx\n# S1\ns1\n# S2\ns2\n')
  const moved = applySet(doc, down)
  expect(down.froms.map((from) => moved.slice(from, from + 4))).toEqual(['# S1', '# S2'])
})

test('delete removes every selected section with what is under it', () => {
  const doc = '# A\na\n## A1\n# B\nb\n# C\nc\n'
  expect(applySet(doc, deleteSections(doc, [0, doc.indexOf('# C')]))).toBe('# B\nb\n')
})

test('word counts are per section including its subtree', () => {
  const doc = '# A\none two\n## B\nthree four five\n# C\nsix\n'
  expect(sectionWordCounts(doc)).toEqual([7, 4, 2])
  expect(wordsInSections(doc, [0, doc.indexOf('## B')])).toBe(7)
})

test('levels: a limit hides deeper rows but never the cursor section or its ancestors', () => {
  const doc = '# A\n## B\n### C\n### D\n# E\n## F\n'
  const headings = extractOutline(doc)
  expect(deepestLevel(headings)).toBe(3)
  expect(levelVisibility(headings, 2, -1)).toEqual([true, true, false, false, true, true])
  expect(levelVisibility(headings, 1, 3)).toEqual([true, true, false, true, true, false])
  expect(levelVisibility(headings, null, -1).every(Boolean)).toBe(true)
  const shown = levelVisibility(headings, 2, -1)
  expect(hiddenBeneath(headings, shown)).toEqual([2, 2, 0, 0, 0, 0])
})

test('new heading before and as a first subheading', () => {
  const doc = '# A\na\n## B\n'
  const before = newHeadingEdit(doc, doc.indexOf('## B'), 'before')!
  expect(apply(doc, before)).toBe('# A\na\n## \n\n## B\n')
  const sub = newHeadingEdit(doc, 0, 'sub')!
  expect(apply(doc, sub)).toBe('# A\n## \n\na\n## B\n')
  expect(newHeadingEdit(doc, 1, 'sub')).toBeNull()
})
