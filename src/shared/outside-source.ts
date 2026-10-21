/**
 * The closed list of sources a Change from outside WriteFlex can have, and the label each is shown
 * with. Defined ONCE, here: the main process maps what a request declared onto it
 * (main/cli/review-format.ts), and the preload bridge's `Change` type is derived from it, so the two
 * cannot differ. No Node or Electron import: the renderer can read it.
 */
export const OUTSIDE_SOURCES = ['claude-code', 'codex', 'outside-agent', 'reader'] as const
export type OutsideSource = (typeof OUTSIDE_SOURCES)[number]

/** The label, which is also the author the app gives a Change from each source. */
export const OUTSIDE_SOURCE_LABELS: Record<OutsideSource, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'outside-agent': 'Outside agent',
  // A reader of a shared link (0.24 ticket 07). Only the app's own collector gives this source: the
  // command line's `declaredSource` never maps a request onto it (cli/review-format.ts).
  reader: 'Reader',
}

/**
 * What a reader's note or proposed edit carries in the ledger beside the Change (0.24 ticket 07). All
 * of it is the reader's or the link's text, kept as TEXT: shown with React text nodes, never as markup.
 */
export type ReaderNoteFields = {
  /** The share it came through, and the note's key there (`<reader id>.<note id>`). */
  shareId: string
  key: string
  /** The link's name, or its settings and the date it was made when it has none ("Private notes · 11 Oct"). */
  link: string
  /** The name the reader typed. */
  name: string
  kind: 'note' | 'edit'
  /** A note's text, or a proposed edit's replacement for the quoted words. */
  text: string
  /** The words the reader selected, as they read them. */
  quote: string
  /** Where those words were found when the note was collected: as written, the nearest match (the text
   *  has changed since), or nowhere. `ambiguous`: they stand in more than one place equally well. */
  anchored: 'unchanged' | 'changed' | 'gone'
  ambiguous?: true
  /** When the reader wrote it (their clock), or when the service received it. */
  at: number
  /** The words in the piece it was placed beside when collected (a stretch that stood there once);
   *  absent when gone. A proposed edit that could not be applied is drawn beside these. */
  words?: string
}

/** What the writer did with a reader's note or proposed edit, as the reader is told (0.24 ticket 08). */
export type ReaderOutcome = 'accepted' | 'declined' | 'done' | 'failed'

/**
 * The writer's reply on a reader's note or proposed edit (0.24 ticket 08): plain text, kept as TEXT and
 * shown with text nodes. `id` makes the reply arrive once however often it is sent; `sent` is when the
 * link's sharing service confirmed it holds it (absent: not sent yet). `notSent` is a final answer that
 * it never will be: `full`, the service refused it because the note has its 20 replies; `gone`, the
 * service no longer holds the note. A reply with `notSent` is never sent again and never shown as Sent.
 */
export type ReaderReply = { id: string; text: string; at: number; by: string; sent?: number; notSent?: ReaderReplyNotSent }
export type ReaderReplyNotSent = 'full' | 'gone'

/** What the link's sharing service last confirmed it holds for the note: its outcome (null: open) and when it was decided. */
export type ReaderHeard = { outcome: ReaderOutcome | null; at: number | null }

/** The fields an outside Change carries beside the shared ledger's own (main/outside-change-fields.ts reads them). */
export type OutsideRequestRef = { id: string; index: number; count: number; at: number }
export type OutsideChangeFields = {
  /** Present on a Change that came through the command line; chosen by the app from the closed list. */
  outsideSource?: OutsideSource
  /** The request it came from, this Change's place among that request's (1-based), and when the request says it was made. */
  outsideRequest?: OutsideRequestRef
  /** A move's destination anchor as text; accept places the move by text, never by the stored ranges. */
  outsideMoveAfter?: string
  /** The request failed validation: this record can never be accepted, held or reopened. */
  outsideRefused?: true
  /** What a refused request asked for, each side cut to a length. Never applied. `path` is the path
   *  the request named, as typed, when it is not a document path (a dot-folder, `..`, an absolute
   *  path): the record's own `path` is then `NOT_A_DOCUMENT_PATH_LABEL`, never what was typed. */
  outsideIntended?: { oldText: string; newText: string; cut: boolean; path?: string }
  /** Source `reader` only: the reader, the link and the quoted words (0.24 ticket 07). */
  readerNote?: ReaderNoteFields
  /** Source `reader` only: the writer's replies, oldest first (0.24 ticket 08). */
  readerReplies?: ReaderReply[]
  /** Source `reader` only: what the link's service last confirmed for the note (0.24 ticket 08). Absent: nothing sent yet. */
  readerHeard?: ReaderHeard
  /** Source `reader` only: when the writer last moved the record's status (decided, re-decided, taken back); the outcome's time the reader is told (0.24 ticket 08). */
  readerDecidedAt?: number
  /** Source `reader` only: when the link's service answered that it no longer holds the note (cleared, or wiped). Final: nothing for it is sent again (0.24 ticket 08). */
  readerGone?: number
  /** Source `reader` only, never stored: the link's sharing service is older than this WriteFlex and its replies wait until it is updated (main adds it as the window lists the ledger; 0.24 ticket 08). */
  readerRepliesWait?: true
}

/** The `path` of a refused outside request's record whose typed path is not a document path. Not a path. */
export const NOT_A_DOCUMENT_PATH_LABEL = '(not a document in this Collection)'

/** How full the review ledger is with undecided Changes from outside, for the dock (`changes:outside-summary`). */
export type OutsideSummary = {
  /** Undecided (pending or held) outside Changes now, and the most the ledger takes, in all and per source. */
  undecided: number
  limit: number
  limitPerSource: number
  bySource: Array<{ source: OutsideSource; label: string; undecided: number }>
  /** One row per request that still has undecided Changes, newest first. */
  byRequest: Array<{ id: string; source: OutsideSource; at: number; undecided: number; count: number; paths: string[] }>
  /** What the app's last look at the inbox did, or null before the first one that met a proposed change. */
  lastLook: OutsideLook | null
}

/** One look at the inbox, as kept for the dock. */
export type OutsideLook = {
  at: number
  /** Requests added as pending Changes, and how many Changes. */
  filed: number
  changes: number
  /** Requests refused by the app's checks (`unrecorded` of them with no closed record, the ledger keeping its limit of those). */
  closed: number
  unrecorded: number
  /** Requests the ledger already held. */
  repeats: number
  /** Requests still in the inbox after the look, and why. */
  left: number
  leftBecause: Array<'look-limit' | 'ledger-full' | 'not-held' | 'ledger-not-writable'>
  /** Requests refused because the ledger had no room for their source or at all. */
  refusedFull: number
  /** Replies that could not be written to the outbox (the requests were settled all the same). */
  repliesNotWritten: number
  limits: { requestsPerLook: number; bytesPerLook: number; undecidedInLedger: number; undecidedPerSource: number; undecidedBytesInLedger: number; refusedRecordsInLedger: number; changesPerRequest: number }
  failed?: string
}
