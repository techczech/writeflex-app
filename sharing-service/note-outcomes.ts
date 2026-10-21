// Hearing back: what
// the author's app sends about a reader's note or proposed edit, checked. Pure; no storage.
//
//   POST /shares/<id>/notes/outcomes   owner token   {outcomes: [{key, outcome, at, replies}]}
//     → 200 {recorded, waiting, unknown, full, replies: [{key, kept, already, full}]}
//
// `outcome` is what the author did: accepted, declined, done (a note), failed (a proposed edit that
// could not be applied), or null (still open; a decision taken back). `replies` are the author's
// replies, each with an id the app made, so a reply sent twice (an answer lost on the way, an
// offline Mac sending again) is kept once. A reply is plain text: controls and bidi characters are
// removed, as from a reader's note, and the page shows it with textContent.
//
// Who sees it: the reader whose secret wrote the note, through `POST /s/<id>/notes/mine`, which
// returns only notes stored under that reader's digest. No other reader route returns an outcome or
// a reply, so on a private share no other reader can obtain them.
import { NoteProtocolError, cleanText } from './reader-notes.ts'

export const OUTCOMES = ['accepted', 'declined', 'done', 'failed'] as const
export type NoteOutcome = (typeof OUTCOMES)[number]

export const OUTCOME_LIMITS = {
  /** One `notes/outcomes` request's JSON, in bytes. */
  requestBytes: 256 * 1024,
  /** Notes named in one request. */
  perRequest: 50,
  /** One reply, in characters (the app's reply box says "of 1,000"). */
  replyChars: 1000,
  /** Replies the author may keep on one note. */
  repliesPerNote: 20,
} as const

const REPLY_ID = /^[A-Za-z0-9_-]{8,64}$/
const NOTE_KEY = /^[0-9a-f]{24}\.[A-Za-z0-9_-]{8,64}$/

export interface PostedReply { id: string; text: string; at: number }
export interface PostedOutcome {
  key: string
  outcome: NoteOutcome | null
  /** When the author decided (ms); null with no outcome. */
  at: number | null
  replies: PostedReply[]
}

function fail(message: string): never {
  throw new NoteProtocolError('invalid_outcome', message)
}

function time(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 8.64e15) fail(`${what} must be a time in milliseconds.`)
  return value as number
}

/** A reply's text, checked and cleaned. Throws NoteProtocolError. */
export function parseReplyText(value: unknown): string {
  if (typeof value !== 'string') fail('reply text must be text.')
  if (value.length > OUTCOME_LIMITS.replyChars * 2) fail(`reply is longer than ${OUTCOME_LIMITS.replyChars} characters.`)
  const cleaned = cleanText(value)
  if (cleaned.length === 0) fail('reply is empty.')
  if (cleaned.length > OUTCOME_LIMITS.replyChars) fail(`reply is longer than ${OUTCOME_LIMITS.replyChars} characters.`)
  return cleaned
}

function parseOne(value: unknown): PostedOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('each outcome must be a JSON object.')
  const o = value as Record<string, unknown>
  if (typeof o.key !== 'string' || !NOTE_KEY.test(o.key)) fail('key must be a note key.')
  let outcome: NoteOutcome | null = null
  if (o.outcome !== null && o.outcome !== undefined) {
    if (typeof o.outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(o.outcome)) fail('outcome must be accepted, declined, done, failed or null.')
    outcome = o.outcome as NoteOutcome
  }
  const at = outcome === null ? null : time(o.at, 'at')
  const list = o.replies === undefined ? [] : o.replies
  if (!Array.isArray(list) || list.length > OUTCOME_LIMITS.repliesPerNote) fail(`replies must be a list of at most ${OUTCOME_LIMITS.repliesPerNote}.`)
  const seen = new Set<string>()
  const replies = list.map((item): PostedReply => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('each reply must be a JSON object.')
    const r = item as Record<string, unknown>
    if (typeof r.id !== 'string' || !REPLY_ID.test(r.id)) fail('reply id must be 8 to 64 letters, digits, - or _.')
    if (seen.has(r.id)) fail('a reply id is named twice.')
    seen.add(r.id)
    return { id: r.id, text: parseReplyText(r.text), at: time(r.at, 'reply at') }
  })
  return { key: o.key, outcome, at, replies }
}

/** The body of `POST /shares/<id>/notes/outcomes`, checked. Throws NoteProtocolError. */
export function parseOutcomes(value: unknown): PostedOutcome[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('The body must be a JSON object.')
  const list = (value as Record<string, unknown>).outcomes
  if (!Array.isArray(list) || list.length > OUTCOME_LIMITS.perRequest) fail(`outcomes must be a list of at most ${OUTCOME_LIMITS.perRequest}.`)
  const parsed = list.map(parseOne)
  if (new Set(parsed.map((o) => o.key)).size !== parsed.length) fail('a note is named twice.')
  return parsed
}

/** What a reader sees of the author's reply. Nothing about the author beyond the page's own "Shared by". */
export interface ReplyView { id: string; text: string; at: number }
