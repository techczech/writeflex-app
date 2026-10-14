import { ChangeSet, StateEffect, StateField, type Extension, type Range, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { leadLength } from './sentences'

/**
 * Anchored Reading's decoration layer: a `wf-lead` mark over each word's lead-in (the bionic ramp).
 *
 * Marks exist only for the visible range plus a margin ("the window"). An edit maps the existing
 * marks through the change and rebuilds only the changed lines, so every other line keeps the same
 * DOM nodes while the writer types; scrolling extends the window instead of rebuilding it.
 * Display-only: the document text never changes. Words never cross a newline, so lines are the unit.
 */

const leadMark = Decoration.mark({ class: 'wf-lead' })

/** Characters either side of the viewport that are decorated ahead of scrolling. */
export const ANCHORED_MARGIN = 4000

/** Test seam: how many lead-in marks have been computed (a full rebuild per keystroke shows here). */
export const anchoredStats = { marksBuilt: 0 }

export type AnchoredValue = {
  deco: DecorationSet
  /** The line-aligned span [from, to] that `deco` is complete for. */
  from: number
  to: number
}

/** Lead-in marks for every word in the line-aligned span [from, to] of `doc`. */
export function anchoredRanges(doc: Text, from: number, to: number): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = []
  const words = /\S+/g
  for (let pos = from; pos <= to; ) {
    const line = doc.lineAt(pos)
    words.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = words.exec(line.text))) {
      const lead = Math.min(leadLength(match[0]), match[0].length)
      ranges.push(leadMark.range(line.from + match.index, line.from + match.index + lead))
    }
    pos = line.to + 1
  }
  anchoredStats.marksBuilt += ranges.length
  return ranges
}

/** Widen [from, to] to whole lines of `doc`, clamped to the document. */
function lineSpan(doc: Text, from: number, to: number): { from: number; to: number } {
  return { from: doc.lineAt(Math.max(0, Math.min(from, doc.length))).from, to: doc.lineAt(Math.max(0, Math.min(to, doc.length))).to }
}

/** Build the marks for the line-aligned window around [viewFrom, viewTo]. */
export function buildAnchoredWindow(doc: Text, viewFrom: number, viewTo: number): AnchoredValue {
  const span = lineSpan(doc, viewFrom - ANCHORED_MARGIN, viewTo + ANCHORED_MARGIN)
  return { deco: Decoration.set(anchoredRanges(doc, span.from, span.to)), ...span }
}

/**
 * Bring `value` (complete for the OLD document) up to the NEW `doc`: map the marks through
 * `changes`, rebuild only the lines the change touched, then grow the window to cover
 * [viewFrom, viewTo] plus the margin (null: edits only, no view known). A view that has jumped clear of the window rebuilds it.
 */
export function advanceAnchored(value: AnchoredValue, changes: ChangeSet | null, doc: Text, viewFrom: number | null, viewTo: number | null): AnchoredValue {
  let { deco, from, to } = value
  if (changes && !changes.empty) {
    deco = deco.map(changes)
    from = changes.mapPos(from, -1)
    to = changes.mapPos(to, 1)
    // A change at the window's edge can leave the mapped edge mid-line; that line is touched below.
    from = doc.lineAt(from).from
    to = doc.lineAt(to).to
    const touched: Array<{ from: number; to: number }> = []
    changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      const span = lineSpan(doc, fromB, toB)
      const last = touched[touched.length - 1]
      if (last && span.from <= last.to + 1) last.to = Math.max(last.to, span.to)
      else touched.push(span)
    })
    for (const span of touched) {
      const lo = Math.max(span.from, from)
      const hi = Math.min(span.to, to)
      if (lo > hi) continue // the edit is outside the window; scrolling there decorates it
      deco = deco.update({
        filter: () => false,
        filterFrom: lo,
        filterTo: hi,
        add: anchoredRanges(doc, lo, hi),
        sort: true,
      })
    }
  }
  if (viewFrom === null || viewTo === null) return { deco, from, to }
  const want = lineSpan(doc, viewFrom - ANCHORED_MARGIN, viewTo + ANCHORED_MARGIN)
  // Disjoint from the window, or the window has grown far past what is wanted: start over.
  if (want.to < from || want.from > to || from < want.from - 2 * ANCHORED_MARGIN || to > want.to + 2 * ANCHORED_MARGIN) {
    return { deco: Decoration.set(anchoredRanges(doc, want.from, want.to)), ...want }
  }
  if (want.from < from) {
    deco = deco.update({ add: anchoredRanges(doc, want.from, from - 1), sort: true })
    from = want.from
  }
  if (want.to > to) {
    const start = doc.lineAt(to).to + 1
    if (start <= want.to) deco = deco.update({ add: anchoredRanges(doc, start, want.to), sort: true })
    to = want.to
  }
  return { deco, from, to }
}

/** Carries the viewport range the window must cover; sent by the plugin below as the view scrolls. */
const setAnchoredView = StateEffect.define<{ from: number; to: number }>()

/** A StateField (not a plugin) so the decorations are readable from the state alone. */
const anchoredField = StateField.define<AnchoredValue>({
  // Before any view exists, decorate around the caret: where a view opens.
  create: (state) => buildAnchoredWindow(state.doc, state.selection.main.head, state.selection.main.head),
  update(value, tr) {
    let next = value
    if (tr.docChanged) next = advanceAnchored(next, tr.changes, tr.state.doc, null, null)
    for (const effect of tr.effects) if (effect.is(setAnchoredView)) next = advanceAnchored(next, null, tr.state.doc, effect.value.from, effect.value.to)
    return next
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
})

/** Watches the viewport and asks the field to extend its window before the visible lines run out of marks. */
const anchoredViewport = ViewPlugin.fromClass(
  class {
    dead = false
    constructor(readonly view: EditorView) {
      this.check()
    }
    update(update: ViewUpdate): void {
      if (update.viewportChanged || update.docChanged) this.check()
    }
    destroy(): void {
      this.dead = true
    }
    check(): void {
      this.view.requestMeasure({
        read: (view) => {
          const { from, to } = view.viewport
          const window = view.state.field(anchoredField)
          const half = ANCHORED_MARGIN / 2
          const covered = (window.from <= 0 || window.from <= from - half) && (window.to >= view.state.doc.length || window.to >= to + half)
          return covered ? null : { from, to }
        },
        write: (need, view) => {
          // The measure phase can run inside a view update, where dispatching is refused.
          if (need) queueMicrotask(() => { if (!this.dead) view.dispatch({ effects: setAnchoredView.of(need) }) })
        },
      })
    }
  },
)

export function anchoredLayer(): Extension {
  return [anchoredField, anchoredViewport]
}
