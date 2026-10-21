import { setMetadataCollapsed } from '../editor/metadata-view-state'
import { createPortal } from 'react-dom'
import { FolioLine } from './FolioLine'
import { ReviewMargin, type ReviewMarginProps } from './ReviewMargin'
import type { FolioPlace } from '../../../shared/folio-place'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type MutableRefObject } from 'react'
import { commandRan } from '../commands/command-ran'
import { Compartment, EditorState, Prec, Transaction } from '@codemirror/state'
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view'
import { SearchQuery } from '@codemirror/search'
import { setFindMatches, type FindMatch } from '../editor/find-highlight'
import { baseExtensions, onEditorUpdate, setSpellcheck } from '../editor/setup'
import type { ScrapExpansion } from '../editor/scraps'
import { resolveChangeRange } from '../editor/change-marks'
import { setInlineChanges, type InlineChange, type InlineAction } from '../editor/inline-changes'
import { reconcileReplace } from '../editor/reconcile'
import { richPasteMarkdown } from '../editor/rich-paste'
import {
  clearWriterReviewChanges,
  documentTextForPersistence,
  foldReviewingChanges,
  materialiseDraftingChanges,
  materialiseRecordsTransaction,
  pendingWriterChanges,
  resolveWriterChangeSpec,
  revisionDecorationsVisible,
  setWriterMode,
  skipWriterReviewTracking,
  type WriterChangeResolution,
  type WriterPendingChange,
  type WriterReviewMode,
} from '../editor/writer-review'
import { clampSelectionToDocument, preserveViewportPosition } from '../editor/viewport-invariant'
import type { Change, ProseMoveInput, Suggestion } from '../../../preload'
import { fixedLineScrollEffect, setTypewriter, typewriterScrollEffect } from '../editor/typewriter'
import { setLiveFixedLine } from '../editor/fixed-line'
import { FixedLineMarker, type FixedLineBounds } from './FixedLineMarker'
import type { WordRange } from '../editor/word-range'
import { setFocusMode, type FocusMode, type LeadStyle } from '../editor/focus-modes'
import { lineOverlayActive, setLineOverlay, wantsTypewriterFollow, type LineOverlayConfig, type LineOverlayHandle } from '../editor/line-overlay'
import {
  createReadAloudScrollGuard,
  isReadAloudPositionOutsideViewport,
  READ_ALOUD_SCROLL_MARGIN_PX,
  setReadAloud,
  setReadAloudScrollSupport,
  shouldTurnReadAloudPage,
  type ReadAloudScrollMode,
} from '../editor/read-aloud'
import { setEditorChords } from '../commands/chords'
import { isTypewriterOn } from '../editor/commands'
import { scrollCursorToTypewriterLine } from '../editor/typewriter-follow'
import { loadCursor, saveCursor } from '../editor/cursor-memory'
import { uniqueRange } from '../editor/suggestion-anchor'
import type { CompareEditorHighlights } from './compare-live'
import { setCompareHighlights } from '../editor/compare-highlights'
import { activeBlock, blockHasPendingChange, livePreview, livePreviewBlocks, setOpenLivePreviewBlock, type LivePreviewBlock, type LivePreviewCommand } from '../editor/live-preview'
import { setEditorViewMode, type EditorViewMode } from '../editor/view-mode'
import { buildCodeBlock, buildMarkmap, buildMermaid, buildSvg, insertFootnote, isSvgFile, isSvgText, metadataEntry } from '../editor/insert-objects'
import { insertBlockObject } from '../editor/insert-block-object'
import { insertWidgetLine, setWidgetDrop, widgetDropIndicator, widgetDropPoint, widgetDropPosition } from '../editor/insert-widget'
import { ActionsHere } from './ActionsHere'
import { actionsAt, placeAt, type Place } from '../commands/place'
import type { ActionRow } from '../commands/actions-here'
import { isTableColumnCommand, tableColumnEdit } from '../editor/table-column-actions'
import { registryCommand } from '../commands/registry'
import { COMPOSED_PREFIX } from '../commands/actions-layout'
import { composeCommands, deleteBlock } from '../editor/block-actions'
import { makePlainParagraph } from '../editor/block-marks'
import type { StateCommand } from '@codemirror/state'
import { frontmatterSafeInsertPosition } from '../../../shared/object-markup'
import { editorTextOf } from '../../../shared/line-endings'
import { suggestionResolutionHistory, suggestionResolutionSpec, type SuggestionResolutionEffect } from '../editor/suggestion-resolution-history'
import { openMarkdownLinkAt } from '../editor/markdown-link-open'
import { activateWikilinkAtCursor, setWikilinkResolutions, type WikilinkRange, type WikilinkResolution } from '../editor/wikilinks'
import type { WikilinkCompletionPiece } from '../editor/wikilink-autocomplete'
import {
  citationUpgradeField,
  clearTrackedCitation,
  trackCitation,
  trackedCitationRange,
} from '../editor/citation-upgrade'
import {
  commitReadingRoomAreaDrop,
  parseReadingRoomAreaTransfer,
  READING_ROOM_AREA_MIME,
  type ReadingRoomAreaTransfer,
} from '../editor/reading-room-area-drop'

type ProseMoveSuggestion = Suggestion & { input: ProseMoveInput }

function isProseMoveSuggestion(suggestion: Suggestion): suggestion is ProseMoveSuggestion {
  if (suggestion.capabilityName !== 'prose.move') return false
  const input = suggestion.input as Partial<ProseMoveInput> | null
  return (
    !!input &&
    typeof input.path === 'string' &&
    typeof input.text === 'string' &&
    typeof input.insertAfter === 'string' &&
    typeof input.summary === 'string'
  )
}

function liveMoveInputForChange(change: Change, suggestions: Suggestion[]): ProseMoveInput | undefined {
  if (change.editClass !== 'move') return undefined
  const candidates = suggestions
    .filter(isProseMoveSuggestion)
    .filter((suggestion) => suggestion.input.path === change.path && suggestion.input.text === change.oldText)
  const matchingSummary = candidates.filter((suggestion) => suggestion.input.summary === change.summary)
  if (matchingSummary.length === 1) return matchingSummary[0].input
  return candidates.length === 1 ? candidates[0].input : undefined
}

function liveMoveDestination(doc: string, change: Change, moveInput?: ProseMoveInput): number | null {
  if (moveInput) {
    const anchor = uniqueRange(doc, moveInput.insertAfter)
    if (anchor) return anchor.to
  }
  const destination = change.moveTo?.from
  return destination !== undefined && destination >= 0 && destination <= doc.length ? destination : null
}

export function inlineChangeForPendingAgentChange(
  doc: string,
  change: Change,
  selectedId: string | null,
  moveInput?: ProseMoveInput,
): InlineChange | null {
  if (change.editClass === 'move') {
    const source = resolveChangeRange(doc, change)
    const destination = liveMoveDestination(doc, change, moveInput)
    if (!source || destination === null) return null
    return {
      kind: 'move',
      id: change.id,
      from: source.from,
      to: source.to,
      oldText: doc.slice(source.from, source.to),
      newText: change.newText || change.oldText,
      category: change.category ?? 'structure',
      selected: change.id === selectedId,
      destination,
    }
  }

  const range = resolveChangeRange(doc, change)
  if (!range) return null
  return {
    kind: 'text',
    id: change.id,
    from: range.from,
    to: range.to,
    oldText: doc.slice(range.from, range.to),
    newText: change.newText,
    category: change.category,
    selected: change.id === selectedId,
  }
}

/** Cursor-memory debounce: frequent enough to survive an accidental quit, cheap enough to ignore. */
const CURSOR_SAVE_DEBOUNCE_MS = 500
/** Convert to mind map is offered by Insert object… where Actions here does not list it at the place (a heading's section converts too). */
const OUTLINE_TO_MIND_MAP = 'outline.toMindMap'

/** A document detached by the document owner (document-owner.ts): read-only while a route that may forget
 *  it (tab close, folder browse, trash) waits for main, so no keystroke lands in a buffer about to go. */
const detachedCompartment = new Compartment()
const DETACHED = [EditorState.readOnly.of(true), EditorView.editable.of(false)]

/**
 * Imperative surface the app (and Tasks 12–16) drive the editor through. All buffer mutation goes
 * via these methods so the per-path state map stays the single owner of undo history, cursor, and
 * scroll position for each file. Ported from M1's proven Editor.tsx; typewriter mode (per-view,
 * reapplied on every switch) and per-file cursor persistence across relaunches land here (Task 11).
 */
export type EditorHandle = {
  view(): EditorView | null
  /** The file the live view holds right now (null when none); read together with `view()` so a snapshot knows whose text it is. */
  path(): string | null
  /** A frontmatter-safe, exact cursor anchor for restaging one stored agent object. */
  insertionPoint(): { anchor: { from: number; to: number }; insertAfter?: string } | null
  /** direction 0 (default) re-anchors to the query's current match; ±1 steps to the next/previous. */
  find(query: string, direction?: 0 | 1 | -1, replacement?: string): { current: number; total: number }
  clearFind(): void
  replaceFind(query: string, replacement: string, all?: boolean): { current: number; total: number }
  /** Show `path`: stash the outgoing file's state, restore `path`'s cached state or a fresh buffer. */
  switchTo(path: string, content: string, writerMode: WriterReviewMode): void
  /** Replace `path`'s whole doc (agent write / applied suggestion); drops stale cache if inactive. */
  setContent(path: string, content: string, opts?: { silent?: boolean; discardLocal?: boolean }): void
  /** Record an agent accept/reject in the OPEN file's CodeMirror history. Returns false when another
   *  file is open, where the resolution intentionally stays outside this editor's ⌘Z scope. */
  recordSuggestionResolution(path: string, id: string, action: 'accept' | 'reject', resolvedContent?: string): boolean
  /** Show a historical snapshot read-only without making it the live buffer that auto-save reads. */
  enterHistorical(path: string, content: string): void
  /** Show one past writer session as read-only Reviewing marks over its as-of content. */
  enterSessionRecall(path: string, content: string, records: WriterPendingChange[]): void
  /** Return from a historical snapshot to the exact live buffer state captured on entry. */
  exitHistorical(): void
  /** Insert text at the caret, frontmatter-safe, giving a block its own blank lines. The path a
   *  citation takes into the draft (ReadFlex ADR-0003) — App owns the Markdown, the editor owns
   *  where it lands and returning the keyboard to the prose. */
  insertText(text: string, opts?: { block?: boolean }): void
  /** Drop any cached state for `path` (e.g. its tab closed or the file was deleted). A view left showing a
   *  forgotten, detached document stays read-only until another document is shown. */
  forget(path: string): void
  /** The document owner's detach: the editor takes no typing for these paths (true) until attached again
   *  (false). Applied to the live view in this turn, and to a cached document when it is shown. */
  setReadOnly(paths: readonly string[], readOnly: boolean): void
  /** Move cached/active bookkeeping from `oldPath` to `newPath` after a rename. */
  renamePath(oldPath: string, newPath: string): void
  /** Place the caret at the start of `line` (1-based) in the LIVE view and scroll it to the top. The
   *  primitive behind an outline jump: same-file callers invoke it directly, cross-file callers invoke
   *  it once the target file's buffer has been switched in (App's pending-line flush, Task 10). */
  goToLine(line: number): void
  /** Place a SELECTION over a search hit in the LIVE view and scroll it into view: `line`/`column`
   *  are 1-based, `length` the match char count. Same queue-until-ready contract as goToLine for a
   *  cross-file jump (App flushes it once the target buffer is switched in). */
  goToMatch(line: number, column: number, length: number): void
  /** Create or open the document-leading metadata block and focus its title value. */
  setMetadataCollapsed(collapsed: boolean): void
  editMetadata(): void
  /** Toggle typewriter (centred-cursor) mode on the live view; returns the resulting on/off. The mode
   *  is per-view, not per-file — switchTo reapplies it to whichever EditorState it activates. */
  toggleTypewriter(): boolean
  /** Set typewriter mode explicitly (the Settings switch / boot-time apply, Task 17). */
  setTypewriter(on: boolean): void
  /** Apply the `editor.spellcheck` setting (Task 17). Like typewriter it is per-view state:
   *  switchTo reapplies the last-set choice to whichever EditorState it activates. */
  setSpellcheck(on: boolean): void
  /** Apply the writer's chord overrides to the editor keymap (Round A T6). Per-view state like
   *  typewriter: switchTo reapplies the last-set map to whichever EditorState it activates. */
  setCommandChords(overrides: Record<string, string>): void
  /** Set the per-window presentation grammar without mutating the Markdown buffer. */
  setViewMode(mode: EditorViewMode): void
  /** Bring the paused spoken position back into view without resuming the voice. */
  returnToReadAloudPosition(): void
  /** The current doc text for `path` — the live view if it is active, else its cached buffer, or null
   *  if this pane holds no state for it. Lets App save a dirty background tab before closing it. */
  docFor(path: string): string | null
  currentDoc(): string
  /** The selected text in the LIVE view, or null when the selection is empty — the copy commands'
   *  scope law: the selection if there is one, otherwise the whole document. */
  selectedText(): string | null
  pendingWriterChanges(path: string): WriterPendingChange[]
  /** The RAW buffer text for `path` (marks included, no derived-clean pass), or null when not resident —
   *  the save guard compares it against the derived text before letting an empty write reach disk. */
  rawDocFor(path: string): string | null
  /** Reveal the quiet Drafting capture as struck-old/highlighted-new Reviewing marks. */
  revealDraftingSession(path: string): void
  /** Return Reviewing marks to clean Drafting text while preserving their unreviewed capture records. */
  foldWriterChanges(path: string): void
  settleWriterChanges(path: string): void
  /** Resolve ONE tracked writer edit by its mark-group id (accept keeps new, reject keeps old, hold keeps
   *  both). Returns true when the edit was found and resolved in the buffer. */
  resolveWriterChange(path: string, localId: string, action: WriterChangeResolution): boolean
  /** Make one current Change the real editor selection and centre it. Cards and commands share this path. */
  revealChange(change: Change): boolean
  /** Tell the editor where the pending agent changes sit (no prose is drawn for them since ticket 13; an
   *  agent's proposed object is staged over its render, ADR-0024). Returns the ids that could NOT be placed
   *  (their original text has drifted out of the buffer), so the margin can flag those cards honestly. */
  setInlineChanges(changes: Change[], selectedId: string | null, suggestions?: Suggestion[]): string[]
  /** Compare mode: temporary content-diff highlights over the live Working editor. */
  setCompareHighlights(highlights: CompareEditorHighlights): void
  /** Refresh live/dead wikilink classification without rebuilding the editor state. */
  setWikilinks(links: WikilinkResolution[]): void
  activateWikilink(): boolean
}

function searchMatches(query: SearchQuery, state: EditorState): FindMatch[] {
  if (!query.valid) return []
  const cursor = query.getCursor(state)
  const matches: FindMatch[] = []
  for (let next = cursor.next(); !next.done; next = cursor.next()) matches.push({ from: next.value.from, to: next.value.to })
  return matches
}

/** Push the query's matches into the highlight field and select+scroll `index`, clear of the Find float. */
function showFindMatch(view: EditorView, matches: FindMatch[], index: number): { current: number; total: number } {
  const target = matches[index]
  // Put the match a clear gap below the float's actual bottom (taller when Replace is disclosed),
  // measured against the scroller — the S5 rule is "the current match is never underneath the box".
  const box = document.querySelector<HTMLElement>('.findbox')?.getBoundingClientRect()
  const scrollerTop = view.scrollDOM.getBoundingClientRect().top
  const yMargin = box ? Math.max(0, box.bottom - scrollerTop) + 24 : 96
  view.dispatch({
    selection: { anchor: target.from, head: target.to },
    effects: [setFindMatches.of({ matches, current: index }), EditorView.scrollIntoView(target.from, { y: 'start', yMargin })],
  })
  return { current: index + 1, total: matches.length }
}

type EditorPaneProps = {
  onDocChanged: (path: string, doc: string, beforeDoc: string) => void
  onDocumentTransaction: () => void
  onDocumentPointerDown: () => void
  onManualReadAloudScroll: () => void
  onReadAloudPositionVisibilityChange: (visible: boolean) => void
  onSuggestionResolutionReplay: (effect: SuggestionResolutionEffect) => void | Promise<void>
  onSave: () => void
  /** False while no tab is open: the view stays mounted (cached states survive) but invisible, so
   *  nothing can be typed into a buffer that belongs to no file. */
  hasDocument: boolean
  /** Where the open file sits in its Folio; null draws no line. */
  folioPlace?: FolioPlace | null
  onOpenFolioPlan?: () => void
  onOpenFolioPiece?: (path: string) => void
  /** Review-view filter: hide struck old text in inline track-changes without resolving changes. */
  hideStrikes: boolean
  /** ⌘K → Reference…: App raises the Shelf as a picker and inserts the chip. */
  onInsertReference?: () => void
  /** Insert widget… from the Insert object list: App opens the picker (ticket 05). */
  onInsertWidget?: () => void
  /** Supplies the immediate page citation plus an optional confirmed annotation-link replacement. */
  citationForText?: (text: string) => {
    identity: string
    initial: string
    upgrade: Promise<string | null>
  } | null
  /** Review-view filter: hide inserted new text in inline track-changes without resolving changes. */
  hideInserts: boolean
  /** Scopes cursor-memory keys so same-named files in different Workspaces never collide; null while
   *  no Workspace is bound (cursor save/restore is then a no-op). */
  workspaceRoot: string | null
  assetBaseUrl: string | null
  /** ⌘⇧X removed a selection into a scrap (Task 20): App stores it via add(activeFile, text). */
  onCutToScrap: (text: string) => void
  /** A scrap tile was dropped into the document (text already inserted): App removes it. */
  onScrapDropped: (id: string) => void
  /** The live expandable set for `{trigger}`+space expansion (App derives it from the scrap list). */
  getScrapExpansions: () => ScrapExpansion[]
  /** Change Ledger link (Task 5): a `.change-mark` was clicked — App selects that Change's dock card. */
  onChangeMarkClick: (id: string) => void
  /** Inline track-changes: a per-change action (Accept/Reject/Revise) fired from the prose. */
  onInlineAction: (id: string, act: InlineAction) => void
  /** Inline track-changes: a pending agent widget was clicked, so App selects its dock card. */
  onInlineSelect: (id: string) => void
  /** The review margin beside the text (0.23): mounted in the scroller so it scrolls with the text. Absent = no margin. */
  margin?: ReviewMarginProps | null
  onWikilinkActivate: (link: WikilinkRange) => void
  wikilinkPieces: WikilinkCompletionPiece[]
  writerMode: WriterReviewMode
  /** The persisted per-window presentation mode. Passed declaratively so settings hydration cannot
   *  race the imperative ref during window startup. */
  viewMode: EditorViewMode
  /** The live focus mode (Round A, ADR-0028). Declarative for the same reason as viewMode: settings
   *  hydration may land before this pane mounts, so an imperative handle call could be lost. */
  focus: { mode: FocusMode; leadStyle: LeadStyle }
  /** Line focus and Ruler: overlays on top of any focus mode (applied through their own compartment). */
  lineOverlay: LineOverlayConfig
  /** The voice's current source position. null means no read-aloud session and removes the wash. */
  readAloudPosition: number | null
  /** The word being spoken (source range) when the voice reports word boundaries, else null. */
  readAloudWord: WordRange | null
  /** The fixed line, a fraction of the visible height, shared by read-aloud and typewriter mode. */
  fixedLine: number
  /** Live typewriter state, so the fixed-line marker shows while the mode is on. */
  typewriterOn: boolean
  /** The marker moved (drag or key): the editor follows at once. */
  onFixedLineChange: (fraction: number) => void
  /** The marker settled: App persists the value. */
  onFixedLineCommit: (fraction: number) => void
  /** How the editor follows the voice: stable centre or one top-aligned jump per screenful. */
  readAloudScrollMode: ReadAloudScrollMode
  onWriterReviewChanged: (path: string, changes: WriterPendingChange[]) => void
  compareToActive?: boolean
  overlayOpenRef: MutableRefObject<boolean>
  onStatus: (message: string) => void
  /** Called only after one complete Area image-plus-source block has entered this exact draft. */
  onReadingRoomAreaPrepared?: (transfer: ReadingRoomAreaTransfer) => Promise<string>
  onReadingRoomAreaInserted?: (
    transfer: ReadingRoomAreaTransfer,
    draftPath: string,
    receipt: string,
    draftText: string,
  ) => void | Promise<void>
}

/**
 * The CM6 editor pane. Mounts in the mockup's .editor-scroll slot; the scroll surface is CM's own
 * .cm-scroller (see app.css), and the locked typography lives in editor/theme.ts. One EditorView
 * for the window; per-file EditorState objects are swapped through it on tab switches, which is
 * what makes cursor/undo/scroll survive the round trip.
 */
export const EditorPane = forwardRef<EditorHandle, EditorPaneProps>(function EditorPane(
  { citationForText, onInsertReference, onInsertWidget, onDocChanged, onDocumentTransaction, onDocumentPointerDown, onManualReadAloudScroll, onReadAloudPositionVisibilityChange, onSuggestionResolutionReplay, onSave, hasDocument, folioPlace = null, onOpenFolioPlan, onOpenFolioPiece, hideStrikes, hideInserts, workspaceRoot, assetBaseUrl, onCutToScrap, onScrapDropped, getScrapExpansions, onChangeMarkClick, onInlineAction, onInlineSelect, margin = null, onWikilinkActivate, wikilinkPieces, writerMode, viewMode, focus, lineOverlay, readAloudPosition, readAloudWord, fixedLine, typewriterOn, onFixedLineChange, onFixedLineCommit, readAloudScrollMode, onWriterReviewChanged, compareToActive = false, overlayOpenRef, onStatus, onReadingRoomAreaPrepared, onReadingRoomAreaInserted },
  ref,
): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [folioLineHost, setFolioLineHost] = useState<HTMLElement | null>(null)
  const [marginHost, setMarginHost] = useState<HTMLElement | null>(null)
  const marginListenersRef = useRef(new Set<(update: ViewUpdate) => void>())
  const subscribeMargin = useCallback((listener: (update: ViewUpdate) => void) => {
    marginListenersRef.current.add(listener)
    return () => { marginListenersRef.current.delete(listener) }
  }, [])
  // The file the live view currently holds. Inactive files live in `statesRef`; the active one
  // lives in the view itself and is only stashed back into the map when we switch away.
  const activePathRef = useRef<string | null>(null)
  const statesRef = useRef<Map<string, EditorState>>(new Map())
  const historicalRef = useRef<{ path: string; liveState: EditorState } | null>(null)
  // The paths the document owner has detached (setReadOnly).
  const detachedRef = useRef<Set<string>>(new Set())
  const suppressChangeRef = useRef(false)
  const cursorSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollRestoreFrameRef = useRef<number | null>(null)
  const viewportRestoreFrameRef = useRef<number | null>(null)
  // The live `editor.spellcheck` choice (Task 17). Held in a ref (not state) because, like
  // typewriter mode, it must be reapplied inside switchTo — a swapped-in EditorState carries the
  // compartment's baseExtensions default, not the setting.
  const spellcheckOnRef = useRef(true)
  // The writer's chord overrides (T6) — per-view like typewriter/spellcheck, reapplied in switchTo.
  const chordOverridesRef = useRef<Record<string, string>>({})
  const assetBaseUrlRef = useRef(assetBaseUrl ?? '')
  assetBaseUrlRef.current = assetBaseUrl ?? ''
  const viewModeRef = useRef<EditorViewMode>(viewMode)
  viewModeRef.current = viewMode
  // The live focus mode (Round A). A ref for switchTo's reapply (a swapped-in EditorState resets
  // the compartment to []) + an effect below that applies prop changes to the live view.
  const focusRef = useRef(focus)
  focusRef.current = focus
  // Line focus / Ruler: the overlay compartment is reapplied per swapped-in state (like focus), and
  // the plugin reports where its focus line sits so the margin handle can ride on the band.
  const [overlayHandle, setOverlayHandle] = useState<LineOverlayHandle>({ focusFraction: null, handleFraction: null, lineFraction: 0 })
  const reportOverlayHandle = useCallback((handle: LineOverlayHandle) => setOverlayHandle(handle), [])
  // Follow = Cursor drag: the focus-line height the handle is dragged to (the caret waits for the drop).
  const [overlayDrag, setOverlayDrag] = useState<number | null>(null)
  const lineOverlayRef = useRef({ config: lineOverlay, fixedLine, drag: overlayDrag })
  lineOverlayRef.current = { config: lineOverlay, fixedLine, drag: overlayDrag }
  const readAloudPositionRef = useRef(readAloudPosition)
  readAloudPositionRef.current = readAloudPosition
  // The typewriter scroll reads the live fixed line at scroll time; keep it current before any effect runs.
  setLiveFixedLine(fixedLine)
  const readAloudScrollModeRef = useRef(readAloudScrollMode)
  readAloudScrollModeRef.current = readAloudScrollMode
  const readAloudScrollGuardRef = useRef<ReturnType<typeof createReadAloudScrollGuard> | null>(null)
  readAloudScrollGuardRef.current ??= createReadAloudScrollGuard()
  const readAloudVisibilityFrameRef = useRef<number | null>(null)
  const [objectMenu, setObjectMenu] = useState<(LivePreviewCommand & { place: Place }) | null>(null)
  const objectMenuRef = useRef<(LivePreviewCommand & { place: Place }) | null>(null)
  objectMenuRef.current = objectMenu
  const onStatusRef = useRef(onStatus)
  // An archive citation's writeflex:// link opens the piece at its line through main's link parser;
  // a public http(s) link goes out through the window-open handler to the browser.
  const openLinkRef = useRef((url: string): void => {
    if (/^writeflex:/i.test(url)) {
      void window.writeflex.openWriteflexLink(url).then((result) => {
        if (!result.ok) onStatusRef.current(`Could not open the link: ${result.reason}`)
      })
    } else {
      window.open(url, '_blank')
    }
  })
  onStatusRef.current = onStatus
  const onReadingRoomAreaInsertedRef = useRef(onReadingRoomAreaInserted)
  onReadingRoomAreaInsertedRef.current = onReadingRoomAreaInserted
  const onReadingRoomAreaPreparedRef = useRef(onReadingRoomAreaPrepared)
  onReadingRoomAreaPreparedRef.current = onReadingRoomAreaPrepared
  const notifyPendingMetadata = useCallback((view: EditorView, block: LivePreviewBlock): void => {
    if (block.kind === 'frontmatter' && blockHasPendingChange(view.state, block)) {
      onStatusRef.current('Pending agent suggestion on this block — review it in the panel')
    }
  }, [])

  const closeObjectMenu = useCallback(() => {
    setObjectMenu(null)
    requestAnimationFrame(() => viewRef.current?.focus())
  }, [])

  // The insertion itself lives in editor/insert-block-object.ts, so the Insert menu and the
  // registered `insert.table` command (ADR-0040 ticket A1b) share one implementation.
  const insertText = useCallback((
    text: string,
    opts: { open?: boolean; block?: boolean } = {},
  ): { from: number; to: number } | null => {
    const view = viewRef.current
    if (!view) return null
    return insertBlockObject(view, text, opts)
  }, [])

  const saveDroppedImages = useCallback(async (files: File[], at: number): Promise<void> => {
    const links: string[] = []
    for (const file of files) {
      const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') || file.name.split('.').pop() || 'png'
      const saved = await window.writeflex.saveImage(await file.arrayBuffer(), ext)
      links.push(`![pasted image](${saved.path})`)
      onStatusRef.current(`Saved ${saved.path}`)
    }
    const view = viewRef.current
    if (view && links.length) {
      const doc = view.state.doc.toString()
      const position = frontmatterSafeInsertPosition(doc, Math.min(at, view.state.doc.length))
      const prefix = doc.slice(0, position).endsWith('\n\n') ? '' : '\n\n'
      const suffix = position >= doc.length || doc.slice(position).startsWith('\n\n') ? '' : '\n\n'
      view.dispatch({ changes: { from: position, insert: `${prefix}${links.join('\n')}${suffix}` } })
    }
  }, [])

  const insertSvgFiles = useCallback(async (files: File[], at: number): Promise<void> => {
    const blocks = await Promise.all(files.map(async (file) => `\`\`\`svg\n${(await file.text()).trim()}\n\`\`\``))
    const view = viewRef.current
    if (!view || !blocks.length) return
    const doc = view.state.doc.toString()
    const position = frontmatterSafeInsertPosition(doc, Math.min(at, view.state.doc.length))
    const prefix = position === 0 || doc.slice(0, position).endsWith('\n\n') ? '' : '\n\n'
    const suffix = position >= doc.length || doc.slice(position).startsWith('\n\n') ? '' : '\n\n'
    const inserted = `${prefix}${blocks.join('\n\n')}${suffix}`
    view.dispatch({ changes: { from: position, insert: inserted }, selection: { anchor: position + inserted.length }, scrollIntoView: true })
    view.focus()
  }, [])

  // Extensions are built once per state, so route through refs to always call the latest props.
  const onDocChangedRef = useRef(onDocChanged)
  const onDocumentTransactionRef = useRef(onDocumentTransaction)
  const citationForTextRef = useRef(citationForText)
  const onDocumentPointerDownRef = useRef(onDocumentPointerDown)
  const onManualReadAloudScrollRef = useRef(onManualReadAloudScroll)
  const onReadAloudPositionVisibilityChangeRef = useRef(onReadAloudPositionVisibilityChange)
  const onSuggestionResolutionReplayRef = useRef(onSuggestionResolutionReplay)
  const onSaveRef = useRef(onSave)
  const workspaceRootRef = useRef(workspaceRoot)
  const onCutToScrapRef = useRef(onCutToScrap)
  const onScrapDroppedRef = useRef(onScrapDropped)
  const getScrapExpansionsRef = useRef(getScrapExpansions)
  const onChangeMarkClickRef = useRef(onChangeMarkClick)
  const onInlineActionRef = useRef(onInlineAction)
  const onInlineSelectRef = useRef(onInlineSelect)
  const onWikilinkActivateRef = useRef(onWikilinkActivate)
  const wikilinkPiecesRef = useRef(wikilinkPieces)
  const writerModeRef = useRef(writerMode)
  const onWriterReviewChangedRef = useRef(onWriterReviewChanged)
  onDocChangedRef.current = onDocChanged
  onDocumentTransactionRef.current = onDocumentTransaction
  citationForTextRef.current = citationForText
  onDocumentPointerDownRef.current = onDocumentPointerDown
  onManualReadAloudScrollRef.current = onManualReadAloudScroll
  onReadAloudPositionVisibilityChangeRef.current = onReadAloudPositionVisibilityChange
  onSuggestionResolutionReplayRef.current = onSuggestionResolutionReplay
  onSaveRef.current = onSave
  workspaceRootRef.current = workspaceRoot
  onCutToScrapRef.current = onCutToScrap
  onScrapDroppedRef.current = onScrapDropped
  getScrapExpansionsRef.current = getScrapExpansions
  onChangeMarkClickRef.current = onChangeMarkClick
  onInlineActionRef.current = onInlineAction
  onInlineSelectRef.current = onInlineSelect
  onWikilinkActivateRef.current = onWikilinkActivate
  wikilinkPiecesRef.current = wikilinkPieces
  writerModeRef.current = writerMode
  onWriterReviewChangedRef.current = onWriterReviewChanged

  /** Debounced (500ms) cursor+scroll save, keyed to whichever path was active when activity fired
   *  (captured as an argument, not re-read at fire time) so a fast file switch mid-debounce can
   *  never misattribute a save to the newly active file. */
  const scheduleCursorSave = useCallback((path: string, head: number, scrollTop: number) => {
    if (cursorSaveTimerRef.current) clearTimeout(cursorSaveTimerRef.current)
    cursorSaveTimerRef.current = setTimeout(() => {
      const root = workspaceRootRef.current
      if (!root) return
      // Prefer the live scrollTop at fire time over the value captured at schedule time: CM6's async
      // measure pass keeps adjusting the scroll position after the triggering event as line heights
      // settle, and those scroll-only adjustments never re-fire the update listener. Only safe while
      // `path` is still the active file — otherwise fall back to the captured value rather than
      // reading another file's scroll position.
      const view = viewRef.current
      const liveScrollTop = view && activePathRef.current === path ? view.scrollDOM.scrollTop : scrollTop
      saveCursor(localStorage, root, path, { head, scrollTop: liveScrollTop })
    }, CURSOR_SAVE_DEBOUNCE_MS)
  }, [])

  const reportReadAloudPositionVisibility = useCallback((view: EditorView): void => {
    const position = readAloudPositionRef.current
    if (position === null) {
      onReadAloudPositionVisibilityChangeRef.current(true)
      return
    }
    const clamped = Math.max(0, Math.min(position, view.state.doc.length))
    const positionBounds = view.coordsAtPos(clamped)
    const viewportBounds = view.scrollDOM.getBoundingClientRect()
    onReadAloudPositionVisibilityChangeRef.current(
      !isReadAloudPositionOutsideViewport(positionBounds, viewportBounds),
    )
  }, [])

  const scrollReadAloudPositionIntoView = useCallback((
    view: EditorView,
    position: number,
    force = false,
  ): void => {
    const mode = readAloudScrollModeRef.current
    let effect = null
    if (mode === 'typewriter') {
      effect = fixedLineScrollEffect(view, Math.max(0, Math.min(position, view.state.doc.length)))
    } else {
      const shouldTurn = force || shouldTurnReadAloudPage(
        view.coordsAtPos(Math.max(0, Math.min(position, view.state.doc.length))),
        view.scrollDOM.getBoundingClientRect(),
      )
      if (shouldTurn) effect = typewriterScrollEffect(position, READ_ALOUD_SCROLL_MARGIN_PX)
    }

    if (!effect) {
      reportReadAloudPositionVisibility(view)
      return
    }

    // Raise the guard before CodeMirror schedules its measure-pass scroll. The guard remains active
    // until those deferred scroll events settle, unless genuine scroll input clears it first.
    readAloudScrollGuardRef.current!.beginProgrammaticScroll()
    view.dispatch({ effects: effect })
    if (readAloudVisibilityFrameRef.current !== null) {
      cancelAnimationFrame(readAloudVisibilityFrameRef.current)
    }
    readAloudVisibilityFrameRef.current = requestAnimationFrame(() => {
      readAloudVisibilityFrameRef.current = null
      reportReadAloudPositionVisibility(view)
    })
  }, [reportReadAloudPositionVisibility])

  const buildState = useCallback(
    (content: string, readOnly = false): EditorState =>
      EditorState.create({
        doc: content,
        extensions: [
          ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
          detachedCompartment.of([]),
          citationUpgradeField,
          EditorView.updateListener.of((update) => { for (const listener of marginListenersRef.current) listener(update) }),
          // Save from within the editor. ⌘S is natively owned by the File menu (menu.ts) and
          // usually arrives as the 'save' menu action; this binding covers synthetic key events
          // (tests) and platforms where the event reaches the renderer instead.
          keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (onSaveRef.current(), true) }]),
          ...baseExtensions({
            initialViewMode: viewModeRef.current,
            onDocumentTransaction: () => onDocumentTransactionRef.current(),
            onDocChanged: (doc, beforeDoc) => {
              if (suppressChangeRef.current) return
              const path = activePathRef.current
              if (path) onDocChangedRef.current(path, doc, beforeDoc)
            },
            // Auto-link-title fetches page titles through the main-process web:fetch-title channel
            // (S9 amendment); the renderer only ever sees the preload bridge, never Node fetch.
            fetchTitle: (url) => window.writeflex.fetchLinkTitle(url),
            // Scratchpad (Task 20): the ⌘⇧X cut, drag-into-document, and `{trigger}`+space expansion all
            // read the latest App handlers through refs (extensions are built once per EditorState).
            scraps: {
              onCut: (text) => onCutToScrapRef.current(text),
              onDrop: (id) => onScrapDroppedRef.current(id),
              expansions: () => getScrapExpansionsRef.current(),
              readClipboard: () => navigator.clipboard.readText().catch(() => ''),
            },
            changeMarks: { onSelect: (id) => onChangeMarkClickRef.current(id) },
            inlineChanges: {
              onAction: (id, act) => onInlineActionRef.current(id, act),
              onSelect: (id) => onInlineSelectRef.current(id),
            },
            onWikilinkActivate: (link) => onWikilinkActivateRef.current(link),
            wikilinkPieces: () => wikilinkPiecesRef.current,
            // An archive citation's writeflex:// link opens the piece at its line through main's link
            // parser; a public http(s) link goes out through the window-open handler to the browser.
            onOpenLink: (url) => openLinkRef.current(url),
            onWriterReviewChanged: (_doc, changes) => {
              const path = activePathRef.current
              if (path) onWriterReviewChangedRef.current(path, changes)
            },
          }),
          Prec.high(EditorView.domEventHandlers({
            pointerdown(event, view) {
              if (event.button !== 0 || !view.contentDOM.contains(event.target as Node)) return false
              const target = event.target instanceof Element ? event.target : null
              if (target?.closest('button,input,select,textarea,[role="button"]')) return false
              onDocumentPointerDownRef.current()
              requestAnimationFrame(() => reportReadAloudPositionVisibility(view))
              return false
            },
            // An HTML file dragged over the text shows where its widget line would go (drawing state 14).
            dragover(event, view) {
              const items = [...(event.dataTransfer?.items ?? [])]
              if (!items.some((item) => item.kind === 'file' && item.type === 'text/html')) return false
              event.preventDefault()
              const at = widgetDropPoint(view, event.clientX, event.clientY)
              view.dispatch({ effects: setWidgetDrop.of(at === null ? null : widgetDropPosition(view, at)) })
              return true
            },
            dragleave(event, view) {
              if (event.relatedTarget instanceof Node && view.dom.contains(event.relatedTarget)) return false
              view.dispatch({ effects: setWidgetDrop.of(null) })
              return false
            },
            paste(event, view) {
              const items = [...(event.clipboardData?.items ?? [])]
              const files = items.filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((file): file is File => !!file)
              const svgs = files.filter(isSvgFile)
              if (svgs.length) {
                event.preventDefault(); void insertSvgFiles(svgs, view.state.selection.main.head); return true
              }
              const images = files.filter((file) => file.type.startsWith('image/'))
              if (!images.length) {
                // Words that came out of the Reading Room arrive as a quote WITH their reference — the
                // same act of pasting, one step instead of three.
                const pasted = event.clipboardData?.getData('text/plain') ?? ''
                const citation = pasted ? citationForTextRef.current?.(pasted) ?? null : null
                if (citation) {
                  event.preventDefault()
                  const insertionPath = activePathRef.current
                  const inserted = insertText(citation.initial, { block: true })
                  if (!inserted) return true
                  view.dispatch({
                    effects: trackCitation.of({
                      ...inserted,
                      id: citation.identity,
                      original: citation.initial,
                    }),
                  })
                  // Paste handlers cannot wait on promises: the page citation is already in the
                  // draft. Only a confirmed create may replace that exact tracked citation.
                  void citation.upgrade
                    .then((replacement) => {
                      if (activePathRef.current !== insertionPath) return
                      if (!replacement) {
                        view.dispatch({ effects: clearTrackedCitation.of(citation.identity) })
                        return
                      }
                      const range = trackedCitationRange(view.state, citation.identity)
                      if (!range) {
                        view.dispatch({ effects: clearTrackedCitation.of(citation.identity) })
                        return
                      }
                      view.dispatch({
                        changes: { ...range, insert: replacement },
                        effects: clearTrackedCitation.of(citation.identity),
                      })
                    })
                    .catch(() => { /* The page-level citation remains valid if its upgrade stops late. */ })
                  return true
                }
                const selection = view.state.selection.main
                const safe = selection.empty ? frontmatterSafeInsertPosition(view.state.doc.toString(), selection.from) : selection.from
                const plain = event.clipboardData?.getData('text/plain') ?? ''
                if (isSvgText(plain)) {
                  event.preventDefault()
                  insertText(`\`\`\`svg\n${plain.trim()}\n\`\`\``, { block: true })
                  return true
                }
                // Rich text with links (a Highlight Scout citation, a browser, Word) keeps its link
                // targets as Markdown `[words](url)`; with no anchors, the plain paste is unchanged.
                const rich = richPasteMarkdown(event.clipboardData?.getData('text/html') ?? '', plain)
                const text = rich ?? plain
                if (rich !== null && safe === selection.from) {
                  event.preventDefault()
                  view.dispatch({
                    changes: { from: selection.from, to: selection.to, insert: rich },
                    selection: { anchor: selection.from + rich.length },
                    userEvent: 'input.paste',
                    scrollIntoView: true,
                  })
                  return true
                }
                if (safe === selection.from || !text) return false
                const doc = view.state.doc.toString()
                const prefix = doc.slice(0, safe).endsWith('\n\n') ? '' : '\n\n'
                const suffix = safe >= doc.length || doc.slice(safe).startsWith('\n\n') ? '' : '\n\n'
                event.preventDefault()
                view.dispatch({ changes: { from: safe, insert: `${prefix}${text}${suffix}` }, selection: { anchor: safe + prefix.length + text.length } })
                return true
              }
              event.preventDefault(); void saveDroppedImages(images, view.state.selection.main.head); return true
            },
            drop(event, view) {
              const transfer = event.dataTransfer
              const hasAreaPayload = transfer
                ? Array.from(transfer.types).includes(READING_ROOM_AREA_MIME)
                : false
              if (hasAreaPayload) {
                event.preventDefault()
                const area = parseReadingRoomAreaTransfer(transfer?.getData(READING_ROOM_AREA_MIME) ?? '')
                if (!area) {
                  onStatusRef.current('The Area capture drag data was invalid, so nothing was inserted.')
                  return true
                }
                const insertionView = view
                const insertionState = view.state
                const insertionPath = activePathRef.current
                const quotationReceipt = (onReadingRoomAreaPreparedRef.current
                  ? onReadingRoomAreaPreparedRef.current(area)
                  : Promise.reject(new Error('Area quotation recording is unavailable.')))
                  .then(
                    (receipt) => ({ receipt } as const),
                    (error: unknown) => ({ error } as const),
                  )
                const rawPosition = view.posAtCoords({ x: event.clientX, y: event.clientY })
                  ?? view.state.selection.main.head
                let insertedDraftText: string | null = null
                void commitReadingRoomAreaDrop(area, {
                  saveImage: (bytes) => window.writeflex.saveImage(bytes, 'png'),
                  isCurrent: () => viewRef.current === insertionView
                    && insertionView.state === insertionState
                    && insertionPath !== null
                    && activePathRef.current === insertionPath,
                  insert: (markdown) => {
                    if (
                      viewRef.current !== insertionView
                      || insertionView.state !== insertionState
                      || activePathRef.current !== insertionPath
                    ) return false
                    const doc = insertionView.state.doc.toString()
                    const position = frontmatterSafeInsertPosition(
                      doc,
                      Math.min(rawPosition, insertionView.state.doc.length),
                    )
                    const prefix = position === 0 || doc.slice(0, position).endsWith('\n\n') ? '' : '\n\n'
                    const suffix = position >= doc.length || doc.slice(position).startsWith('\n\n') ? '' : '\n\n'
                    const inserted = `${prefix}${markdown}${suffix}`
                    insertionView.dispatch({
                      changes: { from: position, insert: inserted },
                      selection: { anchor: position + inserted.length },
                      scrollIntoView: true,
                    })
                    insertedDraftText = insertionView.state.doc.toString()
                    insertionView.focus()
                    return true
                  },
                  recordQuotation: async () => {
                    if (!insertionPath || !onReadingRoomAreaInsertedRef.current) {
                      throw new Error('Area quotation recording is unavailable.')
                    }
                    const prepared = await quotationReceipt
                    if ('error' in prepared) throw prepared.error
                    if (insertedDraftText === null) throw new Error('The inserted draft text was not retained.')
                    await onReadingRoomAreaInsertedRef.current(
                      area,
                      insertionPath,
                      prepared.receipt,
                      insertedDraftText,
                    )
                  },
                  onStatus: (message) => onStatusRef.current(message),
                })
                return true
              }
              const dragged = event.dataTransfer?.getData('text/plain') ?? ''
              const draggedCitation = dragged ? citationForTextRef.current?.(dragged) ?? null : null
              if (draggedCitation) {
                event.preventDefault()
                const at = view.posAtCoords({ x: event.clientX, y: event.clientY })
                if (at !== null) view.dispatch({ selection: { anchor: Math.min(at, view.state.doc.length) } })
                const insertionPath = activePathRef.current
                const inserted = insertText(draggedCitation.initial, { block: true })
                if (!inserted) return true
                view.dispatch({
                  effects: trackCitation.of({
                    ...inserted,
                    id: draggedCitation.identity,
                    original: draggedCitation.initial,
                  }),
                })
                void draggedCitation.upgrade
                  .then((replacement) => {
                    if (activePathRef.current !== insertionPath) return
                    if (!replacement) {
                      view.dispatch({ effects: clearTrackedCitation.of(draggedCitation.identity) })
                      return
                    }
                    const range = trackedCitationRange(view.state, draggedCitation.identity)
                    if (!range) {
                      view.dispatch({ effects: clearTrackedCitation.of(draggedCitation.identity) })
                      return
                    }
                    view.dispatch({
                      changes: { ...range, insert: replacement },
                      effects: clearTrackedCitation.of(draggedCitation.identity),
                    })
                  })
                  .catch(() => { /* The page-level citation remains valid if its upgrade stops late. */ })
                return true
              }
              const files = [...(event.dataTransfer?.files ?? [])]
              // An HTML file from inside the workspace becomes one embed line at the drop point; from outside it is refused.
              const html = files.find((file) => /\.html?$/i.test(file.name))
              if (html) {
                event.preventDefault()
                view.dispatch({ effects: setWidgetDrop.of(null) })
                const at = widgetDropPoint(view, event.clientX, event.clientY) ?? view.state.selection.main.head
                const documentPath = activePathRef.current
                if (!documentPath) return true
                void window.writeflex.resolveWidgetDrop(documentPath, html).then((result) => {
                  if (viewRef.current !== view || activePathRef.current !== documentPath) return
                  if (result.ok) insertWidgetLine(view, result.rawPath, Math.min(at, view.state.doc.length))
                  else onStatusRef.current(result.reason === 'outside-workspace'
                    ? 'This file is outside your workspace, so WriteFlex will not run it.'
                    : result.reason === 'not-html' ? `${html.name} is not an HTML file.` : `Cannot find ${html.name}`)
                })
                return true
              }
              const svgs = files.filter(isSvgFile)
              if (svgs.length) {
                event.preventDefault()
                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
                void insertSvgFiles(svgs, pos); return true
              }
              const images = files.filter((file) => file.type.startsWith('image/'))
              if (!images.length) return false
              event.preventDefault()
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
              void saveDroppedImages(images, pos); return true
            },
          })),
          widgetDropIndicator(),
          livePreview({
            assetBaseUrl: () => assetBaseUrlRef.current,
            documentPath: () => activePathRef.current,
            overlayOpen: () => overlayOpenRef.current || objectMenuRef.current !== null,
            onCommandK: (command) => { const state = viewRef.current?.state; if (state) setObjectMenu({ ...command, place: placeAt(state) }) },
            onPendingMetadataEdit: () => onStatusRef.current('Pending agent suggestion on this block — review it in the panel'),
          }),
          suggestionResolutionHistory((effect) => onSuggestionResolutionReplayRef.current(effect)),
        ],
      }),
    [notifyPendingMetadata, overlayOpenRef, saveDroppedImages],
  )

  useEffect(() => {
    const view = new EditorView({ parent: hostRef.current ?? undefined, state: buildState('') })
    viewRef.current = view
    // The Folio line lives in CM's scroll element, before the content: it scrolls with the text and is
    // outside the document. The host is out of flow (absolute), so the text column does not move.
    const lineMount = document.createElement('div')
    lineMount.className = 'folio-line-host'
    view.scrollDOM.insertBefore(lineMount, view.contentDOM)
    setFolioLineHost(lineMount)
    // The review margin lives in the same scroller, out of flow, so its cards scroll with the text.
    const marginMount = document.createElement('div')
    marginMount.className = 'wf-margin-host'
    view.scrollDOM.insertBefore(marginMount, view.contentDOM)
    setMarginHost(marginMount)
    const noteUserScrollIntent = (): void => {
      readAloudScrollGuardRef.current!.noteUserScrollIntent()
    }
    const onPotentialScrollKey = (event: KeyboardEvent): void => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        noteUserScrollIntent()
      }
    }
    const onScroll = (): void => {
      if (
        readAloudPositionRef.current !== null
        && readAloudScrollGuardRef.current!.shouldPauseForScroll()
      ) {
        onManualReadAloudScrollRef.current()
      }
      reportReadAloudPositionVisibility(view)
    }
    view.scrollDOM.addEventListener('scroll', onScroll)
    view.scrollDOM.addEventListener('wheel', noteUserScrollIntent, { passive: true })
    view.scrollDOM.addEventListener('pointerdown', noteUserScrollIntent, { capture: true })
    view.scrollDOM.addEventListener('keydown', onPotentialScrollKey, { capture: true })
    return () => {
      view.scrollDOM.removeEventListener('scroll', onScroll)
      view.scrollDOM.removeEventListener('wheel', noteUserScrollIntent)
      view.scrollDOM.removeEventListener('pointerdown', noteUserScrollIntent, { capture: true })
      view.scrollDOM.removeEventListener('keydown', onPotentialScrollKey, { capture: true })
      if (readAloudVisibilityFrameRef.current !== null) {
        cancelAnimationFrame(readAloudVisibilityFrameRef.current)
        readAloudVisibilityFrameRef.current = null
      }
      readAloudScrollGuardRef.current!.dispose()
      setFolioLineHost(null)
      setMarginHost(null)
      view.destroy()
      viewRef.current = null
    }
  }, [buildState, reportReadAloudPositionVisibility])

  useEffect(() => {
    const content = viewRef.current?.contentDOM
    if (!content) return
    content.classList.toggle('hide-strikes', hideStrikes)
    content.classList.toggle('hide-inserts', hideInserts)
  }, [hideStrikes, hideInserts])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !activePathRef.current || historicalRef.current) return
    // A mode switch changes no text: it stays out of the undo history, so ⌘Z is never spent on it.
    view.dispatch({ effects: setWriterMode.of(writerMode), annotations: Transaction.addToHistory.of(false) })
  }, [writerMode])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: setEditorViewMode.of(viewMode) })
    // Raw mode reads as a code editor: a class on the content DOM switches the whole surface to the
    // mono font and drops prose/object styling (CSS). Clean/Markup keep the prose surface.
    view.contentDOM.classList.toggle('view-raw', viewMode === 'raw')
  }, [viewMode])

  // Focus mode (Round A, ADR-0028): apply the live choice to the view whenever it changes — the
  // declarative twin of the viewMode effect above; switchTo reapplies it per swapped-in state.
  useEffect(() => {
    const view = viewRef.current
    if (view) setFocusMode(view, focus.mode, focus.leadStyle)
  }, [focus.mode, focus.leadStyle])

  useEffect(() => {
    const view = viewRef.current
    if (view) setLineOverlay(view, lineOverlay, fixedLine, reportOverlayHandle, overlayDrag)
    if (!lineOverlayActive(lineOverlay)) setOverlayHandle({ focusFraction: null, handleFraction: null, lineFraction: 0 })
  }, [lineOverlay, fixedLine, reportOverlayHandle, overlayDrag])

  // Follow = Typewriter: switching it on brings the cursor line to the band once; from then on the
  // extension inside the overlay compartment keeps it there (typewriter-follow.ts).
  const typewriterFollow = wantsTypewriterFollow(lineOverlay)
  const wasTypewriterFollowRef = useRef(false)
  useEffect(() => {
    const was = wasTypewriterFollowRef.current
    wasTypewriterFollowRef.current = typewriterFollow
    const view = viewRef.current
    if (typewriterFollow && !was && view && readAloudPositionRef.current === null) scrollCursorToTypewriterLine(view)
  }, [typewriterFollow])

  const readAloudActive = readAloudPosition !== null
  useEffect(() => {
    const view = viewRef.current
    if (view) setReadAloudScrollSupport(view, readAloudActive)
  }, [readAloudActive])

  // The voice's source position is declarative like focus mode; a swapped state is reapplied below.
  // If the writer's own Typewriter mode is also on, its listener stays configured but only reacts to
  // document/selection changes. Voice-boundary effects change neither, so the voice is the sole
  // scroll owner while it runs; the writer's mode resumes naturally after reading stops or pauses.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    setReadAloud(view, readAloudPosition, readAloudWord)
    if (readAloudPosition === null) {
      onReadAloudPositionVisibilityChangeRef.current(true)
      return
    }
    scrollReadAloudPositionIntoView(view, readAloudPosition)
    // The word's two ends, not its object, so a pause (same word) never re-scrolls.
  }, [readAloudPosition, readAloudWord?.from, readAloudWord?.to, readAloudScrollMode, fixedLine, scrollReadAloudPositionIntoView])

  // Typewriter mode follows the marker: when the fixed line moves, the caret line moves with it.
  // (While the voice is speaking, the effect above owns the scroll.)
  const previousFixedLineRef = useRef(fixedLine)
  useEffect(() => {
    const changed = previousFixedLineRef.current !== fixedLine
    previousFixedLineRef.current = fixedLine
    const view = viewRef.current
    if (!changed || !view || !(typewriterOn || typewriterFollow) || readAloudPositionRef.current !== null) return
    view.dispatch({ effects: fixedLineScrollEffect(view, view.state.selection.main.head) })
  }, [fixedLine, typewriterOn, typewriterFollow])

  // The marker sits in the left margin at the fixed line's height, measured from the live scroller.
  const paneRef = useRef<HTMLDivElement | null>(null)
  const [markerBounds, setMarkerBounds] = useState<FixedLineBounds | null>(null)
  const overlayOn = lineOverlayActive(lineOverlay)
  const markerVisible = readAloudActive || typewriterOn || overlayOn
  // The handle is always draggable and never changes the Follow mode. Cursor: the caret moves to the line
  // under the drop point. Read-aloud: the fixed-line height. By hand: the line is placed and locked.
  const [dragFraction, setDragFraction] = useState<number | null>(null)
  const overlayFollow = lineOverlay.lineFocus.on ? lineOverlay.lineFocus.follow : lineOverlay.ruler.follow
  // For a Ruler the handle sits on the bar, a line below the focus line: drops are measured on the focus line.
  const handleOffset = overlayHandle.handleFraction !== null && overlayHandle.focusFraction !== null ? overlayHandle.handleFraction - overlayHandle.focusFraction : 0
  const moveCaretToFraction = (fraction: number): void => {
    const view = viewRef.current
    if (!view) return
    const scroller = view.scrollDOM.getBoundingClientRect()
    const y = scroller.top + fraction * view.scrollDOM.clientHeight
    const content = view.contentDOM.getBoundingClientRect()
    // Keep the column where there is one; a shorter line takes its end, an empty one its start.
    const x = view.coordsAtPos(view.state.selection.main.head)?.left ?? content.left + 1
    const pos = view.posAtCoords({ x, y }, false)
    if (pos !== view.state.selection.main.head) view.dispatch({ selection: { anchor: pos } })
  }
  useEffect(() => {
    const view = viewRef.current
    const pane = paneRef.current
    if (!markerVisible || !view || !pane) {
      setMarkerBounds(null)
      return
    }
    const measure = (): void => {
      const scroller = view.scrollDOM.getBoundingClientRect()
      const frame = pane.getBoundingClientRect()
      setMarkerBounds((previous) => {
        const next = { top: scroller.top - frame.top, height: scroller.height }
        return previous && previous.top === next.top && previous.height === next.height ? previous : next
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(view.scrollDOM)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [markerVisible])

  // Cursor/scroll memory: the shared editor-update bus (setup.ts) fires on every doc or selection
  // change, so debounce a save of the active file's live head + scrollTop off it. Kept out of
  // baseExtensions so setup.ts stays agnostic of persistence; scroll-only nudges are picked up by
  // reading the live scrollTop at debounce-fire time (see scheduleCursorSave).
  useEffect(
    () =>
      onEditorUpdate(() => {
        const view = viewRef.current
        const path = activePathRef.current
        if (!view || !path) return
        scheduleCursorSave(path, view.state.selection.main.head, view.scrollDOM.scrollTop)
      }),
    [scheduleCursorSave],
  )

  useEffect(
    () => () => {
      if (cursorSaveTimerRef.current) clearTimeout(cursorSaveTimerRef.current)
      if (scrollRestoreFrameRef.current !== null) cancelAnimationFrame(scrollRestoreFrameRef.current)
      if (viewportRestoreFrameRef.current !== null) cancelAnimationFrame(viewportRestoreFrameRef.current)
    },
    [],
  )

  useImperativeHandle(
    ref,
    (): EditorHandle => ({
      view: () => viewRef.current,
      path: () => activePathRef.current,
      insertionPoint: () => {
        const view = viewRef.current
        if (!view) return null
        const content = view.state.doc.toString()
        const position = frontmatterSafeInsertPosition(content, view.state.selection.main.head)
        return {
          anchor: { from: position, to: position },
          ...(position > 0 ? { insertAfter: content.slice(0, position) } : {}),
        }
      },
      insertText: (text, opts) => insertText(text, { block: opts?.block ?? false }),
      returnToReadAloudPosition: () => {
        const view = viewRef.current
        const position = readAloudPositionRef.current
        if (view && position !== null) {
          scrollReadAloudPositionIntoView(view, position, true)
        }
      },
      // direction 0 = the query changed (anchor to the match at/after the cursor — do NOT walk, or
      // typing letter by letter would march to the last match); ±1 = step from the current match.
      find: (query, direction = 0, replacement = '') => {
        const view = viewRef.current
        if (!view || !query) { view?.dispatch({ effects: setFindMatches.of({ matches: [], current: -1 }) }); return { current: 0, total: 0 } }
        const matches = searchMatches(new SearchQuery({ search: query, replace: replacement, literal: true }), view.state)
        if (matches.length === 0) { view.dispatch({ effects: setFindMatches.of({ matches: [], current: -1 }) }); return { current: 0, total: 0 } }
        const selection = view.state.selection.main
        let index: number
        if (direction === 0) {
          // First match ending after the cursor; the current selection sits ON its match, so re-querying
          // as the term grows keeps landing on the same match rather than advancing past it. Wrap to 0.
          index = matches.findIndex((match) => match.to > selection.from)
          if (index < 0) index = 0
        } else {
          const current = matches.findIndex((match) => match.from === selection.from && match.to === selection.to)
          index = current < 0 ? (direction === 1 ? 0 : matches.length - 1) : (current + direction + matches.length) % matches.length
        }
        return showFindMatch(view, matches, index)
      },
      clearFind: () => {
        const view = viewRef.current
        if (!view) return
        view.dispatch({ effects: setFindMatches.of({ matches: [], current: -1 }) })
        view.focus()
      },
      replaceFind: (query, replacement, all = false) => {
        const view = viewRef.current
        if (!view || !query) return { current: 0, total: 0 }
        const before = searchMatches(new SearchQuery({ search: query, literal: true }), view.state)
        if (before.length === 0) return { current: 0, total: 0 }
        const selection = view.state.selection.main
        const onMatch = before.find((match) => match.from === selection.from && match.to === selection.to)
        // Replace all, or just the current match (the one the caret sits on, else the first).
        const targets = all ? before : [onMatch ?? before[0]]
        view.dispatch({ changes: targets.map((match) => ({ from: match.from, to: match.to, insert: replacement })) })
        const after = searchMatches(new SearchQuery({ search: query, replace: replacement, literal: true }), view.state)
        if (after.length === 0) { view.dispatch({ effects: setFindMatches.of({ matches: [], current: -1 }) }); return { current: 0, total: 0 } }
        const next = after.findIndex((match) => match.to > selection.from)
        return showFindMatch(view, after, next < 0 ? 0 : next)
      },
      currentDoc: () => {
        if (historicalRef.current) return documentTextForPersistence(historicalRef.current.liveState)
        const state = viewRef.current?.state
        return state ? documentTextForPersistence(state) : ''
      },
      selectedText: () => {
        const state = viewRef.current?.state
        if (!state) return null
        const range = state.selection.main
        return range.empty ? null : state.sliceDoc(range.from, range.to)
      },
      rawDocFor: (path) => {
        if (historicalRef.current?.path === path) return historicalRef.current.liveState.doc.toString()
        if (activePathRef.current === path) return viewRef.current?.state.doc.toString() ?? null
        return statesRef.current.get(path)?.doc.toString() ?? null
      },
      setInlineChanges: (changes, selectedId, suggestions = []) => {
        const view = viewRef.current
        if (!view) return []
        const doc = view.state.doc.toString()
        const inline: InlineChange[] = []
        const unplaced: string[] = []
        for (const c of changes) {
          const rendered = inlineChangeForPendingAgentChange(doc, c, selectedId, liveMoveInputForChange(c, suggestions))
          if (rendered) inline.push(rendered)
          else unplaced.push(c.id)
        }
        view.dispatch({
          effects: setInlineChanges.of(inline),
        })
        return unplaced
      },
      revealChange: (change) => {
        const view = viewRef.current
        // Every item's words are in the text, drawn or not (Drafting shows quiet marks, ticket 13): Show in text and
        // stepping put the caret on them whoever made the change. Where Reviewing draws the change its words are
        // selected as before; in Drafting the caret sits at their start, so no selection-match highlighting rides on a stray selection.
        if (!view) return false
        const range = resolveChangeRange(view.state.doc.toString(), change)
        if (!range) return false
        const from = Math.min(range.from, view.state.doc.length)
        const to = Math.min(Math.max(range.to, from), view.state.doc.length)
        const select = revisionDecorationsVisible(view.state) || change.provenance === 'writer'
        view.dispatch({
          selection: select ? { anchor: from, head: to } : { anchor: from },
          effects: EditorView.scrollIntoView(from, { y: 'center' }),
        })
        return true
      },
      setCompareHighlights: (highlights) => {
        const view = viewRef.current
        if (!view) return
        view.dispatch({ effects: setCompareHighlights.of(highlights) })
      },
      setWikilinks: (links) => {
        const view = viewRef.current
        if (view) view.dispatch({ effects: setWikilinkResolutions.of(links) })
      },
      activateWikilink: () => {
        const view = viewRef.current
        if (!view) return false
        // ⌥⏎ follows a wikilink first, else a Markdown link (an archive citation's archive/public link).
        return activateWikilinkAtCursor(view, (link) => onWikilinkActivateRef.current(link)) || openMarkdownLinkAt(view, openLinkRef.current)
      },
      switchTo: (path, content, mode) => {
        const view = viewRef.current
        if (!view) return
        const historical = historicalRef.current
        if (historical) {
          if (historical.path === path) view.setState(historical.liveState)
          else statesRef.current.set(historical.path, historical.liveState)
          historicalRef.current = null
        }
        const outgoing = activePathRef.current
        if (outgoing === path) return // re-activation of the file already shown (e.g. after save)
        const root = workspaceRootRef.current
        // Typewriter is a per-view mode: read it from the outgoing live state so it carries to the
        // swapped-in state, whose compartment always starts at the baseExtensions default ([]).
        const typewriterOn = isTypewriterOn(view.state)
        // Stash the outgoing file's full state (doc, selection, undo history) before swapping.
        if (outgoing !== null) {
          statesRef.current.set(outgoing, view.state)
          // Save the outgoing file's cursor synchronously (not the debounce) so a fast switch never
          // loses its final position, and cancel any debounced save it may have queued.
          if (cursorSaveTimerRef.current) clearTimeout(cursorSaveTimerRef.current)
          if (root) {
            saveCursor(localStorage, root, outgoing, {
              head: view.state.selection.main.head,
              scrollTop: view.scrollDOM.scrollTop,
            })
          }
        }
        activePathRef.current = path
        const cached = statesRef.current.get(path)
        view.setState(cached ?? buildState(content))
        view.dispatch({ effects: setWriterMode.of(mode), annotations: Transaction.addToHistory.of(false) })
        // The active file lives in the view, never the map, so a later switch stashes fresh state.
        statesRef.current.delete(path)
        // A cached/fresh state resets the compartments, so reapply the live per-view modes.
        view.dispatch({ effects: detachedCompartment.reconfigure(detachedRef.current.has(path) ? DETACHED : []) })
        setTypewriter(view, typewriterOn)
        if (focusRef.current.mode !== '') setFocusMode(view, focusRef.current.mode, focusRef.current.leadStyle)
        if (lineOverlayActive(lineOverlayRef.current.config)) setLineOverlay(view, lineOverlayRef.current.config, lineOverlayRef.current.fixedLine, reportOverlayHandle, lineOverlayRef.current.drag)
        setReadAloudScrollSupport(view, readAloudPositionRef.current !== null)
        setReadAloud(view, readAloudPositionRef.current)
        if (!spellcheckOnRef.current) setSpellcheck(view, false)
        // Assignable chords (T6): a swapped-in state carries the compartment's default keymap, not
        // the writer's overrides — reapply them or a reassigned chord silently reverts on tab switch.
        if (Object.keys(chordOverridesRef.current).length > 0) setEditorChords(view, chordOverridesRef.current)
        view.dispatch({ effects: setEditorViewMode.of(viewModeRef.current) })
        // Restore this file's remembered cursor + scroll. The caret goes in now; the scroll is
        // deferred one frame because scrollHeight isn't settled until the swapped-in content lays
        // out — a synchronous scrollTop write can clamp to 0 on a tall doc that hasn't measured yet.
        if (scrollRestoreFrameRef.current !== null) {
          cancelAnimationFrame(scrollRestoreFrameRef.current)
          scrollRestoreFrameRef.current = null
        }
        const saved = root ? loadCursor(localStorage, root, path) : null
        if (saved) {
          const head = Math.min(Math.max(saved.head, 0), view.state.doc.length)
          view.dispatch({ selection: { anchor: head } })
          scrollRestoreFrameRef.current = requestAnimationFrame(() => {
            scrollRestoreFrameRef.current = null
            if (activePathRef.current !== path) return // a newer switch already won
            view.scrollDOM.scrollTop = saved.scrollTop
            // The restore dispatch above (and App's follow-up setContent for this same load) fired
            // the update bus synchronously, scheduling a debounced save that captured the PREVIOUS
            // scrollTop. Cancel it and persist the values actually applied so a user who pauses
            // >500ms right after switching keeps the correct position.
            if (cursorSaveTimerRef.current) clearTimeout(cursorSaveTimerRef.current)
            const liveRoot = workspaceRootRef.current
            if (liveRoot) {
              saveCursor(localStorage, liveRoot, path, {
                head: view.state.selection.main.head,
                scrollTop: view.scrollDOM.scrollTop,
              })
            }
          })
        }
        // Keyboard-first: opening a document means writing in it next.
        view.focus()
      },
      setContent: (path, disk, opts) => {
        const view = viewRef.current
        if (!view) return
        // Disk bytes enter the editor here: offsets, lengths and the identical-content check below are
        // all in the editor's LF form, which is what CodeMirror stores for a CRLF or lone-CR file (bug 01).
        const content = editorTextOf(disk)
        if (historicalRef.current?.path === path) {
          historicalRef.current = { path, liveState: buildState(content) }
          return
        }
        if (activePathRef.current === path) {
          // Viewport invariant: while this document remains open and the writer has not moved the caret
          // or typed, NOTHING may change its scroll position. Identical reconciles therefore do nothing;
          // genuine external edits preserve the exact selection and scrollTop instead of navigating.
          if (documentTextForPersistence(view.state) === content) return
          const preservedSelection = view.state.selection
          const preservedScrollTop = view.scrollDOM.scrollTop
          suppressChangeRef.current = opts?.silent === true
          try {
            // Reconcile with the SMALLEST raw-buffer replacement, so pending writer track-changes
            // outside the changed region survive by position mapping (the old full-doc replace +
            // clearWriterReviewChanges silently folded the writer's tracked edits into plain text —
            // the 2026-07-11 "auto-accepted my sentence" walk report). addToHistory:false keeps disk
            // reconciles out of ⌘Z, so undo only ever walks the writer's own edits.
            const pending = pendingWriterChanges(view.state)
            if (pending.length > 0 && opts?.discardLocal !== true) {
              const clean = documentTextForPersistence(view.state)
              const spec = reconcileReplace(pending, clean, content)
              if (spec) {
                view.dispatch({
                  changes: spec,
                  selection: clampSelectionToDocument(preservedSelection, content.length),
                  annotations: [skipWriterReviewTracking.of(true), Transaction.addToHistory.of(false)],
                })
              }
            } else {
              view.dispatch({
                changes: { from: 0, to: view.state.doc.length, insert: content },
                selection: clampSelectionToDocument(preservedSelection, content.length),
                effects: clearWriterReviewChanges.of(),
                annotations: [skipWriterReviewTracking.of(true), Transaction.addToHistory.of(false)],
              })
            }
            const reconciledState = view.state
            view.scrollDOM.scrollTop = preservedScrollTop
            if (viewportRestoreFrameRef.current !== null) cancelAnimationFrame(viewportRestoreFrameRef.current)
            viewportRestoreFrameRef.current = requestAnimationFrame(() => {
              viewportRestoreFrameRef.current = null
              if (activePathRef.current === path && view.state === reconciledState) {
                view.scrollDOM.scrollTop = preservedScrollTop
              }
            })
          } finally {
            suppressChangeRef.current = false
          }
        } else {
          // Not showing this file: discard its cached state so a later switchTo re-reads from disk.
          statesRef.current.delete(path)
        }
      },
      recordSuggestionResolution: (path, id, action, resolvedContent) => {
        const view = viewRef.current
        if (!view || activePathRef.current !== path || historicalRef.current) return false
        const beforeContent = documentTextForPersistence(view.state)
        let changes: ReturnType<typeof reconcileReplace> = null
        if (action === 'accept' && resolvedContent !== undefined) {
          const pending = pendingWriterChanges(view.state)
          changes = reconcileReplace(pending, documentTextForPersistence(view.state), resolvedContent)
        }
        suppressChangeRef.current = true
        try {
          preserveViewportPosition(
            view.scrollDOM,
            () => view.dispatch(suggestionResolutionSpec({
              id,
              path,
              action,
              ...(action === 'accept' ? { beforeContent } : {}),
              ...(changes ? { changes } : {}),
            })),
            (restore) => {
              if (viewportRestoreFrameRef.current !== null) cancelAnimationFrame(viewportRestoreFrameRef.current)
              const resolvedState = view.state
              viewportRestoreFrameRef.current = requestAnimationFrame(() => {
                viewportRestoreFrameRef.current = null
                if (activePathRef.current === path && view.state === resolvedState) restore()
              })
            },
          )
        } finally { suppressChangeRef.current = false }
        return true
      },
      enterHistorical: (path, content) => {
        const view = viewRef.current
        if (!view || activePathRef.current !== path) return
        const existing = historicalRef.current
        const liveState = existing?.path === path ? existing.liveState : view.state
        historicalRef.current = { path, liveState }
        view.setState(buildState(content, true))
      },
      enterSessionRecall: (path, content, records) => {
        const view = viewRef.current
        if (!view || activePathRef.current !== path) return
        const existing = historicalRef.current
        const liveState = existing?.path === path ? existing.liveState : view.state
        historicalRef.current = { path, liveState }
        const historicalState = buildState(content, true)
        view.setState(historicalState.update(materialiseRecordsTransaction(records, content)).state)
      },
      exitHistorical: () => {
        const view = viewRef.current
        const historical = historicalRef.current
        if (!view || !historical) return
        historicalRef.current = null
        view.setState(historical.liveState)
        view.focus()
      },
      forget: (path) => {
        statesRef.current.delete(path)
        detachedRef.current.delete(path)
        if (activePathRef.current === path) activePathRef.current = null
      },
      setReadOnly: (paths, readOnly) => {
        for (const path of paths) {
          if (readOnly) detachedRef.current.add(path)
          else detachedRef.current.delete(path)
        }
        const view = viewRef.current
        const active = activePathRef.current
        if (view && active !== null && paths.includes(active) && !historicalRef.current) {
          view.dispatch({ effects: detachedCompartment.reconfigure(readOnly ? DETACHED : []) })
        }
      },
      renamePath: (oldPath, newPath) => {
        if (detachedRef.current.delete(oldPath)) detachedRef.current.add(newPath)
        if (activePathRef.current === oldPath) activePathRef.current = newPath
        const cached = statesRef.current.get(oldPath)
        if (cached) {
          statesRef.current.set(newPath, cached)
          statesRef.current.delete(oldPath)
        }
      },
      goToLine: (line) => {
        const view = viewRef.current
        if (!view) return
        const doc = view.state.doc
        const target = doc.line(Math.min(Math.max(line, 1), doc.lines)).from
        view.dispatch({
          selection: { anchor: target },
          effects: EditorView.scrollIntoView(target, { y: 'start', yMargin: 80 }),
        })
        // Keyboard-first: land in the editor at the jumped-to line, ready to write.
        view.focus()
      },
      goToMatch: (line, column, length) => {
        const view = viewRef.current
        if (!view) return
        const doc = view.state.doc
        const target = doc.line(Math.min(Math.max(line, 1), doc.lines))
        const from = Math.min(target.from + Math.max(column - 1, 0), target.to)
        const to = Math.min(from + Math.max(length, 0), target.to)
        view.dispatch({
          selection: { anchor: from, head: to },
          effects: EditorView.scrollIntoView(from, { y: 'start', yMargin: 80 }),
        })
        // Keyboard-first: land in the editor on the selected match, ready to edit it.
        view.focus()
      },
      setMetadataCollapsed: (collapsed) => { setMetadataCollapsed(workspaceRootRef.current ?? '', collapsed) },
      editMetadata: () => {
        const view = viewRef.current
        if (!view) return
        const metadata = livePreviewBlocks(view.state).find((block) => block.kind === 'frontmatter' && block.from === 0)
        const entry = metadataEntry(view.state.doc.toString(), metadata !== undefined)
        if (entry.kind === 'open' && metadata) {
          notifyPendingMetadata(view, metadata)
          view.dispatch({ selection: { anchor: 0 }, effects: setOpenLivePreviewBlock.of(metadata), scrollIntoView: true })
        } else if (entry.kind === 'malformed') {
          onStatusRef.current('Metadata is mid-edit or malformed — fix the source before reopening it')
        } else if (entry.kind === 'create') {
          view.dispatch({ changes: { from: 0, insert: entry.insert }, selection: { anchor: 0 }, effects: setOpenLivePreviewBlock.of({ from: 0, to: entry.insert.length - 1 }), scrollIntoView: true })
        }
      },
      toggleTypewriter: () => {
        const view = viewRef.current
        if (!view) return false
        const next = !isTypewriterOn(view.state)
        setTypewriter(view, next)
        return next
      },
      setTypewriter: (on) => {
        const view = viewRef.current
        if (view) setTypewriter(view, on)
      },
      setSpellcheck: (on) => {
        spellcheckOnRef.current = on
        const view = viewRef.current
        if (view) setSpellcheck(view, on)
      },
      setCommandChords: (overrides) => {
        chordOverridesRef.current = overrides
        const view = viewRef.current
        if (view) setEditorChords(view, overrides)
      },
      setViewMode: (mode) => {
        viewModeRef.current = mode
        const view = viewRef.current
        if (view) view.dispatch({ effects: setEditorViewMode.of(mode) })
      },
      docFor: (path) => {
        if (historicalRef.current?.path === path) return documentTextForPersistence(historicalRef.current.liveState)
        if (activePathRef.current === path) {
          const state = viewRef.current?.state
          return state ? documentTextForPersistence(state) : null
        }
        const cached = statesRef.current.get(path)
        return cached ? documentTextForPersistence(cached) : null
      },
      pendingWriterChanges: (path) => {
        if (activePathRef.current === path && viewRef.current) return pendingWriterChanges(viewRef.current.state)
        const cached = statesRef.current.get(path)
        return cached ? pendingWriterChanges(cached) : []
      },
      revealDraftingSession: (path) => {
        const view = viewRef.current
        if (!view) return
        if (activePathRef.current === path) {
          view.dispatch(materialiseDraftingChanges(view.state))
          return
        }
        const cached = statesRef.current.get(path)
        if (cached) statesRef.current.set(path, cached.update(materialiseDraftingChanges(cached)).state)
      },
      foldWriterChanges: (path) => {
        const view = viewRef.current
        if (!view) return
        if (activePathRef.current === path) {
          view.dispatch(foldReviewingChanges(view.state))
          return
        }
        const cached = statesRef.current.get(path)
        if (cached) statesRef.current.set(path, cached.update(foldReviewingChanges(cached)).state)
      },
      settleWriterChanges: (path) => {
        const view = viewRef.current
        if (!view) return
        if (activePathRef.current === path) {
          const clean = documentTextForPersistence(view.state)
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: clean },
            effects: clearWriterReviewChanges.of(),
            annotations: skipWriterReviewTracking.of(true),
          })
          return
        }
        const cached = statesRef.current.get(path)
        if (cached) {
          statesRef.current.set(
            path,
            cached.update({
              changes: { from: 0, to: cached.doc.length, insert: documentTextForPersistence(cached) },
              effects: clearWriterReviewChanges.of(),
              annotations: skipWriterReviewTracking.of(true),
            }).state,
          )
        }
      },
      resolveWriterChange: (path, localId, action) => {
        const view = viewRef.current
        if (view && activePathRef.current === path) {
          const spec = resolveWriterChangeSpec(view.state, localId, action)
          if (!spec) return false
          view.dispatch(spec)
          return true
        }
        const cached = statesRef.current.get(path)
        if (!cached) return false
        const spec = resolveWriterChangeSpec(cached, localId, action)
        if (!spec) return false
        statesRef.current.set(path, cached.update(spec).state)
        return true
      },
    }),
    [buildState, scrollReadAloudPositionIntoView],
  )

  const classes = [
    'editor-scroll',
    hasDocument ? '' : 'no-doc',
    compareToActive ? 'compare-live-to' : '',
  ].filter(Boolean).join(' ')

  /** Edit, Copy source and Delete block on the block the menu was opened on. */
  const runBlockAction = (view: EditorView, action: string, opened: LivePreviewBlock | null): void => {
    const block = opened
      ? livePreviewBlocks(view.state).find((item) => item.from === opened.from && item.kind === opened.kind)
      : activeBlock(view)
    if (!block) { onStatusRef.current('That block changed — select it and open the menu again'); view.focus(); return }
    if (action === 'edit') { notifyPendingMetadata(view, block); view.dispatch({ selection: { anchor: block.from }, effects: setOpenLivePreviewBlock.of(block), scrollIntoView: true }) }
    else if (action === 'copy') { void navigator.clipboard.writeText(block.source); onStatusRef.current('Block source copied') }
    else if (action === 'delete') view.dispatch({ changes: { from: block.from, to: block.to }, selection: { anchor: block.from } })
    view.focus()
  }

  /** One object of Insert object…, by the id it has had since the menu began (table, image, mermaid:pie …). */
  const runInsertAction = (view: EditorView, id: string): void => {
    if (id === 'outline-to-mind-map') {
      const registered = registryCommand('outline.toMindMap')
      registered.run?.(view)
      view.focus()
      return
    }
    if (id === 'metadata') {
      const metadata = livePreviewBlocks(view.state).find((block) => block.kind === 'frontmatter' && block.from === 0)
      const entry = metadataEntry(view.state.doc.toString(), metadata !== undefined)
      if (entry.kind === 'open' && metadata) { notifyPendingMetadata(view, metadata); view.dispatch({ selection: { anchor: 0 }, effects: setOpenLivePreviewBlock.of(metadata), scrollIntoView: true }) }
      else if (entry.kind === 'malformed') onStatusRef.current('Metadata is mid-edit or malformed — fix the source before reopening it')
      else if (entry.kind === 'create') view.dispatch({ changes: { from: 0, insert: entry.insert }, selection: { anchor: 0 }, effects: setOpenLivePreviewBlock.of({ from: 0, to: entry.insert.length - 1 }), scrollIntoView: true })
      return
    }
    if (id === 'image') {
      void window.writeflex.pickImage().then((saved) => {
        if (saved) { insertText(`![${saved.path.split('/').at(-1) ?? 'image'}](${saved.path})`, { block: true }); onStatusRef.current(`Saved ${saved.path}`) }
      })
      return
    }
    if (id === 'reference') { onInsertReference?.(); return }
    if (id === 'widget') { onInsertWidget?.(); return }
    // The registered command, not a second copy of it: one verb, one code path (ADR-0040 A1b).
    if (id === 'table') registryCommand('insert.table').run?.(view)
    else if (id === 'code') insertText(buildCodeBlock(), { open: true })
    else if (id.startsWith('mermaid:')) insertText(buildMermaid(id.slice('mermaid:'.length) as Parameters<typeof buildMermaid>[0]), { open: true })
    else if (id === 'markmap') insertText(buildMarkmap(), { open: true })
    else if (id === 'svg') insertText(buildSvg(), { open: true })
    else if (id === 'divider') insertText('---', { block: true })
    else if (id === 'footnote') {
      const before = view.state.doc.toString()
      const final = insertFootnote(before, view.state.selection.main.head)
      view.dispatch({ changes: { from: 0, to: before.length, insert: final }, selection: { anchor: final.length }, scrollIntoView: true })
      view.focus()
    }
  }

  /**
   * The rows of Actions here that only the editor can run: the block's Edit, Copy source and Delete,
   * the objects of Insert object…, and the table's column commands. True when it ran one (the panel
   * is closed here). Every other row is run by App as the palette runs it.
   */
  const runEditorRow = (id: string): boolean => {
    const view = viewRef.current
    const menu = objectMenuRef.current
    if (!view || !menu) return false
    // Delete block at a paragraph, quotation or list item: no confirmation, undo restores it. Objects and metadata keep theirs.
    if (id === 'block.delete' && ['paragraph', 'quotation', 'list-item', 'task-item'].includes(menu.place)) {
      setObjectMenu(null)
      if (deleteBlock(view)) commandRan(id)
      view.focus()
      return true
    }
    // A quotation's Turn into target: make it a plain paragraph, then the paragraph target, as one undo step.
    // Lists and code act on every line of the quotation; a heading is one line, so it takes the caret's line.
    if (id.startsWith(COMPOSED_PREFIX)) {
      setObjectMenu(null)
      const targetId = id.slice(COMPOSED_PREFIX.length)
      const target = registryCommand(targetId).run as StateCommand | undefined
      if (target && composeCommands(makePlainParagraph, target, { wholeBlock: targetId !== 'outline.makeHeadingAtSurroundingLevel' })(view)) commandRan(targetId)
      view.focus()
      return true
    }
    if (id === 'block.edit' || id === 'block.copy' || id === 'block.delete') {
      setObjectMenu(null)
      runBlockAction(view, id.slice('block.'.length), menu.block)
      commandRan(id)
      return true
    }
    if (id.startsWith('insert.') || id.startsWith('mermaid:') || (id === OUTLINE_TO_MIND_MAP && !actionsAt(menu.place, view.state).some((command) => command.id === id))) {
      setObjectMenu(null)
      runInsertAction(view, id === OUTLINE_TO_MIND_MAP ? 'outline-to-mind-map' : id.replace(/^insert\./, ''))
      // The diagram sub-panel's rows (`mermaid:flow` …) are the Flow diagram command.
      commandRan(id.startsWith('mermaid:') ? 'insert.mermaid' : id)
      return true
    }
    if (isTableColumnCommand(id)) {
      setObjectMenu(null)
      const edit = tableColumnEdit(view.state, id, menu.block?.kind === 'table' ? menu.block : null)
      if (!edit) onStatusRef.current(id === 'table.delete' ? 'A table keeps at least one column' : 'There is no table here')
      else if (id !== 'table.delete' || window.confirm('Delete this column?')) {
        view.dispatch({ changes: edit, userEvent: 'input' })
        commandRan(id)
      }
      view.focus()
      return true
    }
    return false
  }

  /** Convert to mind map stays in Insert object… where the place does not list it. */
  const insertExtras = (menu: NonNullable<typeof objectMenu>): ActionRow[] => {
    const state = viewRef.current?.state
    const command = registryCommand(OUTLINE_TO_MIND_MAP)
    if (!state || !command.when?.(state) || actionsAt(menu.place, state).some((item) => item.id === OUTLINE_TO_MIND_MAP)) return []
    return [{ id: OUTLINE_TO_MIND_MAP, label: command.label, chords: [], keywords: 'mind map outline convert' }]
  }

  return (
    <div className={classes} ref={paneRef} data-metadata-workspace={workspaceRoot ?? ""}>
      <div className="editor-host" ref={hostRef} />
      {folioLineHost && folioPlace && onOpenFolioPlan && onOpenFolioPiece && createPortal(
        <FolioLine place={folioPlace} onOpenPlan={onOpenFolioPlan} onOpenPiece={onOpenFolioPiece} />,
        folioLineHost,
      )}
      {marginHost && margin && viewRef.current && createPortal(
        <ReviewMargin {...margin} view={viewRef.current} subscribe={subscribeMargin} />,
        marginHost,
      )}
      {markerVisible && markerBounds && (
        <FixedLineMarker
          fraction={overlayOn ? dragFraction ?? overlayHandle.handleFraction ?? fixedLine : fixedLine}
          bounds={markerBounds}
          lineStep={overlayOn && overlayHandle.lineFraction > 0 ? overlayHandle.lineFraction : undefined}
          onChange={(fraction) => {
            if (!overlayOn) {
              onFixedLineChange(fraction)
              return
            }
            setDragFraction(fraction)
            if (overlayFollow === 'cursor') setOverlayDrag(fraction - handleOffset)
            else onFixedLineChange(fraction - handleOffset)
          }}
          onCancel={overlayOn ? () => {
            // Escape or a cancelled pointer: back to the cursor's line, caret and settings untouched.
            setDragFraction(null)
            setOverlayDrag(null)
          } : undefined}
          onCommit={(fraction) => {
            if (!overlayOn) {
              onFixedLineCommit(fraction)
              return
            }
            setDragFraction(null)
            const target = fraction - handleOffset
            // The overlay was showing this line all drag; the caret lands on it and the overlay follows it.
            if (overlayFollow === 'cursor') { moveCaretToFraction(target); setOverlayDrag(null) }
            // By hand lets go onto the CENTRE of the line it chose, never a height on a line boundary.
            else onFixedLineCommit(overlayFollow === 'by-hand' && overlayHandle.focusFraction !== null ? overlayHandle.focusFraction : target)
          }}
        />
      )}
      {objectMenu && (
        <ActionsHere
          x={objectMenu.x}
          y={objectMenu.y}
          place={objectMenu.place}
          startView={objectMenu.objects ? 'insert' : 'here'}
          insertExtras={insertExtras(objectMenu)}
          runHere={runEditorRow}
          onClose={(reason) => { if (reason === 'dismiss') closeObjectMenu(); else setObjectMenu(null) }}
        />
      )}
    </div>
  )
})
