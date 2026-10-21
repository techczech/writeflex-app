import { BULK_THRESHOLD } from '../app/margin-bulk'
import type { OtherPiece } from '../app/margin-model'
export type StatusBarModeId = 'reviewing' | 'typewriter' | 'focus' | 'read-aloud'
export type AbsorbableStatusItem = 'event' | StatusBarModeId

export type StatusBarDegradation = {
  collectionWidth: number
  collectionFloor: number
  goalDueWidth: number
  agentLabelWidth: number
}

/** The place chip as measured: its whole width with its leading gap, and the width of "· N actions" inside it. */
export type PlaceChipWidths = { width: number; countWidth: number }
/** How the place chip is shown: whole, without its "· N actions", or not at all (it is in the disclosure). */
export type PlaceChipLayout = 'full' | 'no-count' | 'absorbed'

export type StatusBarLayout = {
  absorbed: AbsorbableStatusItem[]
  collectionAtFloor: boolean
  goalWithoutDue: boolean
  agentIconOnly: boolean
  typewriterPriority: boolean
  /** Present only when a place chip was measured. */
  place?: PlaceChipLayout
}

/**
 * Screen 9's measurement-driven absorption order. `residentWidth` is the measured width of the
 * collection's full measured width plus every non-absorbable resident, including gaps. Optional item widths include
 * their leading gap. The event leaves first, then mode chips in DOM order, only until the residents
 * fit. The instrument is absent from this candidate list and therefore cannot be absorbed or clipped.
 */
export function statusBarAbsorption(
  availableWidth: number,
  residentWidth: number,
  eventWidth: number,
  modes: Array<{ id: StatusBarModeId; width: number }>,
): AbsorbableStatusItem[] {
  return statusBarLayout(availableWidth, residentWidth, eventWidth, modes, {
    collectionWidth: 0,
    collectionFloor: 0,
    goalDueWidth: 0,
    agentLabelWidth: 0,
  }).absorbed
}

/** The narrow-width ladder keeps the active Typewriter label resident after other modes and resident
 * degradations. It enters the disclosure only when those reductions still cannot make the bar fit.
 *
 * The place chip ("On a heading · 15 actions ⌘K") stands through the ladder's earlier steps, as the
 * drawing's 900px window has it (state 34: the chip whole, "Message the agent…" as its icon). After
 * the agent label it gives up its "· N actions", then leaves for the disclosure; once it has left,
 * everything else is laid out exactly as it is with no chip. The instrument (the word count) is
 * never a candidate, so the chip always yields before the count does. */
export function statusBarLayout(
  availableWidth: number,
  residentWidth: number,
  eventWidth: number,
  modes: Array<{ id: StatusBarModeId; width: number }>,
  degradation: StatusBarDegradation,
  preserveTypewriter = false,
  place: PlaceChipWidths | null = null,
): StatusBarLayout {
  if (!Number.isFinite(availableWidth)) return {
    absorbed: [],
    collectionAtFloor: false,
    goalWithoutDue: false,
    agentIconOnly: false,
    typewriterPriority: false,
    ...(place ? { place: 'full' as const } : {}),
  }
  const absorbed: AbsorbableStatusItem[] = []
  let collectionAtFloor = false
  let goalWithoutDue = false
  let agentIconOnly = false
  let typewriterPriority = false
  let required = residentWidth + eventWidth + modes.reduce((total, mode) => total + mode.width, 0) + (place?.width ?? 0)
  let placeLayout: PlaceChipLayout = 'full'
  if (eventWidth > 0) {
    if (required > availableWidth) {
      absorbed.push('event')
      required -= eventWidth
    }
  }
  const typewriter = modes.find((mode) => mode.id === 'typewriter')
  for (const mode of modes.filter((candidate) => candidate.id !== 'typewriter')) {
    if (required <= availableWidth) break
    absorbed.push(mode.id)
    required -= mode.width
  }
  if (required > availableWidth && degradation.collectionWidth > degradation.collectionFloor) {
    collectionAtFloor = true
    required -= degradation.collectionWidth - degradation.collectionFloor
  }
  if (required > availableWidth && degradation.goalDueWidth > 0) {
    goalWithoutDue = true
    required -= degradation.goalDueWidth
  }
  if (required > availableWidth && degradation.agentLabelWidth > 0) {
    agentIconOnly = true
    required -= degradation.agentLabelWidth
  }
  if (required > availableWidth && place && place.countWidth > 0) {
    placeLayout = 'no-count'
    required -= place.countWidth
  }
  // A chip that cannot stand even after every step above leaves, and the bar is then laid out as it
  // is with no chip at all: nothing else stays reduced on the chip's account.
  if (required > availableWidth && place) {
    return { ...statusBarLayout(availableWidth, residentWidth, eventWidth, modes, degradation, preserveTypewriter), place: 'absorbed' }
  }
  if (required > availableWidth && typewriter && !preserveTypewriter) {
    absorbed.push('typewriter')
  }
  if (required > availableWidth && typewriter && preserveTypewriter) typewriterPriority = true
  return { absorbed, collectionAtFloor, goalWithoutDue, agentIconOnly, typewriterPriority, ...(place ? { place: placeLayout } : {}) }
}

/** The chip's words: the place, and how many commands Actions here lists there. */
export function placeChipText(label: string, count: number): { place: string; count: string; full: string } {
  const counted = ` · ${count} ${count === 1 ? 'action' : 'actions'}`
  return { place: label, count: counted, full: `${label}${counted}` }
}

export type ReviewKindFilter = 'all' | 'comments' | 'edits'

/** What the status bar's review line is drawn from. Counts are the margin model's own, so the line and the margin never disagree. */
export type ReviewLineInput = {
  /** Items waiting in this piece, before any filter. */
  waiting: number
  /** Items shown under the current filter. */
  shown: number
  /** Whether any filter narrows the margin (kind, who, kind of edit, status). */
  filtered: boolean
  /** The kind segment that is pressed. */
  kind: ReviewKindFilter
  /** Segment counts, over the items every other filter lets through (so they stay put while a kind is pressed). */
  counts: { all: number; comments: number; edits: number }
  /** The focused card's place among the shown cards, or null when none is focused. */
  position: { index: number; of: number } | null
  /** Items that arrived and have not been looked at: "N new", once. */
  newCount: number
  /** Other pieces with something waiting. */
  otherPieces: number
  /** The who chip's words when a source, link or request narrows the margin ("Readers"); null otherwise. */
  who?: string | null
  /** Picked cards still shown (Space or ⌘-click): "N selected · Accept · Decline · Clear". */
  picked?: number
  /** The shown edits Accept all would take (no cards picked): "Accept all N" at six or more. */
  acceptable?: number
  /** The batch's progress, when one of six or more is settled ("M of N settled"). */
  batch?: { settled: number; total: number } | null
  /** Changes asked for from outside that never reached the text (ticket 06): "N could not be placed", which opens their popover. */
  notPlaced?: number
  /** Settled today or My edits (ticket 08): the line names the mode instead of the review count. */
  mode?: ReviewLineMode | null
}

/** Settled today: items settled today (those reopened in it included) and those waiting again. My edits: your recorded edits and everything else waiting. */
export type ReviewLineMode = { kind: 'settled'; settled: number; again: number } | { kind: 'mine'; recorded: number; others: number }

/** "Settled today · 5 settled, 1 waiting again · Esc Back"; "My edits · 3 recorded · Accept all 3 · 5 others waiting · Esc Back". */
export type ReviewModeLine = {
  kind: 'settled' | 'mine'
  label: 'Settled today' | 'My edits'
  /** "5 settled, 1 waiting again", "3 recorded". */
  text: string
  /** My edits: "Accept all 3" while any are recorded (the old Accept session), else null. */
  acceptAllText: string | null
  /** My edits: "5 others waiting", else null. */
  othersText: string | null
}

export type ReviewSegment = { id: ReviewKindFilter; label: string; count: number; pressed: boolean; off: boolean }

export type ReviewLine = {
  /** Nothing waiting here, items only in other pieces: the line is just "Waiting in N other pieces". */
  hereless: boolean
  /** The count button: "5 waiting", "4 of 5 waiting", "2 of 3 shown". Empty when hereless. */
  countText: string
  segments: ReviewSegment[]
  /** "3 new" while an arrival has not been looked at. */
  newText: string | null
  /** "Waiting in 2 other pieces". */
  elsewhereText: string | null
  /** The who chip ("Readers", with a × that clears it), or null. */
  who: string | null
  /** "2 selected" while cards are picked (then Accept, Decline, Clear act on them), else null. */
  selectedText: string | null
  /** "Accept all 19" when six or more edits are shown and nothing is picked, else null. */
  acceptAllText: string | null
  /** "1 of 20 settled" and the bar's fill (0..1), once one of a batch of six or more is settled. */
  progress: { text: string; fraction: number } | null
  /** "1 could not be placed" while outside changes wait there (ticket 06), else null. */
  notPlacedText: string | null
  /** Settled today or My edits (ticket 08); when set, only `mode` is drawn, with Esc Back. */
  mode: ReviewModeLine | null
}

/** The mode's words (ticket 08). */
export function reviewModeLine(mode: ReviewLineMode): ReviewModeLine {
  const n = (value: number): string => value.toLocaleString()
  if (mode.kind === 'settled') {
    return { kind: 'settled', label: 'Settled today', text: `${n(mode.settled)} settled${mode.again > 0 ? `, ${n(mode.again)} waiting again` : ''}`, acceptAllText: null, othersText: null }
  }
  return {
    kind: 'mine', label: 'My edits', text: `${n(mode.recorded)} recorded`,
    acceptAllText: mode.recorded > 0 ? `Accept all ${n(mode.recorded)}` : null,
    othersText: mode.others > 0 ? `${n(mode.others)} ${mode.others === 1 ? 'other' : 'others'} waiting` : null,
  }
}

export function waitingInOtherPieces(pieces: number): string {
  return `Waiting in ${pieces.toLocaleString()} other ${pieces === 1 ? 'piece' : 'pieces'}`
}

/**
 * The status bar's review line (0.25, ADR-0046). Absent with nothing waiting anywhere; with items only in other pieces it
 * is that one phrase; otherwise the count, the All / Comments / Edits segments (a segment with nothing in it is off),
 * and the position: "4 of 5 waiting", or "2 of 3 shown" when a filter narrows the margin.
 */
export function reviewLine(input: ReviewLineInput): ReviewLine | null {
  if (input.mode) {
    return { hereless: false, countText: '', segments: [], newText: null, elsewhereText: null, who: null, selectedText: null, acceptAllText: null, progress: null, notPlacedText: null, mode: reviewModeLine(input.mode) }
  }
  const here = input.waiting > 0
  const notPlaced = input.notPlaced ?? 0
  if (!here && input.otherPieces <= 0 && notPlaced <= 0) return null
  const elsewhereText = input.otherPieces > 0 ? waitingInOtherPieces(input.otherPieces) : null
  const n = (value: number): string => value.toLocaleString()
  const notPlacedText = notPlaced > 0 ? `${n(notPlaced)} could not be placed` : null
  if (!here) return { hereless: true, countText: '', segments: [], newText: null, elsewhereText, who: null, selectedText: null, acceptAllText: null, progress: null, notPlacedText, mode: null }
  const noun = input.filtered ? 'shown' : 'waiting'
  const total = input.filtered ? input.shown : input.waiting
  const countText = input.position ? `${n(input.position.index)} of ${n(total)} ${noun}` : `${n(total)} ${noun}`
  const picked = input.picked ?? 0
  const acceptable = input.acceptable ?? 0
  const seg = (id: ReviewKindFilter, label: string, count: number): ReviewSegment => ({ id, label, count, pressed: input.kind === id, off: count === 0 && input.kind !== id })
  return {
    hereless: false,
    countText,
    segments: [seg('all', 'All', input.counts.all), seg('comments', 'Comments', input.counts.comments), seg('edits', 'Edits', input.counts.edits)],
    newText: input.newCount > 0 ? `${n(input.newCount)} new` : null,
    elsewhereText,
    who: input.who ?? null,
    selectedText: picked > 0 ? `${n(picked)} selected` : null,
    acceptAllText: picked === 0 && acceptable >= BULK_THRESHOLD ? `Accept all ${n(acceptable)}` : null,
    progress: input.batch && input.batch.settled > 0 && input.batch.total >= BULK_THRESHOLD
      ? { text: `${n(input.batch.settled)} of ${n(input.batch.total)} settled`, fraction: input.batch.settled / input.batch.total }
      : null,
    notPlacedText,
    mode: null,
  }
}

/** One row of "Waiting in N other pieces" (ticket 07, frame `elsewhere`). */
export type ElsewhereRow = { path: string; name: string; count: number; sources: string; first: string; firstId: string }

/** The popover's rows from the margin model's other pieces: file name, count, who ("Agent 2 · Claude Code 1"), the first item's words. */
export function elsewhereRows(pieces: readonly OtherPiece[]): ElsewhereRow[] {
  return pieces.map((piece) => ({
    path: piece.path,
    name: piece.name,
    count: piece.count,
    sources: piece.bySource.map((row) => `${row.label} ${row.count}`).join(' \u00b7 '),
    first: piece.firstWords ? `first: \u201c${piece.firstWords}\u201d` : '',
    firstId: piece.firstId,
  }))
}

/** Below this window width the review line keeps its parts but drops the key hints and the progress bar (frame `narrow-1000`). It was the margin's fallback width until 2026-10-19; the margin now falls back by the room left for the text (margin-geometry's MARGIN_MIN_TEXT_WIDTH). */
export const REVIEW_LINE_COMPACT_WIDTH = 1150
export const reviewLineCompact = (windowWidth: number): boolean => windowWidth < REVIEW_LINE_COMPACT_WIDTH

export type StatusBarEvent = {
  id: string
  kind: 'save-pending' | 'save-failed' | 'zotero-waiting' | 'zotero-rejected'
  label: string
  detailLabel?: string
  title: string
  onSelect?: () => void
  glyphOnly?: boolean
}
