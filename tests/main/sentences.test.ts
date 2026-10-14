import { describe, expect, test } from 'bun:test'
import { segmentSentences, leadLength } from '../../src/renderer/src/editor/sentences'

// Task 1 (Round A): prose-aware sentence segmentation — the shared pure module feeding the focus
// modes now and read-aloud later. Offsets are absolute (shifted by `from`), boundaries are
// abbreviation-aware, and closing quotes/brackets stay with their sentence.

test('splits plain sentences with offsets', () => {
  const t = 'One here. Two there! Three?'
  expect(segmentSentences(t)).toEqual([
    { from: 0, to: 9 },
    { from: 10, to: 20 },
    { from: 21, to: 27 },
  ])
})

test('does not split abbreviations or decimals', () => {
  const t = 'See e.g. the 3.5 release by Dr. Smith. Then stop.'
  expect(segmentSentences(t).length).toBe(2)
})

test('keeps closing quotes with the sentence', () => {
  const t = '“Done.” Next one.'
  expect(segmentSentences(t)[0]).toEqual({ from: 0, to: 7 })
})

test('offsets shift by from', () => {
  expect(segmentSentences('Hi. Yo.', 100)[1].from).toBe(104)
})

test('lead length ramp', () => {
  expect(leadLength('a')).toBe(1)
  expect(leadLength('word')).toBe(2)
  expect(leadLength('anchored')).toBe(3)
  expect(leadLength('extraordinarily')).toBe(6)
})

describe('boundary details', () => {
  test('a single capital initial does not end a sentence', () => {
    expect(segmentSentences('Written by J. Smith. The end.').length).toBe(2)
  })

  test('an ellipsis followed by a capital is a boundary; followed by lowercase it is not', () => {
    expect(segmentSentences('He waited… Then he left.').length).toBe(2)
    expect(segmentSentences('He waited… and left.').length).toBe(1)
  })

  test('a terminator-less tail still counts as a sentence', () => {
    expect(segmentSentences('Done. And a trailing fragment')).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 29 },
    ])
  })

  test('closing bracket after the terminator stays inside', () => {
    expect(segmentSentences('(All done.) Next.')[0]).toEqual({ from: 0, to: 11 })
  })

  test('a boundary can be followed by an opening quote', () => {
    const t = 'He spoke. “Quiet now.”'
    expect(segmentSentences(t)).toEqual([
      { from: 0, to: 9 },
      { from: 10, to: 22 },
    ])
  })

  test('empty and whitespace-only input yield no sentences', () => {
    expect(segmentSentences('')).toEqual([])
    expect(segmentSentences('   \n ')).toEqual([])
  })

  test('lead length ignores punctuation when measuring the word', () => {
    // “word,” strips to 4 letters → 2; a bare em-dash token has no letters → still ≥ 1.
    expect(leadLength('word,')).toBe(2)
    expect(leadLength('—')).toBe(1)
  })
})
