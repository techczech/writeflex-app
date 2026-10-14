import { expect, test } from 'bun:test'
import { EditorState, Text } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import { ANCHORED_MARGIN, advanceAnchored, anchoredRanges, buildAnchoredWindow, type AnchoredValue } from '../../src/renderer/src/editor/anchored-reading'

const marks = (deco: DecorationSet): Array<[number, number]> => {
  const out: Array<[number, number]> = []
  const cursor = deco.iter()
  for (; cursor.value; cursor.next()) out.push([cursor.from, cursor.to])
  return out
}
const fresh = (doc: Text, from: number, to: number): Array<[number, number]> => marks(buildAnchoredWindow(doc, from, to).deco)

const LINES = Array.from({ length: 40 }, (_, i) => `Line ${i} carries several ordinary words, plus extraordinary ones.`)
const DOC = LINES.join('\n')

/** Apply `spec` as one transaction and advance `value`, as the view plugin does. */
function edit(value: AnchoredValue, doc: string, spec: { from: number; to?: number; insert?: string }[]): { value: AnchoredValue; doc: string } {
  const state = EditorState.create({ doc })
  const tr = state.update({ changes: spec })
  const next = tr.state.doc
  return { value: advanceAnchored(value, tr.changes, next, 0, next.length), doc: next.toString() }
}

test('marks are the lead-in of each word, line by line', () => {
  const doc = Text.of(['Hi there', '  extraordinary'])
  expect(marks(Decoration_set(doc))).toEqual([[0, 1], [3, 5], [11, 16]])
})
function Decoration_set(doc: Text): DecorationSet {
  return buildAnchoredWindow(doc, 0, doc.length).deco
}

test('a small document is decorated whole', () => {
  const doc = Text.of(DOC.split('\n'))
  expect(anchoredRanges(doc, 0, doc.length).length).toBeGreaterThan(200)
})

test('edits keep the marks identical to a full rebuild: insert, delete, newline, paste, join', () => {
  const edits: { from: number; to?: number; insert?: string }[][] = [
    [{ from: 10, insert: 'x' }],
    [{ from: 5, to: 40 }],
    [{ from: 20, insert: '\n\n' }],
    [{ from: 100, insert: 'A pasted paragraph, with several words.\nAnd a second line.\n' }],
    [{ from: LINES[0].length, to: LINES[0].length + 1 }], // join lines 0 and 1
    [{ from: 0, to: 0, insert: 'Start ' }, { from: DOC.length, insert: ' end' }],
    [{ from: 0, to: DOC.length }], // delete everything
  ]
  for (const spec of edits) {
    const doc = Text.of(DOC.split('\n'))
    const result = edit(buildAnchoredWindow(doc, 0, doc.length), DOC, spec)
    expect(marks(result.value.deco)).toEqual(fresh(Text.of(result.doc.split('\n')), 0, result.doc.length))
  }
})

test('a window over a long document decorates the view plus margin and scrolling extends it', () => {
  const long = Text.of(Array.from({ length: 3000 }, (_, i) => `Row ${i} has a handful of ordinary words in it.`))
  const small = buildAnchoredWindow(long, 0, 500)
  expect(small.to).toBeLessThan(500 + ANCHORED_MARGIN + 100)
  expect(small.to).toBeLessThan(long.length / 2)
  const scrolled = advanceAnchored(small, null, long, 3000, 3500)
  // Everything in the new window is decorated exactly as a fresh build would decorate it.
  const expected = anchoredRanges(long, scrolled.from, scrolled.to).map((range) => [range.from, range.to])
  expect(marks(scrolled.deco)).toEqual(expected)
  // A jump far away rebuilds around the new view instead of keeping the old window.
  const jumped = advanceAnchored(small, null, long, long.length - 500, long.length)
  expect(jumped.from).toBeGreaterThan(small.to)
  expect(marks(jumped.deco)).toEqual(anchoredRanges(long, jumped.from, jumped.to).map((range) => [range.from, range.to]))
})

test('an edit outside the window is mapped, not rebuilt, and the window still matches a fresh build', () => {
  const rows = Array.from({ length: 3000 }, (_, i) => `Row ${i} has a handful of ordinary words in it.`)
  const text = rows.join('\n')
  const doc = Text.of(rows)
  const window = buildAnchoredWindow(doc, 0, 500)
  const state = EditorState.create({ doc: text })
  const tr = state.update({ changes: { from: text.length - 5, insert: 'zzz ' } })
  const next = advanceAnchored(window, tr.changes, tr.state.doc, 0, 500)
  expect(next.to).toBe(window.to)
  expect(marks(next.deco)).toEqual(anchoredRanges(tr.state.doc, next.from, next.to).map((range) => [range.from, range.to]))
})
