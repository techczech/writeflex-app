import { Compartment, Facet, StateField, type Extension, type StateEffect } from '@codemirror/state'
import { EditorView, ViewPlugin, scrollPastEnd } from '@codemirror/view'
import { fixedLineMargin, getFixedLine } from './fixed-line'

/**
 * Empty by default (see setup.ts's baseExtensions); setTypewriter reconfigures this in place so
 * toggling never needs to touch the rest of the extension stack or rebuild EditorState.
 */
export const typewriterCompartment = new Compartment()

/**
 * True while Line focus or Ruler follows the typewriter line (typewriter-follow.ts): that extension scrolls
 * on every selection and document change, so this mode's own typing-run pin steps aside and the line is
 * positioned by one mechanism.
 */
export const typewriterFollowFacet = Facet.define<boolean, boolean>({ combine: (values) => values.some(Boolean) })

/** Shared vertical room that lets a driven position reach the viewport centre/top near document end. */
export const typewriterScrollSupport: Extension = scrollPastEnd()

const TOP_ROOM = '--wf-fixed-line-top'
const TOP_ROOM_CLASS = 'wf-fixed-line-room'

// A stable key for each cached document keeps layout memory across tab switches.
export const typewriterTopRoomKey = StateField.define<object>({
  create: () => ({}),
  update: key => key,
})
const documentsWithTopRoom = new WeakSet<object>()

function shortPage(view: EditorView): boolean {
  const { top, bottom } = view.documentPadding
  return view.contentHeight - top - bottom <= view.scrollDOM.clientHeight
}

const topRoom = ViewPlugin.define((view) => {
  const documentKey = view.state.field(typewriterTopRoomKey, false) ?? {}
  const read = (): number | null => {
    if (!documentsWithTopRoom.has(documentKey) && !view.state.facet(typewriterFollowFacet) && !shortPage(view)) return null
    return fixedLineMargin(getFixedLine(), view.scrollDOM.clientHeight)
  }
  const write = (room: number | null): void => {
    const scroller = view.scrollDOM
    scroller.classList.toggle(TOP_ROOM_CLASS, room !== null)
    if (room === null) scroller.style.removeProperty(TOP_ROOM)
    else {
      documentsWithTopRoom.add(documentKey)
      scroller.style.setProperty(TOP_ROOM, `${room}px`)
    }
  }
  write(read())
  return {
    update(update) {
      if (update.geometryChanged || update.startState.facet(typewriterFollowFacet) !== update.state.facet(typewriterFollowFacet)) {
        view.requestMeasure({ key: write, read, write })
      }
    },
    destroy() { write(null) },
  }
})

/** Short pages and the following band need room above line one, even at scrollTop zero. */
export const typewriterTopRoom: Extension = [
  topRoom,
  EditorView.theme({ [`.cm-scroller.${TOP_ROOM_CLASS} > .cm-content`]: { paddingTop: `var(${TOP_ROOM}) !important` } }),
]

/** Feel-tuned values the user may want to change after more real writing. */
export const TYPEWRITER_RUN_THRESHOLD = 5
export const TYPEWRITER_RUN_PAUSE_MS = 1_200

/**
 * The shared typewriter scroll primitive. The writer drives `position` from the caret; read-aloud
 * drives it from the voice. `yMargin` places the line's top that many px below the scroller's top
 * (`fixedLineMargin` turns the fixed-line fraction into it).
 */
export function typewriterScrollEffect(position: number, yMargin: number) {
  return EditorView.scrollIntoView(position, { y: 'start', yMargin })
}

/** The scroll effect that puts `position` on the fixed line of THIS view, at this instant. */
export function fixedLineScrollEffect(view: EditorView, position: number) {
  const margin = fixedLineMargin(getFixedLine(), view.scrollDOM.clientHeight)
  // A drag changes the chosen fraction before the next layout pass.
  if (view.scrollDOM.classList.contains(TOP_ROOM_CLASS)) {
    const room = `${margin}px`
    if (view.scrollDOM.style.getPropertyValue(TOP_ROOM) !== room) view.scrollDOM.style.setProperty(TOP_ROOM, room)
  }
  return typewriterScrollEffect(position, margin)
}

/**
 * Keeps the cursor line pinned to the fixed line (fixed-line.ts, the same position read-aloud
 * uses) during sustained writing: `y:'start'` aligns the line top to a `yMargin` of that fraction of
 * the visible height, the same idiom goToLine uses.
 *
 * The pin dispatch is itself a doc/selection-inert effect (scrollIntoView doesn't touch doc or
 * selection), so it doesn't re-trigger this listener — but rapid keystrokes can still fire several
 * updates within one animation frame, so `frame` guards against stacking up redundant rAF callbacks;
 * only the latest cursor position (read fresh inside the callback) is ever applied.
 *
 * Stale-frame teardown: every `typewriterExtension()` call returns a distinct instance, so the rAF
 * callback re-checks that the compartment's live content in the view's CURRENT state is still this
 * very instance before dispatching. One identity check covers all three ways a pending frame can go
 * stale — toggle-off (compartment now []), a file switch swapping in another EditorState (fresh []
 * or a new instance from switchTo's reapply), and view destruction — with no cancel bookkeeping
 * needed at the call sites.
 */
export function typewriterExtension(): Extension {
  let frame: number | null = null
  let runUnits = 0
  let lastTypingAt = 0
  const instance: Extension = [
    typewriterScrollSupport,
    typewriterTopRoom,
    EditorView.updateListener.of((update) => {
      let typedUnits = 0
      for (const transaction of update.transactions) {
        if (!transaction.isUserEvent('input.type') && !transaction.isUserEvent('delete')) continue
        transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
          typedUnits += Math.max(toA - fromA, inserted.length)
        })
      }
      // A line break (or other non-typing user input) inside a live run belongs to the run: it
      // neither resets it nor adds to it, but it still needs the scroll below. Without it, an Enter
      // arriving right after the last typed character carries its own "nearest" scroll, which
      // replaces our pending one (CodeMirror keeps only the latest scroll target), and nothing
      // would re-apply the fixed line until the next typed run.
      const now = Date.now()
      const continuesRun = typedUnits === 0
        && update.docChanged
        && runUnits >= TYPEWRITER_RUN_THRESHOLD
        && now - lastTypingAt <= TYPEWRITER_RUN_PAUSE_MS
        && update.transactions.some((transaction) => transaction.isUserEvent('input'))
      if (typedUnits === 0 && !continuesRun) {
        if (update.selectionSet) {
          runUnits = 0
          lastTypingAt = 0
        }
        return
      }
      if (typedUnits > 0 && (lastTypingAt === 0 || now - lastTypingAt > TYPEWRITER_RUN_PAUSE_MS)) runUnits = 0
      lastTypingAt = now
      runUnits += typedUnits
      if (runUnits < TYPEWRITER_RUN_THRESHOLD) return
      if (frame !== null) return
      const view = update.view
      frame = requestAnimationFrame(() => {
        frame = null
        if (typewriterCompartment.get(view.state) !== instance) return
        if (view.state.facet(typewriterFollowFacet)) return
        const head = view.state.selection.main.head
        view.dispatch({
          effects: fixedLineScrollEffect(view, head),
        })
      })
    }),
  ]
  return instance
}

/** Toggle typewriter mode on `view` by reconfiguring the (already-installed) compartment. */
export function setTypewriter(view: EditorView, on: boolean): void {
  const effects: StateEffect<unknown>[] = [typewriterCompartment.reconfigure(on ? typewriterExtension() : [])]
  // A short page has nowhere to scroll until the top room is added. Align it on entry while
  // leaving long pages to the existing sustained-typing rule.
  if (on && !view.state.facet(typewriterFollowFacet) && shortPage(view)) {
    effects.push(fixedLineScrollEffect(view, view.state.selection.main.head))
  }
  view.dispatch({ effects })
}
