import { describe, expect, test } from 'bun:test'
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { history, redo, undo } from '@codemirror/commands'
import {
  acceptedPlacementEffect, anchorDiff, beginCapture, captureIsCurrent, finishCut, insertWithAnchor, insertionPoint, liveAnchors, removeAnchorText, scratchpadEditing, sectionHeadingAt,
  externalReconciliation, writableState,
} from '../../src/renderer/src/scratchpad/scratchpad-editor'
import { textChanges } from '../../src/shared/text-diff'
import { skipWriterReviewTracking } from '../../src/renderer/src/editor/writer-review'

// The CodeMirror capture/history seam (ticket 01) on real editor states with real history: the captured
// span is exact, a cut removes only the unchanged span, an inserted fragment carries an explicit anchor
// that Undo and Redo move with the text, and equal prose elsewhere never counts as a placement.

type Port = { state: EditorState; dispatch: (spec: TransactionSpec | Transaction) => void; log: Transaction[] }
const open = (doc: string, anchor: number, head = anchor): Port => {
  const port = { state: EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [history(), scratchpadEditing()] }), log: [] } as unknown as Port
  port.dispatch = (spec) => {
    const tr = 'startState' in (spec as object) ? (spec as Transaction) : port.state.update(spec as TransactionSpec)
    port.log.push(tr)
    port.state = tr.state
  }
  return port
}
const run = (port: Port, command: typeof undo): boolean => command({ state: port.state, dispatch: (tr) => port.dispatch(tr) })

const SECTION = '## Keeping the record\n\nEach change is recorded **beside** the text.\n\n```md\n## s_abc123\n```\n\n- one\n  - nested\n'
const DOC = `# Paper\n\nIntro paragraph.\n\n${SECTION}\n## Next\n\nTail.\n`

describe('capture', () => {
  test('captures the exact selected source and the heading it sits under', () => {
    const from = DOC.indexOf(SECTION)
    const port = open(DOC, from, from + SECTION.length)
    const capture = beginCapture(port, 'paper.md')!
    expect(capture.markdown).toBe(SECTION)
    expect(capture.heading).toBe('Paper')
    expect(sectionHeadingAt(port.state, DOC.indexOf('Tail.'))).toBe('Next')
  })

  test('an empty selection captures nothing', () => {
    expect(beginCapture(open(DOC, 3), 'paper.md')).toBeNull()
  })
})

describe('cut removes only an unchanged captured span, after the save', () => {
  test('unchanged: the span goes in one transaction marked as an explicit removal, and Undo restores it', () => {
    const from = DOC.indexOf(SECTION)
    const port = open(DOC, from, from + SECTION.length)
    const capture = beginCapture(port, 'paper.md')!
    expect(port.state.doc.toString()).toBe(DOC) // nothing removed before the save answers
    expect(finishCut(port, capture)).toBe('removed')
    expect(port.state.doc.toString()).toBe(DOC.replace(SECTION, ''))
    expect(port.log.at(-1)!.annotation(skipWriterReviewTracking)).toBe(true)
    run(port, undo)
    expect(port.state.doc.toString()).toBe(DOC)
  })

  test('typing elsewhere while the save was in flight still removes exactly the captured span', () => {
    const from = DOC.indexOf(SECTION)
    const port = open(DOC, from, from + SECTION.length)
    const capture = beginCapture(port, 'paper.md')!
    port.dispatch({ changes: { from: 0, insert: 'Typed. ' } })
    expect(captureIsCurrent(port.state, capture)).toBe(true)
    expect(finishCut(port, capture)).toBe('removed')
    expect(port.state.doc.toString()).toBe(`Typed. ${DOC.replace(SECTION, '')}`)
  })

  test('an edit inside the captured span makes the capture stale: nothing is removed', () => {
    const from = DOC.indexOf(SECTION)
    const port = open(DOC, from, from + SECTION.length)
    const capture = beginCapture(port, 'paper.md')!
    port.dispatch({ changes: { from: from + 5, insert: 'X' } })
    expect(finishCut(port, capture)).toBe('stale')
    expect(port.state.doc.toString()).toContain('## KeXeping the record')
  })

  test('a different document in the editor (a new state) is stale: nothing is removed', () => {
    const from = DOC.indexOf(SECTION)
    const port = open(DOC, from, from + SECTION.length)
    const capture = beginCapture(port, 'paper.md')!
    port.state = EditorState.create({ doc: DOC, extensions: [history(), scratchpadEditing()] })
    expect(finishCut(port, capture)).toBe('stale')
    expect(port.state.doc.toString()).toBe(DOC)
  })
})

describe('insertion with an explicit anchor', () => {
  const PLAIN = '# Part\n\nFirst paragraph.\n\nSecond paragraph.\n'

  test('the fragment lands after the caret\'s block, byte-exact, in one transaction; Undo takes it out and the anchor with it; Redo brings both back', () => {
    const port = open(PLAIN, PLAIN.indexOf('First') + 3)
    const at = insertionPoint(port.state)
    expect(at.after).toBe('First paragraph.')
    const before = port.log.length
    const range = insertWithAnchor(port, at, SECTION, { itemId: 'p_item0001', useId: 'u_use00001', mode: 'put-back' })
    expect(port.log.length).toBe(before + 1)
    expect(port.state.sliceDoc(range.from, range.to)).toBe(SECTION)
    expect(port.state.doc.toString()).toBe(`# Part\n\nFirst paragraph.\n\n${SECTION}\nSecond paragraph.\n`)
    expect(liveAnchors(port.state).map((a) => [a.useId, a.mode])).toEqual([['u_use00001', 'put-back']])

    const placed = port.state
    run(port, undo)
    expect(port.state.doc.toString()).toBe(PLAIN)
    expect(liveAnchors(port.state)).toEqual([])
    expect(anchorDiff(placed, port.state)).toEqual({ added: [], removed: [expect.objectContaining({ useId: 'u_use00001', itemId: 'p_item0001' })] })

    const undone = port.state
    run(port, redo)
    expect(port.state.doc.toString()).toBe(`# Part\n\nFirst paragraph.\n\n${SECTION}\nSecond paragraph.\n`)
    expect(anchorDiff(undone, port.state).added.map((a) => a.useId)).toEqual(['u_use00001'])
  })

  test('deleting the inserted text by hand loses the anchor', () => {
    const port = open(PLAIN, PLAIN.length)
    const range = insertWithAnchor(port, insertionPoint(port.state), 'Kept words.', { itemId: 'p_item0001', useId: 'u_use00002', mode: 'copy' })
    port.dispatch({ changes: { from: range.from, to: range.to } })
    expect(liveAnchors(port.state)).toEqual([])
  })

  test('the same words typed elsewhere are not a placement', () => {
    const port = open(PLAIN, PLAIN.length)
    port.dispatch({ changes: { from: 0, insert: SECTION } })
    expect(liveAnchors(port.state)).toEqual([])
  })

  test('toast Undo removes exactly the anchored text, and editor Undo of that puts it back with its anchor', () => {
    const port = open(PLAIN, PLAIN.indexOf('Second'))
    insertWithAnchor(port, insertionPoint(port.state), 'Inserted.', { itemId: 'p_item0001', useId: 'u_use00003', mode: 'put-back' })
    port.dispatch({ changes: { from: 0, insert: 'Edit first. ' } })
    expect(removeAnchorText(port, 'u_use00003')).toBe('removed')
    expect(port.state.doc.toString()).toBe(`Edit first. ${PLAIN}`)
    run(port, undo)
    expect(liveAnchors(port.state).map((a) => a.useId)).toEqual(['u_use00003'])
    expect(port.state.doc.toString()).toContain('Inserted.')
  })
})

// R3: the toast's selective Undo owns only the insert it made. Any edit inside it (its words or the
// separators it added), including a nested insert, makes it refuse; editor Undo still walks history.
describe('toast Undo after later edits (R3)', () => {
  const PLAIN = '# Part\n\nFirst paragraph.\n\nSecond paragraph.\n'
  const placed = (): { port: Port; range: { from: number; to: number } } => {
    const port = open(PLAIN, PLAIN.indexOf('First'))
    const range = insertWithAnchor(port, insertionPoint(port.state), 'Old words.', { itemId: 'p_item0001', useId: 'u_r3000001', mode: 'copy' })
    return { port, range }
  }

  test('a sentence typed inside the inserted paragraph: refused, and both stay', () => {
    const { port, range } = placed()
    port.dispatch({ changes: { from: range.to, insert: ' A new sentence.' } })
    const before = port.state.doc.toString()
    expect(removeAnchorText(port, 'u_r3000001')).toBe('edited')
    expect(port.state.doc.toString()).toBe(before)
    expect(before).toContain('Old words. A new sentence.')
    run(port, undo) // ordinary Undo is still there: it takes the typing back, in history order
    expect(port.state.doc.toString()).not.toContain('A new sentence.')
    expect(port.state.doc.toString()).toContain('Old words.')
  })

  test('an edit to an owned separator: refused', () => {
    const { port, range } = placed()
    const anchor = liveAnchors(port.state)[0]
    expect(anchor.outerTo).toBeGreaterThan(range.to)
    port.dispatch({ changes: { from: range.to, to: range.to + 1, insert: ' ' } }) // the line end the insert added
    expect(removeAnchorText(port, 'u_r3000001')).toBe('edited')
  })

  test('a nested insert inside the first: the outer refuses, the inner still comes out alone', () => {
    const { port, range } = placed()
    const inner = { pos: range.from + 4, prefix: '', needsLineEnd: false, after: null }
    insertWithAnchor(port, inner, 'NESTED ', { itemId: 'p_item0002', useId: 'u_r3000002', mode: 'copy' })
    expect(removeAnchorText(port, 'u_r3000001')).toBe('edited')
    expect(port.state.doc.toString()).toContain('Old NESTED words.')
    expect(removeAnchorText(port, 'u_r3000002')).toBe('removed')
    expect(port.state.doc.toString()).toContain('Old words.')
  })

  test('edits outside the insert (before it, and typed right after its edge) still map: Undo removes only the insert', () => {
    const { port } = placed()
    port.dispatch({ changes: { from: 0, insert: 'Prefix. ' } })
    const anchor = liveAnchors(port.state)[0]
    port.dispatch({ changes: { from: anchor.outerTo, insert: 'Later work. ' } })
    expect(removeAnchorText(port, 'u_r3000001')).toBe('removed')
    // The insert and its separators went; the words typed at its edge stayed exactly where they were typed.
    expect(port.state.doc.toString()).toBe(`Prefix. ${PLAIN.replace('First paragraph.\n\n', 'First paragraph.\nLater work. \n')}`)
  })

  test('identical words typed by hand are never an owned insert', () => {
    const port = open(PLAIN, 0)
    port.dispatch({ changes: { from: PLAIN.length, insert: '\nOld words.\n' } })
    expect(removeAnchorText(port, 'u_r3000001')).toBe('gone')
  })
})

// R2: a read-only state (saved version, session recall, detached) is never written to.
describe('read-only states (R2)', () => {
  test('a read-only state is not writable, and a toast Undo there changes nothing', () => {
    const port = open('# Part\n\nText.\n', 3)
    insertWithAnchor(port, insertionPoint(port.state), 'Inserted.', { itemId: 'p_item0001', useId: 'u_r2000001', mode: 'copy' })
    expect(writableState(port.state)).toBe(true)
    const historical = EditorState.create({ doc: '# Old version\n', extensions: [EditorState.readOnly.of(true), history(), scratchpadEditing()] })
    expect(writableState(historical)).toBe(false)
    port.state = historical
    expect(removeAnchorText(port, 'u_r2000001')).toBe('read-only')
    expect(port.state.doc.toString()).toBe('# Old version\n')
  })
})

// R4: placement follows editor history through hand deletion, Undo and Redo, and survives a reload of
// unrelated text; a fresh state starts with no anchors (the store invalidates the old claims).
describe('anchors through deletion, Undo/Redo and reloads (R4)', () => {
  const PLAIN = '# Part\n\nFirst paragraph.\n\nSecond paragraph.\n'

  test('deleting the inserted text by hand, Undo brings the anchor back with the words, Redo takes both again', () => {
    const port = open(PLAIN, PLAIN.indexOf('First'))
    const range = insertWithAnchor(port, insertionPoint(port.state), 'Put back words.', { itemId: 'p_item0001', useId: 'u_r4000001', mode: 'put-back' })
    port.dispatch({ changes: { from: range.from, to: range.to }, userEvent: 'delete' })
    const deleted = port.state
    expect(liveAnchors(port.state)).toEqual([])
    run(port, undo)
    expect(port.state.doc.toString()).toContain('Put back words.')
    expect(liveAnchors(port.state).map((a) => a.useId)).toEqual(['u_r4000001'])
    expect(anchorDiff(deleted, port.state).added.map((a) => a.useId)).toEqual(['u_r4000001'])
    run(port, redo)
    expect(port.state.doc.toString()).not.toContain('Put back words.')
    expect(liveAnchors(port.state)).toEqual([])
    run(port, undo)
    expect(liveAnchors(port.state).map((a) => [a.useId, port.state.sliceDoc(a.from, a.to)])).toEqual([['u_r4000001', 'Put back words.']])
  })

  test('a reload changing only unrelated text keeps the anchor in place; one that removes the insert loses it', () => {
    const port = open(PLAIN, PLAIN.indexOf('First'))
    insertWithAnchor(port, insertionPoint(port.state), 'Put back words.', { itemId: 'p_item0001', useId: 'u_r4000002', mode: 'put-back' })
    const now = port.state.doc.toString()
    const outside = now.replace('Second paragraph.', 'Second paragraph, edited elsewhere.')
    port.dispatch({ ...externalReconciliation(port.state, textChanges(now, outside)), annotations: Transaction.addToHistory.of(false) })
    expect(port.state.doc.toString()).toBe(outside)
    const [anchor] = liveAnchors(port.state)
    expect(port.state.sliceDoc(anchor.from, anchor.to)).toBe('Put back words.')
    const gone = outside.replace('Put back words.\n\n', '')
    port.dispatch({ ...externalReconciliation(port.state, textChanges(outside, gone)), annotations: Transaction.addToHistory.of(false) })
    expect(liveAnchors(port.state)).toEqual([])
  })

  test('the smallest change is exact, and null for identical text', () => {
    expect(textChanges('abc', 'abc')).toEqual([])
    expect(textChanges('one two three', 'one 2 three')).toEqual([{ from: 4, to: 7, insert: '2' }])
    expect(textChanges('a😀b', 'a😃b')).toEqual([{ from: 1, to: 3, insert: '😃' }])
  })

  test('a document opened afresh (a new state) carries no anchors', () => {
    expect(liveAnchors(EditorState.create({ doc: PLAIN, extensions: [history(), scratchpadEditing()] }))).toEqual([])
  })
})

// Review F3: edits on both sides are independent changes, not one enclosing replacement.
test('outside reload preserves the explicit anchor between two unrelated edits', () => {
  const port = open('Before.\n\nAfter.\n', 0)
  insertWithAnchor(port, insertionPoint(port.state), 'Anchored words.', { itemId: 'p_item0001', useId: 'u_bracket1', mode: 'put-back' })
  const before = port.state.doc.toString()
  const after = before.replace('Before.', 'Longer before.').replace('After.', 'Different after.')
  port.dispatch({ ...externalReconciliation(port.state, textChanges(before, after)), annotations: Transaction.addToHistory.of(false) })
  expect(port.state.doc.toString()).toBe(after)
  expect(liveAnchors(port.state).map((a) => port.state.sliceDoc(a.from, a.to))).toEqual(['Anchored words.'])
})


test('an external edit inside an anchored insertion keeps its range but refuses selective toast Undo', () => {
  const port = open('Before.\n\nAfter.\n', 0)
  insertWithAnchor(port, insertionPoint(port.state), 'Anchored words.', { itemId: 'p_item0001', useId: 'u_inside01', mode: 'put-back' })
  const before = port.state.doc.toString(), after = before.replace('Anchored words.', 'Anchored changed words.')
  port.dispatch({ ...externalReconciliation(port.state, textChanges(before, after)), annotations: Transaction.addToHistory.of(false) })
  expect(liveAnchors(port.state)).toHaveLength(1)
  expect(liveAnchors(port.state)[0].touched).toBe(true)
  expect(removeAnchorText(port, 'u_inside01')).toBe('edited')
  expect(port.state.doc.toString()).toBe(after)
})

test('an ambiguous deletion among equal paragraphs invalidates the existing anchor instead of claiming its twin', () => {
  const port = open('Start.\n\nRepeated.\n\nEnd.\n', 0)
  insertWithAnchor(port, insertionPoint(port.state), 'Repeated.', { itemId: 'p_item0001', useId: 'u_repeat01', mode: 'put-back' })
  const before = port.state.doc.toString(), after = 'Start.\n\nRepeated.\n\nEnd.\n'
  expect(before.match(/Repeated\./g)).toHaveLength(2)
  port.dispatch({ ...externalReconciliation(port.state, textChanges(before, after)), annotations: Transaction.addToHistory.of(false) })
  expect(port.state.doc.toString()).toBe(after)
  expect(liveAnchors(port.state)).toEqual([])
})

test('disjoint diffs reproduce exact text in either alignment, including Unicode and empty edge lines', () => {
  for (const [before, after] of [
    ['', 'text\n'], ['text\n', ''], ['\n', '\n\n'], ['a😀b\nmid\nlast\n', 'a😃b\nmid\nend\n'],
    ['a\nb\na\nb\n', 'b\na\nb\na\n'],
  ]) {
    for (const reverse of [false, true]) {
      const port = open(before, 0)
      port.dispatch({ changes: textChanges(before, after, reverse) })
      // EditorState itself normalises line endings; its persistence boundary is tested separately.
      expect(port.state.doc.toString()).toBe(after.replace(/\r\n?/g, '\n'))
    }
  }
})


test('outside edits on both sides of an inline insertion preserve its explicit anchor', () => {
  const port = open('', 0)
  insertWithAnchor(port, { pos: 0, prefix: '', needsLineEnd: false, after: null }, 'middle', { itemId: 'p_item0001', useId: 'u_inline01', mode: 'put-back' })
  port.dispatch({ changes: { from: liveAnchors(port.state)[0].outerFrom, insert: 'before ' } })
  port.dispatch({ changes: { from: liveAnchors(port.state)[0].outerTo, insert: ' after' } })
  const before = port.state.doc.toString(), after = before.replace('before', 'BEFORE').replace('after', 'AFTER')
  expect(liveAnchors(port.state).map((a) => port.state.sliceDoc(a.from, a.to))).toEqual(['middle'])
  port.dispatch({ ...externalReconciliation(port.state, textChanges(before, after)), annotations: Transaction.addToHistory.of(false) })
  expect(port.state.doc.toString()).toBe(after)
  expect(liveAnchors(port.state).map((a) => port.state.sliceDoc(a.from, a.to))).toEqual(['middle'])
})

describe('an accepted agent Put back anchor (ticket 04 correction, R1)', () => {
  const BEFORE = '# Draft\n\nAlpha paragraph.\n\nOmega paragraph.\n'
  const FRAGMENT = 'A kept fragment from the Scratchpad.'
  const AFTER = `# Draft\n\nAlpha paragraph.\n\n${FRAGMENT}\n\nOmega paragraph.\n`
  // The resolution transaction's minimal change and main's receipt, as EditorPane builds them.
  const change = { from: BEFORE.indexOf('\n\nOmega'), to: BEFORE.indexOf('\n\nOmega'), insert: `\n\n${FRAGMENT}` }
  const receipt = { itemId: 'p_item0001', useId: 'u_agentpb1', markdown: FRAGMENT, from: AFTER.indexOf(FRAGMENT), to: AFTER.indexOf(FRAGMENT) + FRAGMENT.length }

  test('the anchor is born on the one transaction that takes the accepted text; Undo removes both, Redo restores both', () => {
    const port = open(BEFORE, 0)
    const effect = acceptedPlacementEffect(port.state, change, receipt, false)
    expect(effect).not.toBeNull()
    const beforeState = port.state
    port.dispatch({ changes: change, effects: effect!, annotations: Transaction.addToHistory.of(true) })
    expect(port.log).toHaveLength(1) // one history step carries words and anchor together
    expect(port.state.doc.toString()).toBe(AFTER)
    const anchors = liveAnchors(port.state)
    expect(anchors).toHaveLength(1)
    expect(anchors[0]).toMatchObject({ itemId: 'p_item0001', useId: 'u_agentpb1', mode: 'put-back' })
    expect(port.state.sliceDoc(anchors[0].from, anchors[0].to)).toBe(FRAGMENT) // Show in document resolves this
    expect(anchorDiff(beforeState, port.state).added.map((a) => a.useId)).toEqual(['u_agentpb1'])

    const placedState = port.state
    expect(run(port, undo)).toBe(true)
    expect(port.state.doc.toString()).toBe(BEFORE)
    expect(liveAnchors(port.state)).toHaveLength(0)
    expect(anchorDiff(placedState, port.state).removed.map((a) => a.useId)).toEqual(['u_agentpb1'])

    expect(run(port, redo)).toBe(true)
    expect(port.state.doc.toString()).toBe(AFTER)
    expect(liveAnchors(port.state).map((a) => a.useId)).toEqual(['u_agentpb1'])
    expect(port.state.sliceDoc(liveAnchors(port.state)[0].from, liveAnchors(port.state)[0].to)).toBe(FRAGMENT)
  })

  test('a receipt that does not match the dispatched change anchors nothing', () => {
    const port = open(BEFORE, 0)
    // Fragment text elsewhere in the document is never searched for: wrong offsets refuse.
    expect(acceptedPlacementEffect(port.state, change, { ...receipt, from: 0, to: FRAGMENT.length }, false)).toBeNull()
    expect(acceptedPlacementEffect(port.state, change, { ...receipt, markdown: 'Different words altogether here.' }, false)).toBeNull()
    // Pending Reviewing spans (raw/clean coordinates differ) refuse rather than mis-anchor.
    expect(acceptedPlacementEffect(port.state, change, receipt, true)).toBeNull()
    expect(liveAnchors(port.state)).toHaveLength(0)
  })

  test('a read-only state anchors nothing', () => {
    const port = open(BEFORE, 0)
    const readOnly = EditorState.create({ doc: BEFORE, extensions: [EditorState.readOnly.of(true), scratchpadEditing()] })
    expect(acceptedPlacementEffect(readOnly, change, receipt, false)).toBeNull()
    expect(port.state.doc.toString()).toBe(BEFORE)
  })
})
