import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'
import type { CompareEditorHighlights } from '../components/compare-live'
import { revisionDecorationsVisible, writerReviewField } from './writer-review'

export const setCompareHighlights = StateEffect.define<CompareEditorHighlights>()

function provenanceClass(provenance: string): string {
  if (provenance === 'agent') return 'prov-agent'
  if (provenance === 'reviewer') return 'prov-reviewer'
  return 'prov-writer'
}

function decorate(input: CompareEditorHighlights): DecorationSet {
  const decorations: Array<{ from: number; range: Range<Decoration> }> = []
  for (const mark of input.marks) {
    decorations.push({
      from: mark.from,
      range: Decoration.mark({
        class: `compare-live-add ${provenanceClass(mark.provenance)}`,
        attributes: { 'data-compare-change-id': mark.id },
      }).range(mark.from, mark.to),
    })
  }
  return Decoration.set(
    decorations
      .sort((a, b) => a.from - b.from)
      .map((item) => item.range),
    true,
  )
}

const compareHighlightsField = StateField.define<{ value: CompareEditorHighlights; deco: DecorationSet }>({
  create: () => ({ value: { marks: [] }, deco: Decoration.none }),
  update(field, tr) {
    const effect = tr.effects.find((candidate) => candidate.is(setCompareHighlights))
    if (effect) return { value: effect.value, deco: decorate(effect.value) }
    if (tr.docChanged) return { value: field.value, deco: field.deco.map(tr.changes) }
    return field
  },
  provide: (field) => EditorView.decorations.compute([field, writerReviewField], (state) =>
    revisionDecorationsVisible(state) ? state.field(field).deco : Decoration.none),
})

export const compareHighlights: Extension = compareHighlightsField
