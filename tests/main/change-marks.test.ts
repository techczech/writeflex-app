import { test, expect } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { EditorView, type DecorationSet } from '@codemirror/view'
import { changeMarking, changeMarkSpecs, changeMarksOf, reviewMarksOf, resolveChangeRange, sameChangeMarks, setChangeMarkHover, setChangeMarks, type MarkableCard } from '../../src/renderer/src/editor/change-marks'
import { setWriterMode, writerReviewing } from '../../src/renderer/src/editor/writer-review'
import type { Change } from '../../src/preload'

// Task 5 (ADR-0010): resolving a Change to its span in the live buffer for the dock↔document link. The
// rule is provenance-aware — an agent proposal is only in the document once accepted, a writer/reviewer
// edit is in it as soon as it is made — and an exact stored anchor beats a text match. Pure, so unit-level.

function mk(over: Partial<Change>): Change {
  return {
    id: 'c1',
    path: 'draft.md',
    ts: 0,
    provenance: 'agent',
    editClass: 'copy',
    category: null,
    summary: 's',
    oldText: '',
    newText: '',
    status: 'pending',
    isCorrection: false,
    ...over,
  }
}

const DOC = 'Alpha the sprawling opening line beta.'

function decorationCount(state: EditorState): number {
  const view = { state } as EditorView
  return state.facet(EditorView.decorations).reduce((count, layer) => {
    const decorations = typeof layer === 'function' ? layer(view) : layer as DecorationSet
    return count + decorations.size
  }, 0)
}

test('quiet marks decorate in Drafting and in Reviewing alike (ticket 13: the locked frames are in Drafting)', () => {
  let state = EditorState.create({
    doc: DOC,
    extensions: [writerReviewing({ initialMode: 'drafting' }), changeMarking],
  })
  state = state.update({
    effects: setChangeMarks.of({
      marks: [{ id: 'c1', from: 6, to: 32, pending: true, kind: 'edit', marker: 1 }],
      selectedId: null,
    }),
  }).state
  // The highlight and its marker number.
  expect(decorationCount(state)).toBe(2)

  state = state.update({ effects: setWriterMode.of('reviewing') }).state
  expect(decorationCount(state)).toBe(2)
})

// ---- the quiet marks (ticket 13): items, filter, focus → what is drawn ----

const card = (id: string, from: number, to: number, over: Partial<MarkableCard> = {}): MarkableCard => ({
  id, kind: 'edit', status: 'pending', source: { type: 'agent' }, anchor: { from, to }, ...over,
})

test('every shown card is marked with its marker number, in card order; your own edits are not', () => {
  const marks = reviewMarksOf([
    card('a', 0, 5),
    card('w', 6, 9, { source: { type: 'you' } }),
    card('n', 10, 14, { kind: 'note', source: { type: 'reader' } }),
    card('h', 15, 18, { status: 'held', source: { type: 'outside' } }),
  ])
  expect(marks.map((m) => [m.id, m.kind, m.marker, m.pending])).toEqual([
    ['a', 'edit', 1, true],
    ['n', 'note', 3, true],
    ['h', 'edit', 4, false],
  ])
})

test('a quiet fix waiting with no card is a faint, unnumbered mark; shown as a card it is a numbered edit', () => {
  const quiet = [{ id: 'q', anchor: { from: 20, to: 23 } }, { id: 'p', anchor: { from: 30, to: 30 } }]
  const marks = reviewMarksOf([card('a', 0, 5)], quiet)
  expect(marks.map((m) => [m.id, m.kind, m.marker])).toEqual([['a', 'edit', 1], ['q', 'quiet', null], ['p', 'quiet', null]])
  const specs = changeMarkSpecs({ marks, selectedId: null }, DOC.length)
  expect(specs.find((s) => s.id === 'q')).toMatchObject({ className: 'change-mark rv-mark k-quiet', marker: null })
  expect(specs.find((s) => s.id === 'p')?.marker).toEqual({ at: 30, text: '', className: 'rv-mn k-quiet rv-point' })
  // Once Show quiet fixes makes it a card, it is marked once, as that card.
  expect(reviewMarksOf([card('a', 0, 5), card('q', 20, 23)], quiet).filter((m) => m.id === 'q')).toEqual([{ id: 'q', from: 20, to: 23, pending: true, kind: 'edit', marker: 2 }])
})

test('a card the filter hides is not among the cards, so its words carry no mark', () => {
  const all = [card('a', 0, 5), card('n', 10, 14, { kind: 'note' })]
  const commentsOnly = all.filter((c) => c.kind === 'note')
  expect(reviewMarksOf(commentsOnly).map((m) => m.id)).toEqual(['n'])
  expect(changeMarkSpecs({ marks: reviewMarksOf(commentsOnly), selectedId: null }, DOC.length).map((s) => s.id)).toEqual(['n'])
})

test('an edit is violet and a comment amber; no struck or inserted words, only the highlight and the number', () => {
  const specs = changeMarkSpecs({
    marks: [{ id: 'n', from: 10, to: 14, pending: true, kind: 'note', marker: 2 }, { id: 'e', from: 0, to: 5, pending: true, kind: 'edit', marker: 1 }],
    selectedId: null,
  }, DOC.length)
  expect(specs.map((s) => [s.id, s.from, s.to, s.className, s.marker])).toEqual([
    ['e', 0, 5, 'change-mark rv-mark k-edit', { at: 5, text: '1', className: 'rv-mn k-edit' }],
    ['n', 10, 14, 'change-mark rv-mark k-note', { at: 14, text: '2', className: 'rv-mn k-note' }],
  ])
})

test('hover outlines the words (is-linked); focus and selection outline them strongly (is-focus)', () => {
  const marks = [{ id: 'a', from: 0, to: 5, pending: true, marker: 1 }, { id: 'b', from: 6, to: 9, pending: true, marker: 2 }, { id: 'c', from: 10, to: 14, pending: true, marker: 3 }]
  const specs = changeMarkSpecs({ marks, selectedId: 'c', focusedIds: ['b'], hoveredId: 'a' }, DOC.length)
  expect(specs.map((s) => s.className)).toEqual([
    'change-mark rv-mark k-edit is-linked',
    'change-mark rv-mark k-edit is-focus',
    'change-mark rv-mark k-edit is-focus cid-active',
  ])
  expect(specs[0].marker?.className).toBe('rv-mn k-edit is-linked')
})

test('a proposed insertion (no words in the text yet) draws only its number, at the point, with a caret', () => {
  const [spec] = changeMarkSpecs({ marks: [{ id: 'i', from: 7, to: 7, pending: true, kind: 'edit', marker: 4 }], selectedId: null }, DOC.length)
  expect(spec.from).toBe(spec.to)
  expect(spec.marker).toEqual({ at: 7, text: '4', className: 'rv-mn k-edit rv-point' })
})

test('the highlight covers the words, not the spaces around them; the number follows the last word', () => {
  const doc = 'I have made several of these myself, for courses.'
  const from = doc.indexOf('of these')
  const to = doc.indexOf('for courses')
  const [spec] = changeMarkSpecs({ marks: [{ id: 'd', from, to, pending: true, marker: 1 }], selectedId: null }, doc.length, doc)
  expect(doc.slice(spec.from, spec.to)).toBe('of these myself,')
  expect(spec.marker?.at).toBe(spec.to)
  // A span of spaces alone keeps its place rather than vanishing.
  const [space] = changeMarkSpecs({ marks: [{ id: 's', from: 1, to: 2, pending: true, marker: 2 }], selectedId: null }, doc.length, doc)
  expect([space.from, space.to]).toEqual([1, 2])
})

test('marks past the end of the text are not drawn', () => {
  expect(changeMarkSpecs({ marks: [{ id: 'x', from: 2, to: DOC.length + 3, pending: true }], selectedId: null }, DOC.length)).toEqual([])
})

test('the field: hover is its own effect, marks follow typing, and a mark whose words are deleted goes', () => {
  let state = EditorState.create({ doc: DOC, extensions: [changeMarking] })
  state = state.update({ effects: setChangeMarks.of({ marks: [{ id: 'a', from: 6, to: 9, pending: true, marker: 1 }, { id: 'i', from: 20, to: 20, pending: true, marker: 2 }], selectedId: null }) }).state
  state = state.update({ effects: setChangeMarkHover.of('a') }).state
  expect(changeMarksOf(state).hoveredId).toBe('a')
  // Typing before the marks moves them with their words; the hover survives a fresh push of the list.
  state = state.update({ changes: { from: 0, insert: 'So ' } }).state
  expect(changeMarksOf(state).marks.map((m) => [m.id, m.from, m.to])).toEqual([['a', 9, 12], ['i', 23, 23]])
  state = state.update({ effects: setChangeMarks.of({ marks: changeMarksOf(state).marks, selectedId: 'a' }) }).state
  expect(changeMarksOf(state).hoveredId).toBe('a')
  // Deleting the marked words takes the mark away; the insertion point stays.
  state = state.update({ changes: { from: 9, to: 12 } }).state
  expect(changeMarksOf(state).marks.map((m) => m.id)).toEqual(['i'])
})

test('sameChangeMarks lets the margin skip a push that would draw the same thing', () => {
  const a = { marks: [{ id: 'a', from: 0, to: 3, pending: true, kind: 'edit' as const, marker: 1 }], selectedId: null, focusedIds: [] }
  expect(sameChangeMarks(a, { ...a, marks: [{ ...a.marks[0] }] })).toBe(true)
  expect(sameChangeMarks(a, { ...a, focusedIds: ['a'] })).toBe(false)
  expect(sameChangeMarks(a, { ...a, marks: [{ ...a.marks[0], marker: 2 }] })).toBe(false)
})

test('a pending agent proposal marks its ORIGINAL text (it is not in the document yet)', () => {
  const r = resolveChangeRange(DOC, mk({ provenance: 'agent', status: 'pending', oldText: 'the sprawling opening line', newText: 'the tight line' }))
  expect(r).toEqual({ from: 6, to: 32 })
})

test('an accepted agent proposal marks its NEW text (now in the document)', () => {
  const applied = 'Alpha the tight line beta.'
  const r = resolveChangeRange(applied, mk({ provenance: 'agent', status: 'accepted', oldText: 'the sprawling opening line', newText: 'the tight line' }))
  expect(r).toEqual({ from: 6, to: 20 })
})

test('a rejected agent proposal falls back to its original text', () => {
  const r = resolveChangeRange(DOC, mk({ provenance: 'agent', status: 'rejected', oldText: 'sprawling', newText: 'tight' }))
  expect(DOC.slice(r!.from, r!.to)).toBe('sprawling')
})

test('a pending WRITER edit marks its NEW text — it is already in the document (Codex P2)', () => {
  // The writer typed it; ledger status 'pending' means unreviewed, not un-applied. Resolving by oldText
  // (the agent rule) would miss it entirely.
  const r = resolveChangeRange(DOC, mk({ provenance: 'writer', status: 'pending', oldText: 'the dull opening line', newText: 'the sprawling opening line' }))
  expect(DOC.slice(r!.from, r!.to)).toBe('the sprawling opening line')
})

test('a valid stored anchor wins even when the text is not unique', () => {
  const doc = 'x TAG y TAG z'
  const r = resolveChangeRange(doc, mk({ provenance: 'writer', status: 'pending', newText: 'TAG', anchor: { from: 8, to: 11 } }))
  expect(r).toEqual({ from: 8, to: 11 }) // the SECOND occurrence, which a text match could never pick
})

test('a stale anchor (slice no longer matches) falls back to a unique text match', () => {
  const r = resolveChangeRange(DOC, mk({ provenance: 'agent', status: 'pending', oldText: 'sprawling', anchor: { from: 0, to: 3 } }))
  expect(DOC.slice(r!.from, r!.to)).toBe('sprawling')
})

test('non-unique text with no anchor resolves to nothing', () => {
  expect(resolveChangeRange('TAG and TAG', mk({ provenance: 'agent', status: 'pending', oldText: 'TAG' }))).toBeNull()
})

test('a writer deletion (empty new text) resolves to no mark, not the removed text elsewhere (Codex P2)', () => {
  // 'gone' is still findable in the buffer, but the writer deleted it — a deletion has no span to mark.
  const r = resolveChangeRange('keep gone keep', mk({ provenance: 'writer', status: 'pending', oldText: 'gone', newText: '' }))
  expect(r).toBeNull()
})

test('an ANCHORED deletion still resolves to nothing — the anchor is not a span to mark (Codex P2)', () => {
  // A stale anchor over surviving text must not resurrect a deleted change's link.
  const r = resolveChangeRange('keep gone keep', mk({ provenance: 'writer', status: 'pending', oldText: 'gone', newText: '', anchor: { from: 0, to: 4 } }))
  expect(r).toBeNull()
})

test('an anchored WHITESPACE-only edit still resolves — it is present, just not text-matchable (Codex P2)', () => {
  // A writer adds a blank line; its text is a newline (never unique), so the exact anchor locates it.
  const doc = 'a\n\nb'
  const r = resolveChangeRange(doc, mk({ provenance: 'writer', status: 'pending', oldText: '', newText: '\n', anchor: { from: 1, to: 2 } }))
  expect(r).toEqual({ from: 1, to: 2 })
})

// A replacement the store minimised to a pure insertion (proposed-replacement.ts) keeps an empty oldText
// and a zero-width anchor at the insertion point. Pending, it must resolve to that point so the proposal
// renders inline; decided, or with no text to insert, it has nothing to mark.
test('a pending agent replacement minimised to a pure insertion resolves to its zero-width anchor', () => {
  const doc = 'teh cat sat on mat by the door.'
  const r = resolveChangeRange(doc, mk({ provenance: 'agent', status: 'pending', oldText: '', newText: 'the ', anchor: { from: 15, to: 15 } }))
  expect(r).toEqual({ from: 15, to: 15 })
  const held = resolveChangeRange(doc, mk({ provenance: 'agent', status: 'held', oldText: '', newText: 'the ', anchor: { from: 15, to: 15 } }))
  expect(held).toEqual({ from: 15, to: 15 })
})

test('a minimised pure insertion resolves to nothing once rejected, out of bounds, or without an anchor', () => {
  const doc = 'teh cat sat on mat by the door.'
  expect(resolveChangeRange(doc, mk({ provenance: 'agent', status: 'rejected', oldText: '', newText: 'the ', anchor: { from: 15, to: 15 } }))).toBeNull()
  expect(resolveChangeRange(doc, mk({ provenance: 'agent', status: 'pending', oldText: '', newText: 'the ', anchor: { from: 99, to: 99 } }))).toBeNull()
  expect(resolveChangeRange(doc, mk({ provenance: 'agent', status: 'pending', oldText: '', newText: 'the ' }))).toBeNull()
  expect(resolveChangeRange(doc, mk({ provenance: 'agent', status: 'pending', oldText: '', newText: '', anchor: { from: 15, to: 15 } }))).toBeNull()
})

// Agent insertions (prose.insert): no text is in the buffer yet, so they resolve to a ZERO-WIDTH point
// where the new text will appear inline — never null. An empty/missing anchor appends at the end so a
// staged insertion is always visible in the document rather than surviving only as a review-pane card.
test('an insertion with an empty anchor resolves to a zero-width point at the end of the document', () => {
  const doc = '# Draft\n\nOne.\n'
  const r = resolveChangeRange(doc, mk({ editClass: 'insert', status: 'pending', oldText: '', newText: 'Two.', insertAfter: '' }))
  expect(r).toEqual({ from: doc.length, to: doc.length })
})

test('an insertion after a unique anchor resolves to a zero-width point just past it', () => {
  const doc = '# Draft\n\nOne.\n\nThree.\n'
  const r = resolveChangeRange(doc, mk({ editClass: 'insert', status: 'pending', oldText: '', newText: 'Two.', insertAfter: 'One.' }))
  expect(r).toEqual({ from: 13, to: 13 })
})

test('an insertion whose anchor has drifted away appends at the end rather than vanishing', () => {
  const doc = '# Draft\n\nOne.\n'
  const r = resolveChangeRange(doc, mk({ editClass: 'insert', status: 'pending', oldText: '', newText: 'Two.', insertAfter: 'Vanished anchor.' }))
  expect(r).toEqual({ from: doc.length, to: doc.length })
})
