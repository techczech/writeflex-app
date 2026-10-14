import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import { revisionDecorationsVisible, writerReviewField } from './writer-review'
import { minimiseProposedReplacement } from '../../../main/proposed-replacement'

/**
 * The post-accept "here's what changed" flash (Ship 1 fix): once an accepted prose edit lands in the
 * buffer, the editor scrolls to the applied text and paints it with a transient `.applied-flash`
 * underlay so the writer's eye lands on the change. It is a one-shot confirmation — the mark clears
 * itself after ~1s (or the moment the writer edits under it) and is never persisted as history.
 */

/** Paint the flash over a doc range, replacing any flash already showing. */
export const showAppliedFlash = StateEffect.define<{ from: number; to: number }>()
/** Retire the flash (the scheduled timeout fires this; a doc edit retires it too). */
export const clearAppliedFlash = StateEffect.define<null>()

const appliedFlashMark = Decoration.mark({ class: 'applied-flash' })

export const appliedFlashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    // A doc edit under the flash retires it: the highlighted range is no longer trustworthy and the
    // flash is a momentary confirmation, not a tracked range.
    let next = tr.docChanged ? Decoration.none : deco
    for (const effect of tr.effects) {
      if (effect.is(showAppliedFlash)) next = Decoration.set([appliedFlashMark.range(effect.value.from, effect.value.to)])
      else if (effect.is(clearAppliedFlash)) next = Decoration.none
    }
    return next
  },
})

/** The whole extension (field + its provided decoration), for baseExtensions. */
export const appliedFlash: Extension = [
  appliedFlashField,
  EditorView.decorations.compute([appliedFlashField, writerReviewField], (state) =>
    revisionDecorationsVisible(state) ? state.field(appliedFlashField) : Decoration.none),
]

/**
 * Scroll `[from, to)` into view, land the caret at its start, and flash it — clearing the highlight
 * after `duration` ms. A dispatch that lands on a torn-down/swapped state is harmless: the clear is
 * guarded on the field still being present, so a tab switch mid-flash can't throw.
 */
export function flashApplied(view: EditorView, from: number, to: number, duration = 1000): void {
  if (!revisionDecorationsVisible(view.state)) return
  view.dispatch({
    selection: { anchor: from },
    effects: [EditorView.scrollIntoView(from, { y: 'center' }), showAppliedFlash.of({ from, to })],
  })
  // Keyboard-first: leave the writer back in the editor at the change, ready to keep writing.
  view.focus()
  window.setTimeout(() => {
    if (view.state.field(appliedFlashField, false)) view.dispatch({ effects: clearAppliedFlash.of(null) })
  }, duration)
}

/**
 * Where to flash once a whole proposal (`oldText` → `newText`) has landed at `from`: the words the ledger
 * minimised it to, not the whole replaced passage — the flash marks what changed, exactly as the review
 * mark did (the same store minimiser, design "marking follows the data"). A pure deletion minimises to no
 * new text, so it keeps the whole applied range rather than flashing an invisible point.
 */
export function minimisedAppliedRange(oldText: string, newText: string, from: number): { from: number; to: number } {
  const whole = { from, to: from + newText.length }
  const minimal = minimiseProposedReplacement({
    path: '', provenance: 'agent', editClass: 'content', summary: '', oldText, newText, isCorrection: false,
    anchor: { from: 0, to: oldText.length },
  })
  if (!minimal?.anchor || minimal.newText === '') return whole
  const start = from + minimal.anchor.from
  return { from: start, to: start + minimal.newText.length }
}
