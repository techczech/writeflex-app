// Readers' notes and proposed edits into the review ledger (0.24 ticket 07; spec docs/plans/
// spec-writeflex-sharing-and-reader-notes-2026-10-14.md sections 4.4, 5 rules 1, 7, 9, 10, 6.1 rows
// "Note arrives…" to "Limits reached").
//
// ONE DOOR. Every note enters through `ChangeStore.addOutside`, the door changes from outside the app
// already use, with source `reader` (shared/outside-source.ts), the same limits (in all, per source,
// in bytes) and the same de-duplication by request id. The request id is `reader-<share>-<note key>`,
// so a note read twice, by two app windows or after a restart, is held once.
//
// NOTHING HERE WRITES TO A PIECE. A note becomes a ledger record; the piece is read (document-only,
// guarded) to find where the note belongs, and is changed only when the writer presses Accept on a
// proposed edit, through the existing accept path (agent.ts, the ledger door: the record's text at its
// one place in the file as read, written with saveFileOverRead).
//
// COLLECTED ONCE. A note is marked collected on the service only after the ledger holds it (added, or
// already there). A note the ledger has no room for, or refuses outright (dropped), is left on the
// service and asked for again on the next look. A link with a document that cannot be read just now is
// skipped for the look. A note the service still lists because marking failed is a repeat in the ledger. The
// collector runs only in the window that owns the Collection (the owner lock), so two windows, or two
// Macs on one synced Collection, never both add it; a Mac that reads after another marked a note
// collected is not given it.
//
// THE READER'S TEXT IS TEXT. Every field from the service is checked for type and size here, again,
// and kept as a string; nothing of it is read as a path, a pattern or markup.
//
// No Electron import.
import type { Change, NewChange } from '../engine'
import { isRefusedOutsideChange, readerNoteOf } from './outside-change-fields'
import { bornClosed, type ChangeStore, type OutsideBatchResult } from './changes'
import { anchorReaderNote, uniqueSpan } from './reader-note-anchor'
import { MAX_CHANGES_PER_REQUEST, MAX_UNDECIDED_OUTSIDE_BYTES, MAX_UNDECIDED_OUTSIDE_CHANGES, MAX_UNDECIDED_PER_SOURCE } from './cli/review-format'
import type { ServiceAnswer } from './sharing-client'
import { documentOnlyView } from './document-only-workspace'
import { readDocumentGuarded } from './guarded-document-read'
import type { Workspace } from './workspace'
import type { OutsideChangeFields, ReaderNoteFields } from '../shared/outside-source'
import type { LimitKind, LimitReached } from '../shared/sharing-notes'
import { NOTE_LIMITS } from '../../sharing-service/reader-notes.ts'

/** A note as the service hands it to the author (`GET /shares/<id>/notes`). Unchecked. */
export type OwnerNote = {
  key: string; id: string; kind: 'note' | 'edit'; name: string; text: string
  anchor: { quote: string; before: string; after: string; block: string | null; start: number | null; end: number | null }
  writtenAt: number | null; receivedAt: number
}
export type NotesRefused = { total: number; byReason: Record<string, number>; more: string[]; lastAt: number | null }
export type NotesAnswer = { notes: unknown[]; more: boolean; refused: unknown; limits?: unknown }
/** The share's own limits on the service now (build 5): the defaults times `factor`, which is at most `most`. */
export type ShareNoteLimits = { factor: number; most: number; perHour: number; waiting: number; total: number }

/** One link the collector asks: where it is and its owner token (never leaves main). */
export type ReaderLinkSource = {
  shareId: string
  /** The link as cards name it: its name, or its settings and the date it was made. */
  label: string
  /** The documents its notes may be on: the piece, or a Folio's parts in running order. */
  paths: string[]
  /** A Folio link: each part's key (ShareRecord.partKeys, path → key), which starts every id in the
   *  part, so a note's block hint `id:<key>-…` names the part it was written on. */
  partKeys?: Readonly<Record<string, string>>
  base: string
  owner: string
}

export interface ReaderNotesPorts {
  fetchNotes(base: string, shareId: string, owner: string): Promise<ServiceAnswer<NotesAnswer>>
  markCollected(base: string, shareId: string, owner: string, keys: string[]): Promise<ServiceAnswer<unknown>>
  /** The document as it stands on disk, read guarded and document-only; null when it cannot be read. */
  readDocument(path: string): Promise<string | null>
  /** `boundReaderClosed`: absent, closed records are not bounded here (tests of other rules). */
  changes: Pick<ChangeStore, 'addOutside'> & Partial<Pick<ChangeStore, 'boundReaderClosed'>>
  now(): number
}

export type CollectOutcome = {
  added: number
  repeats: number
  /** Notes left on the service because the review list had no room for them. */
  full: number
  /** Notes left on the service because the ledger refused the request outright (too many changes in one
   *  request; never too many closed records, see LEDGER_LIMITS): never marked collected, asked for again next look. */
  dropped: number
  /** Links skipped this look: the service did not answer, or a document of the link could not be read. */
  failed: string[]
  /** What each link's service refused from readers (limits). */
  refused: Record<string, NotesRefused>
  /** Each link's own limits on the service; null from a service older than build 5. */
  limits: Record<string, ShareNoteLimits | null>
}

/** The reader's fields, as the service limits them (sharing-service/reader-notes.ts NOTE_LIMITS). */
const LIMITS = { name: 60, text: 4000, quote: 1000, context: 200, key: 100 }
const SUMMARY_CHARS = 200

const str = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length <= max ? value : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null)

/** A note from the service, checked; null when anything is not what the service promises. */
export function checkedNote(value: unknown): OwnerNote | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const anchor = v.anchor as Record<string, unknown> | null | undefined
  const key = str(v.key, LIMITS.key)
  const id = str(v.id, LIMITS.key)
  const name = str(v.name, LIMITS.name)
  const text = str(v.text, LIMITS.text)
  if (!key || !/^[A-Za-z0-9_.-]+$/.test(key) || id === null || name === null || text === null) return null
  if (v.kind !== 'note' && v.kind !== 'edit') return null
  if (!anchor || typeof anchor !== 'object') return null
  const quote = str(anchor.quote, LIMITS.quote)
  const before = str(anchor.before ?? '', LIMITS.context)
  const after = str(anchor.after ?? '', LIMITS.context)
  if (!quote || before === null || after === null) return null
  return {
    key, id, kind: v.kind, name: name.trim() || 'A reader', text,
    anchor: { quote, before, after, block: str(anchor.block, 200), start: num(anchor.start), end: num(anchor.end) },
    writtenAt: num(v.writtenAt), receivedAt: num(v.receivedAt) ?? 0,
  }
}

export function checkedRefused(value: unknown): NotesRefused {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const byReason: Record<string, number> = {}
  if (v.byReason && typeof v.byReason === 'object') {
    for (const [reason, count] of Object.entries(v.byReason as Record<string, unknown>).slice(0, 20)) {
      if (/^[a-z_]{1,40}$/.test(reason) && Number.isSafeInteger(count) && (count as number) >= 0) byReason[reason] = count as number
    }
  }
  const total = Number.isSafeInteger(v.total) && (v.total as number) >= 0 ? v.total as number : Object.values(byReason).reduce((a, b) => a + b, 0)
  const more = Array.isArray(v.more) ? v.more.filter((r): r is string => typeof r === 'string' && /^[a-z_]{1,40}$/.test(r)).slice(0, 20) : []
  return { total, byReason, more, lastAt: num(v.lastAt) }
}

/** The share's limits as the service states them; null when absent (a service older than build 5) or not what it promises. */
export function checkedLimits(value: unknown): ShareNoteLimits | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const whole = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 1
  if (!whole(v.factor) || !whole(v.most) || !whole(v.perHour) || !whole(v.waiting) || !whole(v.total) || v.factor > v.most) return null
  return { factor: v.factor, most: v.most, perHour: v.perHour, waiting: v.waiting, total: v.total }
}

const LIMIT_KIND: Record<string, LimitKind> = {
  share_rate: 'share_rate', share_waiting: 'share_waiting', share_total: 'share_total',
  reader_rate: 'reader', reader_waiting: 'reader', reader_total: 'reader',
  network_rate: 'network', network_readers: 'network', service_rate: 'service',
}

/**
 * The Limits panel for one link (spec 6.1 "Limits reached"), or null: the notes the service refused
 * under a limit since the writer last acted on the panel (`seen`). Refused because comments are off is
 * no limit and never counts. The limit named is the one most of them ran into; a link's own limit
 * carries its figure. Raise is offered while the service's most is not reached (a service of build 5).
 */
export function limitReachedOf(refused: NotesRefused | null, seen: Readonly<Record<string, number>>, limits: ShareNoteLimits | null | undefined): LimitReached | null {
  if (!refused) return null
  const byKind = new Map<LimitKind, number>()
  let total = 0
  let more = false
  for (const [reason, count] of Object.entries(refused.byReason)) {
    const kind = LIMIT_KIND[reason]
    if (!kind) continue
    const since = Math.max(0, count - (seen[reason] ?? 0))
    if (since === 0) continue
    total += since
    if (refused.more.includes(reason)) more = true
    byKind.set(kind, (byKind.get(kind) ?? 0) + since)
  }
  if (total === 0) return null
  const order: LimitKind[] = ['share_rate', 'share_waiting', 'share_total', 'reader', 'network', 'service']
  const kind = order.reduce((best, next) => ((byKind.get(next) ?? 0) > (byKind.get(best) ?? 0) ? next : best), order.find((k) => byKind.has(k))!)
  const own = limits ?? { factor: 1, most: 1, perHour: NOTE_LIMITS.sharePerHour, waiting: NOTE_LIMITS.shareWaiting, total: NOTE_LIMITS.shareTotal }
  const figure = kind === 'share_rate' ? own.perHour : kind === 'share_waiting' ? own.waiting : kind === 'share_total' ? own.total : null
  return { refused: total, more, kind, figure, raisable: !!limits && limits.factor < limits.most }
}

export const readerRequestId = (shareId: string, key: string): string => `reader-${shareId}-${key}`

const quoteShown = (text: string): string => (text.length > 80 ? `“${text.slice(0, 80)}…”` : `“${text}”`)

/** Why a proposed edit cannot be accepted as it stands, in the writer's words. */
export const READER_EDIT_CHANGED = (name: string): string => `You changed these words after ${name} sent this, so the edit could not be applied. Their wording is kept here.`
export const READER_EDIT_GONE = (name: string, quote: string): string => `The words ${quoteShown(quote)} are no longer in the piece, so ${name}'s edit could not be applied. Their wording is kept here.`
export const READER_EDIT_AMBIGUOUS = (name: string, quote: string): string => `The words ${quoteShown(quote)} stand in more than one place, so ${name}'s edit could not be applied. Their wording is kept here.`

export const READER_EDIT_FORMATTED = (name: string): string => `The words ${name} edited carry formatting in the piece (emphasis, a link), so the edit could not be applied as plain words. Their wording is kept here.`
/** The words stand where the reader saw them, but the passage around them is repeated word for word, so no one place can be named. */
export const READER_EDIT_REPEATED_PASSAGE = (name: string, quote: string): string => `The words ${quoteShown(quote)} are in the piece, but the passage around them is repeated word for word elsewhere, so ${name}'s edit could not be applied in one place. Their wording is kept here.`
/** A replacement over more than one line would add paragraphs or list items in the middle of a line. */
export const READER_EDIT_MULTILINE = (name: string): string => `${name}'s edit spans more than one line, so it could not be applied as a change to these words. Their wording is kept here.`

/** A reader's replacement text that would break the line it lands in (line feed, carriage return, or a Unicode line or paragraph separator). */
const LINE_BREAK = /[\r\n\u2028\u2029]/

type Placed = { path: string; content: string; anchor: ReturnType<typeof anchorReaderNote>; ambiguous: boolean }

/** A Folio part's key named by a block hint `id:<key>-…` (sharing-folio.ts: every id in a part starts with its key). */
const PART_HINT = /^id:([a-z][a-z0-9]{5})-/

/**
 * The best place for a note among the link's documents: words as written first, then the nearest
 * match. On a Folio link the part the block hint names is tried first at each step (the hint decides
 * between parts, never over the words: a part where the words stand as written wins over the hinted
 * part where they changed). Words as written in more than one part, none of them hinted, are flagged
 * ambiguous, as a tie within one document is.
 */
function place(note: OwnerNote, documents: Array<{ path: string; content: string }>, partKeys?: Readonly<Record<string, string>>): Placed | null {
  const hintKey = note.anchor.block ? PART_HINT.exec(note.anchor.block)?.[1] ?? null : null
  const hinted = hintKey && partKeys ? Object.entries(partKeys).find(([, key]) => key === hintKey)?.[0] ?? null : null
  const ordered = hinted ? [...documents.filter((doc) => doc.path === hinted), ...documents.filter((doc) => doc.path !== hinted)] : documents
  const anchored = ordered.map((doc) => ({ ...doc, anchor: anchorReaderNote(doc.content, note.anchor) }))
  const unchanged = anchored.filter((doc) => doc.anchor.state === 'unchanged')
  if (unchanged.length > 0) {
    const first = unchanged[0]
    const tiedInPart = first.anchor.state === 'unchanged' && first.anchor.ambiguous
    const byHint = hinted !== null && first.path === hinted
    return { ...first, ambiguous: tiedInPart || (!byHint && unchanged.length > 1) }
  }
  const changed = anchored.find((doc) => doc.anchor.state === 'changed')
  return changed ? { ...changed, ambiguous: false } : null
}

/** The ledger record a note becomes. Never a write: a record only. */
export function readerChangeFor(note: OwnerNote, link: Pick<ReaderLinkSource, 'shareId' | 'label' | 'paths' | 'partKeys'>, documents: Array<{ path: string; content: string }>, nowMs: number): NewChange {
  const at = Math.min(note.writtenAt ?? note.receivedAt ?? nowMs, nowMs) || nowMs
  const placed = place(note, documents, link.partKeys)
  const state = placed?.anchor.state ?? 'gone'
  const ambiguous = placed?.anchor.state === 'unchanged' && placed.ambiguous
  const span = placed && placed.anchor.state !== 'gone' ? uniqueSpan(placed.content, placed.anchor.from, placed.anchor.to) : null
  const fields: ReaderNoteFields = {
    shareId: link.shareId, key: note.key, link: link.label, name: note.name, kind: note.kind, text: note.text, quote: note.anchor.quote,
    anchored: state, ...(ambiguous ? { ambiguous: true as const } : {}), at,
    // The words in the piece it was placed beside, as they stood when collected: a closed edit has no
    // text of its own, so the margin finds its place by these (never applied, never a write).
    ...(span && placed ? { words: placed.content.slice(span.from, span.to) } : {}),
  }
  const requestId = readerRequestId(link.shareId, note.key)
  const stamp: Pick<NewChange, 'provenance' | 'isCorrection' | 'author' | 'ts'> & OutsideChangeFields = {
    provenance: 'agent', isCorrection: false, author: { name: note.name }, ts: nowMs,
    outsideSource: 'reader', outsideRequest: { id: requestId, index: 1, count: 1, at }, readerNote: fields,
  }
  const path = placed?.path ?? link.paths[0] ?? ''
  const summary = (note.text.replace(/\s+/g, ' ').trim() || note.anchor.quote).slice(0, SUMMARY_CHARS)

  if (note.kind === 'note') {
    // A note changes nothing: old and new text are the same words. Where they cannot be found it is
    // listed without an anchor (its quoted words do not stand in the piece).
    const words = span && placed ? placed.content.slice(span.from, span.to) : note.anchor.quote
    return { path, editClass: 'content', category: 'other', summary, oldText: words, newText: words, ...(span ? { anchor: span } : {}), ...stamp } as NewChange
  }
  // The words as they stand in the file must be exactly the words the reader saw: a replacement over
  // Markdown markers would leave half a marker behind.
  const plain = placed?.anchor.state === 'unchanged' && placed.content.slice(placed.anchor.from, placed.anchor.to).replace(/\s+/g, ' ') === note.anchor.quote.replace(/\s+/g, ' ').trim()
  const multiline = LINE_BREAK.test(note.text)
  if (placed && placed.anchor.state === 'unchanged' && !ambiguous && span && plain && !multiline) {
    const { from, to } = placed.anchor
    const content = placed.content
    return {
      path, editClass: 'content', category: 'other', summary,
      oldText: content.slice(span.from, span.to),
      newText: content.slice(span.from, from) + note.text + content.slice(to, span.to),
      anchor: span, ...stamp,
    } as NewChange
  }
  // Cannot be accepted as it stands: closed with the reason, the reader's wording kept where no accept reads it.
  const repeatedPassage = state === 'unchanged' && !ambiguous && plain && !span
  const reason = multiline ? READER_EDIT_MULTILINE(note.name)
    : state === 'changed' ? READER_EDIT_CHANGED(note.name)
    : state === 'unchanged' && !ambiguous && !plain ? READER_EDIT_FORMATTED(note.name)
    : ambiguous ? READER_EDIT_AMBIGUOUS(note.name, note.anchor.quote)
    : repeatedPassage ? READER_EDIT_REPEATED_PASSAGE(note.name, note.anchor.quote)
    : READER_EDIT_GONE(note.name, note.anchor.quote)
  const code = multiline ? 'other' as const : ambiguous || repeatedPassage ? 'target-repeated' as const : state === 'unchanged' ? 'other' as const : 'target-gone' as const
  const record: NewChange & OutsideChangeFields = {
    path, editClass: 'content', category: 'other', summary, oldText: '', newText: '',
    ...(span ? { anchor: span } : {}), ...stamp, outsideRefused: true,
    outsideIntended: { oldText: note.anchor.quote, newText: note.text, cut: false },
  }
  return bornClosed(record, reason, code, nowMs)
}

/**
 * The readers' records in a Collection's review list, for the Sharing page's counts and Clear handled
 * notes (ticket 07): each one's link, its note key on the service, and whether it is decided (Done,
 * accepted, declined, or closed because it could not be applied). Undecided: pending or held.
 */
export function readerNoteRecords(changes: readonly Change[]): Array<{ shareId: string; key: string; settled: boolean }> {
  return changes.flatMap((change) => {
    const fields = readerNoteOf(change)
    if (!fields || typeof fields.key !== 'string') return []
    return [{ shareId: fields.shareId, key: fields.key, settled: change.status !== 'pending' && change.status !== 'held' }]
  })
}

/** The production `readDocument`: a document the sidebar would show, read guarded (no link followed); null otherwise. */
export function guardedDocumentReader(ws: Workspace): (path: string) => Promise<string | null> {
  const view = documentOnlyView(ws).workspace
  return async (path) => {
    try { return (await readDocumentGuarded(view, path)).content } catch { return null }
  }
}

/**
 * The ledger's limits for readers' notes. A reader's closed record (an edit that cannot be applied) is
 * filed whatever the limit on closed records from outside (ticket 11, review 07 P3-A): the service
 * hands the author only its oldest 200 notes not yet collected and has no later page, so a note left
 * there because the ledger refused it would stand at the head of the link's notes and keep every later
 * note from arriving. What a link can send is bounded by the service (spec 5 rule 10: per hour, waiting,
 * kept), and each note is filed once. Clear handled notes frees the service's room while the ledger
 * keeps the records, so the ledger bounds them itself after filing (READER_CLOSED_KEPT).
 */
const LEDGER_LIMITS = {
  maxUndecided: MAX_UNDECIDED_OUTSIDE_CHANGES, maxUndecidedBytes: MAX_UNDECIDED_OUTSIDE_BYTES, maxRefused: Number.POSITIVE_INFINITY,
  maxPerSource: MAX_UNDECIDED_PER_SOURCE, maxPerRequest: MAX_CHANGES_PER_REQUEST,
}

/**
 * Closed reader records the ledger keeps per link (review round 1 of ticket 11, F1): past this, the
 * oldest whose note the service no longer holds are dropped (`ChangeStore.boundReaderClosed`). Those it
 * still holds are kept whatever their number; the service's own limits bound them.
 */
export const READER_CLOSED_KEPT = 2000

/** One look at every link: notes in, then marked collected. Throws only what the ledger throws (then nothing is marked). */
export async function collectReaderNotes(ports: ReaderNotesPorts, links: readonly ReaderLinkSource[]): Promise<CollectOutcome> {
  const outcome: CollectOutcome = { added: 0, repeats: 0, full: 0, dropped: 0, failed: [], refused: {}, limits: {} }
  for (const link of links) {
    const answer = await ports.fetchNotes(link.base, link.shareId, link.owner).catch(() => ({ kind: 'unreachable' as const }))
    if (answer.kind !== 'ok') { outcome.failed.push(link.shareId); continue }
    outcome.refused[link.shareId] = checkedRefused(answer.body.refused)
    // Absent limits: a service older than build 5 (null). Present but not what the service promises:
    // nothing is said, so the limits last known stand.
    const limits = checkedLimits(answer.body.limits)
    if (limits !== null || answer.body.limits === undefined || answer.body.limits === null) outcome.limits[link.shareId] = limits
    const notes = (Array.isArray(answer.body.notes) ? answer.body.notes : []).map(checkedNote).filter((note): note is OwnerNote => note !== null)
    if (notes.length === 0) continue
    // Every document of the link must be read before any note is placed: a note is "gone" only against
    // documents actually read. One that cannot be read just now (an iCloud placeholder, a lock) skips
    // the link for this look; nothing is filed or marked collected, and the next look asks again.
    const documents: Array<{ path: string; content: string }> = []
    for (const path of link.paths) {
      const content = await ports.readDocument(path).catch(() => null)
      if (content === null) break
      documents.push({ path, content })
    }
    if (link.paths.length === 0 || documents.length < link.paths.length) { outcome.failed.push(link.shareId); continue }
    const nowMs = ports.now()
    const entries = notes.map((note) => ({ requestId: readerRequestId(link.shareId, note.key), changes: [readerChangeFor(note, link, documents, nowMs)] }))
    const results: OutsideBatchResult[] = await ports.changes.addOutside(entries, LEDGER_LIMITS)
    const byRequest = new Map(results.map((result) => [result.requestId, result.outcome]))
    // A closed record filed: the link's closed records kept within READER_CLOSED_KEPT.
    if (results.some((result) => result.outcome === 'added' && result.changes.some(isRefusedOutsideChange))) await ports.changes.boundReaderClosed?.(link.shareId, READER_CLOSED_KEPT)
    const kept: string[] = []
    for (const note of notes) {
      const result = byRequest.get(readerRequestId(link.shareId, note.key))
      if (result === 'added') { outcome.added += 1; kept.push(note.key) }
      else if (result === 'repeat') { outcome.repeats += 1; kept.push(note.key) }
      else if (result === 'dropped') outcome.dropped += 1
      else outcome.full += 1
    }
    if (kept.length > 0) await ports.markCollected(link.base, link.shareId, link.owner, kept).catch(() => null)
  }
  return outcome
}
