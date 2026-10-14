import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import { uniqueRange } from './suggestion-anchor'
import type { Change } from '../../../preload'
import { revisionDecorationsVisible } from './writer-review'

/**
 * The document end of the dock↔document link (Task 5, ADR-0010). Each in-scope Change that resolves to a
 * unique span in the live buffer wears a `.change-mark` underlay; the one selected in the dock also wears
 * `.cid-active` (the mockup's cross-highlight). App recomputes the ranges — it owns the Change list — and
 * pushes them through `setChangeMarks`; between pushes the decorations MAP through the writer's edits, so
 * a marked phrase tracks typing exactly as suggestion anchors do (editor/suggestion-anchor.ts).
 *
 * Clicking a mark is the reverse link: the ref-driven `changeMarkClicks` handler reads App's latest
 * onSelect (extensions are built once per EditorState, so it dereferences a getter, like the scraps
 * handlers) and selects that Change's card without stealing the caret.
 */

export type ChangeMark = { id: string; from: number; to: number; pending: boolean }
export type ChangeMarkState = { marks: ChangeMark[]; selectedId: string | null }

/**
 * The text side of a change that is actually present in the live buffer — which differs by who made it:
 * an agent's proposal only enters the document once accepted (until then its ORIGINAL text is what's
 * there, and a rejected proposal is never applied), whereas a writer's or reviewer's edit is in the
 * document the moment it is typed, so its NEW text is what's there regardless of ledger status.
 */
function liveText(c: Change): string {
  if (c.provenance === 'agent') return (c.status === 'accepted' ? c.newText : c.oldText) ?? ''
  // A writer/reviewer edit is in the document as its NEW text; a deletion (newText '') leaves no span,
  // so it resolves to no mark rather than chasing the removed text to some unrelated occurrence.
  return c.newText ?? ''
}

/**
 * Resolve a change to its span in `doc` for the dock↔document link (Task 5). A stored `anchor` wins when
 * it still covers the expected text (it was captured at edit time and is exact); otherwise the text is
 * matched uniquely — the anchor-free path agent changes always take. Null when neither locates it (the
 * text drifted to non-unique, or a deletion left no span to mark).
 */
export function resolveChangeRange(doc: string, c: Change): { from: number; to: number } | null {
  if (c.editClass === 'insert') {
    // An insertion has no text in the buffer yet, so it resolves to a ZERO-WIDTH point at its anchor —
    // the inline surface then renders the proposed text there. An empty anchor (or one that has drifted to
    // missing/ambiguous) appends at the end of the document rather than vanishing: a staged agent change
    // must always be visible in the text, never survive only as a review-pane card.
    const anchor = c.insertAfter ?? ''
    if (anchor === '') return { from: doc.length, to: doc.length }
    const at = uniqueRange(doc, anchor)
    const point = at ? at.to : doc.length
    return { from: point, to: point }
  }
  const target = liveText(c)
  // A replacement the store minimised to a pure insertion ("sat on mat" → "sat on the mat" keeps only
  // "the ") is an undecided agent proposal with no original text in the buffer: its zero-width stored
  // anchor is the point the new words will land, exactly as for an editClass 'insert'. Without this it
  // resolved to nothing and the proposal survived only as a review-pane card.
  if (
    target === '' && c.provenance === 'agent' && (c.status === 'pending' || c.status === 'held') && c.newText !== '' &&
    c.anchor && c.anchor.from === c.anchor.to && c.anchor.from >= 0 && c.anchor.from <= doc.length
  ) {
    return { from: c.anchor.from, to: c.anchor.to }
  }
  // TRULY empty text means no span exists — a deletion, or an agent insertion not yet applied — so it
  // resolves to nothing even when a (now-stale) anchor is stored. Whitespace-only text is NOT empty: a
  // blank line the writer added is present in the buffer, and its exact anchor can still locate it below.
  if (target === '') return null
  // Move.anchor records the destination anchor for host-side re-basing, not the moved source span.
  if (c.editClass !== 'move' && c.anchor && c.anchor.from >= 0 && c.anchor.to <= doc.length && c.anchor.to > c.anchor.from) {
    if (doc.slice(c.anchor.from, c.anchor.to) === target) return { from: c.anchor.from, to: c.anchor.to }
  }
  // A text match needs distinguishing text; whitespace-only never matches uniquely, so it relies on the
  // anchor above and otherwise resolves to nothing.
  return target.trim() ? uniqueRange(doc, target) : null
}

export const setChangeMarks = StateEffect.define<ChangeMarkState>()

function decorate(state: ChangeMarkState): DecorationSet {
  const ranges = state.marks
    .filter((m) => m.to > m.from)
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((m) =>
      Decoration.mark({
        class: m.id === state.selectedId ? 'change-mark cid-active' : 'change-mark',
        attributes: { 'data-cid': m.id },
      }).range(m.from, m.to),
    )
  return Decoration.set(ranges, true)
}

const changeMarksField = StateField.define<{ value: ChangeMarkState; deco: DecorationSet }>({
  create: () => ({ value: { marks: [], selectedId: null }, deco: Decoration.none }),
  update(field, tr) {
    const effect = tr.effects.find((e) => e.is(setChangeMarks))
    const visible = revisionDecorationsVisible(tr.state)
    if (effect) return { value: effect.value, deco: visible ? decorate(effect.value) : Decoration.none }
    if (visible !== revisionDecorationsVisible(tr.startState)) {
      return { value: field.value, deco: visible ? decorate(field.value) : Decoration.none }
    }
    // No fresh push: keep the marks pinned to their text by mapping through the edit.
    if (tr.docChanged) {
      const value = {
        ...field.value,
        marks: field.value.marks.flatMap((mark) => {
          const from = tr.changes.mapPos(mark.from, 1)
          const to = tr.changes.mapPos(mark.to, -1)
          return to > from ? [{ ...mark, from, to }] : []
        }),
      }
      return { value, deco: visible ? field.deco.map(tr.changes) : Decoration.none }
    }
    return field
  },
  provide: (f) => EditorView.decorations.from(f, (s) => s.deco),
})

export function changeMarkRanges(state: EditorState): Array<{ from: number; to: number }> {
  return state.field(changeMarksField, false)?.value.marks.filter(({ pending }) => pending).map(({ from, to }) => ({ from, to })) ?? []
}

/** The field alone (no click routing) — headless/test editors carry it so App can still dispatch marks. */
export const changeMarking: Extension = changeMarksField

/** Field + ref-driven click routing. `onSelect` is a getter so the built-once extension always reaches
 *  App's current handler. mousedown returns false: the mark is a link, but the caret still lands. */
export function changeMarkClicks(onSelect: () => (id: string) => void): Extension {
  return [
    changeMarksField,
    EditorView.domEventHandlers({
      mousedown: (event) => {
        const el = (event.target as HTMLElement | null)?.closest('.change-mark')
        const cid = el instanceof HTMLElement ? el.dataset.cid : undefined
        if (!cid) return false
        onSelect()(cid)
        return false
      },
    }),
  ]
}
