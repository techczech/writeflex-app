import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'

/**
 * Match highlighting for the in-document Find (S5). CodeMirror's own `@codemirror/search` highlighter
 * only paints `.cm-searchMatch` while ITS search panel is open (index.js: `if (!panel || …) return`),
 * and WriteFlex's Find is a custom float (DocumentFind) that never opens that panel. So Find drives this
 * field instead: App recomputes the match ranges — it owns the query — and pushes them through
 * `setFindMatches`, exactly as the change-mark dock↔document link pushes its ranges (editor/change-marks).
 * Between pushes the decorations MAP through edits, so a Replace that shifts later text keeps the
 * remaining highlights aligned. The classes reuse the editor theme's existing `.cm-searchMatch` /
 * `.cm-searchMatch-selected` styling, so the current match reads stronger than the rest.
 */

export type FindMatch = { from: number; to: number }

export const setFindMatches = StateEffect.define<{ matches: FindMatch[]; current: number }>()

const matchMark = Decoration.mark({ class: 'cm-searchMatch' })
const currentMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' })

export const findHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes)
    for (const effect of tr.effects) {
      if (!effect.is(setFindMatches)) continue
      const { matches, current } = effect.value
      if (matches.length === 0) return Decoration.none
      value = Decoration.set(
        matches.map((match, index) => (index === current ? currentMark : matchMark).range(match.from, match.to)),
        true,
      )
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field),
})
