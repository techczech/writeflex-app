import { test, expect } from 'bun:test'
import { EditorState } from '@codemirror/state'
import {
  calloutDiff,
  setSuggestionAnchors,
  suggestionAnchorField,
  suggestionAnchors,
  uniqueRange,
} from '../../src/renderer/src/editor/suggestion-anchor'

// Task 16: the anchor field, driven headlessly (the tab-state/agent-chat precedent). An EditorState
// with the field + the setSuggestionAnchors effect stands in for the live view; transactions stand
// in for the writer's edits.

const DOC = '# Draft\n\nThe opening sentence is sprawling and could be tightened.\n\nA second paragraph.\n'
const OLD = 'The opening sentence is sprawling and could be tightened.'

function stateWith(doc: string, specs: Array<{ id: string; oldText: string }>): EditorState {
  const state = EditorState.create({ doc, extensions: [suggestionAnchorField] })
  return state.update({ effects: setSuggestionAnchors.of(specs) }).state
}

test('uniqueRange finds a single occurrence and rejects absent or ambiguous text', () => {
  expect(uniqueRange('a bee c', 'bee')).toEqual({ from: 2, to: 5 })
  expect(uniqueRange('a bee c', 'wasp')).toBeNull()
  expect(uniqueRange('bee and bee', 'bee')).toBeNull()
  expect(uniqueRange('anything', '')).toBeNull()
})

test('the effect anchors a unique oldText to its doc range', () => {
  const state = stateWith(DOC, [{ id: 's1', oldText: OLD }])
  const anchors = suggestionAnchors(state)
  expect(anchors).toHaveLength(1)
  expect(state.sliceDoc(anchors[0].from, anchors[0].to)).toBe(OLD)
})

test('no anchor for text that is absent or matches more than once', () => {
  const absent = stateWith(DOC, [{ id: 's1', oldText: 'not in this document' }])
  expect(suggestionAnchors(absent)).toHaveLength(0)
  const ambiguous = stateWith('twice. twice.', [{ id: 's1', oldText: 'twice.' }])
  expect(suggestionAnchors(ambiguous)).toHaveLength(0)
})

test('an unanchorable spec does not block anchoring the others', () => {
  const state = stateWith(DOC, [
    { id: 'bad', oldText: 'no such sentence' },
    { id: 'good', oldText: 'A second paragraph.' },
  ])
  const anchors = suggestionAnchors(state)
  expect(anchors.map((a) => a.id)).toEqual(['good'])
})

test('the anchor survives edits before it, range shifted', () => {
  const state = stateWith(DOC, [{ id: 's1', oldText: OLD }])
  const next = state.update({ changes: { from: 0, to: 0, insert: 'PREAMBLE ' } }).state
  const anchors = suggestionAnchors(next)
  expect(anchors).toHaveLength(1)
  expect(next.sliceDoc(anchors[0].from, anchors[0].to)).toBe(OLD)
})

test('the anchor survives edits after it, range unchanged', () => {
  const state = stateWith(DOC, [{ id: 's1', oldText: OLD }])
  const before = suggestionAnchors(state)[0]
  const next = state.update({ changes: { from: state.doc.length, to: state.doc.length, insert: 'A coda.\n' } }).state
  const anchors = suggestionAnchors(next)
  expect(anchors[0].from).toBe(before.from)
  expect(next.sliceDoc(anchors[0].from, anchors[0].to)).toBe(OLD)
})

test('typing flush against either edge never pulls the new text into the range', () => {
  const state = stateWith(DOC, [{ id: 's1', oldText: OLD }])
  const { from, to } = suggestionAnchors(state)[0]
  // At the leading edge: the insertion lands OUTSIDE, the anchor shifts right.
  const lead = state.update({ changes: { from, to: from, insert: 'Xx ' } }).state
  expect(lead.sliceDoc(suggestionAnchors(lead)[0].from, suggestionAnchors(lead)[0].to)).toBe(OLD)
  // At the trailing edge: the insertion lands OUTSIDE, the anchor stays put.
  const trail = state.update({ changes: { from: to, to, insert: ' Yy' } }).state
  expect(trail.sliceDoc(suggestionAnchors(trail)[0].from, suggestionAnchors(trail)[0].to)).toBe(OLD)
})

test('the anchor vanishes when the anchored text is edited away', () => {
  const state = stateWith(DOC, [{ id: 's1', oldText: OLD }])
  const { from } = suggestionAnchors(state)[0]
  const next = state.update({ changes: { from: from + 4, to: from + 11, insert: 'shutting' } }).state
  expect(suggestionAnchors(next)).toHaveLength(0)
})

test('a re-sync keeps the TRACKED range for surviving ids and drops departed ids', () => {
  const state = stateWith(DOC, [
    { id: 's1', oldText: OLD },
    { id: 's2', oldText: 'A second paragraph.' },
  ])
  // The user edits ahead of both anchors, shifting them; a suggestions push then re-syncs with s2 gone.
  const edited = state.update({ changes: { from: 0, to: 0, insert: 'NEW LEAD\n\n' } }).state
  const shifted = suggestionAnchors(edited).find((a) => a.id === 's1')!
  const resynced = edited.update({ effects: setSuggestionAnchors.of([{ id: 's1', oldText: OLD }]) }).state
  const anchors = suggestionAnchors(resynced)
  expect(anchors.map((a) => a.id)).toEqual(['s1'])
  expect(anchors[0].from).toBe(shifted.from) // kept the tracked range, not a re-search
  expect(resynced.sliceDoc(anchors[0].from, anchors[0].to)).toBe(OLD)
})

test('anchors keep the pending-list order the specs arrive in', () => {
  const state = stateWith(DOC, [
    { id: 's2', oldText: 'A second paragraph.' },
    { id: 's1', oldText: OLD },
  ])
  expect(suggestionAnchors(state).map((a) => a.id)).toEqual(['s2', 's1'])
})

test('calloutDiff reduces the mockup example to shared prose + del/ins', () => {
  const d = calloutDiff(
    'It has become something of a commonplace to observe that the language we use to describe artificial intelligence is saturated with metaphor.',
    'The language we use to describe artificial intelligence is saturated with metaphor.',
  )
  expect(d.prefix).toBe('')
  expect(d.removed).toBe('It has become something of a commonplace to observe that the')
  expect(d.inserted).toBe('The')
  expect(d.suffix).toBe('language we use to describe artificial intelligence is saturated with metaphor.')
})

test('calloutDiff keeps a shared prefix and suffix around the replaced middle', () => {
  const d = calloutDiff(
    'The opening sentence is sprawling and could be tightened.',
    'The opening sentence sprawls.',
  )
  expect(d.prefix).toBe('The opening sentence')
  expect(d.removed).toBe('is sprawling and could be tightened.')
  expect(d.inserted).toBe('sprawls.')
  expect(d.suffix).toBe('')
})

test('calloutDiff handles a wholesale replacement (nothing shared)', () => {
  const d = calloutDiff('Alpha beta.', 'Gamma delta!')
  expect(d.prefix).toBe('')
  expect(d.removed).toBe('Alpha beta.')
  expect(d.inserted).toBe('Gamma delta!')
  expect(d.suffix).toBe('')
})
