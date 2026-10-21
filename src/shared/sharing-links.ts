// What the Sharing page and the title-bar mark show for one piece (sharing ticket 03; spec docs/plans/
// spec-writeflex-sharing-and-reader-notes-2026-10-14.md sections 4.2, 6.1, 8). The main process
// (src/main/sharing-publisher.ts) decides; this file holds the shapes it answers in and the fixed
// sentences. Nothing here is a secret: no view ever carries an owner token, the admin key or the
// Cloudflare token, and no view names the piece's file path to anything but this Mac's own window.

import type { OwnAddressState } from './sharing-setup'

/** What a link opens: one piece, or a whole Folio with its parts in running order (ticket 09). */
export type ShareKind = 'piece' | 'folio'

/** One part of a shared Folio as the copy readers see now (frame `folio`, "Parts of this Folio"). */
export type FolioPartView = {
  title: string
  /** Missing on disk: readers see its title with "not available". */
  missing: boolean
  /** The part's file name, for "… is not on disk". */
  fileName: string
  /** The part's path in this window's Workspace (Show in Files). */
  path: string
}

/** One link of a piece, as the window draws it (frames `shared-one`, `shared-several`). */
export type ShareLinkView = {
  shareId: string
  /** The optional name ("Marta", "Workshop group"); null when the link has none. */
  name: string | null
  /** The link's address, ready to copy (`https://…/s/<id>`): on your own address only while linksAddressNow allows (confirmed with Cloudflare within the day, answering). */
  address: string
  /** The same link on the address Cloudflare gives the account (ticket 05: copy again when the own address lapsed). */
  cloudflareAddress?: string
  /** Readers may leave notes and propose edits. */
  comments: boolean
  /** Private notes only in 0.24 (open notes ship later). */
  notes: 'private'
  on: boolean
  madeAt: number
  /** When publishing last worked for this link; null when nothing has been published yet. */
  publishedAt: number | null
  /** The save time of the copy readers see now. */
  publishedSavedAt: number | null
  /** The last publish did not go through: what readers see is older than the piece. */
  problem: SharePublishProblem | null
  /** A publish is running now. */
  publishing: boolean
  /** What the last publish left out, in plain words (pictures whose address points at this Mac or its
   *  network went out as their descriptions); null when nothing was left out. Never a failure. */
  note: string | null
  /** A Folio link: how many parts the copy readers see has as "not available" (missing on disk). */
  missingParts?: number
  /** Ticket 04: saves made since the last copy went out are kept on this Mac and sent when publishing works. */
  queued?: boolean
  /** Ticket 04: the share ended because its piece (or Folio folder) went to the Trash. `removed`: the copy
   *  is off the service (false while that is still owed, offline); `back`: the file is on disk again,
   *  so the page offers to turn the link on again. */
  ended?: { removed: boolean; back: boolean } | null
  /** Ticket 04 (ruling R-B): the link is on but its piece is not where the share has it: deleted or moved
   *  outside WriteFlex (`gone`), or its folder cannot be read now (`unreadable`). Nothing is published and
   *  nothing removed until the writer turns it off or follows it. `candidate`: the one place in this
   *  Workspace that main found holding the same file, offered as "Follow to". */
  lost?: { why: 'gone' | 'unreadable'; candidate: string | null } | null
}

export type SharePublishProblem = {
  /** `offline`: the service could not be reached; `token`: this Mac's key or the link's token was refused;
   *  `too-big`: the piece is over a limit of the service; `refused`: anything else the service said. */
  kind: 'offline' | 'auth' | 'too-big' | 'refused' | 'unreadable' | 'not-set-up' | 'not-saved'
  /** One or two plain sentences: what happened. */
  reason: string
  at: number
}

/** The title-bar mark for the open piece (frame `title-bar-marks`). Live is not in 0.24. */
export type ShareMark =
  | { kind: 'share' }
  | { kind: 'shared'; missing?: number }
  | { kind: 'not-published' }

export type PieceSharingView = {
  /** Sharing is set up on this Mac (ticket 02). */
  ready: boolean
  /** The address new and copied links read, once set up: your own address only while linksAddressNow allows (ticket 05),
   *  otherwise the one Cloudflare gives the account (`https://writeflex-sharing.<subdomain>.workers.dev`). */
  address: string | null
  /** The address Cloudflare gives the account; links sent on it always open. */
  cloudflareAddress?: string | null
  /** When `address` is your own address: the instant (ms) it stops being trusted; the page reads its view
   *  again then, so the address shown never outlives trust (review round 3). Null otherwise. */
  addressUntil?: number | null
  /** Ticket 05: your own address and its state (`lapsed`: links sent on it no longer open). */
  ownAddress?: OwnAddressState | null
  links: ShareLinkView[]
  mark: ShareMark
  /** A Folio's page (ticket 09): its parts in running order as readers see them now. */
  folio?: { parts: FolioPartView[] }
  /** The piece or Folio is no longer one (its file or its running order went away): its links can be
   *  turned off and copied, no link can be made (ticket 09 review round 1, finding 4). */
  sourceGone?: true
  /** With `sourceGone`: the piece's file is not on disk (deleted, or moved where WriteFlex cannot follow).
   *  The page shows "Piece not found" and offers no Turn on (ticket 11). */
  pieceNotFound?: true
  /** Links of another kind on the same file or folder, which the page lists for Copy and Turn off
   *  (ticket 09 review round 1, findings 3 and 4). */
  otherLinks?: OtherLinks[]
}

/** A part's own piece links on its Folio's page; on a piece's page, the links of a folder above it that is no longer a Folio. */
export type OtherLinks = { kind: ShareKind; path: string; links: ShareLinkView[] }

/** Make a link for the piece at `path`, or for the Folio whose folder is `folio` ('' the Workspace itself). */
export type MakeLinkRequest = { path?: string; folio?: string; name: string | null; comments: boolean }

/** The title-bar mark's words: "Shared · 1 part missing" (frame `folio`). */
export function missingPartsLabel(count: number): string {
  return count === 1 ? '1 part missing' : `${count} parts missing`
}

export type SharingLinkResult =
  | { ok: true; view: PieceSharingView; shareId?: string }
  | { ok: false; view: PieceSharingView; problem: { reason: string; fix: string } }

/** A link's name: one line, at most this many characters. */
export const LINK_NAME_CHARS = 60

/** The name as kept: trimmed, one line, or null for none. */
export function cleanLinkName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, ' ').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, LINK_NAME_CHARS) : null
}

/** How a link without a name is listed: its settings and the date it was made ("Private notes · 13 Oct"). */
export function linkLabel(link: Pick<ShareLinkView, 'name' | 'comments' | 'madeAt'>): string {
  if (link.name) return link.name
  const made = new Date(link.madeAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return `${link.comments ? 'Private comments' : 'No comments'} · ${made}`
}

/** The settings column: "Comments on, private" / "Comments off". */
export function linkSettingsLabel(link: Pick<ShareLinkView, 'comments'>): string {
  return link.comments ? 'Comments on, private' : 'Comments off'
}

// ── The fixed sentences ─────────────────────────────────────────────────────────────────────────

export const SHARE_OFFLINE = 'WriteFlex cannot reach your sharing service.'
export const SHARE_AUTH = 'Your sharing service did not accept this Mac\'s key for this link.'
export const SHARE_NOT_SET_UP = 'Sharing is not set up on this Mac.'
export const SHARE_UNREADABLE = 'WriteFlex could not read the piece to publish it.'
export const SHARE_REFUSED = 'Your sharing service refused the copy.'
export const IMAGES_OVER_COUNT = (count: number, limit: number) => `This piece has ${count} pictures; a link holds at most ${limit}.`
export const IMAGES_OVER_BYTES = (megabytes: number, limit: number) => `This piece's pictures come to ${megabytes} MB; a link holds at most ${limit} MB of pictures.`
export const IMAGE_TOO_BIG = (megabytes: number, limit: number) => `One picture in this piece is ${megabytes} MB; a link takes pictures of at most ${limit} MB each.`
export const PICTURES_REFUSED = (count: number) => count === 1
  ? 'One picture was published as its description: its address points at this Mac or its local network, so WriteFlex did not fetch it.'
  : `${count} pictures were published as their descriptions: their addresses point at this Mac or its local network, so WriteFlex did not fetch them.`
export const PAGE_TOO_BIG = (megabytes: number, limit: number) => `This piece comes to ${megabytes} MB when published; a link holds at most ${limit} MB of text.`

export const MAKE_FAILED = { reason: 'The link could not be made.', fix: 'Check that this Mac is online, then press Make a link again.' }
export const LINK_UNKNOWN = { reason: 'That link is no longer on this Mac.', fix: 'Close the Sharing page and open it again.' }
export const TURN_OFF_FAILED = { reason: 'The link could not be turned off: WriteFlex cannot reach your sharing service.', fix: 'Check that this Mac is online, then press Turn off again. Readers can still open it until then.' }
export const TURN_ON_FAILED = { reason: 'The link could not be turned on: WriteFlex cannot reach your sharing service.', fix: 'Check that this Mac is online, then press Turn on again.' }
export const TOKENS_NOT_SAVED = { reason: 'This Mac\'s secure storage did not keep the link\'s key, so the link was not made.', fix: 'Unlock the login Keychain, then try again.' }
export const LINK_NOT_SAVED = { reason: 'WriteFlex could not save the link on this Mac, so the link was not made and nothing was published.', fix: 'Check that the Mac has free disk space, then press Make a link again.' }
export const NO_PIECE = { reason: 'Open a piece to share it.', fix: 'Open the piece, then choose Share.' }
export const FOLIO_GONE = 'This folder is no longer a Folio, so WriteFlex has nothing to publish on this link.'
export const FOLIO_EMPTY = 'This Folio has no parts to publish.'
export const FOLIO_TOO_MANY_PARTS = (count: number, limit: number) => `This Folio has ${count} parts; a link holds at most ${limit}.`
/** Frame `folio`, the right column: "<file> is not on disk. Readers see its title with “not available”. The other five parts are published." */
export function partMissingText(missing: readonly FolioPartView[], total: number): string {
  const others = total - missing.length
  const names = missing.map((part) => part.fileName)
  const which = names.length === 1 ? `${names[0]} is not on disk.` : `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are not on disk.`
  const see = names.length === 1 ? 'Readers see its title with “not available”.' : 'Readers see their titles with “not available”.'
  const rest = others === 0 ? 'No other part is published.' : others === 1 ? 'The other part is published.' : `The other ${numberWord(others)} parts are published.`
  return `${which} ${see} ${rest}`
}
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const numberWord = (count: number): string => NUMBER_WORDS[count] ?? String(count)
/** Ticket 04, the Sharing page: a link whose piece went to the Trash. */
export const ENDED_BY_TRASH = 'This piece went to the Trash, so its link was turned off and the copy removed.'
export const ENDED_REMOVAL_OWED = 'This piece went to the Trash. Its link is off for this Mac; WriteFlex removes the copy from your sharing service as soon as it can reach it.'
export const ENDED_BACK = 'This piece is back from the Trash. Its link stayed off; turn it on again to publish the piece at the same address.'
export const NOT_SET_UP_PROBLEM = { reason: SHARE_NOT_SET_UP, fix: 'Set up sharing first.' }
/** Ticket 04 (ruling R-F): a change to a link (moved with its piece, ended, a save queued) could not be saved on this Mac. */
export const RECORD_NOT_SAVED = 'WriteFlex could not save a change to this link on this Mac (its settings file could not be written), so the link was left as it was and your latest save was not published.'
/** Ticket 04 (Sol round 2 P2-2): what happened to a link (a publish, its file, not found or found) went through but could not be saved on this Mac. */
export const LINK_STATE_NOT_SAVED = 'WriteFlex could not save this link\'s latest details on this Mac (its settings file could not be written), so after a restart it may show an older state.'
/** Ticket 04 (R-B): "Follow to" refused: the file is no longer at the place found, or is another file now. */
export const FOLLOW_NOT_THERE = { reason: 'The piece is no longer at the place WriteFlex found it, so the link was not moved.', fix: 'Turn the link off, or open the piece where it is now and make a new link.' }
/** Ticket 04 (R-F): Turn on went through at the service, but the link could not be saved on this Mac, so nothing was published. */
export const TURN_ON_NOT_SAVED = { reason: 'WriteFlex could not save the link on this Mac, so it was not turned on here and nothing was published.', fix: 'Check that the Mac has free disk space, then press Turn on again.' }
export const FOLLOW_NOT_SAVED = { reason: 'WriteFlex could not save the link on this Mac, so it was not moved.', fix: 'Check that the Mac has free disk space, then press Follow again.' }
/** "Piece not found" for a link that is off (ticket 11): it stays off until the piece is back. */
export function pieceNotFoundOffText(where: string): string {
  return `WriteFlex cannot find ${where}: it was deleted, or moved somewhere WriteFlex cannot follow. This link is off, so readers see the link-off page. It can be turned on again when the piece is back.`
}

/** Ticket 04 (R-B), the "Piece not found" row (frame `problems`): what happened and what readers see. */
export function pieceNotFoundText(lost: { why: 'gone' | 'unreadable'; candidate: string | null }, where: string, lastCopy: string | null): string {
  const readers = lastCopy ? `Readers still see the copy published at ${lastCopy}.` : 'Nothing was published on this link, so readers see the link-off page.'
  const what = lost.why === 'unreadable'
    ? `WriteFlex cannot read ${where} just now: its folder may be on a drive that is not connected, not yet downloaded, or closed to WriteFlex.`
    : `WriteFlex cannot find ${where}: it was deleted, or moved somewhere WriteFlex cannot follow.`
  const found = lost.candidate ? ` The same file is now at ${lost.candidate}.` : ''
  return `${what}${found} Nothing is published to this link and nothing has been removed until you decide. ${readers}`
}
