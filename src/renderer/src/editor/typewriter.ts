import { Compartment, Facet, type Extension } from '@codemirror/state'
import { EditorView, scrollPastEnd } from '@codemirror/view'
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
  return typewriterScrollEffect(position, fixedLineMargin(getFixedLine(), view.scrollDOM.clientHeight))
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
  view.dispatch({
    effects: typewriterCompartment.reconfigure(on ? typewriterExtension() : []),
  })
}
