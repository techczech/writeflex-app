import type { Change, OutsideSummary } from '../../../preload'

/**
 * What the margin knows about outside changes (ticket 10). The rows that used to carry them (the arrived row, the
 * unplaced row and "N waiting in M other pieces") moved to the status bar's review line and its popovers; the margin
 * keeps the allowance summary for its top line and the arrivals so it stays visible while a first one is unread.
 */
export type MarginOutside = {
  summary: OutsideSummary | null
  /** Outside changes that arrived since the writer last looked. */
  arrived: Change[]
}
