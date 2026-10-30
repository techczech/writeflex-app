import { EditorView, keymap, type ViewUpdate } from '@codemirror/view'
import type { EditorState, Extension } from '@codemirror/state'
import { anchorsMayHaveChanged, scratchpadEditing } from '../scratchpad/scratchpad-editor'

/** The drag payload a scrap tile writes; the editor's drop handler reads it to insert + remove. */
export const SCRAP_DRAG_MIME = 'application/x-writeflex-scrap'
export type ScrapDrag = { id: string; text: string }

/** Start a scrap drag: the one payload every scrap source writes (the Scratchpad tile, the Board card's
 *  drawer), so the editor's drop handler inserts the text and the scrap leaves its scraps file. */
export function writeScrapDrag(dataTransfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>, scrap: ScrapDrag): void {
  dataTransfer.setData(SCRAP_DRAG_MIME, JSON.stringify({ id: scrap.id, text: scrap.text }))
  dataTransfer.setData('text/plain', scrap.text) // a drop outside the editor still pastes the text
  dataTransfer.effectAllowed = 'move'
}

/** A registered expandable: its `{trigger}` and the body it expands to (with `[date]`/`[clipboard]`). */
export type ScrapExpansion = { trigger: string; text: string }

export type ScrapEditingOpts = {
  /** ⌘⇧X with a selection: App's Scratchpad controller saves the exact text first and only then removes
   *  the unchanged span (scratchpad-controller.ts). The binding itself never deletes anything. */
  onCut: () => void
  /** The editor's explicit Scratchpad anchors changed (an insert, its Undo or Redo, or its text deleted). */
  onAnchors?: (before: EditorState, after: EditorState) => void
  /** A scrap was dropped into the document (text already inserted): App removes it from the store. */
  onDrop: (id: string) => void
  /** The live expandable set (App reads it off the scrap list). */
  expansions: () => ScrapExpansion[]
  /** Clipboard read for the `[clipboard]` placeholder (navigator.clipboard in the renderer). */
  readClipboard: () => Promise<string>
}

/** `[date]` → a long British date; `[clipboard]` handled async by the caller when present. */
function formatDate(): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' }).format(new Date())
}

const TRIGGER_BEFORE_CURSOR = /\{([^{}\s]+)\}$/

/**
 * The Scratchpad editor integration (Task 20, ADR-0008):
 *  - ⌘⇧X hands the selection to the Scratchpad, which removes it once saved (so ⌘Z restores it);
 *  - typing a registered `{trigger}` + space expands it to the scrap body in place, resolving
 *    `[date]` and `[clipboard]` placeholders;
 *  - dropping a scrap tile inserts its text at the drop point and removes the scrap.
 */
export function scrapEditing(opts: ScrapEditingOpts): Extension {
  const expand = (view: EditorView, from: number): boolean => {
    const line = view.state.doc.lineAt(from)
    const before = view.state.sliceDoc(line.from, from)
    const match = TRIGGER_BEFORE_CURSOR.exec(before)
    if (!match) return false
    const found = opts.expansions().find((e) => e.trigger === match[1])
    if (!found) return false
    const start = from - match[0].length
    const dispatch = (body: string): void =>
      view.dispatch({ changes: { from: start, to: from, insert: body }, selection: { anchor: start + body.length }, scrollIntoView: true })
    const dated = found.text.replace(/\[date\]/g, formatDate())
    if (dated.includes('[clipboard]')) {
      // Clipboard is async: consume the space now, splice the trigger once the read resolves.
      void opts
        .readClipboard()
        .then((clip) => dispatch(dated.replace(/\[clipboard\]/g, clip)))
        .catch(() => dispatch(dated.replace(/\[clipboard\]/g, '')))
    } else {
      dispatch(dated)
    }
    return true
  }

  const anchorsChanged = (update: ViewUpdate): void => {
    if (update.transactions.length === 0 || !opts.onAnchors || !anchorsMayHaveChanged(update.startState, update.state)) return
    opts.onAnchors(update.startState, update.state)
  }

  return [
    scratchpadEditing(),
    EditorView.updateListener.of(anchorsChanged),
    keymap.of([
      {
        key: 'Mod-Shift-x',
        preventDefault: true,
        run: (view) => {
          const { from, to } = view.state.selection.main
          if (from === to) return false // nothing selected — let the key fall through
          // Undo-the-cut semantics (ruled): the removal is a normal CM6 transaction, so ⌘Z restores the
          // doc text, and the scrap deliberately STAYS. What changed (ADR-0050): the removal now happens
          // after the Scratchpad holds the exact text, and only if that span is unchanged, so a failed
          // save can never lose prose. The removal skips Reviewing-mode tracking (scratchpad-editor.ts).
          opts.onCut()
          return true
        },
      },
    ]),
    // Trigger + space expansion. The space itself is consumed (the expansion is the gesture); a
    // non-matching space falls through and types normally.
    EditorView.inputHandler.of((view, from, to, text) => {
      if (text !== ' ' || from !== to) return false
      return expand(view, from)
    }),
    EditorView.domEventHandlers({
      dragover(event) {
        // Allow the drop only for our own payload, so external text drags keep CM's default handling.
        if (event.dataTransfer?.types.includes(SCRAP_DRAG_MIME)) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }
        return false
      },
      drop(event, view) {
        const raw = event.dataTransfer?.getData(SCRAP_DRAG_MIME)
        if (!raw) return false
        let payload: ScrapDrag
        try {
          payload = JSON.parse(raw) as ScrapDrag
        } catch {
          return false
        }
        event.preventDefault()
        // A read-only state (a saved version) takes no drop: nothing is inserted and nothing removed.
        if (view.state.readOnly) return true
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
        // A floating Scratchpad item (p_…) is inserted by the Scratchpad itself, as a copy after the block
        // at the drop point, so its anchor is recorded and its links carried; here only the caret moves.
        if (/^p_/.test(payload.id)) {
          view.dispatch({ selection: { anchor: pos } })
          view.focus()
          opts.onDrop(payload.id)
          return true
        }
        view.dispatch({ changes: { from: pos, insert: payload.text }, selection: { anchor: pos + payload.text.length }, scrollIntoView: true })
        view.focus()
        opts.onDrop(payload.id)
        return true
      },
    }),
  ]
}
