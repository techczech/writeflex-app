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

export type StatusBarEvent = {
  id: string
  kind: 'save-pending' | 'save-failed' | 'zotero-waiting' | 'zotero-rejected'
  label: string
  detailLabel?: string
  title: string
  onSelect?: () => void
  glyphOnly?: boolean
}
