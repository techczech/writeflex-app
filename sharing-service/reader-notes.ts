// What a reader sends: a note or a proposed edit on quoted words, checked. Pure; no storage, no
// Workers runtime.
//
// Two reader routes, both POST with a JSON body (index.ts). Neither acts on GET: the author's HTML
// is not sanitised and can make same-origin GET requests (an <img src>), so a GET to any of these
// paths gets the "turned off" page and changes nothing.
//   POST /s/<id>/notes        {reader, note}   201 {note, already:false}; 200 {note, already:true}
//   POST /s/<id>/notes/mine   {reader}         200 {notes}: this reader's own notes, nobody else's,
//                                              each with the author's outcome and replies
//
// The reader. A reader has no account. The page makes a secret in the browser the first time (32
// random bytes, base64url, kept in localStorage for this share only) and sends it with every
// request. The service keeps only a digest of it bound to the share (`readerKey`), and every note
// is stored under that digest. `/notes/mine` returns the notes stored under the digest of the
// secret sent, so a reader can obtain only notes made with their own secret. The typed name is
// never an identity: two readers may type the same name, and a name is shown only with the notes
// of the reader who typed it. No reader route returns another reader's note, name or digest, and
// every refusal reads the same whoever else has written.
//
// The text. Names, notes and proposed edits are plain text, limited in size, and the page shows
// them as text (textContent), never as markup. Names are one line. Control characters other than
// line breaks and tabs, and the characters that reorder text on screen (bidi overrides and
// isolates), are removed from note text, so what the author reads is what the reader saw.
//
// The anchor is the export's (reader-notes-runtime.js): the quoted words, up to 200 characters
// either side as context, offsets in the block, and the block as a hint only (its id, or its
// position among the page's blocks), as block ids shift when the piece is edited.
// The offsets count the block's text with runs of white space made one space, as the quote does,
// so when both are given they span exactly the quote: an anchor whose offsets cover more or fewer
// characters than its quote describes two different ranges and is refused.
//
// The reader's network. A reader can make a new secret at will, so limits per reader alone hold
// back nobody who means harm. Each share also counts notes and new readers per network address
// (Cloudflare's CF-Connecting-IP; an IPv6 address is counted by its /64, the block one household
// or one device is given). The address is never stored: the share keeps only an HMAC of it under
// a random key of its own made for each hour, counts a sliding 60 minutes across this hour's key
// and the last's, and deletes a key and its counts when the hour after theirs ends, so nothing
// about a network is kept more than two hours (shared-piece.ts).

import type { NoteOutcome, ReplyView } from './note-outcomes.ts'

export const NOTE_LIMITS = {
  /** One request's JSON, in bytes. */
  requestBytes: 32 * 1024,
  nameChars: 60,
  noteChars: 4000,
  editChars: 4000,
  quoteChars: 1000,
  contextChars: 200,
  blockHintChars: 128,
  /** Notes one reader may send to one share in any hour. */
  readerPerHour: 30,
  /** Notes from one reader the author has not collected yet. */
  readerWaiting: 100,
  /** Notes one reader may keep on one share at all. */
  readerTotal: 300,
  /** Notes all readers together may send to one share in any hour. */
  sharePerHour: 200,
  /** Notes on one share the author has not collected yet. */
  shareWaiting: 1000,
  /** Notes one share may keep at all. */
  shareTotal: 5000,
  /** Notes the whole service accepts in any hour, across every share. */
  servicePerHour: 2000,
  /**
   * Notes one network address may send to one share in any 60 minutes, whoever the readers are. A
   * class of 30 behind one school address can send four notes each; one address alone cannot fill
   * a share's hour (200).
   */
  networkPerHour: 120,
  /** Readers new to a share whose first note may come from one network address in any 60 minutes. */
  networkNewReadersPerHour: 40,
  /** Notes the author collects in one request. */
  collectBatch: 200,
  /**
   * Raise the limit for this link (the Limits panel): the share's own limits (per hour,
   * waiting, kept) times this at most, doubled each time the author raises them (1, 2, 4). The
   * limits per reader, per network and for the whole service never move.
   */
  shareRaiseMost: 4,
} as const

const READER_SECRET = /^[A-Za-z0-9_-]{43}$/
const NOTE_ID = /^[A-Za-z0-9_-]{8,64}$/
const BLOCK_HINT = /^[A-Za-z0-9_:.-]{1,128}$/
/** Not allowed in a name: control characters, invisible formatting, bidi controls, line separators. */
const NOT_A_NAME = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/
/** Removed from note text: control characters except tab and line feed, and every bidi control. */
const STRIP_FROM_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\ufff9-\ufffb]/g

export type NoteKind = 'note' | 'edit'

export interface NoteAnchor {
  /** The selected words, spaces collapsed. */
  quote: string
  /** Up to 200 characters of the block before the words, and after them. */
  before: string
  after: string
  /** Where the words were: the block's id (`id:<id>`) or position (`n:<index>`). A hint only. */
  block: string | null
  /** Offsets of the words in the block's text; a hint only. */
  start: number | null
  end: number | null
}

export interface PostedNote {
  id: string
  kind: NoteKind
  name: string
  /** A note's text, or a proposed edit's replacement for the quoted words. */
  text: string
  anchor: NoteAnchor
  /** When the reader wrote it (ms since 1970), as the reader's clock says; null when not given. */
  writtenAt: number | null
  /** The published revision the reader was reading; null when not given. */
  revision: number | null
}

/** What a reader gets back about one of their own notes. */
export interface ReaderNoteView {
  id: string
  kind: NoteKind
  name: string
  text: string
  anchor: NoteAnchor
  writtenAt: number | null
  receivedAt: number
  /** Open until the author decides; then the outcome (note-outcomes.ts). */
  status: 'open' | NoteOutcome
  /** When the author decided; null while open. */
  outcomeAt: number | null
  /** The author's replies, oldest first. */
  replies: ReplyView[]
}

export class NoteProtocolError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'NoteProtocolError'
    this.code = code
  }
}

function fail(message: string): never {
  throw new NoteProtocolError('invalid_note', message)
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${what} must be a JSON object.`)
  return value as Record<string, unknown>
}

/** Plain text: line endings made \n, controls and bidi characters removed, ends trimmed. */
export function cleanText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n').replace(STRIP_FROM_TEXT, '').trim()
}

function text(value: unknown, max: number, what: string, { allowEmpty = false, oneLine = false } = {}): string {
  if (typeof value !== 'string') fail(`${what} must be text.`)
  // Measured before cleaning as well, so an oversize body is refused without being worked on.
  if (value.length > max * 2) fail(`${what} is longer than ${max} characters.`)
  const cleaned = oneLine ? cleanText(value).replace(/\s+/g, ' ') : cleanText(value)
  if (!allowEmpty && cleaned.length === 0) fail(`${what} is empty.`)
  if (cleaned.length > max) fail(`${what} is longer than ${max} characters.`)
  return cleaned
}

function offset(value: unknown, what: string): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000_000) fail(`${what} must be a whole number.`)
  return value as number
}

/** The reader's secret, checked. Throws NoteProtocolError. */
export function parseReaderSecret(value: unknown): string {
  if (typeof value !== 'string' || !READER_SECRET.test(value)) fail('reader must be the secret this browser made.')
  return value
}

/** A digest of the reader's secret, bound to the share: what the service stores, never the secret. */
export async function readerKeyOf(shareId: string, secret: string): Promise<string> {
  const bytes = new TextEncoder().encode(`writeflex-reader\u0000${shareId}\u0000${secret}`)
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A reader's name, checked: one line of plain text. */
export function parseName(value: unknown): string {
  if (typeof value !== 'string') fail('name must be text.')
  const name = value.trim()
  if (name.length === 0) fail('name is empty.')
  if (name.length > NOTE_LIMITS.nameChars) fail(`name is longer than ${NOTE_LIMITS.nameChars} characters.`)
  if (NOT_A_NAME.test(name)) fail('name must be one line of plain text.')
  return name
}

export function parseAnchor(value: unknown): NoteAnchor {
  const a = record(value, 'anchor')
  const quote = text(a.quote, NOTE_LIMITS.quoteChars, 'anchor quote', { oneLine: true })
  const before = a.before === undefined || a.before === null ? '' : text(a.before, NOTE_LIMITS.contextChars, 'anchor before', { allowEmpty: true, oneLine: true })
  const after = a.after === undefined || a.after === null ? '' : text(a.after, NOTE_LIMITS.contextChars, 'anchor after', { allowEmpty: true, oneLine: true })
  let block: string | null = null
  if (a.block !== undefined && a.block !== null) {
    if (typeof a.block !== 'string' || !BLOCK_HINT.test(a.block)) fail('anchor block must be a block id or position.')
    block = a.block
  }
  const start = offset(a.start, 'anchor start')
  const end = offset(a.end, 'anchor end')
  if (start !== null && end !== null && end < start) fail('anchor end comes before its start.')
  if (start !== null && end !== null && end - start !== quote.length) fail('anchor offsets do not span the quoted words.')
  return { quote, before, after, block, start, end }
}

/** The note in a `POST /s/<id>/notes` body, checked. Throws NoteProtocolError. */
export function parsePostedNote(value: unknown): PostedNote {
  const n = record(value, 'note')
  if (typeof n.id !== 'string' || !NOTE_ID.test(n.id)) fail('note id must be 8 to 64 letters, digits, - or _.')
  if (n.kind !== 'note' && n.kind !== 'edit') fail('note kind must be "note" or "edit".')
  const kind = n.kind
  const name = parseName(n.name)
  const anchor = parseAnchor(n.anchor)
  const body = kind === 'note'
    ? text(n.text, NOTE_LIMITS.noteChars, 'note text')
    // A proposed edit may replace the words with nothing (a cut), but must change them.
    : text(n.text, NOTE_LIMITS.editChars, 'proposed edit', { allowEmpty: true })
  if (kind === 'edit' && body.replace(/\s+/g, ' ') === anchor.quote) fail('proposed edit does not change the words.')
  let writtenAt: number | null = null
  if (n.writtenAt !== undefined && n.writtenAt !== null) {
    if (!Number.isSafeInteger(n.writtenAt) || (n.writtenAt as number) <= 0 || (n.writtenAt as number) > 8.64e15) fail('writtenAt must be a time in milliseconds.')
    writtenAt = n.writtenAt as number
  }
  let revision: number | null = null
  if (n.revision !== undefined && n.revision !== null) {
    if (!Number.isSafeInteger(n.revision) || (n.revision as number) < 1) fail('revision must be a whole number from 1.')
    revision = n.revision as number
  }
  return { id: n.id, kind, name, text: body, anchor, writtenAt, revision }
}

/** A reader request's body: the secret, and the note when one is sent. */
export function parseReaderRequest(bytes: Uint8Array, withNote: boolean): { secret: string; note: PostedNote | null } {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    fail('The body is not JSON.')
  }
  const body = record(value, 'The body')
  const secret = parseReaderSecret(body.reader)
  return { secret, note: withNote ? parsePostedNote(body.note) : null }
}

/**
 * The network a request came from, as the share counts it: an IPv4 address as it is, an IPv6
 * address by its first 64 bits, and anything else (no header, as in local tests) as `unknown`,
 * which is one network like any other. Never stored; shared-piece.ts keeps only an HMAC of it.
 */
export function networkOf(header: string | null): string {
  const value = (header ?? '').trim().toLowerCase()
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return value
  if (value.length > 64 || !/^[0-9a-f:.]+$/.test(value) || !value.includes(':')) return 'unknown'
  const halves = value.split('::')
  if (halves.length > 2) return 'unknown'
  const groups = (part: string) => (part ? part.split(':') : [])
  const head = groups(halves[0])
  const tail = halves.length === 2 ? groups(halves[1]) : []
  // An IPv4 tail (::ffff:1.2.3.4) is two groups; only the first four groups matter here.
  const width = (list: string[]) => list.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0)
  const missing = 8 - width(head) - width(tail)
  if (halves.length === 1 ? missing !== 0 : missing < 1) return 'unknown'
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  const first = all.slice(0, 4)
  if (first.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return 'unknown'
  return `${first.map((g) => g.padStart(4, '0')).join(':')}::/64`
}

/** The one thing a reader is told when a limit refuses a note, whichever limit it was. */
export const NOTES_REFUSED_MESSAGE = 'The author is not receiving more comments on this link for now.'
export const COMMENTS_OFF_MESSAGE = 'Comments are off for this link.'

/** Why a note was refused, as counted for the author: what is refused is counted and shown. */
export type RefusalReason = 'reader_rate' | 'reader_waiting' | 'reader_total' | 'network_rate' | 'network_readers' | 'share_rate' | 'share_waiting' | 'share_total' | 'service_rate' | 'comments_off'
export const REFUSAL_REASONS: readonly RefusalReason[] = ['reader_rate', 'reader_waiting', 'reader_total', 'network_rate', 'network_readers', 'share_rate', 'share_waiting', 'share_total', 'service_rate', 'comments_off']
