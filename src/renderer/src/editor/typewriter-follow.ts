import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { fixedLineMargin, getFixedLine } from './fixed-line'
import { fixedLineScrollEffect, typewriterFollowFacet, typewriterScrollSupport } from './typewriter'

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

/** The CSS variable the top room is read from (set on the scroller, removed with the extension). */
const TOP_ROOM_VAR = '--wf-follow-top'

/**
 * Room above the first line, as high as the fixed line, so line 1 can sit on the band at the top of the
 * document. (The room below, for the last line, is Typewriter mode's scrollPastEnd, reused as it is.)
 */
class TopRoom {
  constructor(private readonly view: EditorView) {
    // Set at once (not in a measure cycle) so the first scroll after switching on already has the room.
    view.scrollDOM.style.setProperty(TOP_ROOM_VAR, `${fixedLineMargin(getFixedLine(), view.scrollDOM.clientHeight)}px`)
  }

  update(update: ViewUpdate): void {
    if (update.geometryChanged || update.viewportChanged) this.measure()
  }

  destroy(): void {
    this.view.scrollDOM.style.removeProperty(TOP_ROOM_VAR)
  }

  private measure(): void {
    this.view.requestMeasure<number>({
      key: this,
      read: (view) => fixedLineMargin(getFixedLine(), view.scrollDOM.clientHeight),
      write: (room, view) => view.scrollDOM.style.setProperty(TOP_ROOM_VAR, `${room}px`),
    })
  }
}

const topRoomTheme = EditorView.theme({ '.cm-content': { paddingTop: `var(${TOP_ROOM_VAR}, 0px) !important` } })

export function typewriterFollowExtension(): Extension {
  let live: EditorView | null = null
  return [
    typewriterScrollSupport,
    typewriterFollowFacet.of(true),
    topRoomTheme,
    ViewPlugin.fromClass(TopRoom),
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
