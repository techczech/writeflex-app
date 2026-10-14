import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { EditorView } from '@codemirror/view'
import { Check, CornerUpLeft, PenLine, X } from 'lucide-react'
import type { ProseEditInput, Suggestion } from '../../../preload'
import { onEditorUpdate } from '../editor/setup'
import { calloutDiff, setSuggestionAnchors, suggestionAnchors } from '../editor/suggestion-anchor'
import type { EditorHandle } from './EditorPane'

/**
 * The margin suggestion callout (Task 16, mockup `.callout`): the agent's staged prose edit as a
 * designed card in the editor's right margin, hairline-connected to the anchored sentence (which
 * carries the `.sugg-target` underlay via the anchor field's decoration). Resolved by Accept ⏎ /
 * Reject ⌫ / Revise R.
 *
 * One card at a time, per the locked mockup: with several suggestions pending, the FIRST anchored
 * one (pending-list order) gets the card; the rest stay reachable through the agent panel's `view`
 * links, and each takes the card in turn as the one before it is resolved.
 *
 * The card is rendered into a portal INSIDE CM's scroll surface (`.cm-scroller`, position:relative
 * in CM's base theme), positioned in content coordinates — so it scrolls WITH the prose natively
 * and only doc edits or pane resizes need a reposition.
 */

export type CalloutViewRequest = { id: string; path: string; tick: number }

type ProseSuggestion = Suggestion & { input: ProseEditInput }

function isProseEdit(suggestion: Suggestion): suggestion is ProseSuggestion {
  if (suggestion.capabilityName !== 'prose.edit') return false
  const input = suggestion.input as Partial<ProseEditInput> | null
  return typeof input?.path === 'string' && typeof input.oldText === 'string' && typeof input.newText === 'string'
}

/** The mockup's `room` constant: card width (292) + its border box, used for the right-edge clamp. */
const CALLOUT_WIDTH = 296

/**
 * The mockup's positionCallout, translated to CM geometry: 34px into the right margin of the prose
 * column, clamped to the visible pane width when the agent panel narrows it — the v2 fix lesson.
 * Top: the anchor's line top − 4, in the scroller's content coordinate space (the card is
 * absolutely positioned inside `.cm-scroller`).
 *
 * Deviation of record: the mockup's own positionCallout mixes coordinate spaces (its `room` is
 * scroller-relative but applied doc-relative), so its demo still bled the card ~100px past the
 * pane edge — defeating the clamp its own comment declares ("right padding + card width"). The
 * task text rules the intent ("position clamps to visible editor width when the agent panel is
 * open"), so here the clamp is computed in ONE space and visibility wins over the mockup's
 * 120px-overlap floor when the two cannot both hold; the card may overlay the prose column's
 * right edge on a narrow pane (the mockup accepts that too) but is never cut off.
 */
function calloutPosition(view: EditorView, anchorFrom: number): { left: number; top: number } | null {
  const scroller = view.scrollDOM
  const scrollerRect = scroller.getBoundingClientRect()
  if (scrollerRect.width === 0) return null // not laid out yet
  const contentRect = view.contentDOM.getBoundingClientRect()
  const contentStyle = window.getComputedStyle(view.contentDOM)
  const padLeft = parseFloat(contentStyle.paddingLeft) || 0
  const padRight = parseFloat(contentStyle.paddingRight) || 0
  // The prose column (the mockup's .doc measure) in scroller-content coordinates.
  const colLeft = contentRect.left - scrollerRect.left + scroller.scrollLeft + padLeft
  const colWidth = contentRect.width - padLeft - padRight
  const room = scroller.clientWidth - 96 - CALLOUT_WIDTH // the mockup's right-edge inset
  const left = Math.min(colLeft + colWidth + 34, Math.max(room, colLeft + 12))
  let blockTop: number
  try {
    blockTop = view.lineBlockAt(anchorFrom).top
  } catch {
    return null // stale position during a state swap; the next sync recomputes
  }
  const top = blockTop + view.documentTop - scrollerRect.top + scroller.scrollTop - 4
  return { left: Math.round(left), top: Math.round(top) }
}

type SuggestionCalloutProps = {
  editorRef: RefObject<EditorHandle | null>
  /** The live pending list (useAgent); prose edits for the loaded file anchor into the buffer. */
  suggestions: Suggestion[]
  /** The path whose buffer the view is ACTUALLY showing (App's activation flush) — anchors are only
   *  synced once the buffer is live, never against the previous file's state mid-load. */
  loadedFile: string | null
  /** The T13 overlay guard: while a sheet is up the callout's plain-key handling stands down. */
  overlayOpenRef: MutableRefObject<boolean>
  onAccept: (suggestion: Suggestion) => void
  onReject: (suggestion: Suggestion) => void
  onRevise: (suggestion: Suggestion, note: string) => void
  /** The agent panel's `view` link: once the file's buffer is live, scroll its anchor to centre. */
  viewRequest: CalloutViewRequest | null
}

export function SuggestionCallout({
  editorRef,
  suggestions,
  loadedFile,
  overlayOpenRef,
  onAccept,
  onReject,
  onRevise,
  viewRequest,
}: SuggestionCalloutProps): JSX.Element | null {
  const [layer, setLayer] = useState<HTMLElement | null>(null)
  const [card, setCard] = useState<{ id: string; left: number; top: number } | null>(null)
  const [revising, setRevising] = useState(false)
  const [note, setNote] = useState('')
  const calloutRef = useRef<HTMLElement | null>(null)
  const reviseInputRef = useRef<HTMLInputElement | null>(null)
  const handledViewTick = useRef(0)

  // The pending prose edits for the file the view is showing, in pending-list (stagedAt) order —
  // the order that decides which suggestion is carded.
  const pending = useMemo(
    () => (loadedFile ? suggestions.filter(isProseEdit).filter((s) => s.input.path === loadedFile) : []),
    [suggestions, loadedFile],
  )

  // The portal layer: one div inside CM's scroll surface, so the card scrolls with the prose.
  useEffect(() => {
    const view = editorRef.current?.view()
    if (!view) return
    const el = document.createElement('div')
    el.className = 'callout-layer'
    view.scrollDOM.appendChild(el)
    setLayer(el)
    return () => {
      el.remove()
      setLayer(null)
    }
  }, [editorRef])

  /** Re-derive the carded anchor + its position from the live view. Cheap (a rect read and a line
   *  block lookup), so it runs on every editor update tick. */
  const recompute = useCallback(() => {
    const view = editorRef.current?.view()
    const primary = view ? suggestionAnchors(view.state)[0] : undefined
    const pos = view && primary ? calloutPosition(view, primary.from) : null
    if (!primary || !pos) {
      setCard(null)
      return
    }
    setCard((prev) =>
      prev && prev.id === primary.id && prev.left === pos.left && prev.top === pos.top ? prev : { id: primary.id, ...pos },
    )
  }, [editorRef])

  // Sync the pending list into the buffer's anchor field whenever either side moves (a suggestions
  // push, a tab switch landing, an accept/reject). An effects-only dispatch does not fire the
  // editor-update bus, so the reposition is invoked directly after it.
  useEffect(() => {
    const view = editorRef.current?.view()
    if (!view) return
    view.dispatch({ effects: setSuggestionAnchors.of(pending.map((s) => ({ id: s.id, oldText: s.input.oldText }))) })
    recompute()
  }, [pending, editorRef, recompute])

  // Follow the writer's edits (the anchor field maps ranges; the card follows its line).
  useEffect(() => onEditorUpdate(recompute), [recompute])

  // Follow geometry: the pane narrowing when the agent panel opens (the clamp case), content
  // height changes (wrapping, folding), and the prose fonts settling after first paint.
  useEffect(() => {
    const view = editorRef.current?.view()
    if (!view) return
    const observer = new ResizeObserver(recompute)
    observer.observe(view.scrollDOM)
    observer.observe(view.contentDOM)
    void document.fonts?.ready.then(recompute)
    return () => observer.disconnect()
  }, [editorRef, recompute])

  // The agent panel's `view` link: once the requested file's buffer is live and its anchors are
  // synced (the effect above runs first), centre the suggestion's anchored sentence.
  useEffect(() => {
    if (!viewRequest || viewRequest.tick === handledViewTick.current) return
    if (loadedFile !== viewRequest.path) return // still opening; retried when loadedFile lands
    const view = editorRef.current?.view()
    if (!view) return
    handledViewTick.current = viewRequest.tick
    const anchor = suggestionAnchors(view.state).find((a) => a.id === viewRequest.id)
    if (anchor) view.dispatch({ effects: EditorView.scrollIntoView(anchor.from, { y: 'center' }) })
  }, [viewRequest, loadedFile, pending, editorRef])

  const cardSuggestion = card ? pending.find((s) => s.id === card.id) : undefined

  // Live mirrors for the stable key handler below (the sidebarOpenRef pattern).
  const cardRef = useRef<ProseSuggestion | null>(null)
  cardRef.current = cardSuggestion ?? null
  const onAcceptRef = useRef(onAccept)
  onAcceptRef.current = onAccept
  const onRejectRef = useRef(onReject)
  onRejectRef.current = onReject

  const accept = useCallback(() => {
    if (cardRef.current) onAcceptRef.current(cardRef.current)
  }, [])
  const reject = useCallback(() => {
    if (cardRef.current) onRejectRef.current(cardRef.current)
  }, [])
  const openRevise = useCallback(() => {
    setRevising(true)
    // Focus lands post-commit (the line is display:none until the class flips).
    requestAnimationFrame(() => reviseInputRef.current?.focus())
  }, [])

  // A new card (or none) starts with the revise line closed and the note cleared.
  const cardId = card?.id ?? null
  useEffect(() => {
    setRevising(false)
    setNote('')
  }, [cardId])

  // Accept ⏎ / Reject ⌫ / Revise R — only while a card is showing, no overlay is up (the T13
  // guard), and the keyboard is not in a typing context: inputs AND the CM buffer itself (a plain
  // ⏎/⌫/R there is prose, never a verdict). Focus inside the card keeps native button behaviour.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (!cardRef.current || overlayOpenRef.current) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement as HTMLElement | null
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return
      if (el && calloutRef.current?.contains(el)) return
      if (e.key === 'Enter') {
        e.preventDefault()
        accept()
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        reject()
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        openRevise()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [accept, reject, openRevise, overlayOpenRef])

  function onReviseKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      const trimmed = note.trim()
      if (trimmed && cardRef.current) onRevise(cardRef.current, trimmed)
    } else if (e.key === 'Escape') {
      // Collapse the note line, keep the card; plain keys resume once focus leaves the input.
      e.preventDefault()
      e.stopPropagation()
      setRevising(false)
      reviseInputRef.current?.blur()
    }
  }

  if (!layer || !card || !cardSuggestion) return null
  const input = cardSuggestion.input
  const diff = calloutDiff(input.oldText, input.newText)

  return createPortal(
    <aside
      ref={calloutRef}
      className={revising ? 'callout revising' : 'callout'}
      role="region"
      aria-label="Suggested edit"
      style={{ left: card.left, top: card.top }}
    >
      <div className="chead">
        <PenLine className="icon sm" />
        <span className="ctype">{input.category} edit</span>
      </div>
      <div className="csum">{input.summary}</div>
      <div className="cdiff">
        {diff.prefix && `${diff.prefix} `}
        {diff.removed && <del>{diff.removed}</del>}
        {diff.removed && diff.inserted && ' '}
        {diff.inserted && <ins>{diff.inserted}</ins>}
        {diff.suffix && ` ${diff.suffix}`}
      </div>
      <div className="cactions">
        <button className="cbtn primary" title="Accept the edit (⏎)" onClick={accept}>
          <Check className="icon sm" />
          Accept <kbd>⏎</kbd>
        </button>
        <button className="cbtn" title="Reject the edit (⌫)" onClick={reject}>
          <X className="icon sm" />
          Reject <kbd>⌫</kbd>
        </button>
        <button className="cbtn" title="Revise with a note (R)" onClick={openRevise}>
          <CornerUpLeft className="icon sm" />
          Revise <kbd>R</kbd>
        </button>
      </div>
      <div className="revise-line">
        <input
          ref={reviseInputRef}
          type="text"
          placeholder="Tell the agent what to change…"
          aria-label="Revision note"
          title="Revision note — ⏎ sends it back to the agent"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={onReviseKeyDown}
        />
        <kbd>⏎</kbd>
      </div>
    </aside>,
    layer,
  )
}
