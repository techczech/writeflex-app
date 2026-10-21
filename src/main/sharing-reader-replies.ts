// Readers hear back (0.24 ticket 08; spec 4.4 "either way the reader's page shows the outcome and
// your reply the next time it loads", 6.2 "Outcome recorded", 9 "Hearing back").
//
// WHAT IS SENT. For each reader record in the review ledger: the outcome the writer gave it (Accepted,
// Declined, Done, Could not be applied; none while it waits) and the writer's replies. Nothing else
// from the Collection: no path, no piece text, no other record. Each goes only to the link the note
// came through (its share id), with that link's owner token, and only for links of this Collection.
//
// SENT ONCE. A reply carries an id made when it was written, so the service keeps it once however
// often it is sent. The ledger records what the service confirmed (`readerHeard`, each reply's
// `sent`, only for a reply the service names held); what it has not confirmed is sent again on the
// next look (offline, the service not answering, an older service), and a reply written offline goes
// on return, once. Two answers are final and end sending, never shown as Sent: a reply refused
// because the note has its 20 (`notSent: full`), and a note the service no longer holds
// (`readerGone`, its unsent replies `notSent: gone`).
//
// AN OLDER SERVICE. A service that answers without per-reply entries (`replies`) is older than this
// WriteFlex (before build 7): nothing it says confirms a reply, so its replies stay unsent and are
// sent again. Never inferred from `recorded` or the note-level `full`. Counted per answer: after
// LEGACY_ANSWERS_AT_MOST such answers in a row the link's replies stop going, from the next request of
// the same look (its outcomes still go: that service keeps them), and the link is `outdated`: the cards
// say to update the sharing service. The count is kept by the caller (`ports.legacy`). The pause lifts
// three ways: an answer with `replies` sets the count back to 0; every LEGACY_RETRY_MS since the last
// older answer the replies go once more, as an ordinary request (the service may have been updated from
// another Mac); and the caller clears it when the service is set up, updated, or found current.
//
// ONE OUTCOME PER NOTE. The outcome's time is the decision time the record keeps, never the time of
// sending; records of one note filed twice send one outcome, the latest decision's.
//
// NOTHING HERE WRITES TO A PIECE. It reads the ledger and writes only the confirmation fields.
//
// No Electron import.
import { randomBytes } from 'node:crypto'
import type { Change } from '../engine'
import { closedReasonOf, isReaderReply, READER_REPLY_CHARS, type ChangeStore, type ReaderHeardAck } from './changes'
import { readerNoteOf } from './outside-change-fields'
import type { ServiceAnswer } from './sharing-client'
import type { OutsideChangeFields, ReaderHeard, ReaderOutcome, ReaderReply } from '../shared/outside-source'
import { cleanText } from '../../sharing-service/reader-notes.ts'
import { OUTCOME_LIMITS } from '../../sharing-service/note-outcomes.ts'

/** One link the sender may answer through: where its service is and its owner token (never leaves main). */
export type ReplyLink = { shareId: string; base: string; owner: string }

export type OutcomeItem = { key: string; outcome: ReaderOutcome | null; at: number | null; replies: Array<{ id: string; text: string; at: number }> }

export interface ReaderRepliesPorts {
  sendOutcomes(base: string, shareId: string, owner: string, items: OutcomeItem[]): Promise<ServiceAnswer<{ recorded: unknown; waiting: unknown; unknown: unknown; full: unknown; replies?: unknown }>>
  changes: Pick<ChangeStore, 'list' | 'markReaderHeard'>
  now(): number
  /** Older-service answers in a row, by share id (kept by the caller across looks). Absent: not counted. */
  legacy?: Map<string, LegacyAnswers>
}

/** A link's older-service answers in a row, and when the last came (ports.now). */
export type LegacyAnswers = { count: number; lastAt: number }

export type SendOutcome = {
  /** Notes whose outcome the service confirmed it holds. */
  sent: number
  /** Notes left for the next look: the service did not answer, or has not got the note yet. */
  left: number
  /** Notes the service no longer holds (cleared, or wiped): marked so, never sent again. */
  gone: number
  /** Links whose service did not take them (no answer, refused, or too old for outcomes). */
  failed: string[]
  /** Links whose service answered as older than build 7 LEGACY_ANSWERS_AT_MOST times in a row: their replies wait for the update. */
  outdated: string[]
}

/** Older-service answers in a row after which a link's replies stop going until the service is updated. */
export const LEGACY_ANSWERS_AT_MOST = 3
/** How long a link's replies wait, after its last older-service answer, before they are tried once more. */
export const LEGACY_RETRY_MS = 30 * 60_000

/** The most one request carries, under the service's limits (OUTCOME_LIMITS). */
const PER_REQUEST = Math.min(OUTCOME_LIMITS.perRequest, 50)
const REQUEST_BYTES = Math.floor(OUTCOME_LIMITS.requestBytes * 0.75)
const NOTE_KEY = /^[0-9a-f]{24}\.[A-Za-z0-9_-]{8,64}$/

/** The outcome the reader is told for a record, or null while it waits (pending or held). */
export function readerOutcomeOf(change: Change): ReaderOutcome | null {
  const fields = readerNoteOf(change)
  if (!fields) return null
  if (change.status === 'accepted') return fields.kind === 'note' ? 'done' : 'accepted'
  if (change.status === 'rejected') return closedReasonOf(change) !== null ? 'failed' : 'declined'
  return null
}

/**
 * When the writer last decided the record, or null when it was never decided (filed and left open).
 * The time kept on the record (`readerDecidedAt`, changes.ts); a record decided before it was kept
 * reads its closing time, else its filing time. Never the time of sending, so a resend sends the same.
 */
export function decisionTimeOf(change: Change): number | null {
  const kept = (change as Change & OutsideChangeFields).readerDecidedAt
  if (typeof kept === 'number' && Number.isSafeInteger(kept) && kept > 0) return kept
  if (change.status === 'pending') return null
  const closedAt = (change as Change & { closedAt?: unknown }).closedAt
  if (change.status === 'rejected' && typeof closedAt === 'number' && Number.isSafeInteger(closedAt) && closedAt > 0) return closedAt
  return Number.isSafeInteger(change.ts) && change.ts > 0 ? change.ts : null
}

const repliesOf = (change: Change): ReaderReply[] => {
  const list = (change as Change & OutsideChangeFields).readerReplies
  return Array.isArray(list) ? list.filter(isReaderReply) : []
}

/** A reply still to be sent: neither confirmed held nor finally refused. */
const unsentOf = (change: Change): ReaderReply[] => repliesOf(change).filter((reply) => reply.sent === undefined && reply.notSent === undefined)

/**
 * The one outcome the reader is told for a note, across every ledger record of it (the same note filed
 * twice): the latest decision's, by the decision time each record keeps, a later record winning a tie.
 * Records never decided count only when no record was; then the note is open.
 */
export function authoritativeOutcome(records: readonly Change[]): ReaderHeard {
  let best: { change: Change; at: number } | null = null
  for (const change of records) {
    const at = decisionTimeOf(change)
    if (at !== null && (best === null || at >= best.at)) best = { change, at }
  }
  const outcome = best ? readerOutcomeOf(best.change) : null
  return { outcome, at: outcome === null || !best ? null : best.at }
}

const sameHeard = (change: Change, heard: ReaderHeard): boolean => {
  const last = (change as Change & OutsideChangeFields).readerHeard
  const outcome = last && typeof last === 'object' ? last.outcome ?? null : null
  const at = last && typeof last === 'object' ? last.at ?? null : null
  return outcome === heard.outcome && (heard.outcome === null || at === heard.at)
}

/**
 * What one note still owes its reader, across its ledger records, or null when the service holds all
 * of it or will never take it: its one outcome when a record's last confirmed one differs (a note
 * never sent and still open owes nothing), and the replies not yet confirmed or refused. A note the
 * service no longer holds (`readerGone`) owes nothing.
 */
export function owedForNote(records: readonly Change[], withReplies = true): { item: OutcomeItem; heard: ReaderHeard; replyIds: Map<string, string[]> } | null {
  const fields = records.length > 0 ? readerNoteOf(records[0]) : null
  if (!fields || !NOTE_KEY.test(fields.key)) return null
  if (records.some((change) => typeof (change as Change & OutsideChangeFields).readerGone === 'number')) return null
  const heard = authoritativeOutcome(records)
  const replyIds = new Map<string, string[]>()
  const replies: OutcomeItem['replies'] = []
  const seen = new Set<string>()
  for (const change of withReplies ? records : []) {
    for (const reply of unsentOf(change)) {
      // The service takes at most OUTCOME_LIMITS.repliesPerNote replies a request; the rest go next look.
      if (seen.has(reply.id) || replies.length >= OUTCOME_LIMITS.repliesPerNote) continue
      seen.add(reply.id)
      replies.push({ id: reply.id, text: reply.text, at: reply.at })
    }
  }
  for (const change of records) replyIds.set(change.id, unsentOf(change).map((reply) => reply.id).filter((id) => seen.has(id)))
  if (replies.length === 0 && records.every((change) => sameHeard(change, heard))) return null
  return { item: { key: fields.key, outcome: heard.outcome, at: heard.at, replies }, heard, replyIds }
}

/** What one record owes its reader, as `owedForNote` for a note with this one record. */
export function owedFor(change: Change): { item: OutcomeItem; heard: ReaderHeard; replyIds: string[] } | null {
  const due = owedForNote([change])
  return due ? { item: due.item, heard: due.heard, replyIds: due.replyIds.get(change.id) ?? [] } : null
}

/**
 * The writer's reply as the ledger keeps it: plain text (line endings made \n, controls and bidi
 * characters removed, as from a reader), 1 to 1000 characters, with an id that makes it arrive once.
 * Throws with the writer's words when it cannot be a reply.
 */
export function readerReplyFor(text: unknown, by: string, now: number, makeId: () => string = () => randomBytes(12).toString('base64url')): ReaderReply {
  if (typeof text !== 'string' || text.length > READER_REPLY_CHARS * 2) throw new Error(`A reply is at most ${READER_REPLY_CHARS.toLocaleString('en-GB')} characters.`)
  const cleaned = cleanText(text)
  if (cleaned === '') throw new Error('A reply needs some words.')
  if (cleaned.length > READER_REPLY_CHARS) throw new Error(`A reply is at most ${READER_REPLY_CHARS.toLocaleString('en-GB')} characters.`)
  return { id: makeId(), text: cleaned, at: now, by: by.trim().slice(0, 200) || 'You' }
}


const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])

/** The service's answer for each reply sent on a recorded note: held (kept now or before) and refused for the limit. */
function replyAnswers(value: unknown): Map<string, { held: Set<string>; full: Set<string> }> {
  const answers = new Map<string, { held: Set<string>; full: Set<string> }>()
  if (!Array.isArray(value)) return answers
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || typeof (entry as { key?: unknown }).key !== 'string') continue
    const e = entry as { key: string; kept?: unknown; already?: unknown; full?: unknown }
    answers.set(e.key, { held: new Set([...strings(e.kept), ...strings(e.already)]), full: new Set(strings(e.full)) })
  }
  return answers
}

/** One look: every link's owed outcomes and replies sent, and what each service confirmed recorded. */
export async function sendReaderOutcomes(ports: ReaderRepliesPorts, links: readonly ReplyLink[]): Promise<SendOutcome> {
  const result: SendOutcome = { sent: 0, left: 0, gone: 0, failed: [], outdated: [] }
  if (links.length === 0) return result
  const byShare = new Map(links.map((link) => [link.shareId, link]))
  const now = ports.now()
  // Every record of each note, by link then note key: duplicates of one note are sent as one.
  const notes = new Map<string, Map<string, Change[]>>()
  for (const change of await ports.changes.list()) {
    const fields = readerNoteOf(change)
    // Only a link of this Collection, with its token: a record from any other share is never sent.
    if (!fields || !byShare.has(fields.shareId)) continue
    const byKey = notes.get(fields.shareId) ?? new Map<string, Change[]>()
    byKey.set(fields.key, [...(byKey.get(fields.key) ?? []), change])
    notes.set(fields.shareId, byKey)
  }
  for (const [shareId, byKey] of notes) {
    const link = byShare.get(shareId)!
    // An older service, answered so too often: only outcomes go; its replies wait for the update, or
    // go once more when LEGACY_RETRY_MS has passed since its last answer.
    const paused = (count: LegacyAnswers | undefined): boolean => (count?.count ?? 0) >= LEGACY_ANSWERS_AT_MOST
    let withReplies = !paused(ports.legacy?.get(shareId)) || now - ports.legacy!.get(shareId)!.lastAt >= LEGACY_RETRY_MS
    const owed = (all: Change[][]) => all.flatMap((records) => {
      const due = owedForNote(records, withReplies)
      return due ? [{ records, ...due }] : []
    })
    let entries = owed([...byKey.values()])
    if (entries.length === 0) {
      if (paused(ports.legacy?.get(shareId))) result.outdated.push(shareId)
      continue
    }
    const acks: ReaderHeardAck[] = []
    let failed = false
    for (let start = 0; start < entries.length;) {
      const batch: typeof entries = []
      let bytes = 0
      while (start < entries.length && batch.length < PER_REQUEST) {
        const size = JSON.stringify(entries[start].item).length * 3
        if (batch.length > 0 && bytes + size > REQUEST_BYTES) break
        batch.push(entries[start])
        bytes += size
        start += 1
      }
      const answer = await ports.sendOutcomes(link.base, link.shareId, link.owner, batch.map((entry) => entry.item)).catch(() => ({ kind: 'unreachable' as const }))
      if (answer.kind !== 'ok') { failed = true; result.left += entries.length - start + batch.length; break }
      // Recorded: the service holds the outcome; a reply is confirmed only when the service names it
      // held (kept now or before), and a reply it refused for the limit is final. Unknown: the service
      // no longer holds the note (cleared, or wiped), so nothing can reach its reader: final, never
      // shown as Sent. Waiting, or a reply the answer does not name: the next look.
      const recorded = new Set(strings(answer.body.recorded))
      const unknown = new Set(strings(answer.body.unknown))
      // Per-reply entries are what confirms a reply; an answer without them is from an older service.
      const listed = (answer.body as { replies?: unknown }).replies
      if (ports.legacy) {
        const last = ports.legacy.get(shareId)
        ports.legacy.set(shareId, Array.isArray(listed) ? { count: 0, lastAt: last?.lastAt ?? now } : { count: (last?.count ?? 0) + 1, lastAt: now })
      }
      const replies = replyAnswers(listed)
      for (const entry of batch) {
        const key = entry.item.key
        if (recorded.has(key)) {
          const said = replies.get(key)
          for (const change of entry.records) {
            const ids = entry.replyIds.get(change.id) ?? []
            acks.push({ id: change.id, heard: entry.heard, replyIds: ids.filter((id) => said?.held.has(id)), fullIds: ids.filter((id) => said?.full.has(id)), at: now })
          }
          result.sent += 1
        } else if (unknown.has(key)) {
          for (const change of entry.records) acks.push({ id: change.id, heard: entry.heard, replyIds: [], gone: true, at: now })
          result.gone += 1
        } else result.left += 1
      }
      // The bound reached mid-look: the requests still to go carry no replies, and a note that owed
      // only replies is left out.
      if (withReplies && paused(ports.legacy?.get(shareId)) && start < entries.length) {
        withReplies = false
        entries = [...entries.slice(0, start), ...owed(entries.slice(start).map((entry) => entry.records))]
      }
    }
    if (failed) result.failed.push(shareId)
    if (paused(ports.legacy?.get(shareId))) result.outdated.push(shareId)
    if (acks.length > 0) await ports.changes.markReaderHeard(acks)
  }
  return result
}
