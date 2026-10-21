/**
 * The shown-first requests (specification sections 3 and 4, "Shown-first changes"): the closed list
 * of operations that change an existing document and therefore never apply it, the closed list of
 * sources a caller may declare, and every size limit. Electron-free; shared by the command line, which
 * files the request, and the app, which turns it into a pending Change in the review ledger.
 *
 * A shown-first request has the same file format as any other (request-format.ts): `{ version, id,
 * operation, args }`. Its arguments are the operation's own. One of them, `source`, is the caller's
 * statement of who it is. It is a statement, not proof: any program running as the user can file a
 * request. The app maps it through `declaredSource`; nothing else from the request reaches the
 * Change's author.
 */
import { OUTSIDE_SOURCES, OUTSIDE_SOURCE_LABELS, type OutsideSource } from '../../shared/outside-source'

export const SHOWN_FIRST_OPERATIONS = [
  'replace', 'insert', 'move-text', 'restore-version',
  'set-frontmatter', 'normalise-frontmatter', 'set-status', 'tick', 'insert-object', 'attach-source',
] as const
export type ShownFirstOperation = (typeof SHOWN_FIRST_OPERATIONS)[number]
export const isShownFirst = (operation: string): operation is ShownFirstOperation => (SHOWN_FIRST_OPERATIONS as readonly string[]).includes(operation)

/** The stored source of an outside Change: a closed list, defined once in shared/outside-source.ts. */
export { OUTSIDE_SOURCES, type OutsideSource }

/** The author the APP gives a Change from each source. Nothing in a request is copied into an author. */
export const OUTSIDE_AUTHORS = Object.fromEntries(OUTSIDE_SOURCES.map((source) => [source, { name: OUTSIDE_SOURCE_LABELS[source] }])) as Record<OutsideSource, { name: string }>

/**
 * The stored source for whatever a request declared. Only the exact strings `claude-code` and `codex`
 * name a source; anything else (nothing, another name, "writer", "agent", "WriteFlex Agent", a
 * non-string) is the generic outside agent.
 */
export function declaredSource(declared: unknown): OutsideSource {
  return declared === 'claude-code' || declared === 'codex' ? declared : 'outside-agent'
}

const KIB = 1024
/** The text to find: a replacement's target, an insert's or move's anchor, the text a move carries. */
export const MAX_TARGET_BYTES = 64 * KIB
/** New text: a replacement, an insertion, an object's markup. */
export const MAX_NEW_TEXT_BYTES = 256 * KIB
/** A note that becomes the Change's summary line. Longer is cut, not refused. */
export const MAX_NOTE_CHARS = 300
/** A frontmatter value or a status. */
export const MAX_VALUE_CHARS = 2000
/** A document changed as a whole (restore a version, frontmatter, status, a source): its size, before and after. */
export const MAX_WHOLE_DOCUMENT_BYTES = 1024 * KIB
/** How much of a refused request's text is kept on its closed Change, per side, for the writer to read. */
export const INTENDED_SHOWN_CHARS = 2000

/**
 * WHAT ONE LOOK AT A FOLDER MAY COST, defined here once for the app and the command line alike. Every
 * folder a Collection controls (the inbox, the outbox) and every folder of records is listed through
 * `HeldFolder.namesUpTo(MAX_ENTRIES_LISTED)` or `entriesUpTo`, which stop taking directory entries at
 * the count; a look then reads at most so many request files, and so many bytes of them.
 */
export const MAX_ENTRIES_LISTED = 2000
export const MAX_REQUESTS_PER_PASS = 500
export const MAX_REQUEST_BYTES_PER_PASS = 16 * KIB * KIB
/** What is remembered from look to look (names already told, requests already answered again or put
 *  off) is kept to this many, the oldest forgotten first: all that two looks can meet. */
export const MAX_NAMES_REMEMBERED = 2 * MAX_ENTRIES_LISTED
/** The review ledger holds at most this many undecided outside Changes, and this much of their text. Beyond it, requests wait in the inbox. */
export const MAX_UNDECIDED_OUTSIDE_CHANGES = 1000
export const MAX_UNDECIDED_OUTSIDE_BYTES = 32 * KIB * KIB
/** No one source holds more than this many of them, so one source cannot take the whole allowance. */
export const MAX_UNDECIDED_PER_SOURCE = 400
/** One request yields at most this many Changes. */
export const MAX_CHANGES_PER_REQUEST = 20
/** The ledger keeps at most this many records of refused requests. Past it, a refused request is answered and cleared without a record. */
export const MAX_REFUSED_OUTSIDE_RECORDS = 2000
/** The path of a refused request is kept on its record cut to this length: it is shown, never acted on. */
export const REFUSED_PATH_SHOWN_CHARS = 300
/** A request deferred because the ledger is full is not read again for this long. */
export const DEFERRED_RETRY_MS = 30_000
/** A reply is written only for a request made within this long: an older one has nobody waiting for it. */
export const REPLY_WORTH_MS = 60_000

export const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8')
