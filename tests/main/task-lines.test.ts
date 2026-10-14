import { expect, test } from 'bun:test'
import { countTaskLines, mayBeChecklistNote, readTaskLines, summariseTasks, toggleTaskLine } from '../../src/shared/markdown/task-lines'

// Checkbox-lists ticket 04 (hifi-direction-1 frame 10): the one reading of a file's boxes that the
// Agent notes pane, the pane's tick and the tasks.* agent verbs share. Lines are the FILE's.

const review = [
  '---',
  'author: agent',
  'source_document: essays/metaphor.md',
  '- [ ] a list-looking line inside frontmatter',
  '---',
  '',
  'The verdict, in prose.',
  '',
  '1. [x] **The opening claim is too quick.** "Everybody knows…" invites disagreement.',
  '',
  '2. [ ] **Propositions and statements** are used interchangeably,',
  '   over a continuation line.',
  '   - [X] a nested box',
  '',
  '```',
  '- [ ] a box in code is text',
  '```',
  '',
  'a) [ ] a lettered box',
  '- [] not a box',
  '- plain item',
  '',
].join('\n')

test('reads every real box by its file line, frontmatter and code excluded, any list marker', () => {
  expect(readTaskLines(review).map(({ line, checked, text }) => ({ line, checked, text }))).toEqual([
    { line: 9, checked: true, text: '**The opening claim is too quick.** "Everybody knows…" invites disagreement.' },
    { line: 11, checked: false, text: '**Propositions and statements** are used interchangeably,' },
    { line: 13, checked: true, text: 'a nested box' },
    { line: 19, checked: false, text: 'a lettered box' },
  ])
  expect(countTaskLines(readTaskLines(review))).toEqual({ open: 2, done: 2, total: 4 })
  const [first] = readTaskLines(review)
  expect(review.slice(first.from, first.from + 3)).toBe('[x]')
  expect(review[first.tick]).toBe('x')
})

test('a note without boxes reads as none', () => {
  expect(readTaskLines('1. one\n2. two\n\n- three\n')).toEqual([])
  expect(countTaskLines([])).toEqual({ open: 0, done: 0, total: 0 })
})

test('a tick rewrites exactly one character and nothing else', () => {
  const ticked = toggleTaskLine(review, 11)
  expect(ticked.checked).toBe(true)
  expect(ticked.text.length).toBe(review.length)
  const differing = [...review].flatMap((char, index) => (char === ticked.text[index] ? [] : [index]))
  expect(differing).toEqual([ticked.item.tick])
  expect(ticked.text.split('\n')[10]).toBe('2. [x] **Propositions and statements** are used interchangeably,')
  // Unticking an `[X]` writes a space into the same place.
  expect(toggleTaskLine(review, 13).text.split('\n')[12]).toBe('   - [ ] a nested box')
})

test('a tick refuses a line with no box, and a box that no longer stands as the caller saw it', () => {
  expect(() => toggleTaskLine(review, 7)).toThrow(/Line 7 has no checkbox/)
  expect(() => toggleTaskLine(review, 16)).toThrow(/no checkbox/) // the box in code
  expect(() => toggleTaskLine(review, 9, false)).toThrow(/already ticked; nothing was changed/)
  expect(toggleTaskLine(review, 9, true).checked).toBe(false)
})

// Checkbox-lists ticket 03 (frames 7–9): the one summary the Files tree, Quick Open and the Board
// card share. A checklist note has at least three box lines and more box lines than prose lines.

const talkPrep = [
  '# Before York',
  '- [ ] Check the room has HDMI',
  '- [ ] Rehearse part 3',
  '- [x] Send slides to the organiser',
  '- [x] Print the handout',
].join('\n')

test('the drawn note is a checklist note: 2 open, 2 done, the heading is not prose', () => {
  expect(summariseTasks(talkPrep)).toEqual({ open: 2, done: 2, isChecklistNote: true })
})

test('three boxes is the floor, and box lines must outnumber prose lines', () => {
  expect(summariseTasks('- [ ] one\n- [x] two')).toEqual({ open: 1, done: 1, isChecklistNote: false })
  expect(summariseTasks('- [ ] one\n- [x] two\n- [ ] three').isChecklistNote).toBe(true)
  // Three boxes against three prose lines is not "more": a piece with a to-do list at the bottom.
  const piece = ['A paragraph.', 'Another paragraph.', 'A plain item follows.', '- plain', '- [ ] one', '- [ ] two', '- [x] three'].join('\n')
  expect(summariseTasks(piece)).toEqual({ open: 2, done: 1, isChecklistNote: false })
  expect(summariseTasks(['Intro line.', '- [ ] one', '- [ ] two', '- [x] three'].join('\n')).isChecklistNote).toBe(true)
})

test('frontmatter and blank lines never count; code lines are prose and code boxes are not boxes', () => {
  const note = ['---', 'title: Packing', 'tags: [travel]', '---', '', '- [x] passport', '', '- [x] charger', '', '- [x] tickets'].join('\n')
  expect(summariseTasks(note)).toEqual({ open: 0, done: 3, isChecklistNote: true })
  const code = ['```', '- [ ] in code', '- [ ] in code', '- [ ] in code', '```', '- [ ] real'].join('\n')
  expect(summariseTasks(code)).toEqual({ open: 1, done: 0, isChecklistNote: false })
})

test('a file without boxes summarises to nothing, and the cheap gate never rules out a checklist note', () => {
  expect(summariseTasks('Just prose.\n\n- a plain list\n')).toEqual({ open: 0, done: 0, isChecklistNote: false })
  for (const text of [talkPrep, review, '- [ ] one\n- [x] two\n- [ ] three', '> - [ ] a\n> - [ ] b\n> - [x] c']) {
    if (summariseTasks(text).isChecklistNote) expect(mayBeChecklistNote(text)).toBe(true)
  }
  expect(mayBeChecklistNote(['Para one.', 'Para two.', 'Para three.', 'Para four.', '- [ ] a', '- [ ] b', '- [ ] c'].join('\n'))).toBe(false)
})
