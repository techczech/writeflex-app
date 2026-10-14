import { test, expect } from 'bun:test'
import { countWords, countUnits } from '../../src/renderer/src/editor/word-count'

// Salvaged verbatim from feature/m1-its-your-editor (tests/word-count.test.ts); only the import
// path moved for the rebuild's tests/main/ layout.
test('counts words across markdown syntax', () => {
  // '# Two words' + '- item one' = Two, words, item, one = 4 real words; the '#' and '-'
  // markdown markers are correctly NOT counted (that is the point of the regex). The M1 brief's
  // fixture said 5, which double-counts a syntax marker and contradicts the brief's own regex —
  // corrected to 4, the value the authoritative regex produces (see the M1 task-10 report).
  expect(countWords('# Two words\n\n- item one\n')).toBe(4)
  expect(countWords("don't split contractions or hyphen-joined words")).toBe(6)
  expect(countWords('')).toBe(0)
  expect(countWords('***')).toBe(0)
  expect(countWords('Čeština počítá slova')).toBe(3)
})

// Task 7: the status bar (Task 12) counts prose the reader keeps, not `// ` post-it comments.
test('excludeCommentLines drops // comment lines from the count', () => {
  expect(countWords('a b\n// c d\n', { excludeCommentLines: true })).toBe(2)
  // Indented comments count as comments too; the default (no option) still counts everything.
  expect(countWords('a b\n  // c d\n', { excludeCommentLines: true })).toBe(2)
  expect(countWords('a b\n// c d\n')).toBe(4)
})

// Fix wave 1: fence-aware. A `// code` line inside a ``` fenced block is real code, NOT a WriteFlex
// post-it comment, so it is COUNTED — this keeps the counter in agreement with the fence-aware
// render decorator and the jumps scanner (fenced `//` lines are never WriteFlex comments). Fence
// marker lines (```/~~~ plus any info string) are structural Markdown and contribute no prose.
test('excludeCommentLines keeps fenced `// code` lines but still drops prose comments', () => {
  // a, b (prose) + c, d (fenced `// c d`, counted) = 4. The `js` info string on the opening fence
  // contributes 0 (fence-marker lines are dropped, like `#`/`-` markers the word regex ignores).
  expect(countWords('a b\n```js\n// c d\n```\n', { excludeCommentLines: true })).toBe(4)
  // Fenced content counts (x, y = 2); a real `//` comment OUTSIDE the fence is still dropped.
  expect(countWords('```\n// x y\n```\n// note here\n', { excludeCommentLines: true })).toBe(2)
})

// Task 12: countUnits backs the status bar's click-to-cycle readout. Every unit is derived from the
// same prose the word counter keeps (fence/comment semantics stay consistent), so the seven cycle
// positions never disagree about what "the document" is.
test('countUnits: words, characters, sentences, paragraphs of plain prose', () => {
  const u = countUnits('Hello world. This is a test.')
  expect(u.words).toBe(6)
  expect(u.characters).toBe(28) // every character incl. spaces + full stops — a standard char count
  expect(u.sentences).toBe(2) // split on `[.!?]+\s`: the trailing full-stopped clause counts too
  expect(u.paragraphs).toBe(1)
})

test('countUnits: pages = words/250 (1dp), reading = ⌈words/230⌉, speaking = ⌈words/130⌉', () => {
  // 500 words gives round numbers for every rate; the formulas are the PRD S13 spec.
  const u = countUnits(Array.from({ length: 500 }, () => 'word').join(' '))
  expect(u.words).toBe(500)
  expect(u.pages).toBe(2.0) // 500/250
  expect(u.readMinutes).toBe(3) // ceil(500/230) = ceil(2.17)
  expect(u.speakMinutes).toBe(4) // ceil(500/130) = ceil(3.85)

  // The mockup's 743-word doc: pages 3.0 and speaking 6 min match the locked design; reading is
  // ceil(743/230) = 4 (the mockup's demo array showed an approximate 3 — the PRD formula is ceil).
  const m = countUnits(Array.from({ length: 743 }, () => 'w').join(' '))
  expect(m.pages).toBe(3.0)
  expect(m.speakMinutes).toBe(6)
  expect(m.readMinutes).toBe(4)
})

test('countUnits: empty text is zero for every unit', () => {
  const u = countUnits('')
  expect(u).toEqual({ words: 0, characters: 0, sentences: 0, paragraphs: 0, pages: 0, readMinutes: 0, speakMinutes: 0 })
})

test('countUnits: excludeCommentLines drops `//` post-it lines from every unit', () => {
  const withComments = countUnits('Real prose here.\n// a comment note.\n')
  expect(withComments.words).toBe(6) // Real, prose, here, a, comment, note
  expect(withComments.sentences).toBe(2)

  const stripped = countUnits('Real prose here.\n// a comment note.\n', { excludeCommentLines: true })
  expect(stripped.words).toBe(3) // the comment line no longer contributes
  expect(stripped.sentences).toBe(1)
  expect(stripped.paragraphs).toBe(1)
})

test('countUnits: sentences are split OUTSIDE fenced code (a code `1. 2.` is not two sentences)', () => {
  // Code content still counts as WORDS (fence semantics, T7), but its full stops never split a
  // sentence — sentence counting always strips fenced blocks first ("split on `[.!?]+\s` outside code").
  const u = countUnits('A first sentence. \n```\nx = 1. y = 2.\n```\nA last one.')
  expect(u.sentences).toBe(2) // "A first sentence." + "A last one." — the code's stops are ignored
  expect(u.words).toBe(10) // prose 6 + fenced x,1,y,2 = 4 (code words are kept)
})

test('countUnits: paragraphs are blank-line separated blocks', () => {
  expect(countUnits('Para one.\n\nPara two here.\n\nThird.').paragraphs).toBe(3)
  expect(countUnits('Just\none\nblock').paragraphs).toBe(1)
})
