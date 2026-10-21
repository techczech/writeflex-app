import type { MarginFilter, MarginItem, MarginModel, MarginKind } from './margin-model'
import { isUnfiltered } from './margin-model'
import { categoryLabel } from '../components/change-review'

/**
 * The review margin's bulk actions, over the model. Pure. "Accept all" and "Decline all" act on what the
 * filter shows, in this piece only: the model is built for one document and already carries the filter,
 * so a card the filter hides, or one in another piece, is never in the list. The selection (⌘-click) wins
 * over the filter when it holds at least one visible card.
 */

export type BulkScope = 'selection' | 'filter'
export type BulkTargets = { scope: BulkScope; ids: string[]; edits: number; notes: number; /** Edits only: a note has no Decline. */ declinable: string[] }

function shownItems(model: MarginModel): MarginItem[] {
  return [...model.cards, ...model.unplaced]
}

/** Moves replay differently and are never resolved in bulk (as acceptAllPending). */
/** A reader's closed edit (it could not be applied) is never accepted or declined, alone or in bulk. */
const bulkable = (item: MarginItem): boolean => item.change.editClass !== 'move' && item.status !== 'closed'

/** Selected ids that are still shown; a card the filter hid or that was settled drops out of the selection. */
export function visibleSelection(model: MarginModel, picked: ReadonlySet<string>): string[] {
  return shownItems(model).filter((item) => picked.has(item.id)).map((item) => item.id)
}

/**
 * What a bulk action would touch. Selection first, else everything the filter shows. Held items are
 * included only when the Held filter is on, so Accept all keeps meaning "the waiting ones".
 */
export function bulkTargets(model: MarginModel, picked: ReadonlySet<string>, filter: MarginFilter | undefined, kind?: MarginKind): BulkTargets {
  const selected = new Set(visibleSelection(model, picked))
  const scope: BulkScope = selected.size > 0 ? 'selection' : 'filter'
  const includeHeld = scope === 'selection' || filter?.status === 'held'
  const items = shownItems(model)
    .filter(bulkable)
    .filter((item) => (scope === 'selection' ? selected.has(item.id) : includeHeld || item.status === 'pending'))
    .filter((item) => !kind || item.kind === kind)
  return {
    scope,
    ids: items.map((item) => item.id),
    edits: items.filter((item) => item.kind === 'edit').length,
    notes: items.filter((item) => item.kind === 'note').length,
    declinable: items.filter((item) => item.kind === 'edit').map((item) => item.id),
  }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * What the run-level keys and rows act on (ticket 04, ADR-0046): the picked cards when any are picked (both kinds),
 * else the shown edits for Accept all (⇧⌘A, "Accept all N"), the shown comments for Mark all done, and the shown
 * edits for Decline all. One function, so a label and the action under it can never disagree.
 */
export function runTargets(model: MarginModel, picked: ReadonlySet<string>, filter: MarginFilter | undefined, what: 'accept' | 'done' | 'decline'): BulkTargets {
  const anyPicked = visibleSelection(model, picked).length > 0
  if (anyPicked) return bulkTargets(model, picked, filter)
  return bulkTargets(model, picked, filter, what === 'done' ? 'note' : 'edit')
}

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
const countWord = (n: number, capital: boolean): string => {
  const word = n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n)
  return capital ? word : word.toLowerCase()
}

export type DeclineQuestion = {
  /** "Decline 3 edits?" */
  title: string
  /** Who will hear of it, and whose the rest are: "One is Jonas’s proposed edit: Jonas will see it declined on the reader page. One is the agent’s, one is Claude Code’s." */
  detail: string
  /** "The text stays as it is. Each one can be reopened from Settled today." */
  reassurance: string
  /** The number on the Decline button. */
  count: number
  /** Whether any of them came from a reader (their page will show the outcome). */
  readersSee: boolean
}

/**
 * The words of the Decline all confirmation (frame `bulk-decline-confirm`). Pure: the ids to decline and the items they
 * are, in. Readers are named one by one, because each will see the outcome on the reader page; the agent's and the
 * outside sources' are counted.
 */
export function declineQuestion(model: MarginModel, ids: readonly string[]): DeclineQuestion {
  const wanted = new Set(ids)
  const items = shownItems(model).filter((item) => wanted.has(item.id))
  const n = items.length
  const readers = new Map<string, number>()
  const others = new Map<string, number>()
  for (const item of items) {
    if (item.source.type === 'reader') {
      const name = item.change.readerNote?.name?.trim() || 'A reader'
      readers.set(name, (readers.get(name) ?? 0) + 1)
    } else {
      const whose = item.source.type === 'you' ? 'yours' : item.source.key === 'agent' ? 'the agent’s' : `${item.source.label}’s`
      others.set(whose, (others.get(whose) ?? 0) + 1)
    }
  }
  const sentences: string[] = []
  for (const [name, count] of readers) {
    const one = count === 1
    sentences.push(`${countWord(count, true)} ${one ? 'is' : 'are'} ${name}’s proposed ${one ? 'edit' : 'edits'}: ${name} will see ${one ? 'it' : 'them'} declined on the reader page.`)
  }
  if (others.size > 0) {
    const parts = [...others].map(([whose, count], index) => `${countWord(count, index === 0)} ${count === 1 ? 'is' : 'are'} ${whose}`)
    const only = others.size === 1 && readers.size === 0 ? [...others.keys()][0] : null
    // Everything from one source: "All 3 are Claude Code’s.", "It is the agent’s."
    if (only) sentences.push(n === 1 ? `It is ${only}.` : `All ${n} are ${only}.`)
    else sentences.push(`${parts.join(', ')}.`)
  }
  return {
    title: `Decline ${plural(n, 'edit', 'edits')}?`,
    detail: sentences.join(' '),
    reassurance: n === 1 ? 'The text stays as it is. It can be reopened from Settled today.' : 'The text stays as it is. Each one can be reopened from Settled today.',
    count: n,
    readersSee: readers.size > 0,
  }
}

export type SendBackScope = {
  /** The agent's waiting items that go back with the note, and stay marked Sent back. */
  ids: string[]
  edits: number
  comments: number
  /** "Goes back: the agent’s 2 waiting items (1 edit, 1 comment), with this note. …" */
  text: string
}

/**
 * What Send back to the agent covers (frame `send-back`): the agent's shown waiting items (a filter narrows it further).
 * Readers' and outside sources' items are never included, and the popover says which of them were left out.
 */
export function sendBackScope(model: MarginModel): SendBackScope {
  const shown = shownItems(model).filter((item) => item.status !== 'closed')
  const items = shown.filter((item) => item.source.key === 'agent')
  const edits = items.filter((item) => item.kind === 'edit').length
  const comments = items.length - edits
  const left: string[] = []
  for (const item of shown) {
    if (item.source.key === 'agent' || item.source.type === 'you' || item.source.key === 'writeflex') continue
    if (!left.includes(item.source.label)) left.push(item.source.label)
  }
  const leftText = left.length === 0 ? '' : ` ${left.length === 1 ? left[0] : `${left.slice(0, -1).join(', ')} and ${left[left.length - 1]}`} ${left.length === 1 && left[0] !== 'Readers' ? 'is' : 'are'} not included.`
  const kinds = [edits > 0 ? plural(edits, 'edit', 'edits') : null, comments > 0 ? plural(comments, 'comment', 'comments') : null].filter(Boolean).join(', ')
  const text = items.length === 0
    ? `Nothing of the agent’s is waiting here; the note goes to the agent on its own.${leftText}`
    : `Goes back: the agent’s ${plural(items.length, 'waiting item', 'waiting items')} (${kinds}), with this note. ${items.length === 1 ? 'It stays' : 'They stay'} in the margin marked Sent back until the agent answers.${leftText}`
  return { ids: items.map((item) => item.id), edits, comments, text }
}

/** The edits one review pass is working through (ticket 04, "M of N settled"): every edit that has waited in this piece since the batch began. */
export type ReviewBatch = { key: string | null; ids: ReadonlySet<string> }
export const EMPTY_BATCH: ReviewBatch = { key: null, ids: new Set() }
/** A batch of this many edits or more brings "Accept all N" and progress into the status bar (README: a judgement). */
export const BULK_THRESHOLD = 6

/** The batch after the waiting edits changed. A new piece starts a new batch; so does a piece with nothing left waiting. Arrivals join it. */
export function nextBatch(batch: ReviewBatch, key: string | null, waitingEditIds: readonly string[]): ReviewBatch {
  if (key !== batch.key || waitingEditIds.length === 0) return { key, ids: new Set(waitingEditIds) }
  if (waitingEditIds.every((id) => batch.ids.has(id))) return batch
  return { key, ids: new Set([...batch.ids, ...waitingEditIds]) }
}

/** "1 of 20 settled": only for a batch of six or more, once one of it is settled. */
export function batchProgress(batch: ReviewBatch, waitingEditIds: readonly string[]): { settled: number; total: number } | null {
  const total = batch.ids.size
  if (total < BULK_THRESHOLD) return null
  const waiting = new Set(waitingEditIds)
  const settled = [...batch.ids].filter((id) => !waiting.has(id)).length
  return settled > 0 && settled < total ? { settled, total } : null
}

/** The waiting edits of a piece, before any filter: what a batch is counted over. */
export function waitingEditIds(unfiltered: MarginModel): string[] {
  return shownItems(unfiltered).filter((item) => bulkable(item) && item.kind === 'edit').map((item) => item.id)
}

/** "Showing 3 of 5" and what narrows it, "from readers", for the filter line. */
export function showingLine(model: MarginModel, filter: MarginFilter | undefined): { text: string; because: string; filtered: boolean } {
  const filtered = !isUnfiltered(filter)
  const because: string[] = []
  if (filter?.sources?.size) {
    const names = model.sourceFacets.filter((source) => filter.sources!.has(source.key)).map((source) => source.label)
    if (names.length) because.push(`from ${names.join(', ')}`)
  }
  if (filter?.links?.size) {
    const names = model.linkFacets.filter((link) => filter.links!.has(link.shareId)).map((link) => link.label)
    if (names.length) because.push(`link ${names.join(', ')}`)
  }
  if (filter?.requests?.size) {
    const names = model.requestFacets.filter((request) => filter.requests!.has(request.key)).map((request) => request.label)
    if (names.length) because.push(`request of ${names.join(', ')}`)
  }
  if (filter?.kinds?.size) because.push([...filter.kinds].map((kind) => (kind === 'edit' ? 'edits' : 'comments')).join(', '))
  if (filter?.categories?.size) because.push([...filter.categories].map(categoryLabel).join(', '))
  if (filter?.direction) because.push(`${filter.direction} only`)
  if (filter?.status) because.push(filter.status === 'held' ? 'held' : 'waiting')
  return { text: `Showing ${model.counts.shown} of ${model.counts.total}`, because: because.join(' · '), filtered }
}

export function toggleIn<T>(set: ReadonlySet<T> | undefined, value: T): Set<T> {
  const next = new Set(set ?? [])
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}
