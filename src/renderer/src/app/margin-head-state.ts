import type { Change } from '../../../preload'
import type { MarginFilter, MarginKind } from './margin-model'

/** What the margin's filter, the count menu and the bulk popovers keep: one value, owned by the bound margin. */
export type HeadFilterState = { filter: MarginFilter; showOwnEdits: boolean; settled: boolean; showQuiet: boolean }
export const EMPTY_HEAD_FILTER: HeadFilterState = { filter: {}, showOwnEdits: false, settled: false, showQuiet: false }

export type HeadControls = {
  state: HeadFilterState
  onState: (next: HeadFilterState) => void
  picked: ReadonlySet<string>
  onClearPicked: () => void
  onAccept: (kind?: MarginKind) => void
  onDecline: () => void
  /** Whether the Send back popover (over the status bar's review line, ticket 04) is open. */
  sendBackOpen: boolean
  onSendBackOpen: (open: boolean) => void
  /** Unused since ticket 04: the note is written in the status bar's Send back popover. */
  onSendBack?: (note: string) => void
  onReopen: (id: string) => void
  /** More > Accept session (with Yours pressed): accept every pending edit of yours in this piece. */
  onAcceptSession?: () => void
  /** Send a settled change's original wording to the Scratchpad. */
  onSendOriginal?: (change: Change) => void
  /** Display chords for the three bulk commands, as the writer has them set. */
  chords?: { acceptAll?: string; declineAll?: string; sendBack?: string }
}
