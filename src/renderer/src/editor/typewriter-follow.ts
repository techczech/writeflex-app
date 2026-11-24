import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { fixedLineScrollEffect, typewriterFollowFacet, typewriterScrollSupport, typewriterTopRoom } from './typewriter'

/**
 * Follow = Typewriter for Line focus and Ruler (line-overlay.ts): the band sits on the fixed line and
 * the text moves through it. It rides the same primitive and the same position as Typewriter mode
 * (`fixedLineScrollEffect`, `getFixedLine`), but on every selection or document change instead of only
 * during a typing run, so arrow keys, clicks, Page Up/Down, search and outline jumps all bring the
 * cursor line to the band.
 *
 * The extension lives inside the line-overlay compartment, so it exists only while an overlay is on
 * with this choice: turning either off, or changing the Follow pill, takes the scroll rule, the
 * end-of-document room and the top room away with it. The scroll effect travels in the SAME transaction
 * as the selection change (a transaction extender), so the band never shows the cursor line in transit.
 * With Typewriter mode also on, its typing-run pin steps aside (typewriterFollowFacet).
 */

export function typewriterFollowExtension(): Extension {
  let live: EditorView | null = null
  return [
    typewriterScrollSupport,
    typewriterFollowFacet.of(true),
    typewriterTopRoom,
    ViewPlugin.define((view) => {
      live = view
      return { destroy: () => { if (live === view) live = null } }
    }),
    EditorState.transactionExtender.of((tr) => {
      if (!live || (!tr.docChanged && !tr.selection)) return null
      const selection = tr.newSelection.main
      // A drag or shift-click extends a range under the pointer; moving the text there would chase it.
      if (tr.isUserEvent('select.pointer') && !selection.empty) return null
      return { effects: fixedLineScrollEffect(live, selection.head) }
    }),
  ]
}

/** Put the cursor line on the band once, when the choice is switched on. */
export function scrollCursorToTypewriterLine(view: EditorView): void {
  view.dispatch({ effects: fixedLineScrollEffect(view, view.state.selection.main.head) })
}
