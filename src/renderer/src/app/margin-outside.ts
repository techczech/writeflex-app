import type { Change, OutsideSource, OutsideSummary } from '../../../preload'

/**
 * What the margin knows about outside changes (ticket 10). The rows that used to carry them (the arrived row, the
 * unplaced row and "N waiting in M other pieces") moved to the status bar's review line and its popovers; the margin
 * keeps the allowance summary for its top line and the arrivals so it stays visible while a first one is unread.
 */
export type MarginOutside = {
  summary: OutsideSummary | null
  /** Outside changes that arrived since the writer last looked. */
  arrived: Change[]
  /** Accept all… / Decline all… from one source, across the collection: opens the confirm sheet. */
  onSourceBulk?: (action: 'accept' | 'decline', source: OutsideSource) => void
}
