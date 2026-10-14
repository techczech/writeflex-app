import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { revisionDecorationsVisible, writerReviewField } from './writer-review'

/**
 * Suggestion anchors (Task 16): map a staged prose.edit Suggestion's `oldText` onto a live doc
 * range and keep that range honest while the writer keeps typing. The margin callout renders
 * beside the FIRST anchored suggestion (the mockup shows one card; the rest stay reachable via
 * the agent panel's `view` links), and the anchored sentence carries the mockup's `.sugg-target`
 * underlay as a CM mark decoration.
 *
 * Rules:
 * - Placement uses the pipeline's own unique-match contract (capabilities.ts prose.edit): an
 *   `oldText` that matches the doc zero times or more than once gets NO anchor — the callout
 *   never points at a guess.
 * - Edits BEFORE/AFTER the range shift it via position mapping (the auto-link-title StateField
 *   pattern); positions hug the anchored text INWARD (from assoc 1, to assoc -1) so typing flush
 *   against either edge never pulls the new text into the range.
 * - Any edit that changes the anchored text itself (the mapped range no longer reads exactly
 *   `oldText`) drops the anchor: the suggestion's exact-replacement would no longer apply there.
 */

export type AnchorSpec = { id: string; oldText: string }
export type SuggestionAnchor = { id: string; oldText: string; from: number; to: number }

/** The doc range where `oldText` occurs EXACTLY once, or null (absent or ambiguous — no anchor). */
export function uniqueRange(text: string, oldText: string): { from: number; to: number } | null {
  if (!oldText) return null
  const first = text.indexOf(oldText)
  if (first === -1) return null
  if (text.indexOf(oldText, first + oldText.length) !== -1) return null
  return { from: first, to: first + oldText.length }
}

/**
 * Replace the tracked anchor set with `specs` (the pending prose.edit suggestions for the file the
 * view is showing, in pending-list order). Ids already anchored keep their TRACKED range — the
 * mapped position is the truth once the user has edited around it, so surviving ids are never
 * re-searched; new ids resolve against the current doc; ids gone from `specs` drop.
 */
export const setSuggestionAnchors = StateEffect.define<AnchorSpec[]>()

const suggTargetMark = Decoration.mark({ class: 'sugg-target' })

export const suggestionAnchorField = StateField.define<SuggestionAnchor[]>({
  create: () => [],
  update(anchors, tr) {
    let next = anchors
    if (tr.docChanged) {
      next = []
      for (const anchor of anchors) {
        // Hug inward (from assoc 1, to assoc -1): typing flush against either edge of the anchored
        // sentence shifts the range without swallowing the new text.
        const from = tr.changes.mapPos(anchor.from, 1)
        const to = tr.changes.mapPos(anchor.to, -1)
        // The anchored text must survive the edit verbatim, or the anchor vanishes.
        if (from < to && tr.newDoc.sliceString(from, to) === anchor.oldText) next.push({ ...anchor, from, to })
      }
    }
    for (const effect of tr.effects) {
      if (!effect.is(setSuggestionAnchors)) continue
      const current = next
      const resolved: SuggestionAnchor[] = []
      const docText = tr.newDoc.toString()
      for (const spec of effect.value) {
        const existing = current.find((anchor) => anchor.id === spec.id)
        if (existing) {
          resolved.push(existing)
          continue
        }
        const range = uniqueRange(docText, spec.oldText)
        if (range) resolved.push({ id: spec.id, oldText: spec.oldText, ...range })
      }
      next = resolved
    }
    return next
  },
})

/** The live anchor list (spec order); [] when the field is absent (headless states without it). */
export function suggestionAnchors(state: EditorState): SuggestionAnchor[] {
  return state.field(suggestionAnchorField, false) ?? []
}

/** The whole extension (field + its provided `.sugg-target` decoration), for baseExtensions. */
export const suggestionAnchoring: Extension = [
  suggestionAnchorField,
  EditorView.decorations.compute([suggestionAnchorField, writerReviewField], (state) => {
    const anchors = state.field(suggestionAnchorField)
    return revisionDecorationsVisible(state) && anchors.length > 0
      ? Decoration.set([suggTargetMark.range(anchors[0].from, anchors[0].to)])
      : Decoration.none
  }),
]

/**
 * The callout's `.cdiff` content: `oldText` → `newText` reduced to the mockup's shape — shared
 * words kept as plain prose, the replaced middle as <del>, the replacement as <ins>
 * (`<del>It has become … that the</del> <ins>The</ins> language we use …`). Word-token common
 * prefix/suffix, so the diff reads as prose rather than a character splice.
 */
export function calloutDiff(
  oldText: string,
  newText: string,
): { prefix: string; removed: string; inserted: string; suffix: string } {
  const oldWords = oldText.split(/\s+/).filter(Boolean)
  const newWords = newText.split(/\s+/).filter(Boolean)
  let start = 0
  while (start < oldWords.length && start < newWords.length && oldWords[start] === newWords[start]) start++
  let end = 0
  while (
    end < oldWords.length - start &&
    end < newWords.length - start &&
    oldWords[oldWords.length - 1 - end] === newWords[newWords.length - 1 - end]
  )
    end++
  return {
    prefix: oldWords.slice(0, start).join(' '),
    removed: oldWords.slice(start, oldWords.length - end).join(' '),
    inserted: newWords.slice(start, newWords.length - end).join(' '),
    suffix: oldWords.slice(oldWords.length - end).join(' '),
  }
}
