import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'

/**
 * Room for the review cards under a paragraph (Under view). One empty block widget after the paragraph's last
 * line, as tall as the cards drawn over it; the cards themselves are drawn by the margin, positioned at the
 * widget. The widget is part of the text flow, so typing moves it by whole lines and the caret never shifts
 * sideways. Display only; it never changes the document.
 */
export type UnderSpacer = { pos: number; height: number }

export const setUnderSpacers = StateEffect.define<UnderSpacer[]>()

class SpacerWidget extends WidgetType {
  constructor(readonly height: number) { super() }
  eq(other: SpacerWidget): boolean { return other.height === this.height }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'wf-under-spacer'
    el.setAttribute('aria-hidden', 'true')
    el.style.height = `${this.height}px`
    return el
  }
  get estimatedHeight(): number { return this.height }
  ignoreEvent(): boolean { return true }
}

export const sameSpacers = (a: readonly UnderSpacer[], b: readonly UnderSpacer[]): boolean =>
  a.length === b.length && a.every((s, i) => s.pos === b[i].pos && s.height === b[i].height)

export const underSpacerField = StateField.define<UnderSpacer[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setUnderSpacers)) return effect.value
    if (value.length > 0 && tr.docChanged) return value.map((s) => ({ ...s, pos: tr.changes.mapPos(s.pos, 1) }))
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (spacers) =>
    Decoration.set(
      [...spacers].sort((a, b) => a.pos - b.pos).map((s) => Decoration.widget({ widget: new SpacerWidget(s.height), block: true, side: 1 }).range(s.pos)),
      true,
    )),
})
