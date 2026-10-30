import { planWidgetInsert } from '../../../shared/widget-insert'
import { documentAssets } from '../../../shared/scratchpad-inventory'
import type { ScratchAssetKind } from '../../../shared/scratchpad-items'
// The floating Scratchpad's CodeMirror half (ticket 01, spec §6–7): exact capture of a selection, a cut
// that removes only the span it captured and only after the Scratchpad answered, and insertions that
// carry an explicit anchor through editor history. Placement is what these anchors say, never what
// matching prose suggests. Pure over EditorState plus a dispatch port, so it runs without a DOM.
import { ChangeSet, StateEffect, StateField, type EditorState, type Extension, type Text, type Transaction, type TransactionSpec } from '@codemirror/state'
import { invertedEffects, isolateHistory } from '@codemirror/commands'
import { textChanges, type TextEdit } from '../../../shared/text-diff'
import { skipWriterReviewTracking } from '../editor/writer-review'

/** What the controller dispatches through: an EditorView, or a test's state holder. */
export type EditorPort = { readonly state: EditorState; dispatch: (spec: TransactionSpec | Transaction) => void }

/**
 * Whether the state in front of the writer may be changed by a Scratchpad action. A saved version, a
 * past session's recall and a detached document are read-only states; CodeMirror's read-only facet stops
 * typing there but not a programmatic dispatch, so every Scratchpad write asks this first (spec §6, R2).
 */
export const writableState = (state: EditorState): boolean => !state.readOnly && state.field(anchorField, false) !== undefined

// ── Pending captures: the span a cut will remove, mapped through edits made while its save is in flight ──

type Pending = { token: string; from: number; to: number; touched: boolean }
const trackCapture = StateEffect.define<Pending>({ map: (p, change) => ({ ...p, from: change.mapPos(p.from, 1), to: change.mapPos(p.to, -1) }) })
const dropCapture = StateEffect.define<string>()

const pendingField = StateField.define<readonly Pending[]>({
  create: () => [],
  update(value, tr) {
    let next = value
    if (tr.docChanged && next.length) {
      next = next.map((p) => ({
        ...p,
        touched: p.touched || tr.changes.touchesRange(p.from, p.to) !== false,
        from: tr.changes.mapPos(p.from, 1),
        to: tr.changes.mapPos(p.to, -1),
      }))
    }
    for (const effect of tr.effects) {
      if (effect.is(trackCapture)) next = [...next, effect.value]
      else if (effect.is(dropCapture)) next = next.filter((p) => p.token !== effect.value)
    }
    return next
  },
})

export type SelectionCapture = {
  token: string
  path: string
  /** The document the span was taken from: a later state of another document never matches. */
  doc: Text
  markdown: string
  heading: string | null
}

let tokenCounter = 0
const newToken = (): string => `c${Date.now().toString(36)}${(tokenCounter++).toString(36)}`

/** Take the main selection exactly as the editor holds it, and start tracking its span. */
export function beginCapture(port: EditorPort, path: string): SelectionCapture | null {
  const { from, to } = port.state.selection.main
  if (from === to || port.state.field(pendingField, false) === undefined) return null
  const token = newToken()
  const capture = { token, path, doc: port.state.doc, markdown: port.state.sliceDoc(from, to), heading: from > 0 ? sectionHeadingAt(port.state, from - 1) : null }
  port.dispatch({ effects: trackCapture.of({ token, from, to, touched: false }) })
  return capture
}

function pendingOf(state: EditorState, capture: SelectionCapture): Pending | null {
  const field = state.field(pendingField, false)
  return field?.find((p) => p.token === capture.token) ?? null
}

/** Still the same span of the same editor lineage, untouched by any edit since it was captured. */
export function captureIsCurrent(state: EditorState, capture: SelectionCapture): boolean {
  const pending = pendingOf(state, capture)
  return pending !== null && !pending.touched && state.sliceDoc(pending.from, pending.to) === capture.markdown
}

/** Stop tracking a capture (a copy, or a cut whose save failed). */
export function forgetCapture(port: EditorPort, capture: SelectionCapture): void {
  if (pendingOf(port.state, capture)) port.dispatch({ effects: dropCapture.of(capture.token) })
}

/**
 * The cut's second half, after the Scratchpad holds the text: remove the captured span if it is still
 * current, as one ordinary transaction (so editor Undo restores it). A cut to Scratchpad is an explicit
 * removal already recorded, never a tracked change. Anything else leaves the text where it is.
 */
export function finishCut(port: EditorPort, capture: SelectionCapture): 'removed' | 'stale' {
  const pending = pendingOf(port.state, capture)
  if (!pending || !captureIsCurrent(port.state, capture)) {
    forgetCapture(port, capture)
    return 'stale'
  }
  port.dispatch({
    changes: { from: pending.from, to: pending.to, insert: '' },
    selection: { anchor: pending.from },
    effects: dropCapture.of(capture.token),
    annotations: skipWriterReviewTracking.of(true),
    userEvent: 'delete.cut',
    scrollIntoView: true,
  })
  return 'removed'
}

// ── Anchors: explicit records of where an item was inserted ───────────────────────────────────────

export type AnchorMode = 'copy' | 'put-back'
export type Anchor = {
  itemId: string
  useId: string
  mode: AnchorMode
  /** The fragment itself. */
  from: number
  to: number
  /** The fragment with the blank-line separators the insert added around it. */
  outerFrom: number
  outerTo: number
  /** The length of what the insert wrote (separators included): the owned span at insertion time. */
  ownedLength: number
  /** An edit landed inside the owned span (its words or its separators), including a nested insert.
   *  The span is then no longer the insert alone, so the toast's selective Undo refuses (R3). */
  touched: boolean
}

const mapAnchor = (a: Anchor, change: { mapPos: (pos: number, assoc?: number) => number }): Anchor => ({
  ...a,
  from: change.mapPos(a.from, 1),
  to: change.mapPos(a.to, -1),
  outerFrom: change.mapPos(a.outerFrom, 1),
  outerTo: change.mapPos(a.outerTo, -1),
})
const addAnchor = StateEffect.define<Anchor>({ map: (a, change) => mapAnchor(a, change) })
const removeAnchor = StateEffect.define<string>()

/** Whether `changes` edit inside [from, to): a deletion or replacement overlapping it, or an insertion
 *  strictly within it. Typing right at either edge is outside the insert and does not count. */
export function editsInside(changes: { iterChangedRanges: (f: (fromA: number, toA: number) => void) => void }, from: number, to: number): boolean {
  let inside = false
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA === toA ? fromA > from && fromA < to : fromA < to && toA > from) inside = true
  })
  return inside
}

const anchorField = StateField.define<readonly Anchor[]>({
  create: () => [],
  update(value, tr) {
    let next = tr.docChanged && value.length > 0
      ? value.map((a) => ({ ...mapAnchor(a, tr.changes), touched: a.touched || editsInside(tr.changes, a.outerFrom, a.outerTo) })).filter((a) => a.to > a.from)
      : value
    for (const effect of tr.effects) {
      if (effect.is(addAnchor)) next = [...next.filter((a) => a.useId !== effect.value.useId), effect.value]
      else if (effect.is(removeAnchor)) next = next.filter((a) => a.useId !== effect.value)
    }
    return next
  },
})

/**
 * Placement follows editor history. Undo of an insert removes its anchor; Redo brings it back. An
 * anchor lost because its text was deleted by hand (or by any ordinary edit) is restored by the Undo
 * that restores the text, and lost again by Redo: the inverse of "lost" is "added back as it was".
 */
const anchorHistory = invertedEffects.of((tr) => {
  const out: StateEffect<unknown>[] = []
  const explicit = new Set<string>()
  for (const effect of tr.effects) {
    if (effect.is(addAnchor)) { out.push(removeAnchor.of(effect.value.useId)); explicit.add(effect.value.useId) }
    else if (effect.is(removeAnchor)) {
      explicit.add(effect.value)
      const before = tr.startState.field(anchorField, false)?.find((a) => a.useId === effect.value)
      if (before) out.push(addAnchor.of(before))
    }
  }
  if (tr.docChanged) {
    const after = new Set((tr.state.field(anchorField, false) ?? []).map((a) => a.useId))
    for (const before of tr.startState.field(anchorField, false) ?? []) {
      if (!after.has(before.useId) && !explicit.has(before.useId)) out.push(addAnchor.of(before))
    }
  }
  return out
})

// ── Inline inserts (Cite / Insert link): one transaction at the caret, tracked by its exact range ──
// A citation or link is not a placed fragment, so it carries no use anchor. Its toast Undo still
// needs the insert's exact span: the range is mapped through later edits and discarded the moment
// it no longer holds the exact inserted text (the citation-upgrade field's rule).

type TrackedInline = { id: string; from: number; to: number; text: string }
const trackInline = StateEffect.define<TrackedInline>({ map: (t, change) => ({ ...t, from: change.mapPos(t.from, 1), to: change.mapPos(t.to, -1) }) })
const dropInline = StateEffect.define<string>()
const inlineField = StateField.define<readonly TrackedInline[]>({
  create: () => [],
  update(value, tr) {
    let next = value.map((t) => ({ ...t, from: tr.changes.mapPos(t.from, 1), to: tr.changes.mapPos(t.to, -1) }))
    for (const effect of tr.effects) {
      if (effect.is(trackInline)) next = [...next.filter((t) => t.id !== effect.value.id), effect.value]
      else if (effect.is(dropInline)) next = next.filter((t) => t.id !== effect.value)
    }
    return next.filter((t) => t.from >= 0 && t.to <= tr.newDoc.length && t.from <= t.to && tr.newDoc.sliceString(t.from, t.to) === t.text)
  },
})

/** Insert inline Markdown at the caret (replacing a selection) as one undoable editor transaction. */
export function insertInlineTracked(port: EditorPort, markdown: string, id: string): { from: number; to: number } {
  const { from, to } = port.state.selection.main
  port.dispatch({
    changes: { from, to, insert: markdown },
    selection: { anchor: from + markdown.length },
    effects: trackInline.of({ id, from, to: from + markdown.length, text: markdown }),
    annotations: isolateHistory.of('full'),
    userEvent: 'input.paste',
    scrollIntoView: true,
  })
  return { from, to: from + markdown.length }
}

/** The toast Undo of an inline insert: remove exactly its tracked span, only while it is untouched. */
export function removeTrackedInline(port: EditorPort, id: string): 'removed' | 'gone' | 'read-only' {
  if (!writableState(port.state)) return 'read-only'
  const tracked = port.state.field(inlineField, false)?.find((t) => t.id === id)
  if (!tracked || port.state.sliceDoc(tracked.from, tracked.to) !== tracked.text) return 'gone'
  port.dispatch({ changes: { from: tracked.from, to: tracked.to, insert: '' }, selection: { anchor: tracked.from }, effects: dropInline.of(id), userEvent: 'delete' })
  return 'removed'
}

/**
 * The anchor effect for an ACCEPTED agent Put back (ticket 04 correction, R1): main wrote the
 * document and returned a typed receipt of the exact fragment and its offsets in the written
 * text. The accepting editor adds this effect to the SAME transaction that takes that text (the
 * suggestion-resolution transaction), so the anchor is born with the words and editor Undo/Redo
 * carry both together — never a second history step. The receipt is verified against the actual
 * change being dispatched (the new text at the receipt's offsets must be exactly its fragment,
 * inside the changed span); anything else — a read-only state, pending Reviewing spans that make
 * raw and clean coordinates differ, typing merged since — yields no effect and no placement is
 * recorded. This verifies main's typed coordinates; it never searches prose.
 */
export function acceptedPlacementEffect(
  state: EditorState,
  change: { from: number; to: number; insert: string },
  receipt: { itemId: string; useId: string; markdown: string; from: number; to: number },
  hasPendingSpans: boolean,
): StateEffect<Anchor> | null {
  if (!writableState(state) || hasPendingSpans) return null
  if (receipt.to - receipt.from !== receipt.markdown.length || receipt.markdown.length === 0) return null
  const outerFrom = change.from
  const outerTo = change.from + change.insert.length
  if (receipt.from < outerFrom || receipt.to > outerTo) return null
  const doc = state.doc.toString()
  const next = doc.slice(0, change.from) + change.insert + doc.slice(change.to)
  if (next.slice(receipt.from, receipt.to) !== receipt.markdown) return null
  return addAnchor.of({
    itemId: receipt.itemId, useId: receipt.useId, mode: 'put-back',
    from: receipt.from, to: receipt.to, outerFrom, outerTo, ownedLength: outerTo - outerFrom, touched: false,
  })
}

/** The fields and history hook; installed with the editor's other Scratchpad editing. */
export function scratchpadEditing(): Extension {
  return [pendingField, anchorField, anchorHistory, inlineField]
}

export function liveAnchors(state: EditorState): Anchor[] {
  return [...(state.field(anchorField, false) ?? [])]
}

/** Whether a transaction could have gained or lost an anchor (cheap identity check for listeners). */
export const anchorsMayHaveChanged = (before: EditorState, after: EditorState): boolean => before.field(anchorField, false) !== after.field(anchorField, false)

/** Anchors gained and lost between two states of the same editor. */
export function anchorDiff(before: EditorState, after: EditorState): { added: Anchor[]; removed: Anchor[] } {
  const a = before.field(anchorField, false) ?? []
  const b = after.field(anchorField, false) ?? []
  const had = new Set(a.map((x) => x.useId))
  const has = new Set(b.map((x) => x.useId))
  return { added: b.filter((x) => !had.has(x.useId)), removed: a.filter((x) => !has.has(x.useId)) }
}

/** External reloads map existing anchors through disjoint changes. If equally valid forward and
 * reverse diff alignments disagree on an anchor, drop its claim rather than attach to equal prose.
 * Callers retain selection/viewport, silent-save and writer-review policy. */
export function externalReconciliation(state: EditorState, changes: readonly TextEdit[]): { changes: ChangeSet; effects: StateEffect<string>[] } {
  const forward = ChangeSet.of(changes, state.doc.length)
  const after = forward.apply(state.doc).toString()
  const backward = ChangeSet.of(textChanges(state.doc.toString(), after, true), state.doc.length)
  const ambiguous = liveAnchors(state).filter((a) => {
    const f = mapAnchor(a, forward), b = mapAnchor(a, backward)
    return f.from !== b.from || f.to !== b.to || f.outerFrom !== b.outerFrom || f.outerTo !== b.outerTo
  })
  return { changes: forward, effects: ambiguous.map((a) => removeAnchor.of(a.useId)) }
}

// ── Destination and insertion ─────────────────────────────────────────────────────────────────

export type InsertionPoint = {
  /** Where the separator-plus-fragment goes. */
  pos: number
  prefix: string
  /** Added after the fragment only when it does not end its last line itself. */
  needsLineEnd: boolean
  /** The last words of the block the fragment follows, or null at the start of the document. */
  after: string | null
}

const blank = (text: string): boolean => text.trim() === ''

/** After the block holding the caret (or into the blank line it is on), separated by a blank line. */
export function insertionPoint(state: EditorState): InsertionPoint {
  const doc = state.doc
  let line = doc.lineAt(state.selection.main.head)
  if (blank(line.text)) {
    let previous: string | null = null
    for (let n = line.number - 1; n >= 1; n--) { const t = doc.line(n).text; if (!blank(t)) { previous = t; break } }
    const prevLineBlank = line.number === 1 || blank(doc.line(line.number - 1).text)
    return { pos: line.from, prefix: prevLineBlank ? '' : '\n', needsLineEnd: true, after: previous === null ? null : lastWords(previous) }
  }
  while (line.number < doc.lines && !blank(doc.line(line.number + 1).text)) line = doc.line(line.number + 1)
  if (line.number === doc.lines) return { pos: line.to, prefix: '\n\n', needsLineEnd: false, after: lastWords(line.text) }
  return { pos: line.to + 1, prefix: '\n', needsLineEnd: true, after: lastWords(line.text) }
}

function lastWords(text: string): string {
  const clean = text.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/, '').replace(/[*_`]/g, '').trim()
  return clean.length > 48 ? `…${clean.slice(-46)}` : clean
}

/** Insert `markdown` at `at` in ONE transaction that also records its anchor. Returns the fragment's range. */
export function insertWithAnchor(port: EditorPort, at: InsertionPoint, markdown: string, anchor: { itemId: string; useId: string; mode: AnchorMode }): { from: number; to: number } {
  const suffix = at.needsLineEnd && !/\r?\n$/.test(markdown) ? '\n' : ''
  const insert = `${at.prefix}${markdown}${suffix}`
  const from = at.pos + at.prefix.length
  const to = from + markdown.length
  return dispatchAnchoredInsert(port, { pos: at.pos, insert, from, to }, anchor)
}

/** Typed blocks use the same safe paragraph/fence/frontmatter planner as Insert widget. Validate the
 * resulting parser object before dispatch so an incompatible place never writes a partial insert. */
export function insertAssetWithAnchor(port: EditorPort, kind: ScratchAssetKind, markdown: string, anchor: { itemId: string; useId: string; mode: AnchorMode }): { from: number; to: number } {
  const source = port.state.doc.toString()
  const plan = planWidgetInsert(source, port.state.selection.main.head, markdown)
  const after = source.slice(0, plan.from) + plan.insert + source.slice(plan.to)
  const from = plan.caret, to = from + markdown.length
  if (!documentAssets('_', after, 'live').some(item => item.kind === kind && item.document!.from === from && item.document!.to === to && item.markdown === markdown)) {
    throw new Error('That place cannot hold this object. Choose a place outside code, a list or a quote and insert again.')
  }
  return dispatchAnchoredInsert(port, { pos: plan.from, insert: plan.insert, from, to }, anchor)
}

function dispatchAnchoredInsert(port: EditorPort, plan: { pos: number; insert: string; from: number; to: number }, anchor: { itemId: string; useId: string; mode: AnchorMode }): { from: number; to: number } {
  const { pos, insert, from, to } = plan
  port.dispatch({
    changes: { from: pos, insert },
    selection: { anchor: to },
    effects: addAnchor.of({ ...anchor, from, to, outerFrom: pos, outerTo: pos + insert.length, ownedLength: insert.length, touched: false }),
    annotations: isolateHistory.of('full'),
    userEvent: 'input.paste',
    scrollIntoView: true,
  })
  return { from, to }
}

/**
 * A toast's Undo: remove exactly the anchored insert (with its separators) as one undoable step, and
 * only while that span is still the insert alone. After an edit inside it (or a nested insert) the
 * selective removal would take the writer's later words too, so it refuses and leaves everything; the
 * editor's own Undo, which walks history in order, stays available. Never decided by matching text.
 */
export function removeAnchorText(port: EditorPort, useId: string): 'removed' | 'gone' | 'edited' | 'read-only' {
  if (!writableState(port.state)) return 'read-only'
  const anchor = liveAnchors(port.state).find((a) => a.useId === useId)
  if (!anchor) return 'gone'
  if (anchor.touched || anchor.outerTo - anchor.outerFrom !== anchor.ownedLength) return 'edited'
  port.dispatch({ changes: { from: anchor.outerFrom, to: anchor.outerTo }, effects: removeAnchor.of(useId), userEvent: 'delete' })
  return 'removed'
}

/** The text of the nearest ATX heading at or above `pos`, outside fences. */
export function sectionHeadingAt(state: EditorState, pos: number): string | null {
  const doc = state.doc
  const upto = doc.lineAt(pos).number
  let found: string | null = null
  let fence: string | null = null
  for (let n = 1; n <= upto; n++) {
    const text = doc.line(n).text
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(text)
    if (fence) { if (text.trimStart().startsWith(fence)) fence = null; continue }
    if (open) { fence = open[1]; continue }
    const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(text)
    if (heading && heading[1]) found = heading[1].replace(/[*_`]/g, '').trim()
  }
  return found
}
