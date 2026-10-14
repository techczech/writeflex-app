import { StateEffect, StateField, type EditorState } from '@codemirror/state'

export type TrackedCitation = {
  from: number
  id: string
  original: string
  to: number
}

/**
 * A citation waiting for its Zotero create result. The identity lives only in editor state; the
 * Markdown contains the page-level citation and nothing else.
 */
export const trackCitation = StateEffect.define<TrackedCitation>()
export const clearTrackedCitation = StateEffect.define<string>()

export const citationUpgradeField = StateField.define<TrackedCitation[]>({
  create: () => [],
  update(value, transaction) {
    let next = value.map((citation) => ({
      ...citation,
      from: transaction.changes.mapPos(citation.from, 1),
      to: transaction.changes.mapPos(citation.to, -1),
    }))
    for (const effect of transaction.effects) {
      if (effect.is(trackCitation)) {
        next = [
          ...next.filter((citation) => citation.id !== effect.value.id),
          effect.value,
        ]
      } else if (effect.is(clearTrackedCitation)) {
        next = next.filter((citation) => citation.id !== effect.value)
      }
    }
    // Once a mapped range stops containing the exact inserted citation it is discarded. Restoring
    // identical text later cannot revive the one-shot upgrade.
    return next.filter((citation) =>
      citation.from >= 0
      && citation.to <= transaction.newDoc.length
      && citation.from <= citation.to
      && transaction.newDoc.sliceString(citation.from, citation.to) === citation.original)
  },
})

/**
 * The mapped range is eligible only while it still contains the exact page-level citation inserted
 * for this request. The state field permanently discards a citation as soon as that stops being true.
 */
export function trackedCitationRange(
  state: EditorState,
  id: string,
): { from: number; to: number } | null {
  const tracked = state.field(citationUpgradeField, false)
    ?.find((citation) => citation.id === id)
  if (
    !tracked
    || tracked.from < 0
    || tracked.to > state.doc.length
    || tracked.from > tracked.to
    || state.sliceDoc(tracked.from, tracked.to) !== tracked.original
  ) {
    return null
  }
  return { from: tracked.from, to: tracked.to }
}
