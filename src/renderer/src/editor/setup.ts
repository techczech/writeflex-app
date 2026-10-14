import { EditorView, keymap, drawSelection } from '@codemirror/view'
import { Compartment, Prec, type Extension } from '@codemirror/state'
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { findHighlightField } from './find-highlight'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { tags } from '@lezer/highlight'
import { writeflexTheme } from './theme'
// The ONE Markdown dialect (Round B T1): CommonMark + GFM + `==mark==` + footnotes, defined in
// src/shared/markdown/dialect.ts and installed here UNCHANGED. The exporters parse with the same
// list, which is the whole point — an export cannot drift from what the writer sees. Never inline a
// second copy of a parser extension in this file.
import { markdownDialect } from '../../../shared/markdown/dialect'
import { structuralEditingKeymap } from './commands'
import { editorChordCompartment, editorChordExtension } from '../commands/chords'
import { outlineSelectionExtension } from './outline-selection'
import { comments } from './comments'
import { autoLinkTitle } from './auto-link-title'
import { headingFolding } from './folding'
import { typewriterCompartment } from './typewriter'
import { focusCompartment } from './focus-modes'
import { lineOverlayCompartment } from './line-overlay'
import {
  readAloudCompartment,
  readAloudExtension,
  readAloudScrollSupportCompartment,
} from './read-aloud'
import { suggestionAnchoring } from './suggestion-anchor'
import { changeMarking, changeMarkClicks } from './change-marks'
import { inlineChanges, inlineChangesField, type InlineAction } from './inline-changes'
import { appliedFlash } from './applied-flash'
import { scrapEditing, type ScrapEditingOpts } from './scraps'
import { compareHighlights } from './compare-highlights'
import { documentTextForPersistence, pendingWriterChanges, writerReviewChanged, writerReviewing, type WriterPendingChange } from './writer-review'
import { sourceCodeLanguages } from './live-preview-widgets'
import { listTypography } from './list-typography'
import { taskBoxes } from './task-boxes'
import { checklistSink } from './checklist-sink'
import { letteredLists } from './list-types'
import { headingSpacing } from './heading-spacing'
import { requestCheatSheet } from '../app/shortcuts'
import { editorViewMode, type EditorViewMode } from './view-mode'
import { wikilinks, type WikilinkRange } from './wikilinks'
import { markdownLinkOpener } from './markdown-link-open'
import { wikilinkPicker, type WikilinkCompletionPiece } from './wikilink-autocomplete'
import { diaryRecordedBlock } from './diary-recorded'

/**
 * A per-window bus the outline panel subscribes to. There is one EditorView per window, but its
 * EditorState (and the updateListener baked into it) is rebuilt on every tab switch, so the panel
 * cannot hold a listener on the state directly. Instead each rebuilt state publishes doc/cursor
 * changes here, and the panel re-derives its headings + cursor-follow off the live view — no new
 * props threaded through EditorPane. Module scope is window scope in a renderer, so this is not shared
 * across windows.
 */
type EditorUpdateListener = () => void
const editorUpdateListeners = new Set<EditorUpdateListener>()
/** Subscribe to editor doc or selection changes; returns an unsubscribe. Used by the outline panel. */
export function onEditorUpdate(listener: EditorUpdateListener): () => void {
  editorUpdateListeners.add(listener)
  return () => {
    editorUpdateListeners.delete(listener)
  }
}

/** PRD S15 — the `editor.spellcheck` default: on out of the box. The Settings toggle (Task 17)
 *  reconfigures {@link spellcheckCompartment} live via {@link setSpellcheck}; a fresh EditorState
 *  starts from this default and EditorPane reapplies the live choice on every tab switch (the
 *  typewriter-compartment pattern). */
const EDITOR_SPELLCHECK_DEFAULT = true

/** The `editor.spellcheck` compartment (Task 17): the Settings switch flips the content attribute
 *  in place, so toggling never rebuilds the extension stack. */
export const spellcheckCompartment = new Compartment()

function spellcheckAttributes(on: boolean): Extension {
  return EditorView.contentAttributes.of({ spellcheck: on ? 'true' : 'false' })
}

/** Apply the spellcheck setting to `view` by reconfiguring the (already-installed) compartment. */
export function setSpellcheck(view: EditorView, on: boolean): void {
  view.dispatch({ effects: spellcheckCompartment.reconfigure(spellcheckAttributes(on)) })
}

export type BaseExtensionOpts = {
  /** Fired with the full document text on every buffer change (App derives dirty state from it). */
  onDocChanged: (doc: string, beforeDoc: string) => void
  /** Fired for every document-changing transaction, including silent reconciles. Read-aloud uses
   *  this lower-level signal to pause before its immutable source can become stale. */
  onDocumentTransaction?: () => void
  /** Fetches a page title for the auto-link-title paste handler (main-process `web:fetch-title`).
   *  Omitted in headless/test use, where the paste handler is not wired. */
  fetchTitle?: (url: string) => Promise<string | null>
  /** Scrap editing (Task 20): ⌘⇧X cut-to-scrap, `{trigger}`+space expansion, drag-into-document.
   *  Omitted in headless/test use, where the scrap store is not wired. */
  scraps?: ScrapEditingOpts
  /** Change Ledger link (Task 5): clicking a `.change-mark` selects that Change's dock card. `onSelect`
   *  is read through a getter (built-once extension), like the scraps handlers. Omit to carry the mark
   *  field without click routing (headless tests still dispatch marks). */
  changeMarks?: { onSelect: (id: string) => void }
  /** Inline track-changes (the default agent-review surface): a per-change action-bar button was hit, the
   *  widget body selected its dock card, or the ⌘⏎ / ⇧⌘⏎ / ⌘R keymap fired on the change nearest the
   *  cursor. Omit to carry the field without routing (headless). Read through getters, built once. */
  inlineChanges?: { onAction: (id: string, act: InlineAction) => void; onSelect: (id: string) => void }
  /** Writer Reviewing mode (R1): direct human edits become visible writer track-changes. */
  onWriterReviewChanged?: (doc: string, changes: WriterPendingChange[]) => void
  /** Per-window presentation state. Clean is the product default; cached tabs are reconfigured on switch. */
  initialViewMode?: EditorViewMode
  /** First-class wikilink activation. Resolution data is pushed through the field by EditorPane. */
  onWikilinkActivate?: (link: WikilinkRange) => void
  /** Live Collection Piece vocabulary for the `[[` completion source. */
  wikilinkPieces?: () => WikilinkCompletionPiece[]
  /** ⌘-click / ⌥⏎ on a Markdown link with a writeflex: or http(s): target (markdown-link-open.ts). */
  onOpenLink?: (url: string) => void
}

/**
 * The shared extension stack for every WriteFlex editor (salvaged shape from M1's proven setup).
 * markdownKeymap and the editing keymap (editor/commands.ts) are placed BEFORE defaultKeymap so
 * Enter hits insertNewlineContinueMarkup (Enter must continue lists) and the command set (⌘E marks,
 * Tab outline, ⌃⌘] heading-shift, …) wins over the plain defaults — the M1 ordering lesson. The
 * Markdown parser is extended with GFM + WriteFlex's `==mark==` and footnote highlighting; comments
 * (⌥⌘/ + `//` line decoration) and closeBrackets smart pairs round out the editing surface;
 * lineWrapping keeps prose soft-wrapped; history + search + selection-match highlighting remain.
 */
export function baseExtensions(opts: BaseExtensionOpts): Extension[] {
  return [
    markdown({ extensions: markdownDialect(), addKeymap: false, codeLanguages: sourceCodeLanguages }),
    Prec.high(keymap.of([
      { key: 'Mod-/', preventDefault: true, run: () => { requestCheatSheet(window); return true } },
      { key: 'Mod-Shift-/', preventDefault: true, run: () => { requestCheatSheet(window); return true } },
    ])),
    // Editor-surface command chords (Round A T6): ONE resolver-built keymap in a compartment,
    // seeded with the registry defaults and reconfigured in place when the writer reassigns a
    // chord in the Keycap Ledger (EditorPane reapplies it per swapped-in state, the typewriter
    // pattern). Prec.highest so an assigned chord always wins over the static maps below.
    editorChordCompartment.of(editorChordExtension({})),
    outlineSelectionExtension,
    keymap.of(markdownKeymap),
    // Structural typing keys (⇥/⇧⇥/⌥↑/⌥↓) stay static — they are grammar, not assignable chords.
    Prec.high(keymap.of(structuralEditingKeymap)),
    comments,
    ...(opts.onWikilinkActivate ? [wikilinks(opts.onWikilinkActivate)] : []),
    ...(opts.wikilinkPieces ? [wikilinkPicker(opts.wikilinkPieces)] : []),
    ...(opts.onOpenLink ? [markdownLinkOpener(opts.onOpenLink)] : []),
    // Smart pairs (PRD S10): auto-close brackets, quotes, and backtick code spans. The bracket set
    // is scoped to Markdown regions via language data so it reflects markdown syntax (adds `` ` ``
    // for inline code) rather than closeBrackets' code-oriented default.
    markdownLanguage.data.of({ closeBrackets: { brackets: ['(', '[', '{', "'", '"', '`'] } }),
    closeBrackets(),
    history(),
    drawSelection(),
    // Heading folding (PRD S11): ⌘8/⌘9 fold sections over lezer heading ranges (editor/folding.ts).
    headingFolding,
    // Typewriter mode (PRD S12): empty by default; setTypewriter reconfigures this in place so the
    // centred-cursor toggle never rebuilds the extension stack. Reapplied per EditorState on every
    // tab switch (EditorPane.switchTo) because a fresh/cached state resets the compartment to [].
    typewriterCompartment.of([]),
    // Focus modes (Round A, ADR-0028): empty by default; setFocusMode reconfigures in place and
    // EditorPane.switchTo reapplies the live mode per swapped-in state (the typewriter pattern).
    focusCompartment.of([]),
    // Line focus and Ruler (overlays, not modes): empty by default; setLineOverlay reconfigures in place.
    lineOverlayCompartment.of([]),
    // Read-aloud (ADR-0029): a StateField owns the doc-wide spoken position and its two wash levels.
    // EditorPane reapplies the current position after every swapped-in EditorState.
    readAloudCompartment.of(readAloudExtension),
    // The voice reuses typewriter's scroll-past-end room only while a reading session is active.
    readAloudScrollSupportCompartment.of([]),
    // Suggestion anchors (Task 16): every buffer carries the field so a staged prose edit's range
    // tracks the writer's edits; App syncs the active file's pending suggestions into it and the
    // margin callout renders beside the first anchored one (editor/suggestion-anchor.ts).
    suggestionAnchoring,
    // Change Ledger marks (Task 5): the dock↔document link. The field is always present so App can
    // dispatch marks into any buffer; click routing is added only when a handler is wired (not headless).
    opts.changeMarks ? changeMarkClicks(() => opts.changeMarks!.onSelect) : changeMarking,
    // Inline track-changes (the default agent-review surface, replacing the popup): renders each pending
    // agent change in place with a per-change action bar. Field always present; routing when wired.
    opts.inlineChanges ? inlineChanges(() => opts.inlineChanges!.onAction, () => opts.inlineChanges!.onSelect) : inlineChangesField,
    // Applied-edit flash (Ship 1 fix): after an accepted prose edit lands, the buffer briefly wears a
    // transient `.applied-flash` underlay over the applied text so the writer sees the change land.
    appliedFlash,
    compareHighlights,
    writerReviewing(),
    editorViewMode(opts.initialViewMode),
    EditorView.lineWrapping,
    listTypography,
    // Lettered and roman lists (docs/design/2026-09-27-checkbox-lists, frames 5–6): Return continues
    // `a.` with `b.` and `ii.` with `iii.`. Ahead of taskBoxes so a lettered box line continues here.
    letteredLists,
    // Checkboxes (docs/design/2026-09-27-checkbox-lists): `[ ]` / `[x]` after a list marker is drawn
    // as a box; a click or Toggle checkbox writes one character. Typing `[]` makes one, Return
    // continues one (editor/task-boxes.ts).
    taskBoxes,
    // A checklist note's ticked items sink below a quiet "Done · n" divider while the cursor is out
    // of the list — on screen only; the document keeps its order (editor/checklist-sink.ts, frame 7).
    checklistSink,
    // Heading spacing (ADR-0041): 1.15em of air above a heading and a hair below, display only and
    // identical in Writing and Reviewing. A StateField, not a ViewPlugin — it changes line heights.
    headingSpacing,
    diaryRecordedBlock,
    // Spellcheck (PRD S15, key `editor.spellcheck`): defaults on; the Settings toggle reconfigures
    // the compartment live and EditorPane reapplies the choice per swapped-in state (Task 17).
    spellcheckCompartment.of(spellcheckAttributes(EDITOR_SPELLCHECK_DEFAULT)),
    highlightSelectionMatches(),
    search({ literal: true }),
    // In-document Find paints its own matches (the CM highlighter is gated on its search panel, which
    // our float never opens) and scrolls each current match clear of the float itself (editor/find-highlight).
    findHighlightField,
    // Auto-link-title: paste a bare URL → Markdown link, page title fetched in the background (S9
    // amendment). Only wired when a fetcher is supplied; headless callers (tests) omit it.
    ...(opts.fetchTitle ? [autoLinkTitle(opts.fetchTitle)] : []),
    // Scratchpad items (Task 20): cut-to-scrap, trigger expansion, drag-into-document. Wired only when
    // the scrap store is available (App supplies it); headless callers omit it.
    ...(opts.scraps ? [scrapEditing(opts.scraps)] : []),
    // closeBracketsKeymap first so Backspace deletes an auto-inserted pair before defaultKeymap.
    // searchKeymap's own Mod-d is dropped: ⌘D belongs to the resolver-built chord keymap (T6), and
    // a static duplicate would keep firing selectNextOccurrence after the writer moved the chord.
    keymap.of([...closeBracketsKeymap, ...historyKeymap, ...searchKeymap.filter((binding) => binding.key !== 'Mod-d'), ...defaultKeymap]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onDocumentTransaction?.()
      const writerChanged = writerReviewChanged(update)
      if (update.docChanged || writerChanged) {
        const doc = documentTextForPersistence(update.state)
        opts.onDocChanged(doc, documentTextForPersistence(update.startState))
        opts.onWriterReviewChanged?.(doc, pendingWriterChanges(update.state))
      }
      // Doc edits AND bare cursor moves both feed the outline panel (headings + cursor-follow).
      if (update.docChanged || update.selectionSet || writerChanged) editorUpdateListeners.forEach((listener) => listener())
    }),
    writeflexTheme,
  ]
}
