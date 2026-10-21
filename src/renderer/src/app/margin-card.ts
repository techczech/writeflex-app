import type { Change } from '../../../preload'
import type { ReviewActions } from './review-actions'
import { marginKind, marginSource, type MarginItem, type MarginSettledRow } from './margin-model'
import { isAddHeadingProposal } from '../../../shared/part-title-proposal'
import { tagTitle } from '../components/outside-dock-model'

/**
 * What one margin card says and does, as data. Pure: the card component draws this, and tests run its
 * actions against a fake `ReviewActions` (which is itself the one seam to the ledger).
 *
 * Anatomy (locked reader-page component sheet): Marker, Name, Role tag, Kind, Status, Quoted words,
 * Change, Actions slot, Fold control. The app fills Name, Role tag and the Actions slot.
 */

export type MarginActionId = 'accept' | 'decline' | 'reply' | 'hold' | 'accept-next' | 'to-scratchpad' | 'show' | 'no-heading' | 'copy-wording' | 'dismiss' | 'reopen'

/** What an action needs besides the review actions: the two things that are not review actions. */
export type MarginActionContext = {
  sendOriginalToScratchpad: (change: Change) => void | Promise<void>
  showInText: (id: string) => void
  /** Sets the change's part to `heading: none` (guarded) and declines the proposal. */
  keepTitleInMetadataOnly?: (change: Change) => void | Promise<void>
  /** A reader's closed edit (0.24 ticket 07): copy their wording to the clipboard, as text. */
  copyText?: (text: string) => void | Promise<void>
  /** A reader's closed edit: take it out of the margin (it stays in the ledger, closed). */
  dismiss?: (id: string) => void
  /** A reader's card (0.24 ticket 08): open the reply box inside the card. */
  openReply?: (id: string) => void
  /** A reader's card: keep the writer's reply on the note's record and send it back through its link. */
  sendReaderReply?: (id: string, text: string) => Promise<unknown>
  /** A row settled during this visit (ticket 06): the existing reopen action puts it back to waiting. */
  reopen?: (id: string) => void | Promise<void>
}

/** `key` is the key the action answers to while DOM focus is in the card (the card key table, ticket 01). */
export type MarginActionItem = { id: MarginActionId; label: string; key?: string }

/** The key each action answers to with focus in a card; ⌥⌘↵ is a chord (acts anywhere) and is shown, not handled, by the card. */
export const ACTION_KEYS: Partial<Record<MarginActionId, string>> = {
  accept: 'A', decline: 'D', reply: 'R', hold: 'H', 'accept-next': '⌥⌘↵', 'to-scratchpad': 'S', show: '↵', 'no-heading': 'N', 'copy-wording': 'C', dismiss: '⌫', reopen: 'O',
}
const keyed = (items: MarginActionItem[]): MarginActionItem[] => items.map((item) => ({ ...item, key: ACTION_KEYS[item.id] }))

/** The time at rest on the card head: "21:34" today, "Yesterday", else "13 Oct". */
export function shortWhen(ts: number, now: number = Date.now()): string {
  const at = new Date(ts)
  const today = new Date(now)
  if (today.toDateString() === at.toDateString()) return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
  const yesterday = new Date(now - 86_400_000)
  if (yesterday.toDateString() === at.toDateString()) return 'Yesterday'
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(at)
}

export type DiffSegment = { kind: 'text' | 'del' | 'ins'; text: string }

export type MarginCardDescriptor = {
  id: string
  marker: number
  name: string
  roleTag: string
  /** The tag as drawn: the role, and for an outside change its place in the request ("outside │ 2/5"). */
  roleTagText: string
  /** Hover title of the card: "From Claude Code, 14:02 today, change 2 of 5" for an outside change. */
  title: string | null
  kindLabel: 'Proposed edit' | 'Insertion' | 'Comment' | 'New file'
  /** 'Open' for a pending change, 'Held both' for a held one, 'Could not be applied' for a reader's closed edit. */
  statusLabel: 'Open' | 'Held both' | 'Could not be applied'
  when: string
  /** The time at rest ("21:34", "Yesterday"); `when` stays the full label. */
  time: string
  /** The line under the change on focus: who, the link or request, when ("Claude Code, request of 21:12, change 2 of 5."). */
  roleLine: string
  /** The two icon buttons that replace the time under the pointer (edit: Accept, Decline; note: Done, Reply; none on a closed edit). */
  hover: MarginActionItem[]
  /** Whether the card says its status at rest: never while Open, so only Held both and Could not be applied. */
  statusSpeaks: boolean
  segments: DiffSegment[]
  /** Not beside its own words (ticket 06, frame `stale`): what the status line says, the words it was written on
   *  (null when the reader's own block says them), and the notice under the change. Accept is off. */
  stale: { kind: 'changed' | 'gone'; label: 'Passage changed' | 'Could not be placed'; written: string | null; notice: string } | null
  /** An Accept was refused because the change could not be placed (ticket 14): "Could not be applied" and why,
   *  until the writer declines it or the text changes. Accept is off meanwhile. */
  refused: string | null
  /** At rest, a reader's card whose thread is folded away still says that a reply did not go (ticket 05/06):
   *  the latest unsent reply's state, in the thread's own words. Null when every reply was sent. */
  replyException: string | null
  /** What a comment says (ticket 13: "a comment shows its body"): the agent's or outside source's note on the words. A reader's note is `reader.note`. */
  body: string | null
  /** For a card that creates a file, its path. */
  newFilePath: string | null
  /** Buttons drawn on the card, in order. The last of the card's actions, More, is drawn after them. */
  primary: MarginActionItem[]
  /** Under More. */
  more: MarginActionItem[]
  /** A reader's note or proposed edit (0.24 ticket 07): the link it came through, a note's text, and the
   *  words it was written on when the passage has changed since. All of it the reader's text: drawn as text. */
  reader: {
    link: string; note: string | null; written: string | null; changed: boolean; gone: boolean
    /** The words stand in more than one place equally well: shown beside the best match, flagged. */
    ambiguous: boolean
    /** A proposed edit that could not be applied: why (the app's sentence), and the reader's wording to copy. */
    closed: { reason: string; wording: string } | null
    /** The writer's replies, oldest first (0.24 ticket 08): text, who wrote it, when, and whether the link's service holds it. */
    replies: ReaderReplyView[]
    /** The link's service no longer holds the note: its outcome and replies do not reach the reader (0.24 ticket 08). */
    noteGone: boolean
    /** Whether the card's reply box may offer Send and mark done (a note still waiting). */
    canMarkDone: boolean
  } | null
}

/**
 * Where a writer's reply stands (0.24 ticket 08): `sent`, the link's service holds it; `unsent`, not yet
 * (sent on the next look); `update`, not yet, and it waits until the sharing service is updated (the
 * service is older than this WriteFlex); `full`, refused because the note has its 20 replies; `gone`,
 * the service no longer holds the note. `full` and `gone` are final: never sent again, never shown as
 * Sent, and they win over a `sent` mark should a record somehow carry both.
 */
export type ReaderReplyState = 'sent' | 'unsent' | 'update' | 'full' | 'gone'
export type ReaderReplyView = { id: string; text: string; by: string; when: string; sent: boolean; state: ReaderReplyState
  /** The state as the thread says it (ticket 05): "Sent", "Not sent yet", the update wording, or why it was not sent. */
  stateLabel: string }

/** Not sent, and never will be: the words on a reply the link's service refused, or on one for a note it no longer holds (0.24 ticket 08). */
export const REPLY_NOT_SENT: Record<'full' | 'gone', string> = {
  full: 'Not sent: this comment has reached its 20 replies',
  gone: 'Not sent: this comment is no longer on the reader\'s page',
}

/** Whether the link's service answered that it no longer holds this reader's note (0.24 ticket 08). */
export const readerNoteGone = (change: Change): boolean => typeof change.readerGone === 'number'

/** Not sent yet, and waiting for the sharing service to be updated (0.24 ticket 08). */
export const REPLY_WAITS_FOR_UPDATE = 'Not sent yet: update the sharing service in Settings › Sharing'

/** The thread's state word for a reply (component sheet: Sent, Not sent yet, Not sent (20 replies)). */
export function replyStateLabel(state: ReaderReplyState): string {
  return state === 'sent' ? 'Sent' : state === 'unsent' ? 'Not sent yet' : state === 'update' ? REPLY_WAITS_FOR_UPDATE : REPLY_NOT_SENT[state]
}

/** What a card with replies says at rest in place of its thread (ticket 05): the count, "2 replies". The thread itself is drawn on focus only. */
export const replyCountLabel = (count: number): string => (count === 1 ? '1 reply' : `${count} replies`)

/** The writer's replies on a reader's record, as the card draws them. Text only; anything malformed is left out. */
export function readerRepliesOf(change: Change, now: number = Date.now()): ReaderReplyView[] {
  const list = Array.isArray(change.readerReplies) ? change.readerReplies : []
  const gone = readerNoteGone(change)
  return list.flatMap((reply) => {
    if (!reply || typeof reply.id !== 'string' || typeof reply.text !== 'string' || typeof reply.at !== 'number') return []
    // A final refusal wins over Sent: a reply never shows as Sent while any refusal is on it.
    // A reply sent before its note was cleared stays Sent.
    const state: ReaderReplyState = reply.notSent === 'full' ? 'full'
      : reply.notSent !== undefined ? 'gone'
        : typeof reply.sent === 'number' ? 'sent'
          : gone ? 'gone'
            : change.readerRepliesWait === true ? 'update' : 'unsent'
    return [{ id: reply.id, text: reply.text, by: typeof reply.by === 'string' && reply.by !== '' ? reply.by : 'You', when: whenLabel(reply.at, now), sent: state === 'sent', state, stateLabel: replyStateLabel(state) }]
  })
}

const CONTEXT_WORDS = 4

function tokens(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t !== '')
}

/** Word by word: the words that changed, struck and underlined, with a few unchanged words either side
 *  (all of them with `clip: false`). */
export function diffSegments(oldText: string, newText: string, options: { clip?: boolean } = {}): DiffSegment[] {
  const clip = options.clip ?? true
  if (!oldText && !newText) return []
  if (!oldText) return [{ kind: 'ins', text: newText }]
  if (!newText) return [{ kind: 'del', text: oldText }]
  const a = tokens(oldText)
  const b = tokens(newText)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1 }
  const words = (list: string[]): string[] => list.filter((t) => !/^\s+$/.test(t))
  const prefix = a.slice(0, start)
  const suffix = a.slice(endA)
  const clipPrefix = (): string => {
    const wordCount = words(prefix).length
    if (!clip || wordCount <= CONTEXT_WORDS) return prefix.join('')
    let seen = 0
    let i = prefix.length
    while (i > 0 && seen < CONTEXT_WORDS) { i -= 1; if (!/^\s+$/.test(prefix[i])) seen += 1 }
    return `…${prefix.slice(i).join('')}`
  }
  const clipSuffix = (): string => {
    const wordCount = words(suffix).length
    if (!clip || wordCount <= CONTEXT_WORDS) return suffix.join('')
    let seen = 0
    let i = 0
    while (i < suffix.length && seen < CONTEXT_WORDS) { if (!/^\s+$/.test(suffix[i])) seen += 1; i += 1 }
    return `${suffix.slice(0, i).join('')}…`
  }
  const out: DiffSegment[] = []
  const before = clipPrefix()
  if (before) out.push({ kind: 'text', text: before })
  const removed = a.slice(start, endA).join('')
  const added = b.slice(start, endB).join('')
  if (removed) out.push({ kind: 'del', text: removed })
  if (removed && added) out.push({ kind: 'text', text: ' ' })
  if (added) out.push({ kind: 'ins', text: added })
  const after = clipSuffix()
  if (after) out.push({ kind: 'text', text: after })
  return out
}

/** The most words of the sentence drawn on either side of a change; past it, an ellipsis. */
export const SENTENCE_CONTEXT_WORDS = 30
const SENTENCE_BREAK = /[.!?…]["'”’)\]]*\s+/g
const SENTENCE_END = /[.!?…]["'”’)\]]*(?=\s|$)/
const ENDS_SENTENCE = /[.!?…]["'”’)\]]*\s*$/
/** A line's Markdown block prefix (heading hashes, quote, list bullet or number, task box): not words of the sentence. */
const BLOCK_PREFIX = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)*/

function keepLastWords(text: string, max: number): string {
  const parts = text.split(/(\s+)/)
  let seen = 0
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i] && !/^\s+$/.test(parts[i])) seen += 1
    if (seen > max) return `…${parts.slice(i + 1).join('').replace(/^\s+/, '')}`
  }
  return text
}

function keepFirstWords(text: string, max: number): string {
  const parts = text.split(/(\s+)/)
  let seen = 0
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] && !/^\s+$/.test(parts[i])) seen += 1
    if (seen > max) return `${parts.slice(0, i).join('').replace(/\s+$/, '')}…`
  }
  return text
}

/**
 * Where the sentence holding `from`–`to` starts and ends, within its line (a line is a block, ADR-0039):
 * from just after the last sentence break before the words, to the first sentence end at or after them.
 * Words that already end a sentence end it there.
 */
export function sentenceAround(document: string, from: number, to: number): { start: number; end: number } {
  const lineStart = document.lastIndexOf('\n', from - 1) + 1
  const nextBreak = document.indexOf('\n', to)
  const lineEnd = nextBreak === -1 ? document.length : nextBreak
  let start = lineStart
  for (const match of document.slice(lineStart, from).matchAll(SENTENCE_BREAK)) start = lineStart + (match.index ?? 0) + match[0].length
  if (start === lineStart) start += (document.slice(lineStart, from).match(BLOCK_PREFIX)?.[0].length ?? 0)
  let end = lineEnd
  if (to > from && ENDS_SENTENCE.test(document.slice(from, to))) end = to
  else {
    const match = SENTENCE_END.exec(document.slice(to, lineEnd))
    if (match) end = to + match.index + match[0].length
  }
  return { start: Math.min(start, from), end: Math.max(end, to) }
}

function mergeText(segments: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = []
  for (const segment of segments) {
    if (!segment.text) continue
    const last = out[out.length - 1]
    if (last && last.kind === 'text' && segment.kind === 'text') last.text += segment.text
    else out.push({ ...segment })
  }
  return out
}

/**
 * The change inside its sentence (ticket 13, frames `mixed` and `focused`): the sentence's other words plain,
 * the old words struck and the new words underlined. `anchor` is where the change's words stand in
 * `document` (the old words of a proposal, the new words of an edit already made, a point for an
 * insertion); the words around it come from the document as it is. A change that spans lines (a heading
 * added above a paragraph, a list) has no one sentence, so it is drawn on its own words.
 */
export function changeInSentence(document: string, anchor: { from: number; to: number }, oldText: string, newText: string): DiffSegment[] {
  if (anchor.from < 0 || anchor.to > document.length || anchor.to < anchor.from || oldText.includes('\n') || newText.includes('\n')) return diffSegments(oldText, newText)
  const { start, end } = sentenceAround(document, anchor.from, anchor.to)
  const before = keepLastWords(document.slice(start, anchor.from), SENTENCE_CONTEXT_WORDS)
  const after = keepFirstWords(document.slice(anchor.to, end), SENTENCE_CONTEXT_WORDS)
  return mergeText([{ kind: 'text', text: before }, ...diffSegments(oldText, newText, { clip: false }), { kind: 'text', text: after }])
}

/** "Today, 11:40" for today, "13 Oct, 18:02" otherwise. */
export function whenLabel(ts: number, now: number = Date.now()): string {
  const at = new Date(ts)
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
  if (new Date(now).toDateString() === at.toDateString()) return `Today, ${time}`
  return `${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(at)}, ${time}`
}

function kindLabelOf(card: MarginItem): MarginCardDescriptor['kindLabel'] {
  const change = card.change
  if (card.kind === 'note') return 'Comment'
  if (change.newFile) return 'New file'
  return change.editClass === 'insert' || (change.oldText === '' && change.newText !== '') ? 'Insertion' : 'Proposed edit'
}

/** Who, where it came through, when: the line a focused card carries under its change. Text only. */
function roleLineOf(card: MarginItem, reader: Change['readerNote'] | null, now: number): string {
  const change = card.change
  if (reader) return `Reader ${reader.name}, through the link “${reader.link}”, ${whenLabel(reader.at, now)}.`
  if (card.source.type === 'outside') {
    const request = change.outsideRequest
    if (!request) return `${card.source.label}, ${whenLabel(change.ts, now)}. No reply goes back.`
    const at = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(request.at))
    return `${card.source.label}, request of ${at}${request.count > 1 ? `, change ${request.index} of ${request.count}` : ''}. No reply goes back.`
  }
  if (card.source.type === 'you') return 'Your recorded edit. Decline puts the original words back.'
  return `${card.source.label}, ${whenLabel(change.ts, now)}. Reply goes to the agent.`
}

/**
 * `document` is the text the card's anchor was resolved in: with it, an edit is drawn inside its sentence
 * (ticket 13); without it, on its own words with a few either side.
 */
/** What a card needs besides the item (ticket 06): the reason an Accept of it was refused, if one was. */
export type MarginCardOptions = { refused?: string | null }

/** The stale part of a card (ticket 06): status word, the words it was written on, and the notice. */
function staleOf(card: MarginItem, fromReader: Change['readerNote'] | null, canReply: boolean): MarginCardDescriptor['stale'] {
  if (!card.stale) return null
  const change = card.change
  // A reader's card carries its own Written-on block and nearest-passage notice; it only needs the status word when gone.
  const written = fromReader ? null : change.oldText.trim() ? change.oldText : null
  if (card.stale === 'changed') {
    if (fromReader) return null
    return { kind: 'changed', label: 'Passage changed', written, notice: `You changed these words after this was proposed. Nothing was applied. Decline it${canReply ? ', or Reply to send it back' : ''}.` }
  }
  const where = 'at' in card && card.at === null ? 'Shown at the top of the margin.' : 'Shown at the paragraph they were in.'
  return { kind: 'gone', label: 'Could not be placed', written, notice: `These words are no longer in the piece. ${where}` }
}

/** The latest reply that did not go, in the thread's words ("Not sent yet", "Not sent: this comment has reached its 20 replies"). */
function replyExceptionOf(replies: ReaderReplyView[]): string | null {
  for (let i = replies.length - 1; i >= 0; i -= 1) if (replies[i].state !== 'sent') return replies[i].stateLabel
  return null
}

export function describeMarginCard(card: MarginItem, marker: number, now: number = Date.now(), document?: string, options: MarginCardOptions = {}): MarginCardDescriptor {
  const change = card.change
  const note = card.kind === 'note'
  const fromReader = card.source.type === 'reader' && change.readerNote ? change.readerNote : null
  const outside = card.source.type === 'outside' || card.source.type === 'reader'
  const kindLabel = kindLabelOf(card)
  if (card.status === 'closed' && fromReader) return describeClosedReaderCard(card, marker, fromReader, kindLabel, now)
  const canReply = !outside || fromReader !== null
  const stale = staleOf(card, fromReader, canReply)
  const refused = card.kind === 'edit' && options.refused ? options.refused : null
  // Accept is off on an edit that is not beside its own words, or whose Accept was just refused: it could only refuse.
  const acceptOff = card.kind === 'edit' && (card.stale !== undefined || refused !== null)
  const primary: MarginActionItem[] = note
    ? [{ id: 'accept', label: 'Done' }]
    : acceptOff ? [{ id: 'decline', label: 'Decline' }] : [{ id: 'accept', label: 'Accept' }, { id: 'decline', label: 'Decline' }]
  // There is no Reply on an outside change: nothing carries an answer back to an outside source. A
  // reader's card is the exception (0.24 ticket 08): the reply goes back through the link it came by.
  if (canReply) primary.push({ id: 'reply', label: 'Reply' })
  const more: MarginActionItem[] = []
  // Order of the locked card More menu. A card that creates a file has no "both readings" to hold; a note
  // changes no words, so only an edit that has an original offers Send original to Scratchpad.
  if (card.kind === 'edit' && !acceptOff) more.push({ id: 'accept-next', label: 'Accept and next' })
  if (!change.newFile && card.kind === 'edit' && !acceptOff) more.push({ id: 'hold', label: 'Hold both' })
  more.push({ id: 'show', label: 'Show in text' })
  if (!change.newFile && card.kind === 'edit') more.push({ id: 'to-scratchpad', label: 'Send original to Scratchpad' })
  if (isAddHeadingProposal(change)) more.push({ id: 'no-heading', label: 'No heading in the text' })
  return {
    id: card.id,
    marker,
    name: fromReader ? fromReader.name : card.source.label,
    roleTag: card.source.type,
    roleTagText: fromReader ? 'reader' : outside && change.outsideRequest && change.outsideRequest.count > 1 ? `outside │ ${change.outsideRequest.index}/${change.outsideRequest.count}` : card.source.key === 'writeflex' ? card.source.label : card.source.type,
    title: fromReader ? `From ${fromReader.name}, through the link ${fromReader.link}` : outside ? tagTitle(card.source.label, change.outsideRequest?.at, change.outsideRequest?.index ?? 1, change.outsideRequest?.count ?? 1, now) : null,
    kindLabel,
    statusLabel: card.status === 'held' ? 'Held both' : 'Open',
    when: whenLabel(fromReader ? fromReader.at : change.ts, now),
    time: shortWhen(fromReader ? fromReader.at : change.ts, now),
    roleLine: roleLineOf(card, fromReader, now),
    hover: keyed(primary.filter((item) => (note ? item.id === 'accept' || item.id === 'reply' : item.id === 'accept' || item.id === 'decline' || (acceptOff && item.id === 'reply')))),
    statusSpeaks: card.status !== 'pending',
    stale,
    refused,
    replyException: fromReader ? replyExceptionOf(readerRepliesOf(change, now)) : null,
    body: note && !fromReader && change.summary.trim() ? change.summary : null,
    // A stale edit is drawn on its own words: the sentence it stands beside now is not the one it was written in.
    segments: change.newFile ? [{ kind: 'text', text: change.summary }] : note && (fromReader || change.summary.trim()) ? [] : document !== undefined && card.anchor && !card.stale ? changeInSentence(document, card.anchor, change.oldText, change.newText) : diffSegments(change.oldText, change.newText),
    newFilePath: change.newFile?.path ?? null,
    primary: keyed(primary),
    more: keyed(more),
    reader: fromReader ? {
      link: fromReader.link,
      note: fromReader.kind === 'note' ? fromReader.text : null,
      written: fromReader.anchored === 'unchanged' ? null : fromReader.quote,
      changed: fromReader.anchored === 'changed',
      gone: fromReader.anchored === 'gone',
      ambiguous: fromReader.ambiguous === true,
      closed: null,
      replies: readerRepliesOf(change, now),
      noteGone: readerNoteGone(change),
      canMarkDone: note && card.status === 'pending',
    } : null,
  }
}

/** "Copy Jonas’s wording" (frame `review-cannot-apply`). */
export const copyWordingLabel = (name: string): string => `Copy ${name}’s wording`

/**
 * A reader's proposed edit that could not be applied, drawn beside its words (frame
 * `review-cannot-apply`): Could not be applied, the words it was written on, the reader's wording as a
 * change of those words, the reason, Copy <name>'s wording and Dismiss. No Accept, Decline or Reopen:
 * the ledger keeps it closed (changes.ts neverAcceptable), and the card offers nothing that would ask.
 */
function describeClosedReaderCard(card: MarginItem, marker: number, reader: NonNullable<Change['readerNote']>, kindLabel: MarginCardDescriptor['kindLabel'], now: number): MarginCardDescriptor {
  const change = card.change
  const wording = change.outsideIntended?.newText ?? reader.text
  return {
    id: card.id,
    marker,
    name: reader.name,
    roleTag: card.source.type,
    roleTagText: 'reader',
    title: `From ${reader.name}, through the link ${reader.link}`,
    kindLabel,
    statusLabel: 'Could not be applied',
    when: whenLabel(reader.at, now),
    time: shortWhen(reader.at, now),
    roleLine: roleLineOf(card, reader, now),
    hover: [],
    statusSpeaks: true,
    stale: null,
    refused: null,
    replyException: replyExceptionOf(readerRepliesOf(change, now)),
    body: null,
    segments: diffSegments(reader.quote, wording),
    newFilePath: null,
    // Frame review-cannot-apply: Copy <name>'s wording, Reply, Dismiss.
    primary: keyed([{ id: 'copy-wording', label: copyWordingLabel(reader.name) }, { id: 'reply', label: 'Reply' }, { id: 'dismiss', label: 'Dismiss' }]),
    more: [],
    reader: {
      link: reader.link, note: null, written: reader.quote, changed: false, gone: false, ambiguous: false,
      closed: { reason: change.closedReason ?? '', wording },
      replies: readerRepliesOf(change, now),
      noteGone: readerNoteGone(change),
      canMarkDone: false,
    },
  }
}

/** Run one action. Everything that resolves a change goes through `actions`, the existing review seam. */
export async function runMarginAction(
  id: MarginActionId,
  change: Change,
  actions: Pick<ReviewActions, 'acceptChange' | 'acceptAndNext' | 'rejectChange' | 'holdChange' | 'reviseChange'>,
  context: MarginActionContext,
): Promise<void> {
  switch (id) {
    case 'accept': await actions.acceptChange(change.id); return
    case 'accept-next': await actions.acceptAndNext(change.id); return
    case 'decline': await actions.rejectChange(change.id); return
    case 'hold': await actions.holdChange(change.id); return
    // Reply on a reader's card opens the reply box in the card (0.24 ticket 08). Reply on an agent card
    // is what Revise was: the composer takes a note naming this change.
    case 'reply':
      if (change.readerNote && context.openReply) { context.openReply(change.id); return }
      if (change.readerNote) return
      actions.reviseChange(change.id); return
    case 'to-scratchpad': await context.sendOriginalToScratchpad(change); return
    case 'show': context.showInText(change.id); return
    case 'no-heading': await context.keepTitleInMetadataOnly?.(change); return
    // A reader's closed edit: their wording as plain text; Dismiss takes the card away and writes nothing.
    case 'copy-wording': await context.copyText?.(change.outsideIntended?.newText ?? change.readerNote?.text ?? ''); return
    case 'dismiss': context.dismiss?.(change.id); return
    case 'reopen': await context.reopen?.(change.id); return
  }
}

/**
 * The single keys that act on a focused card while DOM focus is inside it: A accept (Done on a note), D decline,
 * R reply, H hold both, S send original, N no heading, C copy wording, ⌫ dismiss, ↵ show in text. A key the card has no button for does nothing (no Decline on a note, no Reply on
 * an outside change other than a reader's), so the keys never offer more than the card does.
 */
export function cardKeyAction(key: string, descriptor: Pick<MarginCardDescriptor, 'primary'> & Partial<Pick<MarginCardDescriptor, 'more'>>): MarginActionId | null {
  const wanted: MarginActionId | null = key === 'a' || key === 'A' ? 'accept' : key === 'd' || key === 'D' ? 'decline' : key === 'r' || key === 'R' ? 'reply'
    : key === 'h' || key === 'H' ? 'hold' : key === 's' || key === 'S' ? 'to-scratchpad' : key === 'n' || key === 'N' ? 'no-heading'
      : key === 'c' || key === 'C' ? 'copy-wording' : key === 'Backspace' || key === 'Delete' ? 'dismiss' : key === 'Enter' ? 'show' : key === 'o' || key === 'O' ? 'reopen' : null
  if (!wanted) return null
  // Show in text is on every card even when the descriptor passed carries no More list.
  if (wanted === 'show') return 'show'
  return descriptor.primary.some((item) => item.id === wanted) || descriptor.more?.some((item) => item.id === wanted) ? wanted : null
}

/**
 * A settled change drawn as a card (More filters > Settled today; More > Show quiet fixes): the same anatomy
 * as a waiting card, with its outcome as the status and one action that puts it back as a pending card
 * (Return to review for an accepted change, Reopen for a declined one). Send original is kept for any
 * change that has an original to send.
 */
export type SettledCardDescriptor = {
  id: string
  name: string
  roleTag: string
  kindLabel: MarginCardDescriptor['kindLabel']
  statusLabel: 'Accepted' | 'Declined' | 'Applied'
  when: string
  segments: DiffSegment[]
  newFilePath: string | null
  quiet: boolean
  reopenLabel: 'Return to review' | 'Reopen'
  canSendOriginal: boolean
}

export function describeSettledCard(change: Change, now: number = Date.now()): SettledCardDescriptor {
  const source = marginSource(change)
  const kind = marginKind(change)
  const quiet = change.editClass === 'copy'
  const kindLabel: MarginCardDescriptor['kindLabel'] = kind === 'note' ? 'Comment' : change.newFile ? 'New file'
    : change.editClass === 'insert' || (change.oldText === '' && change.newText !== '') ? 'Insertion' : 'Proposed edit'
  const declined = change.status === 'rejected'
  return {
    id: change.id,
    name: source.label,
    roleTag: source.type,
    kindLabel,
    statusLabel: declined ? 'Declined' : quiet ? 'Applied' : 'Accepted',
    when: whenLabel(change.ts, now),
    segments: change.newFile ? [{ kind: 'text', text: change.summary }] : diffSegments(change.oldText, change.newText),
    newFilePath: change.newFile?.path ?? null,
    quiet,
    reopenLabel: declined ? 'Reopen' : 'Return to review',
    canSendOriginal: !change.newFile,
  }
}

/**
 * A row settled during this visit (ticket 06, frame `many`): marker, who, kind, a few of its words as they
 * stand now (an accepted edit's new words, a declined one's old words), and its outcome. Reopen replaces
 * nothing on hover and answers O with focus in the row; it is the existing reopen action.
 */
export type SettledRowDescriptor = {
  id: string
  marker: number
  name: string
  kindLabel: MarginCardDescriptor['kindLabel']
  words: string
  outcome: MarginSettledRow['outcome']
  primary: MarginActionItem[]
}

export function describeSettledRow(row: MarginSettledRow, marker: number): SettledRowDescriptor {
  const change = row.change
  const reader = row.source.type === 'reader' && change.readerNote ? change.readerNote : null
  const kindLabel: MarginCardDescriptor['kindLabel'] = row.kind === 'note' ? 'Comment' : change.newFile ? 'New file'
    : change.editClass === 'insert' || (change.oldText === '' && change.newText !== '') ? 'Insertion' : 'Proposed edit'
  const words = change.newFile ? change.summary
    : row.kind === 'note' ? (reader?.text ?? (change.summary.trim() || change.oldText))
      : row.outcome === 'Accepted' ? (change.newText || change.oldText) : (change.oldText || change.newText)
  return {
    id: row.id,
    marker,
    name: reader ? reader.name : row.source.label,
    kindLabel,
    words: words.replace(/\s+/g, ' ').trim(),
    outcome: row.outcome,
    primary: keyed([{ id: 'reopen', label: 'Reopen' }]),
  }
}

/**
 * A settled item in Settled today (ticket 08, frame `settled`): the card's anatomy beside its words, with its
 * outcome and no waiting actions. Focused, it offers Return to review (an accepted item) or Reopen (a declined one),
 * both on O and both the existing reopen action; More holds Send original to Scratchpad for an edit with an original.
 */
export type SettledModeCardDescriptor = {
  id: string
  marker: number
  name: string
  kindLabel: MarginCardDescriptor['kindLabel'] | 'Quiet fix'
  /** The proposal's time at rest ("21:34"). The ledger keeps no time of settling, so the outcome line has none. */
  time: string
  outcome: MarginSettledRow['outcome']
  segments: DiffSegment[]
  body: string | null
  roleLine: string
  primary: MarginActionItem[]
  more: MarginActionItem[]
}

export function describeSettledModeCard(row: MarginSettledRow, marker: number, now: number = Date.now()): SettledModeCardDescriptor {
  const change = row.change
  const reader = row.source.type === 'reader' && change.readerNote ? change.readerNote : null
  const note = row.kind === 'note'
  const kindLabel: SettledModeCardDescriptor['kindLabel'] = change.editClass === 'copy' ? 'Quiet fix' : note ? 'Comment' : change.newFile ? 'New file'
    : change.editClass === 'insert' || (change.oldText === '' && change.newText !== '') ? 'Insertion' : 'Proposed edit'
  const declined = row.outcome === 'Declined'
  const primary: MarginActionItem[] = [{ id: 'reopen', label: declined ? 'Reopen' : 'Return to review' }]
  const more: MarginActionItem[] = [{ id: 'show', label: 'Show in text' }]
  if (!note && !change.newFile) more.push({ id: 'to-scratchpad', label: 'Send original to Scratchpad' })
  const roleLine = reader ? `Reader ${reader.name}, through the link “${reader.link}”, ${whenLabel(reader.at, now)}.`
    : row.source.type === 'you' ? `Your recorded edit, ${whenLabel(change.ts, now)}.`
      : `${row.source.label}, ${whenLabel(change.ts, now)}.`
  return {
    id: row.id,
    marker,
    name: reader ? reader.name : row.source.label,
    kindLabel,
    time: shortWhen(reader ? reader.at : change.ts, now),
    outcome: row.outcome,
    segments: change.newFile ? [{ kind: 'text', text: change.summary }] : note ? [] : diffSegments(change.oldText, change.newText),
    body: note ? (reader?.text ?? (change.summary.trim() || null)) : null,
    roleLine,
    primary: keyed(primary),
    more: keyed(more),
  }
}
