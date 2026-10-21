import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'

/**
 * The margin's outline for a card whose words carry no mark of their own: the writer's own edit while
 * Drafting (nothing is drawn in the text then). Hovering such a card outlines its words with the same
 * `margin-hover` class the marked cards use. Display only; it never changes the document.
 */
export const setMarginOutline = StateEffect.define<{ from: number; to: number } | null>()

const marginOutlineField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setMarginOutline)) return effect.value
    if (value && tr.docChanged) {
      const from = tr.changes.mapPos(value.from, 1)
      const to = tr.changes.mapPos(value.to, -1)
      return to > from ? { from, to } : null
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (range) =>
    range ? Decoration.set([Decoration.mark({ class: 'margin-hover' }).range(range.from, range.to)]) : Decoration.none),
})

export const marginOutline = marginOutlineField
