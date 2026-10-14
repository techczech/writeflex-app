import { expect, spyOn, test } from 'bun:test'
import { history, redo, undo, undoDepth } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import {
  documentTextForPersistence,
  foldReviewingChanges,
  materialiseDraftingChanges,
  pendingWriterChanges,
  resolveWriterChangeSpec,
  skipWriterReviewTracking,
  visibleWriterMarks,
  writerReviewModeOf,
  writerReviewing,
} from '../../src/renderer/src/editor/writer-review'

// Property test for the writer-review ledger over random sequences of writer edits, untracked edits,
// bursts of disk reconciles, undo, redo and mode switches. The invariants (writer-review.ts header):
// I1 nothing throws, and no guard or stale-range diagnostic fires (console.error fails the test);
// I2 a record (Drafting) or mark (Reviewing) that no change touches survives with the same identity
//    and text, its position mapped by mapPos — through undo and redo too;
// I3 undo then redo restores document, records, marks and mode exactly;
// I4 in Reviewing, rejecting a record replaces exactly its range with its old text, accepting
//    removes exactly its strike, the record leaves the marks, and persistence is the buffer minus
//    every old-role span;
// I5 the generator is not vacuous: at least 40% of steps run with a non-empty ledger;
// I6 one contiguous range per record: in Reviewing at most one old and one new mark per id, the old
//    ending where the new begins; in Drafting one record per id.

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const START = ['# One', '', 'Alpha beta gamma.', '', '## Two', '', 'Delta epsilon zeta eta.', '', 'Closing line here.', ''].join('\n')
const WORDS = ['x', 'new ', '**', 'word', 'zz', ' ', '', '\n\n']

type Snapshot = { doc: string; records: string; marks: string; mode: string }
const snapshotOf = (state: EditorState): Snapshot => ({
  doc: state.doc.toString(),
  records: JSON.stringify(pendingWriterChanges(state)),
  marks: JSON.stringify(visibleWriterMarks(state)),
  mode: writerReviewModeOf(state),
})

type Range = { from: number; to: number }

/** "Touched": the transaction's own changes intersect the range, or — for an undo or redo — the
 *  forward-mapped footprint of the event it reverts does (ShadowHistory). */
const touches = (tr: Transaction, from: number, to: number, footprint: readonly Range[] = []): boolean => {
  let touched = footprint.some((range) => range.from <= to && range.to >= from)
  tr.changes.iterChangedRanges((fromA, toA) => { if (fromA <= to && toA >= from) touched = true })
  return touched
}

const rangesOf = (tr: Transaction, side: 'A' | 'B'): Range[] => {
  const ranges: Range[] = []
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => ranges.push(side === 'A' ? { from: fromA, to: toA } : { from: fromB, to: toB }))
  return ranges
}

/**
 * The test's own model of undo history, for the I2 oracle on undo/redo. Each history event keeps its
 * footprint: its changed ranges plus the writer's requested range (a Reviewing deletion strikes text
 * without changing it). Whether a step joined the previous event is read from CodeMirror itself
 * (undoDepth did not grow). Ranges map forward through every later transaction; undo pops, redo
 * pushes back.
 */
class ShadowHistory {
  private done: Array<{ actual: Range[]; footprint: Range[] }> = []
  private undone: Array<{ actual: Range[]; footprint: Range[] }> = []

  private mapAll(tr: Transaction): void {
    const map = (ranges: Range[]) => ranges.map((range) => ({ from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(range.to, 1) }))
    const mapEntry = (entry: { actual: Range[]; footprint: Range[] }) => ({ actual: map(entry.actual), footprint: map(entry.footprint) })
    this.done = this.done.map(mapEntry)
    this.undone = this.undone.map(mapEntry)
  }

  /** A history step that is not an undo or redo. `requested` is the spec's range, in start coordinates. */
  record(tr: Transaction, requested: readonly Range[] = []): void {
    const depthBefore = undoDepth(tr.startState)
    const depthAfter = undoDepth(tr.state)
    if (depthAfter === depthBefore && (tr.changes.empty || this.done.length === 0)) {
      this.mapAll(tr)
      return
    }
    const joins = depthAfter === depthBefore
    this.mapAll(tr)
    const actual = rangesOf(tr, 'B')
    const footprint = [...actual, ...requested.map((range) => ({ from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(range.to, 1) }))]
    if (joins) this.done[this.done.length - 1] = { actual: [...this.done.at(-1)!.actual, ...actual], footprint: [...this.done.at(-1)!.footprint, ...footprint] }
    else this.done.push({ actual, footprint })
    this.undone = []
  }

  /** A change outside history (a reconcile). */
  carry(tr: Transaction): void {
    this.mapAll(tr)
  }

  /** The footprint (start coordinates) of the event an undo or redo reverts. */
  revert(tr: Transaction, side: 'undo' | 'redo'): Range[] {
    const from = side === 'undo' ? this.done : this.undone
    const entry = from.pop()
    const footprint = [...(entry?.footprint ?? []), ...rangesOf(tr, 'A')]
    this.mapAll(tr)
    if (entry) {
      const map = (ranges: Range[]) => ranges.map((range) => ({ from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(range.to, 1) }))
      ;(side === 'undo' ? this.undone : this.done).push({ actual: map(rangesOf(tr, 'A').length ? rangesOf(tr, 'A') : entry.actual), footprint: map(footprint) })
    }
    return footprint
  }
}

/** I6 on one state. */
function expectOneRangePerRecord(state: EditorState): void {
  if (writerReviewModeOf(state) === 'drafting') {
    const ids = pendingWriterChanges(state).map((change) => change.localId)
    expect(new Set(ids).size).toBe(ids.length)
    return
  }
  const byId = new Map<string, Array<{ role: string; from: number; to: number }>>()
  for (const mark of visibleWriterMarks(state)) byId.set(mark.id, [...(byId.get(mark.id) ?? []), mark])
  for (const group of byId.values()) {
    const olds = group.filter((mark) => mark.role === 'old')
    const news = group.filter((mark) => mark.role === 'new')
    expect(olds.length).toBeLessThanOrEqual(1)
    expect(news.length).toBeLessThanOrEqual(1)
    if (olds[0] && news[0]) expect(olds[0].to).toBe(news[0].from)
  }
}

/**
 * A mode conversion (reveal into Reviewing, fold into Drafting) changes how records are stored, never
 * which records exist: every record keeps its id, its old text and its new text, and its new text is
 * still the document text where it now sits.
 */
function expectConversionPreserves(before: EditorState, after: EditorState): void {
  const identity = (state: EditorState) => pendingWriterChanges(state)
    .map((change) => JSON.stringify([change.localId, change.oldText, change.newText]))
    .sort()
  expect(identity(after)).toEqual(identity(before))
}

/** Every transaction: I2 against its start state, I6 on its result. */
function expectTransaction(tr: Transaction, footprint: readonly Range[] = []): void {
  expectUntouchedSurvive(tr, footprint)
  expectOneRangePerRecord(tr.state)
}

/** I2 over one transaction, against the shadow ledger taken from its start state. */
function expectUntouchedSurvive(tr: Transaction, footprint: readonly Range[] = []): void {
  if (writerReviewModeOf(tr.startState) !== writerReviewModeOf(tr.state)) return
  const doc = tr.state.doc.toString()
  if (writerReviewModeOf(tr.startState) === 'drafting') {
    const after = pendingWriterChanges(tr.state)
    for (const record of pendingWriterChanges(tr.startState)) {
      if (touches(tr, record.anchor.from, record.anchor.to, footprint)) continue
      const from = tr.changes.mapPos(record.anchor.from)
      const to = tr.changes.mapPos(record.anchor.to)
      expect(after).toContainEqual({ ...record, anchor: { from, to } })
      expect(doc.slice(from, to)).toBe(record.newText)
    }
    return
  }
  const after = visibleWriterMarks(tr.state)
  for (const mark of visibleWriterMarks(tr.startState)) {
    if (touches(tr, mark.from, mark.to, footprint)) continue
    expect(after).toContainEqual({ ...mark, from: tr.changes.mapPos(mark.from), to: tr.changes.mapPos(mark.to) })
  }
}

/** Drafting: records never overlap and each newText is the document text over its range. Reviewing:
 *  every mark lies inside the document (a record's anchor there spans its struck AND new text). */
function expectSound(state: EditorState): void {
  const doc = state.doc.toString()
  if (writerReviewModeOf(state) === 'reviewing') {
    for (const mark of visibleWriterMarks(state)) {
      expect(mark.from).toBeGreaterThanOrEqual(0)
      expect(mark.to).toBeLessThanOrEqual(doc.length)
      expect(mark.to).toBeGreaterThan(mark.from)
    }
    // A scratch fold keeps every record, and the folded buffer is exactly what persistence saves.
    const folded = state.update(foldReviewingChanges(state)).state
    expectConversionPreserves(state, folded)
    expect(folded.doc.toString()).toBe(documentTextForPersistence(state))
    return
  }
  let cleanPos = 0
  const sorted = [...pendingWriterChanges(state)].sort((a, b) => a.anchor.from - b.anchor.from || a.anchor.to - b.anchor.to)
  for (const change of sorted) {
    expect(change.anchor.from).toBeGreaterThanOrEqual(cleanPos)
    expect(change.anchor.to).toBeLessThanOrEqual(doc.length)
    expect(doc.slice(change.anchor.from, change.anchor.to)).toBe(change.newText)
    cleanPos = change.anchor.to
  }
  expect(documentTextForPersistence(state)).toBe(doc)
  // A scratch reveal keeps every record, and persists back to exactly this buffer.
  const revealed = state.update(materialiseDraftingChanges(state)).state
  expectConversionPreserves(state, revealed)
  expect(documentTextForPersistence(revealed)).toBe(doc)
}

/** I4 on scratch states: resolving each record in Reviewing touches nothing but its own range. */
function expectLocalResolution(state: EditorState): void {
  const doc = state.doc.toString()
  const marks = visibleWriterMarks(state)
  const oldSpans = [...marks].filter((mark) => mark.role === 'old').sort((a, b) => a.from - b.from)
  let clean = ''
  let pos = 0
  for (const mark of oldSpans) { clean += doc.slice(pos, mark.from); pos = mark.to }
  expect(documentTextForPersistence(state)).toBe(clean + doc.slice(pos))
  for (const id of new Set(marks.map((mark) => mark.id))) expectLocalRecordResolution(state, id)
}

function expectLocalRecordResolution(state: EditorState, id: string): void {
  const doc = state.doc.toString()
  const marks = visibleWriterMarks(state)
  const group = marks.filter((mark) => mark.id === id)
  const oldMark = group.find((mark) => mark.role === 'old')
  const newMark = group.find((mark) => mark.role === 'new')
  const from = Math.min(...group.map((mark) => mark.from))
  const to = Math.max(...group.map((mark) => mark.to))
  const oldText = oldMark ? doc.slice(oldMark.from, oldMark.to) : ''
  const newText = newMark ? doc.slice(newMark.from, newMark.to) : ''

  // Every OTHER record keeps its range (mapped through the resolution) and its text.
  const expectOthersPreserved = (tr: Transaction) => {
    const after = visibleWriterMarks(tr.state)
    for (const mark of marks.filter((candidate) => candidate.id !== id)) {
      const kept = { ...mark, from: tr.changes.mapPos(mark.from), to: tr.changes.mapPos(mark.to) }
      expect(after).toContainEqual(kept)
      expect(tr.state.doc.sliceString(kept.from, kept.to)).toBe(doc.slice(mark.from, mark.to))
    }
  }
  expectOthersPreserved(state.update(resolveWriterChangeSpec(state, id, 'reject')!))
  expectOthersPreserved(state.update(resolveWriterChangeSpec(state, id, 'accept')!))
  const rejected = state.update(resolveWriterChangeSpec(state, id, 'reject')!).state
  expect(rejected.doc.toString()).toBe(doc.slice(0, from) + oldText + doc.slice(to))
  expect(visibleWriterMarks(rejected).some((mark) => mark.id === id)).toBe(false)

  const accepted = state.update(resolveWriterChangeSpec(state, id, 'accept')!).state
  expect(accepted.doc.toString()).toBe(doc.slice(0, from) + newText + doc.slice(to))
  if (oldMark) expect(accepted.doc.toString()).toBe(doc.slice(0, oldMark.from) + doc.slice(oldMark.to))
  expect(visibleWriterMarks(accepted).some((mark) => mark.id === id)).toBe(false)
}

/** Ranges the ledger covers, as [first from, last to], in the current mode's terms. */
function ledgerSpan(state: EditorState): { from: number; to: number } | null {
  const ranges = writerReviewModeOf(state) === 'drafting'
    ? pendingWriterChanges(state).map((change) => change.anchor)
    : visibleWriterMarks(state)
  if (ranges.length === 0) return null
  return { from: Math.min(...ranges.map((r) => r.from)), to: Math.max(...ranges.map((r) => r.to)) }
}

for (const seed of [1, 7, 42, 2026, 31337, 269249, 554333, 728551, 229654, 261330, 348439, 704794, 760227]) {
  test(`seeded ledger sequence ${seed} keeps I1–I6`, () => {
    const random = mulberry32(seed)
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
    const errors = spyOn(console, 'error').mockImplementation(() => undefined)
    const counts = { steps: 0, nonEmpty: 0, reviewing: 0, reconcileBursts: 0, undos: 0, redos: 0, undoRedoPairs: 0 }
    try {
      let state = EditorState.create({
        doc: START,
        extensions: [markdown({ extensions: [GFM] }), history(), writerReviewing({ initialMode: 'drafting' })],
      })
      let caret: number | null = null
      let lastUndo: Snapshot | null = null
      const shadow = new ShadowHistory()

      const apply = (spec: TransactionSpec): boolean => {
        const tr = state.update(spec)
        state = tr.state
        const asked = spec.changes as { from: number; to?: number } | undefined
        const requested = asked ? [{ from: asked.from, to: asked.to ?? asked.from }] : []
        // The writer's own requested range is touched even when Reviewing turns it into a strike.
        expectTransaction(tr, requested)
        if (tr.annotation(Transaction.addToHistory) === false) shadow.carry(tr)
        else shadow.record(tr, requested)
        return tr.docChanged
      }
      const randomChange = () => {
        const length = state.doc.length
        const from = Math.floor(random() * (length + 1))
        const to = random() < 0.3 ? from : Math.min(length, from + 1 + Math.floor(random() * 10))
        return { from, to, insert: pick(WORDS) }
      }

      for (let step = 0; step < 300; step += 1) {
        const roll = random()
        const before = snapshotOf(state)
        let undid = false

        if (roll < 0.15) {
          // A writer edit anywhere.
          const changes = randomChange()
          apply({ changes, userEvent: pick(['input.type', 'delete.backward', 'input.paste']) })
          caret = changes.from + changes.insert.length
        } else if (roll < 0.27) {
          // Keep typing at the caret, so CodeMirror joins keystrokes into one undo event.
          const at: number = Math.min(caret ?? state.doc.length, state.doc.length)
          apply({ changes: { from: at, insert: pick(['a', 'b', ' ', 'c']) }, userEvent: 'input.type' })
          caret = at + 1
        } else if (roll < 0.37) {
          // A command-owned edit (⌘B, ⌘⇧X, block marks): untracked but an undo step.
          apply({ changes: randomChange(), annotations: skipWriterReviewTracking.of(true) })
          caret = null
        } else if (roll < 0.62) {
          // Two or three consecutive disk reconciles, disjoint, before and after the ledger.
          counts.reconcileBursts += 1
          const span = ledgerSpan(state)
          const edits: Array<{ from: number; to: number; insert: string }> = []
          if (span && span.from > 1) {
            const at = Math.floor(random() * (span.from - 1))
            edits.push({ from: at, to: Math.min(at + 1, span.from - 1), insert: pick(['L', 'Ab', '']) })
          }
          if (span && span.to < state.doc.length - 1) {
            const at = span.to + 1 + Math.floor(random() * (state.doc.length - span.to - 1))
            edits.push({ from: at, to: Math.min(state.doc.length, at + 1), insert: pick(['T', 'yz', '']) })
          }
          while (edits.length < 2) edits.push(randomChange())
          for (const changes of edits) {
            const length = state.doc.length
            apply({
              changes: { from: Math.min(changes.from, length), to: Math.min(changes.to, length), insert: changes.insert },
              annotations: [skipWriterReviewTracking.of(true), Transaction.addToHistory.of(false)],
            })
          }
          caret = null
        } else if (roll < 0.77) {
          undo({ state, dispatch: (tr) => { state = tr.state; undid = true; expectTransaction(tr, shadow.revert(tr, 'undo')) } })
          if (undid) counts.undos += 1
          caret = null
        } else if (roll < 0.9) {
          let redone = false
          redo({ state, dispatch: (tr) => { state = tr.state; redone = true; expectTransaction(tr, shadow.revert(tr, 'redo')) } })
          if (redone) counts.redos += 1
          if (redone && lastUndo) {
            counts.undoRedoPairs += 1
            expect(snapshotOf(state)).toEqual(lastUndo)
          }
          caret = null
        } else {
          // Switch mode the way the app does: reveal into Reviewing, fold back into Drafting.
          const tr = state.update(writerReviewModeOf(state) === 'drafting'
            ? materialiseDraftingChanges(state)
            : foldReviewingChanges(state))
          state = tr.state
          shadow.record(tr)
          expectConversionPreserves(tr.startState, state)
          expectOneRangePerRecord(state)
          caret = null
        }
        lastUndo = undid ? before : null

        expectSound(state)
        if (writerReviewModeOf(state) === 'reviewing') {
          counts.reviewing += 1
          expectLocalResolution(state)
        }
        counts.steps += 1
        if (pendingWriterChanges(state).length > 0) counts.nonEmpty += 1
      }
      expect(errors.mock.calls.map((call) => String(call[0]))).toEqual([])
    } finally {
      errors.mockRestore()
    }
    console.log(`seed ${seed}: ${JSON.stringify(counts)}`)
    expect(counts.nonEmpty / counts.steps).toBeGreaterThanOrEqual(0.4)
  })
}
