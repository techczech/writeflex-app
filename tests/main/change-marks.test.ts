import { test, expect } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { EditorView, type DecorationSet } from '@codemirror/view'
import { changeMarking, resolveChangeRange, setChangeMarks } from '../../src/renderer/src/editor/change-marks'
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

test('change marks retain their data but decorate only in Reviewing', () => {
  let state = EditorState.create({
    doc: DOC,
    extensions: [writerReviewing({ initialMode: 'drafting' }), changeMarking],
  })
  state = state.update({
    effects: setChangeMarks.of({
      marks: [{ id: 'c1', from: 6, to: 32, pending: true }],
      selectedId: 'c1',
    }),
  }).state
  expect(decorationCount(state)).toBe(0)

  state = state.update({ effects: setWriterMode.of('reviewing') }).state
  expect(decorationCount(state)).toBeGreaterThan(0)
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
