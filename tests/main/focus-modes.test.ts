import { expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import {
  breakupCacheStats,
  breakupDecorations,
  breakupSpec,
  blockRangesOf,
  caretSentence,
  focusCompartment,
  focusExtension,
  getFocusConfig,
  normaliseFocusMode,
  normaliseLeadStyle,
  overlapsFindMatch,
  paragraphAt,
} from '../../src/renderer/src/editor/focus-modes'
import { segmentSentences } from '../../src/renderer/src/editor/sentences'

// Task 2 (Round A): the pure geometry the focus-mode decorations are built from. The decoration
// layers themselves are exercised live in tests/e2e/focus-modes.spec.ts; here we pin the
// paragraph/sentence/breakup maths that every mode shares.

const TWO_PARAS = 'One here. Two there.\n\nThird now. Fourth ends.'

const DOMINIK_STYLE_DOCUMENT = [
  '# Shopping',
  'This prose follows its heading without a blank line.',
  '## Before leaving',
  '- check the fridge',
  '- write a list',
  '- take the bags',
].join('\n')

const blockTexts = (text: string): string[] =>
  blockRangesOf(text).map((range) => text.slice(range.from, range.to))

test('a typed newline starts a new block in a document with no blank lines', () => {
  expect(blockTexts(DOMINIK_STYLE_DOCUMENT)).toEqual([
    '# Shopping',
    'This prose follows its heading without a blank line.',
    '## Before leaving',
    '- check the fridge',
    '- write a list',
    '- take the bags',
  ])
})

test('headings, list items, blockquotes, table rows, and fence lines remain separate blocks', () => {
  const text = [
    '# Heading',
    '- list item',
    '> quoted line',
    '| A | B |',
    '| - | - |',
    '```',
    'code()',
    '```',
  ].join('\n')
  expect(blockTexts(text)).toEqual(text.split('\n'))
})

test('an indented continuation stays inside its open list item', () => {
  const text = [
    '- first item',
    '  continued on the next typed line',
    '  and continued once more',
    '- second item',
  ].join('\n')
  expect(blockTexts(text)).toEqual([
    '- first item\n  continued on the next typed line\n  and continued once more',
    '- second item',
  ])
  expect(paragraphAt(text, text.indexOf('continued'))).toEqual({
    from: 0,
    to: text.lastIndexOf('\n'),
  })
})

test('a soft-wrappable long typed line remains one block', () => {
  const text = 'This is one deliberately long prose line that an editor may wrap visually across several screen lines without adding any typed newline or document structure.'
  expect(blockRangesOf(text)).toEqual([{ from: 0, to: text.length }])
})

test('paragraphAt finds blocks on either side of a blank separator', () => {
  expect(paragraphAt(TWO_PARAS, 0)).toEqual({ from: 0, to: 20 })
  expect(paragraphAt(TWO_PARAS, 15)).toEqual({ from: 0, to: 20 })
  expect(paragraphAt(TWO_PARAS, 25)).toEqual({ from: 22, to: 45 })
  // A position on the blank separator belongs to no paragraph.
  expect(paragraphAt(TWO_PARAS, 21)).toBeNull()
})

test('paragraphAt tolerates leading/trailing blank lines', () => {
  const t = '\n\nAlone.\n\n'
  expect(paragraphAt(t, 4)).toEqual({ from: 2, to: 8 })
  expect(paragraphAt(t, 0)).toBeNull()
})

test('caretSentence picks the sentence containing the caret', () => {
  const sentences = segmentSentences('One here. Two there.')
  expect(caretSentence(sentences, 3)).toEqual({ from: 0, to: 9 })
  expect(caretSentence(sentences, 12)).toEqual({ from: 10, to: 20 })
  // On the boundary (right after the full stop) the just-finished sentence stays active.
  expect(caretSentence(sentences, 9)).toEqual({ from: 0, to: 9 })
  // In the inter-sentence gap the PRECEDING sentence stays active (the writer just ended it).
  expect(caretSentence([{ from: 0, to: 9 }, { from: 12, to: 20 }], 10)).toEqual({ from: 0, to: 9 })
  expect(caretSentence([], 5)).toBeNull()
})

test('breakupSpec numbers sentences continuously and breaks before each non-first sentence of a paragraph', () => {
  const spec = breakupSpec(TWO_PARAS)
  expect(spec.sentences.map((s) => ({ from: s.from, to: s.to, n: s.n }))).toEqual([
    { from: 0, to: 9, n: 1 },
    { from: 10, to: 20, n: 2 },
    { from: 22, to: 32, n: 3 },
    { from: 33, to: 45, n: 4 },
  ])
  // Line-break widgets go before sentences 2 and 4 only — paragraph starts already sit on new lines.
  expect(spec.breaks).toEqual([10, 33])
})

// The breakup field's decorations, flattened for inspection: [from, to, class] per mark/widget.
const flattenBreakup = (deco: DecorationSet): Array<{ from: number; to: number; cls: string }> => {
  const out: Array<{ from: number; to: number; cls: string }> = []
  deco.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => {
    out.push({ from, to, cls: (value.spec as { class?: string }).class ?? '' })
  })
  return out
}
const activeFroms = (deco: DecorationSet): number[] =>
  flattenBreakup(deco).filter((mark) => mark.cls.includes('wf-break-active')).map((mark) => mark.from)

test('breakup re-segments only on doc change; caret moves reuse the cached spec', () => {
  const state = EditorState.create({
    doc: TWO_PARAS,
    extensions: [focusCompartment.of(focusExtension('breakup', 'contrast'))],
  })
  const afterCreate = breakupCacheStats.segmentations
  expect(activeFroms(breakupDecorations(state)!)).toEqual([0]) // caret at 0 → sentence 1 active

  // Selection-only transaction: NO re-segmentation; the active mark moves to sentence 3 (from 22).
  const moved = state.update({ selection: { anchor: 25 } }).state
  expect(breakupCacheStats.segmentations).toBe(afterCreate)
  expect(activeFroms(breakupDecorations(moved)!)).toEqual([22])
  // The full decoration census is intact after the in-place swap: 4 number marks + 2 break widgets.
  expect(flattenBreakup(breakupDecorations(moved)!).filter((mark) => mark.cls.includes('wf-break-n'))).toHaveLength(4)
  expect(flattenBreakup(breakupDecorations(moved)!).filter((mark) => mark.from === mark.to)).toHaveLength(2)

  // A caret move WITHIN the active sentence changes nothing and reuses the whole value.
  const same = moved.update({ selection: { anchor: 24 } }).state
  expect(breakupCacheStats.segmentations).toBe(afterCreate)
  expect(breakupDecorations(same)).toBe(breakupDecorations(moved))

  // A doc change re-segments once and renumbers from the new text.
  const edited = same.update({ changes: { from: 0, insert: 'X' } }).state
  expect(breakupCacheStats.segmentations).toBe(afterCreate + 1)
  expect(activeFroms(breakupDecorations(edited)!)).toEqual([23]) // everything shifted by the insert
})

test('overlapsFindMatch: search hits exempt a range from dimming, touching is not overlap', () => {
  const matches = [{ from: 10, to: 15 }, { from: 40, to: 44 }]
  expect(overlapsFindMatch(matches, 0, 9)).toBe(false) // clear before
  expect(overlapsFindMatch(matches, 0, 10)).toBe(false) // touching the start is not overlap
  expect(overlapsFindMatch(matches, 15, 20)).toBe(false) // touching the end is not overlap
  expect(overlapsFindMatch(matches, 12, 13)).toBe(true) // inside a match
  expect(overlapsFindMatch(matches, 8, 11)).toBe(true) // straddles a match start
  expect(overlapsFindMatch(matches, 14, 50)).toBe(true) // spans across both
  expect(overlapsFindMatch(matches, 20, 39)).toBe(false) // the gap between matches
  expect(overlapsFindMatch([], 0, 100)).toBe(false) // Find closed: nothing exempt
})

test('focus config is readable from state and empty mode is a no-op extension', () => {
  const off = EditorState.create({ doc: 'x', extensions: [focusCompartment.of(focusExtension('', 'contrast'))] })
  expect(getFocusConfig(off)).toEqual({ mode: '', leadStyle: 'contrast' })
  const on = EditorState.create({ doc: 'x', extensions: [focusCompartment.of(focusExtension('anchored', 'bold'))] })
  expect(getFocusConfig(on)).toEqual({ mode: 'anchored', leadStyle: 'bold' })
})

test('normalisers fall back to Off / Contrast on anything unexpected', () => {
  expect(normaliseFocusMode('fade')).toBe('fade')
  expect(normaliseFocusMode('anchored')).toBe('anchored')
  expect(normaliseFocusMode('nonsense')).toBe('')
  expect(normaliseFocusMode(null)).toBe('')
  expect(normaliseLeadStyle('colour')).toBe('colour')
  expect(normaliseLeadStyle('color')).toBe('contrast')
  expect(normaliseLeadStyle(undefined)).toBe('contrast')
})
