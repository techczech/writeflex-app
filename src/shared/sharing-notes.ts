// Readers' notes on the Sharing page and the Shares list (0.24 ticket 07; spec docs/plans/
// spec-writeflex-sharing-and-reader-notes-2026-10-14.md sections 4.6 and 6.1 "Limits reached"; locked
// frames `problems`, `shared-one`, `shared-several`, `shares-list`). Main (src/main/sharing-piece-ipc.ts
// `sharing:notes`) answers in these shapes; this file holds them and the fixed sentences. Nothing here is
// a secret, and no figure names a reader.

/** Which limit readers ran into, as the writer is told it. */
export type LimitKind = 'share_rate' | 'share_waiting' | 'share_total' | 'reader' | 'network' | 'service'

/** The Limits panel for one link (frame `problems`, "Limit reached: 14 comments refused"). */
export type LimitReached = {
  /** Notes refused since the writer last acted on this panel (Clear, Raise, Turn comments off). */
  refused: number
  /** The service refused more than it counted (a flood): "more than" the figure. */
  more: boolean
  /** The limit most of them ran into. */
  kind: LimitKind
  /** That limit's figure when it is the link's own (per hour, waiting, kept); null otherwise. */
  figure: number | null
  /** Raise the limit for this link can still raise it (the service's most not reached; a service of build 5). */
  raisable: boolean
}

/** Notes for one link: waiting and handled in the review list (this Collection's ledger), and the Limits panel. */
export type LinkNotes = {
  /** Readers' notes and proposed edits from this link not decided yet; null when the Collection's review list could not be read. */
  waiting: number | null
  /** Decided: done, accepted, declined, or closed because it could not be applied. */
  handled: number | null
  limit: LimitReached | null
}

/** By share id, for the links the window has bound (the page's, or the list's). */
export type NotesCounts = Record<string, LinkNotes>

/** The answer to Clear handled notes and Raise the limit for this link. */
export type LimitsActionResult =
  | { ok: true; message: string }
  | { ok: false; problem: { reason: string; fix: string } }

const n = (count: number): string => count.toLocaleString('en-GB')

/** The panel's heading: "Limit reached: 14 comments refused". */
export function limitHeading(limit: LimitReached): string {
  const what = limit.refused === 1 && !limit.more ? '1 comment refused' : `${limit.more ? 'more than ' : ''}${n(limit.refused)} comments refused`
  return `Limit reached: ${what}`
}

/**
 * The panel's sentence, as runs; the link's name in bold, as the frame draws it. "Readers on **Workshop
 * group** sent more than the 200 comments a link holds. 14 were refused, and those readers were told you
 * are not receiving more comments on this link for now."
 */
export function limitText(linkName: string, limit: LimitReached): Array<{ text: string; bold: boolean }> {
  const figure = limit.figure === null ? '' : n(limit.figure)
  const what = ((): string => {
    switch (limit.kind) {
      case 'share_rate': return ` sent more than the ${figure} comments a link takes in an hour.`
      case 'share_waiting': return ` left more than the ${figure} comments a link holds until WriteFlex collects them.`
      case 'share_total': return ` sent more than the ${figure} comments a link holds.`
      case 'reader': return ' sent more comments than one reader may send.'
      case 'network': return ' sent more comments from one network than one network may send in an hour.'
      case 'service': return ' sent comments while your sharing service had taken all the comments it takes in an hour, across all links.'
    }
  })()
  const count = limit.refused === 1 && !limit.more ? 'One was refused' : `${limit.more ? 'More than ' : ''}${n(limit.refused)} were refused`
  return [
    { text: 'Readers on ', bold: false },
    { text: linkName, bold: true },
    { text: `${what} ${count}, and those readers were told you are not receiving more comments on this link for now.`, bold: false },
  ]
}

export const RAISE_AT_MOST = 'The limit for this link is already as high as it goes.'
export const LIMITS_OFFLINE = { reason: 'WriteFlex cannot reach your sharing service.', fix: 'Check that this Mac is online, then try again.' }
export const LIMITS_OLD_SERVICE = { reason: 'Your sharing service is older than this WriteFlex and cannot do this yet.', fix: 'Update the sharing service in Settings › Sharing, then try again.' }
export const LIMITS_NOT_HERE = { reason: 'This link is not on this Mac’s Sharing page any more.', fix: 'Close the Sharing page and open it again.' }

/** "Cleared 7 handled comments from the sharing service." */
export function clearedMessage(cleared: number): string {
  if (cleared === 0) return 'No handled comments were left on the sharing service.'
  return cleared === 1 ? 'Cleared 1 handled comment from the sharing service.' : `Cleared ${n(cleared)} handled comments from the sharing service.`
}

/** "This link now takes 400 notes an hour." */
export function raisedMessage(perHour: number): string {
  return `The limit for this link is raised: it now takes ${n(perHour)} comments an hour.`
}

/** A count cell: the number, or a dash when it is not known. */
export function countLabel(count: number | null | undefined): string {
  return typeof count === 'number' ? n(count) : '–'
}
