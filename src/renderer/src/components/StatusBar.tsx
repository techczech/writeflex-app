import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, X, ChevronDown, ChevronUp, Files, Glasses, History, MessageSquare, Pause, Pencil, TextCursorInput, Volume2 } from 'lucide-react'
import { countUnits, type UnitCounts } from '../editor/word-count'
import { activeHeadingIndex } from '../editor/outline'
import type { EditorSnapshot } from '../hooks/useEditorSnapshot'
import type { SessionState } from '../hooks/useSession'
import type { WriterReviewMode } from '../editor/writer-review'
import { lineFocusChipLabel, rulerChipLabel, type LineOverlayConfig } from '../editor/line-overlay'
import { FOCUS_CHIP_NAMES, LEAD_STYLE_NAMES, type FocusMode, type LeadStyle } from '../editor/focus-modes'
import { goalPercent, isOverdue } from '../../../main/frontmatter'
import type { PlayerState } from '../editor/read-aloud-player'
import { StatusBarEvents } from './StatusBarEvents'
import { StatusBarDisclosure } from './StatusBarDisclosure'
import { ReviewCountMenu } from './ReviewCountMenu'
import { ReviewAskPopover, type ReviewAsk } from './ReviewBulkPopovers'
import { ElsewherePopover, type ElsewhereControls } from './ReviewElsewherePopover'
import { NotPlacedPopover, type NotPlacedControls } from './ReviewNotPlacedPopover'
import type { CountMenuAction, CountMenuRow } from '../app/margin-count-menu'
import { NARROW_REASON } from '../app/margin-count-menu'
import {
  placeChipText,
  type ReviewKindFilter,
  type ReviewLine,
  statusBarAbsorption,
  statusBarLayout,
  type StatusBarEvent,
  type StatusBarLayout,
  type StatusBarModeId,
} from './status-bar-model'
import { explicitSessionInstrument, type ExplicitSessionState } from '../../../shared/explicit-session'

export { statusBarAbsorption } from './status-bar-model'

const useStatusBarLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** The seven cycle positions the count button rotates through, in the locked order (PRD S13). */
const UNIT_ORDER = ['words', 'characters', 'sentences', 'paragraphs', 'pages', 'reading', 'speaking'] as const
type Unit = (typeof UNIT_ORDER)[number]

/** Persist the chosen unit per workspace root (renderer-local, like cursor memory) so reopening a
 *  folder restores the reader's last-picked readout without a round trip to main. */
function unitStorageKey(root: string): string {
  return `writeflex:count-unit:${root}`
}
function loadUnit(root: string | null): Unit {
  if (!root) return 'words'
  try {
    const saved = localStorage.getItem(unitStorageKey(root))
    if (saved && (UNIT_ORDER as readonly string[]).includes(saved)) return saved as Unit
  } catch {
    // localStorage can be disabled; fall back to the default silently.
  }
  return 'words'
}

/** Format a count as its readout, British-spelled and singular/plural aware; a selection scopes the
 *  count and says so (PRD S13). Thousands separators come from toLocaleString (the mockup's `4,608`). */
function unitLabel(unit: Unit, counts: UnitCounts, hasSelection: boolean): string {
  const scope = hasSelection ? ' selected' : ''
  const tally = (n: number, singular: string): string => `${n.toLocaleString()} ${n === 1 ? singular : `${singular}s`}${scope}`
  switch (unit) {
    case 'words':
      return tally(counts.words, 'word')
    case 'characters':
      return tally(counts.characters, 'character')
    case 'sentences':
      return tally(counts.sentences, 'sentence')
    case 'paragraphs':
      return tally(counts.paragraphs, 'paragraph')
    case 'pages':
      return `${counts.pages.toFixed(1)} pages${scope}`
    case 'reading':
      return `${counts.readMinutes} min read${scope}`
    case 'speaking':
      return `${counts.speakMinutes} min spoken${scope}`
  }
}

type CursorContext = { heading: string | null; chars: number }

/** `Focus: Fade` / `Focus: Anchored · Contrast` — Anchored alone carries its style. */
function focusChipLabel(mode: FocusMode, leadStyle: LeadStyle): string {
  if (mode === '') return 'Focus off'
  return `Focus: ${FOCUS_CHIP_NAMES[mode]}${mode === 'anchored' ? ` · ${LEAD_STYLE_NAMES[leadStyle]}` : ''}`
}

/** `Fri 15 Aug` — the mockup's due-date reading, from the frontmatter's ISO date (local calendar). */
function formatDueDate(due: string): string {
  const [year, month, day] = due.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

export type StatusBarProps = {
  /** The shared debounced editor snapshot (App's useEditorSnapshot): doc text, heading outline, and
   *  the primary selection, computed once per update tick for both this bar and the outline pane.
   *  null before the first read / when no view is mounted (counts read zero, cursor context hidden). */
  snapshot: EditorSnapshot | null
  /** Scopes the persisted-unit key; null while no Workspace is bound. */
  workspaceRoot: string | null
  /** Legacy input retained while callers migrate. Saved state is deliberately never rendered. */
  saveLabel?: string | null
  /** Only a pending or failed write enters the attention slot; successful automatic save is silent. */
  saveState?: { kind: 'pending' | 'failed'; path: string } | null
  /** Timestamp of the active document's most recent successful automatic save. */
  lastSavedAt?: number | null
  /** Typewriter mode state — the chip's persistent readout (the flash is now only a subtle confirm). */
  typewriterOn: boolean
  onToggleTypewriter: () => void
  /** The live focus mode (Round A, ADR-0028) — the Focus Chip exists ONLY while a mode is active
   *  (null/mode '' renders nothing); clicking it reopens the Focus Picker. */
  focus: { mode: FocusMode; leadStyle: LeadStyle } | null
  /** Line focus and Ruler overlays; each shows its own chip while on. */
  lineOverlay?: LineOverlayConfig
  onOpenFocusPicker: () => void
  /** Read-aloud's transient state. The chip renders only while PlayerState.speaking is true. */
  readAloud: { state: PlayerState; voiceName: string } | null
  /** The active document's writing goal (Round A T5, ADR-0028): non-null upgrades the count cell
   *  IN PLACE into the Goal Gauge — one instrument, upgraded, never a second chip. `words` is the
   *  document-scoped count App derives (a goal is about the piece, not the selection); null (no
   *  goal, or malformed `goal:` frontmatter) keeps the plain unit-cycling count. */
  goal: { target: number; due: string | null; words: number } | null
  /** Clicking the gauge opens Set writing goal (the command is the keyboard path). */
  onOpenGoal: () => void
  /** Explicit Diary sessions replace the count/goal readout in this same instrument cell. */
  explicitSession?: ExplicitSessionState | null
  automaticSession?: boolean
  onEndExplicitSession?: () => void
  onDismissCompletedSession?: () => void
  onAdjustExplicitTarget?: (target: number | null) => void
  sessionMenuRequest?: number
  writerMode: WriterReviewMode
  /** The window's writing session (words added, elapsed, wpm, idle) — shown across all tabs. */
  session: SessionState
  /** The transient action flash (the mockup's #statusFlash), shown in the right cluster. */
  status: string
  /** One button on the flash (Undo after a running-order change). */
  statusAction?: { label: string; run: () => void } | null
  /**
   * Highlights a drain can still hand to Zotero. The status-bar slot is deliberately the only place
   * their transport state appears (ADR-0029): there is still no badge or colour change on a mark.
   * When this count is positive, its message is also the control that attempts the drain.
   */
  outboxWaiting: number
  /**
   * Highlights Zotero has permanently refused or left in conflict. They occupy the same status-bar
   * slot in separate words and open Highlights for inspection; they are never offered as drainable.
   */
  outboxRejected: number
  /**
   * True when the last attempt was refused because Zotero is open — the one refusal the user can act on. It
   * changes the button's words, not whether it works: pressing it still RE-CHECKS (ADR-0036 amendment),
   * because by the time the user reads the label the user may already have quit Zotero, and a control that refuses
   * on stale state teaches distrust.
   */
  outboxNeedsZoteroClosed: boolean
  /**
   * Hand the waiting highlights to Zotero now. ADR-0036 amendment, the user's idea: the pending indicator and
   * the sync action are ONE surface — a message explains, a button resolves — so the user never has to know
   * or trust the automatic drain.
   */
  onSyncHighlights: () => void
  /** Raise Highlights for permanently refused or conflicted rows; never attempts a drain. */
  onOpenRejectedHighlights: () => void
  /** The Collection containing the active Piece. The tab already names the Piece. */
  collectionName?: string | null
  /** Focuses the existing agent composer from the resident agent affordance. */
  onMessageAgent?: () => void
  /** A palette/chord request increments this value to open the disclosure. */
  disclosureOpenRequest?: number
  /** The two status popovers participate in App's shared overlay guard. */
  activePopover?: 'statusDisclosure' | 'statusEvents' | null
  onOpenPopover?: (popover: 'statusDisclosure' | 'statusEvents') => void
  onClosePopover?: () => void
  /** Sovereign-focus return path after the disclosure or event list closes. */
  onRestoreEditorFocus?: () => void
  /** Packaged builds must not reveal a version in resident chrome. */
  development?: boolean
  /** The app version (package.json), shown quietly at the far bottom-right in development only. */
  version: string | null
  /** The Place chip (ADR-0043): what the caret or the selected row is on and how many commands
   *  Actions here lists there. null renders no chip: the setting is off, or there is no place. */
  place?: { label: string; count: number } | null
  /** Clicking the chip does what ⌘K does at that time. */
  onPlaceChip?: () => void
  /** The review line (ADR-0046), from the margin model: null shows nothing. */
  review?: ReviewLine | null
  /** The count menu's rows (`countMenu()`), drawn when the count is pressed; a pick runs `onReviewMenuPick`. */
  reviewMenu?: () => CountMenuRow[]
  onReviewMenuPick?: (action: CountMenuAction) => void
  /** The who chip's ×: back to Everyone. */
  onReviewClearWho?: () => void
  /** A segment of All / Comments / Edits was pressed. */
  onReviewKind?: (segment: ReviewKindFilter) => void
  /** Previous (-1) or next (1) shown item. */
  onReviewStep?: (direction: -1 | 1) => void
  /** "N new": go to the first arrival. */
  onReviewNew?: () => void
  /** The pieces behind "Waiting in N other pieces" and what Open and Next piece do (ticket 07). */
  reviewElsewhere?: ElsewhereControls | null
  /** A window too narrow for the margin: the review line drops key hints and the progress bar (ticket 07). */
  reviewCompact?: boolean
  /** The Margin | Inline switch on the review line (Dominik 2026-10-19): the view drawn (null while the margin is hidden), whether the text has too little room beside the margin for it, and the switch's chord. */
  reviewView?: { view: 'margin' | 'under' | null; narrow: boolean; chord: string } | null
  onReviewView?: (view: 'margin' | 'under') => void
  /** The step chords, shown beside the arrows while a card is focused; null while none is. */
  reviewKeys?: { previous: string; next: string } | null
  /** "Accept all N" (six or more edits shown): accept them, without asking. */
  onReviewAcceptAll?: () => void
  /** "N selected · Accept · Decline · Clear": act on the picked cards (Decline asks first), or unpick them. */
  onReviewPicked?: (what: 'accept' | 'decline' | 'clear') => void
  /** The chord shown on "Accept all N" (⇧⌘A as the writer has it set). */
  reviewAcceptKey?: string
  /** The Decline all confirmation or the Send back popover, drawn over the review line; null draws neither. */
  reviewAsk?: ReviewAsk | null
  /** The changes behind "N could not be placed" and what their popover's buttons do (ticket 06). */
  reviewNotPlaced?: NotPlacedControls | null
  /** Settled today / My edits (ticket 08): Esc Back, back to review. */
  onReviewModeBack?: () => void
  /** My edits' "Accept all N": the Accept session. */
  onReviewModeAcceptAll?: () => void
}

export type StatusBarSnapshotForCount = Pick<EditorSnapshot, 'docText' | 'countText' | 'selEmpty' | 'selFrom' | 'selTo'>

export function statusBarTextForCount(snapshot: StatusBarSnapshotForCount | null): string {
  if (!snapshot) return ''
  return snapshot.selEmpty ? snapshot.countText : snapshot.docText.slice(snapshot.selFrom, snapshot.selTo)
}

export function autosaveAgeLabel(lastSavedAt: number | null, now: number): string {
  return lastSavedAt === null ? 'not yet this window' : `${Math.max(0, Math.floor((now - lastSavedAt) / 1000))} s ago`
}

const EMPTY_LAYOUT: StatusBarLayout = {
  absorbed: [],
  collectionAtFloor: false,
  goalWithoutDue: false,
  agentIconOnly: false,
  typewriterPriority: false,
}

/**
 * Screen 9's resident law (ADR-0036): Collection identity on the left, then disclosure, one attention
 * slot, active modes, the existing instrument, agent affordance, and development version. Counts and
 * heading context still derive from App's shared editor snapshot; session detail still reads App's
 * one window-scoped session source. Neither computation is duplicated for the disclosure.
 */
export function StatusBar({
  snapshot,
  workspaceRoot,
  saveState = null,
  lastSavedAt = null,
  typewriterOn,
  onToggleTypewriter,
  focus,
  onOpenFocusPicker,
  lineOverlay,
  readAloud,
  goal,
  onOpenGoal,
  explicitSession = null,
  automaticSession = false,
  onEndExplicitSession,
  onDismissCompletedSession,
  onAdjustExplicitTarget,
  sessionMenuRequest = 0,
  writerMode,
  outboxWaiting,
  outboxRejected,
  outboxNeedsZoteroClosed,
  onSyncHighlights,
  onOpenRejectedHighlights,
  session,
  status,
  statusAction = null,
  version,
  collectionName = null,
  onMessageAgent = () => {},
  disclosureOpenRequest = 0,
  activePopover = null,
  onOpenPopover = () => {},
  onClosePopover = () => {},
  onRestoreEditorFocus = () => {},
  development = false,
  place = null,
  review = null,
  reviewMenu,
  onReviewMenuPick,
  onReviewClearWho,
  onReviewKind,
  onReviewStep,
  onReviewNew,
  reviewElsewhere = null,
  reviewCompact = false,
  reviewView = null,
  onReviewView,
  reviewKeys = null,
  onReviewAcceptAll,
  onReviewPicked,
  reviewAcceptKey,
  reviewAsk = null,
  reviewNotPlaced = null,
  onReviewModeBack,
  onReviewModeAcceptAll,
  onPlaceChip = () => {},
}: StatusBarProps): JSX.Element {
  const [unit, setUnit] = useState<Unit>(() => loadUnit(workspaceRoot))
  const [layout, setLayout] = useState(EMPTY_LAYOUT)
  const barRef = useRef<HTMLDivElement>(null)
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false)
  const [adjustingTarget, setAdjustingTarget] = useState(false)
  const [targetText, setTargetText] = useState('')
  const consumedSessionMenuRequest = useRef(0)

  // Restore the workspace's last-picked unit when a root binds/changes.
  useEffect(() => setUnit(loadUnit(workspaceRoot)), [workspaceRoot])
  const [countMenuOpen, setCountMenuOpen] = useState(false)
  const closeCountMenu = useCallback(() => { setCountMenuOpen(false); onRestoreEditorFocus() }, [onRestoreEditorFocus])
  useEffect(() => { if (!review || review.hereless) setCountMenuOpen(false) }, [review])
  const [notPlacedOpen, setNotPlacedOpen] = useState(false)
  const closeNotPlaced = useCallback(() => { setNotPlacedOpen(false); onRestoreEditorFocus() }, [onRestoreEditorFocus])
  useEffect(() => { if (!review?.notPlacedText) setNotPlacedOpen(false) }, [review?.notPlacedText])
  // "N could not be placed" and its popover (ticket 06, frame `stale`), at the end of the review line.
  const notPlacedPart = review?.notPlacedText ? (
    <span className="sb-review-menu-wrap sb-review-np-wrap">
      <button type="button" className="sb-review-np" data-testid="status-review-not-placed" aria-haspopup="dialog" aria-expanded={notPlacedOpen} onMouseDown={(event) => event.preventDefault()} onClick={() => setNotPlacedOpen((open) => !open)}>
        <AlertTriangle className="icon" aria-hidden="true" />{review.notPlacedText}
      </button>
      {notPlacedOpen && reviewNotPlaced && <NotPlacedPopover controls={reviewNotPlaced} onClose={closeNotPlaced} />}
    </span>
  ) : null
  const [elsewhereOpen, setElsewhereOpen] = useState(false)
  const closeElsewhere = useCallback(() => { setElsewhereOpen(false); onRestoreEditorFocus() }, [onRestoreEditorFocus])
  useEffect(() => { if (!review?.elsewhereText) setElsewhereOpen(false) }, [review?.elsewhereText])
  // "Waiting in N other pieces" and its popover (ticket 07, frame `elsewhere`).
  const elsewherePart = review?.elsewhereText ? (
    <span className="sb-review-menu-wrap sb-review-else-wrap">
      <button type="button" className="sb-review-else" data-testid="status-review-elsewhere" aria-haspopup="dialog" aria-expanded={elsewhereOpen} title="Pieces with items waiting" onMouseDown={(event) => event.preventDefault()} onClick={() => setElsewhereOpen((open) => !open)}>
        <Files className="icon" aria-hidden="true" />{review.elsewhereText}
      </button>
      {elsewhereOpen && reviewElsewhere && <ElsewherePopover controls={reviewElsewhere} onClose={closeElsewhere} />}
    </span>
  ) : null
  // Merge note 2026-08-02: the 250ms session clock is retired — the single useSession tick
  // (1s) drives the countdown, sufficient for a mm:ss readout (deliberate choice at merge).
  useEffect(() => {
    if (sessionMenuRequest <= 0 || sessionMenuRequest === consumedSessionMenuRequest.current || explicitSession?.status !== 'running') return
    consumedSessionMenuRequest.current = sessionMenuRequest
    setTargetText(explicitSession.targetWords === null ? '' : String(explicitSession.targetWords))
    setAdjustingTarget(true)
    setSessionMenuOpen(true)
  }, [sessionMenuRequest, explicitSession?.id, explicitSession?.status, explicitSession?.targetWords])

  const hasSelection = snapshot != null && !snapshot.selEmpty
  // A selection counts the literal raw buffer slice, because selection offsets are against docText.
  // The whole-document readout uses countText, the clean persisted Reviewing text.
  const scoped = statusBarTextForCount(snapshot)
  const counts = useMemo<UnitCounts>(() => countUnits(scoped, { excludeCommentLines: true }), [scoped])

  // Cursor context: the heading whose section the caret sits in, and the caret's character offset.
  // Hidden (null) until the first snapshot lands, as before. Reuses the SHARED outline — no second parse.
  const ctx = useMemo<CursorContext | null>(() => {
    if (!snapshot) return null
    const index = activeHeadingIndex(snapshot.outline, snapshot.selHead)
    return { heading: index >= 0 ? `H${snapshot.outline[index].level}` : null, chars: snapshot.selHead }
  }, [snapshot])

  const cycleUnit = useCallback(() => {
    setUnit((current) => {
      const next = UNIT_ORDER[(UNIT_ORDER.indexOf(current) + 1) % UNIT_ORDER.length]
      if (workspaceRoot) {
        try {
          localStorage.setItem(unitStorageKey(workspaceRoot), next)
        } catch {
          // A failed persist is harmless; the cycle still works this session.
        }
      }
      return next
    })
  }, [workspaceRoot])

  const label = unitLabel(unit, counts, hasSelection)
  const signedWords = `${session.sessionWords >= 0 ? '+' : ''}${session.sessionWords}`

  // Goal Gauge states (PRD §3 states table): done at ≥ target (quiet tick, green); overdue = past
  // due AND under target (the date turns to the danger colour); otherwise under target with the
  // fill at min(100, words/target)%. With no goal, the plain count cell below is untouched.
  const goalDone = goal !== null && goal.words >= goal.target
  const goalLate = goal !== null && !goalDone && isOverdue(goal.due)
  const explicitInstrument = explicitSession && explicitSession.status !== 'ended'
    ? explicitSessionInstrument(explicitSession, session.now)
    : null
  const automaticDot = automaticSession ? <span className="automatic-session-dot" aria-label="Automatic session active" /> : null

  const fileName = saveState?.path.split('/').filter(Boolean).at(-1) ?? saveState?.path ?? ''
  const events = useMemo<StatusBarEvent[]>(() => {
    const next: StatusBarEvent[] = []
    if (saveState) {
      const failed = saveState.kind === 'failed'
      const label = failed ? `Could not save ${fileName}` : `Saving ${fileName}`
      next.push({
        id: `save:${saveState.path}`,
        kind: failed ? 'save-failed' : 'save-pending',
        label,
        title: label,
        glyphOnly: true,
      })
    }
    if (outboxWaiting > 0) {
      const syncLabel = outboxWaiting === 1 ? 'Sync 1 highlight to Zotero' : `Sync ${outboxWaiting} highlights to Zotero`
      next.push({
        id: 'zotero-waiting',
        kind: 'zotero-waiting',
        label: `${syncLabel}${outboxNeedsZoteroClosed ? ' — needs Zotero closed' : ''}`,
        title: outboxNeedsZoteroClosed
          ? 'Close Zotero and press this — your highlights are saved here until it takes them'
          : 'Write the waiting highlights into your Zotero library',
        onSelect: onSyncHighlights,
      })
    }
    if (outboxRejected > 0) {
      const detailLabel = outboxRejected === 1 ? "1 highlight Zotero wouldn't take" : `${outboxRejected} highlights Zotero wouldn't take`
      next.push({
        id: 'zotero-rejected',
        kind: 'zotero-rejected',
        label: `${outboxRejected} ${outboxRejected === 1 ? 'highlight' : 'highlights'} refused`,
        detailLabel,
        title: 'See which highlights Zotero would not take, and why. They are kept here.',
        onSelect: onOpenRejectedHighlights,
      })
    }
    return next
  }, [fileName, onOpenRejectedHighlights, onSyncHighlights, outboxNeedsZoteroClosed, outboxRejected, outboxWaiting, saveState])

  const modeIds = useMemo<StatusBarModeId[]>(() => {
    const ids: StatusBarModeId[] = []
    if (writerMode === 'reviewing') ids.push('reviewing')
    if (focus !== null && focus.mode !== '') ids.push('focus')
    if (readAloud?.state.speaking) ids.push('read-aloud')
    if (typewriterOn) ids.push('typewriter')
    return ids
  }, [focus, readAloud?.state.speaking, typewriterOn, writerMode])

  useStatusBarLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return
    const measure = (): void => {
      const styles = getComputedStyle(bar)
      // Always measure the full layout. Reading the priority layout's reduced gap feeds its
      // savings back into the next calculation and can toggle degradation on every resize.
      const gap = 8
      const padding = (Number.parseFloat(styles.paddingLeft) || 0) + (Number.parseFloat(styles.paddingRight) || 0)
      const outerWidth = (node: HTMLElement | null): number => {
        if (!node) return 0
        const nodeStyles = getComputedStyle(node)
        return node.getBoundingClientRect().width
          + (Number.parseFloat(nodeStyles.marginLeft) || 0)
          + (Number.parseFloat(nodeStyles.marginRight) || 0)
      }
      const collection = bar.querySelector<HTMLElement>('[data-sb-measure="collection"]')
      const collectionWidth = collection ? Math.min(240, Math.max(96, collection.getBoundingClientRect().width)) : 0
      const disclosure = outerWidth(bar.querySelector<HTMLElement>(':scope > .sb-disclosure .sb-disclosure-button'))
      const instrument = explicitInstrument !== null
        ? outerWidth(bar.querySelector<HTMLElement>('[data-sb-measure="instrument-session"]'))
        : goal
          ? outerWidth(bar.querySelector<HTMLElement>('[data-sb-measure="instrument-full"]'))
          : outerWidth(bar.querySelector<HTMLElement>(':scope > .count-btn'))
      const agent = outerWidth(bar.querySelector<HTMLElement>('[data-sb-measure="agent-full"]'))
      const versionWidth = outerWidth(bar.querySelector<HTMLElement>(':scope > .sb-version'))
      // The review line (ticket 07): its width counts, so a narrow window gives up the place chip and the rest before it clips.
      const reviewWidth = outerWidth(bar.querySelector<HTMLElement>(':scope > .sb-review[data-testid="status-review-line"]'))
      const fixedWidths = [collectionWidth, disclosure, instrument, agent, versionWidth, reviewWidth].filter((width) => width > 0)
      const residentWidth = padding + fixedWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, fixedWidths.length - 1) * gap
      const eventNode = bar.querySelector<HTMLElement>('[data-sb-measure="event"]')
      const eventWidth = events.length > 0 && eventNode ? eventNode.getBoundingClientRect().width + gap : 0
      const modes = modeIds.map((id) => ({
        id,
        width: (bar.querySelector<HTMLElement>(`[data-sb-measure="${id}"]`)?.getBoundingClientRect().width ?? 0) + gap,
      }))
      const goalWithoutDue = outerWidth(bar.querySelector<HTMLElement>('[data-sb-measure="instrument-without-due"]'))
      const agentIcon = outerWidth(bar.querySelector<HTMLElement>('[data-sb-measure="agent-icon"]'))
      const placeNode = bar.querySelector<HTMLElement>('[data-sb-measure="place"]')
      const placeWidths = placeNode
        ? { width: outerWidth(placeNode) + gap, countWidth: bar.querySelector<HTMLElement>('[data-sb-measure="place-count"]')?.getBoundingClientRect().width ?? 0 }
        : null
      const next = statusBarLayout(bar.clientWidth, residentWidth, eventWidth, modes, {
        collectionWidth,
        collectionFloor: 96,
        goalDueWidth: explicitInstrument === null && goal ? Math.max(0, instrument - goalWithoutDue) : 0,
        agentLabelWidth: Math.max(0, agent - agentIcon),
      }, window.outerWidth >= 960, placeWidths)
      setLayout((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [collectionName, workspaceRoot, events, explicitInstrument?.label, explicitInstrument?.reached, goal, label, modeIds, place?.label, place?.count, review, reviewKeys?.next, readAloud?.state.rate, readAloud?.state.paused, readAloud?.voiceName, status, version])

  const absorbed = layout.absorbed
  const eventAbsorbed = absorbed.includes('event')
  const focusLabel = focus && focus.mode !== '' ? focusChipLabel(focus.mode, focus.leadStyle) : null
    const placeText = place ? placeChipText(place.label, place.count) : null
  const placeLayout = layout.place ?? 'full'
  const absorbedModes = absorbed.reduce<Array<{ id: string; label: string }>>((rows, id) => {
    if (id === 'reviewing') rows.push({ id, label: 'Reviewing' })
    if (id === 'typewriter') rows.push({ id, label: 'Typewriter' })
    if (id === 'focus' && focusLabel) rows.push({ id, label: focusLabel })
    if (id === 'read-aloud' && readAloud?.state.speaking) rows.push({ id, label: `Read aloud · ${readAloud.voiceName}` })
    return rows
  }, placeText && placeLayout === 'absorbed' ? [{ id: 'place', label: placeText.full }] : [])
  const autosaveAge = autosaveAgeLabel(lastSavedAt, session.now)
  const disclosureRows = [
    { label: 'wpm', value: String(session.wpm) },
    { label: 'characters', value: counts.characters.toLocaleString() },
    { label: 'heading', value: ctx?.heading ?? '—' },
    { label: 'autosaved', value: autosaveAge },
    { label: 'session', value: `${session.elapsedLabel} elapsed · ${signedWords} words` },
  ]
  const residentCollection = collectionName ?? workspaceRoot?.split('/').filter(Boolean).at(-1) ?? ''

  return (
    <div className={`statusbar${layout.typewriterPriority ? ' typewriter-priority' : ''}`} ref={barRef} data-absorbed={absorbed.join(' ')} data-degraded={[layout.collectionAtFloor && 'collection-floor', layout.goalWithoutDue && 'goal-no-due', layout.agentIconOnly && 'agent-icon', layout.typewriterPriority && 'typewriter-priority'].filter(Boolean).join(' ')}>
      <span className={`sb-collection${layout.collectionAtFloor ? ' floor' : ''}`} title={residentCollection} data-sb-resident>{residentCollection}</span>
      {placeText && placeLayout !== 'absorbed' && (
        <button
          type="button"
          className="place-chip"
          data-testid="place-chip"
          data-place-layout={placeLayout}
          title="Actions here (⌘K)"
          aria-label={`${placeText.full}. Click to see what you can do here`}
          // The chip must not take the keyboard: the place is where the keyboard already is.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onPlaceChip}
        >
          <TextCursorInput className="icon sm" aria-hidden="true" />
          <span className="place-chip-text">{placeText.place}{placeLayout === 'full' && placeText.count}</span>
          <kbd aria-hidden="true">⌘K</kbd>
        </button>
      )}
      <StatusBarDisclosure
        rows={disclosureRows}
        absorbedEvents={eventAbsorbed ? events : []}
        absorbedModes={absorbedModes}
        openRequest={disclosureOpenRequest}
        open={activePopover === 'statusDisclosure'}
        onOpen={() => onOpenPopover('statusDisclosure')}
        onClose={onClosePopover}
        onRestoreEditorFocus={onRestoreEditorFocus}
      />
      {!eventAbsorbed && <StatusBarEvents events={events} open={activePopover === 'statusEvents'} onOpen={() => onOpenPopover('statusEvents')} onClose={onClosePopover} onRestoreEditorFocus={onRestoreEditorFocus} />}
      {writerMode === 'reviewing' && !absorbed.includes('reviewing') && (
        <span className="reviewing-chip"><Glasses className="icon" aria-hidden="true" /><span>Reviewing</span></span>
      )}
      {typewriterOn && !absorbed.includes('typewriter') && (
        <button
          className="tw-chip on"
          title="Typewriter mode (⌘T)"
          aria-label="Typewriter mode on"
          aria-pressed="true"
          onClick={onToggleTypewriter}
        >
          <TextCursorInput className="icon" aria-hidden="true" />
          <span>Typewriter</span>
        </button>
      )}
      {focusLabel && !absorbed.includes('focus') && (
        <button
          className="focus-chip"
          title="Focus and readability — click to change"
          aria-label={`${focusLabel}. Click to open Focus and readability`}
          onClick={onOpenFocusPicker}
        >
          <span className="dot" aria-hidden="true" />
          <span>{focusLabel}</span>
        </button>
      )}
      {lineOverlay?.lineFocus.on && (
        <button className="focus-chip" data-testid="line-focus-chip" title="Line focus — click to change" aria-label={`${lineFocusChipLabel(lineOverlay.lineFocus)}. Click to open Focus and readability`} onClick={onOpenFocusPicker}>
          <span className="dot" aria-hidden="true" />
          <span>{lineFocusChipLabel(lineOverlay.lineFocus)}</span>
        </button>
      )}
      {lineOverlay?.ruler.on && (
        <button className="focus-chip" data-testid="ruler-chip" title="Ruler — click to change" aria-label={`${rulerChipLabel(lineOverlay.ruler)}. Click to open Focus and readability`} onClick={onOpenFocusPicker}>
          <span className="dot" aria-hidden="true" />
          <span>{rulerChipLabel(lineOverlay.ruler)}</span>
        </button>
      )}
      {readAloud?.state.speaking && !absorbed.includes('read-aloud') && (
        <span
          className={`read-aloud-chip${readAloud.state.paused ? ' paused' : ''}`}
          data-testid="read-aloud-chip"
          role="status"
          title="Read aloud"
          aria-label={`${readAloud.voiceName} at ${readAloud.state.rate.toFixed(1)} times speed${
            readAloud.state.paused ? ', paused' : ', speaking'
          }`}
        >
          <span className="dot" aria-hidden="true" />
          {readAloud.state.paused ? <Pause className="icon" aria-hidden="true" /> : <Volume2 className="icon" aria-hidden="true" />}
          <span>{readAloud.voiceName} · {readAloud.state.rate.toFixed(1)}×{readAloud.state.paused ? ' · Paused' : ''}</span>
        </span>
      )}
      {explicitInstrument !== null && explicitSession ? (
        <span className="explicit-instrument-wrap statusbar-instrument-cell">
          <button
            className={`goal-gauge explicit-session-instrument${explicitInstrument.reached ? ' done' : ''}`}
            style={{ '--p': `${explicitInstrument.fillPercent ?? 0}%` } as React.CSSProperties}
            aria-label={`${explicitInstrument.label}${explicitInstrument.reached ? ', reached' : ''}${explicitSession.status === 'running' ? '. Click for session actions' : ''}`}
            aria-haspopup={explicitSession.status === 'running' ? 'menu' : undefined}
            onClick={() => {
              if (explicitSession.status === 'completed') { onDismissCompletedSession?.(); return }
              if (explicitSession.status !== 'running') return
              setAdjustingTarget(false)
              setSessionMenuOpen((open) => !open)
            }}
          >
            {explicitInstrument.fillPercent !== null && <i className="fill" aria-hidden="true" />}
            {explicitInstrument.reached && <Check className="icon sm explicit-session-check" aria-hidden="true" />}
            <span>{explicitInstrument.label}</span>
          </button>
          {sessionMenuOpen && explicitSession.status === 'running' && (
            <div className="explicit-session-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setSessionMenuOpen(false); onEndExplicitSession?.() }}>End session</button>
              {!adjustingTarget ? (
                <button type="button" role="menuitem" onClick={() => {
                  setTargetText(explicitSession.targetWords === null ? '' : String(explicitSession.targetWords))
                  setAdjustingTarget(true)
                }}>Adjust target…</button>
              ) : (
                <form onSubmit={(event) => {
                  event.preventDefault()
                  const parsed = Number.parseInt(targetText, 10)
                  onAdjustExplicitTarget?.(Number.isFinite(parsed) && parsed > 0 ? Math.min(10_000_000, parsed) : null)
                  setSessionMenuOpen(false)
                  setAdjustingTarget(false)
                }}>
                  <input
                    autoFocus
                    inputMode="numeric"
                    aria-label="Session words target"
                    placeholder="words — optional"
                    value={targetText}
                    onChange={(event) => {
                      const digits = event.target.value.replace(/\D/g, '')
                      setTargetText(digits === '' ? '' : String(Math.min(10_000_000, Number.parseInt(digits, 10))))
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') { event.preventDefault(); setAdjustingTarget(false) }
                    }}
                  />
                </form>
              )}
            </div>
          )}
        </span>
      ) : goal !== null ? (

        <button
          className={`goal-gauge statusbar-instrument-cell${goalDone ? ' done' : ''}${goalLate ? ' late' : ''}`}
          style={{ '--p': `${goalPercent(goal.words, goal.target)}%` } as React.CSSProperties}
          title="Writing goal — click to change"
          aria-label={`Writing goal: ${goal.words.toLocaleString()} of ${goal.target.toLocaleString()} words${
            goalDone ? ', goal met' : goalLate ? `, was due ${formatDueDate(goal.due!)}` : goal.due ? `, due ${formatDueDate(goal.due)}` : ''
          }. Click to set the writing goal`}
          onClick={onOpenGoal}
        >
          <i className="fill" aria-hidden="true" />
          {automaticDot}
          <span>{goal.words.toLocaleString()}</span>
          <span className="of">{`/ ${goal.target.toLocaleString()}${goalDone ? ' ✓' : goalLate ? '' : ' words'}`}</span>
          {!layout.goalWithoutDue && !goalDone && goal.due && (
            <span className="due">{goalLate ? `· was due ${formatDueDate(goal.due)}` : `· ${formatDueDate(goal.due)}`}</span>
          )}
        </button>
      ) : (
        <button
          className="count-btn statusbar-instrument-cell"
          title="Click to cycle units"
          aria-label={`${label}. Click to cycle count units`}
          onClick={cycleUnit}
        >
          {automaticDot}
          {label}
        </button>
      )}
      {review && (
        <span className={`sb-review${reviewCompact ? ' compact' : ''}`} data-testid="status-review-line" data-sb-resident>
          {review.newText && (
            <button type="button" className="sb-review-new" data-testid="status-review-new" onMouseDown={(event) => event.preventDefault()} onClick={onReviewNew}>{review.newText}</button>
          )}
          {review.mode ? (
            // Settled today or My edits (ticket 08, frames settled and my-edits): the mode's name opens the count menu.
            <>
              <span className="sb-review-menu-wrap">
                <button
                  type="button"
                  className="sb-review-count sb-review-mode"
                  data-testid="status-review-mode"
                  data-mode={review.mode.kind}
                  title="Review: count menu"
                  aria-label={`${review.mode.label}, ${review.mode.text}. Open the review menu`}
                  aria-haspopup="menu"
                  aria-expanded={countMenuOpen}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setCountMenuOpen((open) => !open)}
                >
                  {review.mode.kind === 'settled' ? <History className="icon" aria-hidden="true" /> : <Pencil className="icon" aria-hidden="true" />}
                  <b>{review.mode.label} · {review.mode.text}</b>
                </button>
                {countMenuOpen && reviewMenu && (
                  <ReviewCountMenu rows={reviewMenu()} onClose={closeCountMenu} onPick={(action) => { setCountMenuOpen(false); onReviewMenuPick?.(action) }} />
                )}
                {reviewAsk && <ReviewAskPopover ask={reviewAsk} />}
              </span>
              {review.mode.kind === 'mine' && (
                <span className="sb-review-step">
                  <button type="button" className="sb-review-arrow" data-testid="status-review-previous" aria-label="Previous item" title="Previous item" onMouseDown={(event) => event.preventDefault()} onClick={() => onReviewStep?.(-1)}><ChevronUp className="icon" aria-hidden="true" /></button>
                  <button type="button" className="sb-review-arrow" data-testid="status-review-next" aria-label="Next item" title="Next item" onMouseDown={(event) => event.preventDefault()} onClick={() => onReviewStep?.(1)}><ChevronDown className="icon" aria-hidden="true" /></button>
                </span>
              )}
              {review.mode.acceptAllText && (
                <button type="button" className="sb-review-bulk" data-testid="status-review-mode-accept-all" onMouseDown={(event) => event.preventDefault()} onClick={onReviewModeAcceptAll}>
                  <Check className="icon" aria-hidden="true" />{review.mode.acceptAllText}{reviewAcceptKey && <kbd className="sb-review-kbd">{reviewAcceptKey}</kbd>}
                </button>
              )}
              {review.mode.othersText && <span className="sb-review-others" data-testid="status-review-mode-others">{review.mode.othersText}</span>}
              <button type="button" className="sb-review-back" data-testid="status-review-mode-back" title="Back to review (Esc)" onMouseDown={(event) => event.preventDefault()} onClick={onReviewModeBack}>
                <kbd className="sb-review-kbd">Esc</kbd>Back
              </button>
            </>
          ) : review.hereless ? (
            <>
              {elsewherePart}
              {notPlacedPart}
            </>
          ) : (
            <>
              <span className="sb-review-menu-wrap">
                <button
                  type="button"
                  className="sb-review-count"
                  data-testid="status-review-count"
                  title="Review: count menu"
                  aria-label={`${review.countText}. Open the review menu`}
                  aria-haspopup="menu"
                  aria-expanded={countMenuOpen}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setCountMenuOpen((open) => !open)}
                >
                  <MessageSquare className="icon" aria-hidden="true" />
                  <b>{review.countText}</b>
                  <ChevronDown className="icon chev" aria-hidden="true" />
                </button>
                {countMenuOpen && reviewMenu && (
                  <ReviewCountMenu rows={reviewMenu()} onClose={closeCountMenu} onPick={(action) => { setCountMenuOpen(false); onReviewMenuPick?.(action) }} />
                )}
                {reviewAsk && <ReviewAskPopover ask={reviewAsk} />}
              </span>
              <span className="sb-review-seg" role="group" aria-label="Show in the margin">
                {review.segments.map((segment) => (
                  <button
                    key={segment.id}
                    type="button"
                    className="sb-review-seg-btn"
                    data-testid={`status-review-${segment.id}`}
                    aria-pressed={segment.pressed}
                    disabled={segment.off}
                    title={segment.id === 'all' ? 'Show everything (⌃⌥⌘1)' : segment.id === 'comments' ? 'Show comments only (⌃⌥⌘2)' : 'Show edits only (⌃⌥⌘3)'}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onReviewKind?.(segment.id)}
                  >
                    {segment.label} <span className="n">{segment.count}</span>
                  </button>
                ))}
              </span>
              {reviewView && (
                <span className="sb-review-seg sb-review-view" role="group" aria-label="Where the cards sit">
                  <button
                    type="button"
                    className="sb-review-seg-btn"
                    data-testid="status-review-view-margin"
                    aria-pressed={reviewView.view === 'margin'}
                    disabled={reviewView.narrow}
                    title={reviewView.narrow ? NARROW_REASON : `Cards in the margin beside the text (${reviewView.chord || '⇧⌥⌘V'})`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onReviewView?.('margin')}
                  >
                    Margin
                  </button>
                  <button
                    type="button"
                    className="sb-review-seg-btn"
                    data-testid="status-review-view-inline"
                    aria-pressed={reviewView.view === 'under'}
                    title={`Cards inline, under their paragraph (${reviewView.chord || '⇧⌥⌘V'})`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onReviewView?.('under')}
                  >
                    Inline
                  </button>
                </span>
              )}
              {review.who && (
                <span className="sb-review-who" data-testid="status-review-who">
                  {review.who}
                  <button type="button" aria-label={`Clear ${review.who}`} title="Show everyone" data-testid="status-review-who-clear" onMouseDown={(event) => event.preventDefault()} onClick={onReviewClearWho}><X className="icon" aria-hidden="true" /></button>
                </span>
              )}
              <span className="sb-review-step">
                {reviewKeys && <kbd className="sb-review-kbd" data-testid="status-review-previous-key">{reviewKeys.previous}</kbd>}
                <button type="button" className="sb-review-arrow" data-testid="status-review-previous" aria-label="Previous item" title="Previous item" onMouseDown={(event) => event.preventDefault()} onClick={() => onReviewStep?.(-1)}><ChevronUp className="icon" aria-hidden="true" /></button>
                <button type="button" className="sb-review-arrow" data-testid="status-review-next" aria-label="Next item" title="Next item" onMouseDown={(event) => event.preventDefault()} onClick={() => onReviewStep?.(1)}><ChevronDown className="icon" aria-hidden="true" /></button>
                {reviewKeys && <kbd className="sb-review-kbd" data-testid="status-review-next-key">{reviewKeys.next}</kbd>}
              </span>
              {review.selectedText && (
                <span className="sb-review-sel" data-testid="status-review-selected">
                  <b>{review.selectedText}</b>
                  <button type="button" className="sb-review-act yes" data-testid="status-review-picked-accept" onMouseDown={(event) => event.preventDefault()} onClick={() => onReviewPicked?.('accept')}><Check className="icon" aria-hidden="true" />Accept</button>
                  <button type="button" className="sb-review-act" data-testid="status-review-picked-decline" onMouseDown={(event) => event.preventDefault()} onClick={() => onReviewPicked?.('decline')}><X className="icon" aria-hidden="true" />Decline</button>
                  <button type="button" className="sb-review-act" data-testid="status-review-picked-clear" onMouseDown={(event) => event.preventDefault()} onClick={() => onReviewPicked?.('clear')}>Clear</button>
                </span>
              )}
              {review.acceptAllText && (
                <button type="button" className="sb-review-bulk" data-testid="status-review-accept-all" onMouseDown={(event) => event.preventDefault()} onClick={onReviewAcceptAll}>
                  <Check className="icon" aria-hidden="true" />{review.acceptAllText}{reviewAcceptKey && <kbd className="sb-review-kbd">{reviewAcceptKey}</kbd>}
                </button>
              )}
              {review.progress && (
                <span className="sb-review-prog" data-testid="status-review-progress">
                  <span>{review.progress.text}</span>
                  <span className="bar" aria-hidden="true"><i style={{ width: `${Math.round(review.progress.fraction * 100)}%` }} /></span>
                </span>
              )}
              {elsewherePart}
              {notPlacedPart}
            </>
          )}
        </span>
      )}
      {reviewAsk && (!review || review.hereless) && (
        <span className="sb-review sb-review-menu-wrap sb-review-ask-alone">
          <ReviewAskPopover ask={reviewAsk} />
        </span>
      )}
      {!layout.typewriterPriority && (
        <button type="button" className={`sb-agent-affordance${layout.agentIconOnly ? ' icon-only' : ''}`} data-sb-resident title="Message the agent…" aria-label="Message the agent" onClick={onMessageAgent}>
          <MessageSquare aria-hidden="true" />
          {!layout.agentIconOnly && <span>Message the agent…</span>}
        </button>
      )}
      {status && (
        <span className="status-flash" role="status" data-sb-resident>
          {status}
          {statusAction && <button type="button" className="status-flash-undo" onClick={statusAction.run}>{statusAction.label}</button>}
        </span>
      )}
      {development && version && (
        <span className="sb-version" data-sb-resident title={`WriteFlex ${version}`} aria-label={`WriteFlex version ${version}`}>
          v{version}
        </span>
      )}
      <span className="sb-measure" aria-hidden="true">
        <span data-sb-measure="collection">{residentCollection}</span>
        {placeText && (
          <span className="place-chip" data-sb-measure="place">
            <TextCursorInput className="icon sm" />
            <span className="place-chip-text">{placeText.place}<span data-sb-measure="place-count">{placeText.count}</span></span>
            <kbd>⌘K</kbd>
          </span>
        )}
        {explicitInstrument !== null ? (
          <span
            className={`sb-measure-instrument${explicitInstrument.reached ? ' done' : ''}`}
            data-sb-measure="instrument-session"
            style={{ '--p': `${explicitInstrument.fillPercent ?? 0}%` } as React.CSSProperties}
          >
            {explicitInstrument.fillPercent !== null && <i className="fill" aria-hidden="true" />}
            {explicitInstrument.reached && <Check className="icon sm explicit-session-check" aria-hidden="true" />}
            <span>{explicitInstrument.label}</span>
          </span>
        ) : goal !== null && (
          <>
            <span className={`sb-measure-instrument${goalLate ? ' late' : ''}`} data-sb-measure="instrument-full">
              <span>{goal.words.toLocaleString()}</span>
              <span className="of">{`/ ${goal.target.toLocaleString()}${goalDone ? ' ✓' : goalLate ? '' : ' words'}`}</span>
              {!goalDone && goal.due && <span className="due">{goalLate ? `· was due ${formatDueDate(goal.due)}` : `· ${formatDueDate(goal.due)}`}</span>}
            </span>
            <span className="sb-measure-instrument" data-sb-measure="instrument-without-due">
              <span>{goal.words.toLocaleString()}</span>
              <span>{`/ ${goal.target.toLocaleString()}${goalDone ? ' ✓' : goalLate ? '' : ' words'}`}</span>
            </span>
          </>
        )}
        <span className="sb-measure-agent" data-sb-measure="agent-full"><MessageSquare /><span>Message the agent…</span></span>
        <span className="sb-measure-agent icon-only" data-sb-measure="agent-icon"><MessageSquare /></span>
        {events.length > 0 && <span className="sb-measure-event" data-sb-measure="event">{events.length === 1 ? events[0].label : `${events.length} attention events`}</span>}
        {modeIds.map((id) => (
          <span className={`sb-measure-mode ${id}`} data-sb-measure={id} key={id}>
            {id === 'reviewing' ? <><Glasses className="icon" /><span>Reviewing</span></> : id === 'typewriter' ? <><TextCursorInput className="icon" /><span>Typewriter</span></> : id === 'focus' ? <><span className="dot" /><span>{focusLabel}</span></> : <><span className="dot" />{readAloud?.state.paused ? <Pause className="icon" /> : <Volume2 className="icon" />}<span>{readAloud?.voiceName} · {readAloud?.state.rate.toFixed(1)}×{readAloud?.state.paused ? ' · Paused' : ''}</span></>}
          </span>
        ))}
      </span>
    </div>
  )
}
