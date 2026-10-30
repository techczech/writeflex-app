import type { Change } from '../../../preload'
import { isPartTitleProposal } from '../../../shared/part-title-proposal'
import { reviewBuckets } from './review-buckets'
import { resolveChangeRange } from '../editor/change-marks'
import { uniqueRange } from '../editor/suggestion-anchor'
import { categoryKey, categoryOptions, type CategoryOption } from '../components/change-review'
import { isDeletionChange, isInsertionChange } from '../components/change-cards'
import { fileNameOf, isFromOutside, isNotApplied, isUndecided, sortNotApplied, sourceLabel } from '../components/outside-dock-model'
import type { ReviewMode } from './margin-mode'
import { marginPerf } from './margin-perf'

/**
 * The margin model: what the review margin (or the strip under the passage) shows for one document.
 * Pure. It reuses `reviewBuckets` (which changes are reviewable) and `resolveChangeRange` (the one anchor
 * resolver), and orders cards exactly as `ReviewCursor` walks them (anchor position, then list order), so
 * "2 of 3" and next/previous agree with the card order.
 *
 * Every eligible change appears exactly once: as a card (its passage was found) or as unplaced (it was not).
 */

export type MarginView = 'margin' | 'under'
export type MarginKind = 'edit' | 'note'
export type MarginSourceType = 'agent' | 'outside' | 'reader' | 'you'
export type MarginSource = { key: string; type: MarginSourceType; label: string }

export type MarginFilter = {
  /** Source keys to show; undefined or empty shows every source. */
  sources?: ReadonlySet<string>
  /** Kinds to show; undefined or empty shows both. */
  kinds?: ReadonlySet<MarginKind>
  /** Category keys (`categoryKey`) to show; undefined or empty shows every category. */
  categories?: ReadonlySet<string>
  /** Only changes that add text, or only changes that remove it. */
  direction?: 'insertions' | 'deletions' | null
  /** 'held' shows only held-both items; 'waiting' only pending ones; undefined shows both. */
  status?: 'waiting' | 'held' | null
  /** Outside requests (session ids from `requestFacets`) to show; undefined or empty shows every request. */
  requests?: ReadonlySet<string>
  /** Readers' links (share ids from `linkFacets`) to show (0.24 ticket 07, frame `review-filter-and-all`); undefined or empty shows every link. */
  links?: ReadonlySet<string>
}

/** Nothing is narrowing the list. */
export function isUnfiltered(filter: MarginFilter | undefined): boolean {
  return !filter || (!filter.sources?.size && !filter.kinds?.size && !filter.categories?.size && !filter.direction && !filter.status && !filter.requests?.size && !filter.links?.size)
}

export type MarginInput = {
  changes: Change[]
  document: string
  view: MarginView
  filter?: MarginFilter
  /** The Yours chip: the writer's own recorded edits are cards only when this is true. */
  showOwnEdits?: boolean
  /** More > Show quiet fixes: copy-class fixes are cards only when this is true. */
  showQuietFixes?: boolean
  /** The selected card, for "2 of 3" in the review line. */
  selectedId?: string | null
  /** For "Settled today". Defaults to the current time. */
  now?: number
  /** Ids of "could not be placed" records the writer dismissed (they stay in the ledger but leave the margin's top). */
  dismissedIds?: ReadonlySet<string>
  /** Undecided changes to OTHER documents (outside changes; readers arrive in 0.24), for "N waiting in M other pieces". */
  others?: Change[]
  /** Items the writer settled during this visit to the piece (ticket 06, `trackSettledHere`): dim one-line rows until the piece is next opened. */
  settledHere?: ReadonlySet<string>
  /** Ticket 08: Settled today or My edits (`margin-mode.ts`); review when absent. In a mode the filter is not applied. */
  mode?: ReviewMode
  /** Settled today: items reopened while the mode is on (`trackWaitingAgain`), drawn as Open cards, "waiting again". */
  waitingAgain?: ReadonlySet<string>
  /** Ticket 16: where each change's words stand in this document, found once per document revision. Made here when absent. */
  resolver?: AnchorResolver
}

/**
 * Where changes stand in one document text (ticket 16). Each answer is found once per change and kept, so building the
 * model again for the same text (a selection moved, a filter changed) does not read the document again.
 */
export type AnchorResolver = {
  readonly document: string
  range(change: Change): { from: number; to: number } | null
  stale(change: Change): { from: number; to: number } | null
  closedReader(change: Change): { from: number; to: number } | null
}

export function makeAnchorResolver(document: string): AnchorResolver {
  const ranges = new WeakMap<Change, { from: number; to: number } | null>()
  const stales = new WeakMap<Change, { from: number; to: number } | null>()
  const closed = new WeakMap<Change, { from: number; to: number } | null>()
  const memo = (cache: WeakMap<Change, { from: number; to: number } | null>, change: Change, find: () => { from: number; to: number } | null): { from: number; to: number } | null => {
    if (cache.has(change)) return cache.get(change) ?? null
    marginPerf.resolves += 1
    const found = find()
    cache.set(change, found)
    return found
  }
  return {
    document,
    range: (change) => memo(ranges, change, () => resolveChangeRange(document, change)),
    stale: (change) => memo(stales, change, () => staleRange(document, change)),
    closedReader: (change) => memo(closed, change, () => closedReaderRange(document, change)),
  }
}

/**
 * Why an item is not beside its own words (ticket 06, frame `stale`): `changed`, the words it was written
 * on changed under it (it sits beside what stands there now, Passage changed); `gone`, they are no longer
 * in the piece (it sits at the paragraph they were in, or at the top of the margin; Could not be placed).
 * Either way nothing was applied, and Accept is off.
 */
export type MarginStale = 'changed' | 'gone'

export type MarginItem = {
  id: string
  change: Change
  kind: MarginKind
  source: MarginSource
  /** `closed`: a reader's proposed edit that could not be applied, drawn beside its words (0.24 ticket 07,
   *  frame `review-cannot-apply`): never accepted, never reopened; Copy their wording or Dismiss. */
  status: 'pending' | 'held' | 'closed'
  /** The passage in the document, or null when it cannot be placed. */
  anchor: { from: number; to: number } | null
  /** Set when the item is not beside its own words (ticket 06); absent for an item in place. */
  stale?: MarginStale
  /** Settled today (ticket 08): reopened while the mode is on, "Reopened just now". */
  again?: true
}
export type MarginCard = MarginItem & { anchor: { from: number; to: number } }
/** `at`: the start of the paragraph its words were in (the card sits there), or null when no paragraph is known (top of the margin). */
export type MarginUnplaced = MarginItem & { anchor: null; stale: 'gone'; at: number | null }

/** What the writer did with an item settled during this visit, as its row says it. */
export type MarginOutcome = 'Accepted' | 'Declined' | 'Done' | 'Applied'
/**
 * An item settled during this visit (ticket 06, frame `many`): a dim one-line row with its outcome, beside
 * where its words stand now (an accepted edit's new words, a declined edit's old ones). Its words carry no
 * mark. Reopen (hover, or O) puts it back to waiting through the existing reopen action.
 */
export type MarginSettledRow = Omit<MarginItem, 'status' | 'anchor' | 'stale'> & {
  outcome: MarginOutcome
  /** Where its words stand now, or null; `at` is then the paragraph they were in, or null for the top of the margin. */
  anchor: { from: number; to: number } | null
  at: number | null
}

export type SourceCount = MarginSource & { count: number }
export type MarginCounts = {
  /** Over the filtered items (cards plus unplaced). Agent first, then outside sources, then You. */
  bySource: SourceCount[]
  byKind: Record<MarginKind, number>
  shown: number
  /** Eligible items before the filter, for "Showing 3 of 5". */
  total: number
}

/** One reader's link, for the per-link rows under Readers in More filters (frame `review-filter-and-all`). */
export type LinkFacet = { shareId: string; label: string; count: number }
/** One request from an outside source (its changes share a session), for the request rows under More filters. */
export type RequestFacet = { key: string; sourceKey: string; label: string; ts: number; count: number }
/** One other piece with items waiting, for the list behind "N waiting in M other pieces". */
export type OtherPiece = {
  path: string
  /** The piece's file name without its folder. */
  name: string
  count: number
  bySource: Array<{ key: string; label: string; count: number }>
  /** The first waiting change's id and a few of its words, for "first: ...". */
  firstId: string
  firstWords: string
}
export type DirectionCounts = { insertions: number; deletions: number }

export type MarginModel = {
  view: MarginView
  cards: MarginCard[]
  unplaced: MarginUnplaced[]
  counts: MarginCounts
  /** Per source over ALL eligible items, so a source chip can show its count while another filter is on. */
  sourceFacets: SourceCount[]
  /** Categories over ALL eligible items (counts stay put while another filter is on). */
  categoryFacets: CategoryOption[]
  requestFacets: RequestFacet[]
  /** Readers' links over ALL eligible items, in the order first seen. */
  linkFacets: LinkFacet[]
  directionFacets: DirectionCounts
  heldCount: number
  /** Changes the app closed without applying (a passage that is gone, a file that moved): the "N could not be placed" popover in the review line. */
  notPlaced: Change[]
  /** Waiting items in other pieces, by piece (path order), and their total. */
  otherPieces: OtherPiece[]
  otherWaiting: number
  /** Accepted or declined today, for "Settled today, with Reopen" (Reopen / Return to review). Not cards. */
  settledToday: Change[]
  /** Quiet fixes already applied (accepted), newest first: shown as settled cards only while Show quiet fixes is on. */
  quietApplied: Change[]
  /** The writer's own pending edits that are hidden because Yours is not pressed. */
  hiddenOwnEdits: number
  /** Quiet fixes hidden because Show quiet fixes is off. */
  hiddenQuietFixes: number
  /** Those hidden quiet fixes that still wait, with where their words stand (none when it cannot be placed):
   *  the text shows them only as a faint marker (ADR-0016 §3), with no card and no number (ticket 13). */
  quietWaiting: Array<{ id: string; anchor: { from: number; to: number } }>
  /** 1-based position of the selected item among the cards and then the unplaced items, or null. */
  position: { index: number; of: number } | null
  /** Items settled during this visit, shown as dim rows (the filter applies to them as to cards). */
  settled: MarginSettledRow[]
  /** The number each item draws (card, its mark in the text, settled row, unplaced card): in document order
   *  over cards and settled rows, so a settled item keeps its number; then the unplaced, in list order. */
  markers: ReadonlyMap<string, number>
  /** Ticket 08: the mode the model was built for. In Settled today `settled` holds today's settled items (full cards). */
  mode: ReviewMode
  /** Settled today: quiet fixes applied today, for "Include quiet fixes N" (counted whether or not they are included). */
  settledQuiet: number
  /** My edits: the items waiting that are not yours, out of sight ("5 others waiting"). */
  othersWaiting: number
}

/** A paragraph's start for a position: just after the blank line before it, or 0. */
function paragraphStartAt(document: string, pos: number): number {
  const clamped = Math.max(0, Math.min(pos, document.length))
  const blank = document.lastIndexOf('\n\n', Math.max(0, clamped - 1))
  return blank === -1 ? 0 : blank + 2
}

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []

/**
 * The words a waiting agent or outside change was written on, when they changed under it (ticket 06, frame
 * `stale`): its recorded span still lies in the piece and at least half of its old words stand there, but
 * not as written. The span is widened to whole words. Null when the change resolves as written, has no
 * recorded span, or what stands there now shares too little with what it was written on (then its words
 * are gone). Readers' items say this themselves (`readerNote.anchored`); the writer's own edits never drift.
 */
export function staleRange(document: string, change: Change): { from: number; to: number } | null {
  if (change.status !== 'pending' && change.status !== 'held') return null
  if (change.readerNote || change.provenance === 'writer' || change.editClass === 'insert' || change.editClass === 'move' || change.newFile || change.whole) return null
  const at = change.anchor
  const want = wordsOf(change.oldText)
  if (!at || want.length === 0 || !Number.isSafeInteger(at.from) || !Number.isSafeInteger(at.to) || at.from < 0 || at.to <= at.from || at.from >= document.length) return null
  if (resolveChangeRange(document, change)) return null
  let from = at.from
  let to = Math.min(at.to, document.length)
  const wordChar = /[\p{L}\p{N}'’-]/u
  while (from > 0 && wordChar.test(document[from - 1])) from -= 1
  while (to < document.length && wordChar.test(document[to])) to += 1
  const here = document.slice(from, to)
  if (here.includes('\n\n')) return null
  const have = new Set(wordsOf(here))
  const shared = want.filter((word) => have.has(word)).length
  return shared > 0 && shared * 2 >= want.length ? { from, to } : null
}

/** Where an item that cannot be placed sits: the paragraph of its recorded span, or null (top of the margin). */
function unplacedAt(document: string, change: Change): number | null {
  const at = change.anchor
  if (!at || !Number.isSafeInteger(at.from) || at.from < 0 || at.from > document.length) return null
  return paragraphStartAt(document, at.from)
}

/**
 * Items the writer settled during this visit (ticket 06). Pure: `seen` is every item drawn waiting since the
 * piece was opened; one of them now accepted or declined (not closed by the app) is settled here. A reopened
 * item is waiting again and leaves the set. Opening the piece again starts both empty.
 */
export function trackSettledHere(state: { seen: ReadonlySet<string>; settled: ReadonlySet<string> }, waitingIds: readonly string[], changes: readonly Change[]): { seen: ReadonlySet<string>; settled: ReadonlySet<string> } {
  const seen = new Set(state.seen)
  for (const id of waitingIds) seen.add(id)
  const settled = new Set<string>()
  for (const change of changes) {
    if (!seen.has(change.id) || change.snapshotId || change.closedReason) continue
    if (change.status === 'accepted' || change.status === 'rejected') settled.add(change.id)
  }
  const same = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((id) => b.has(id))
  return { seen: same(seen, state.seen) ? state.seen : seen, settled: same(settled, state.settled) ? state.settled : settled }
}

/**
 * Reserve review space only for cards drawn on this piece, or an explicitly requested history mode.
 * Arrivals, closed changes and work in other pieces are reached in status-bar popovers; they draw nothing here.
 */
export function marginVisible(model: Pick<MarginModel, 'cards' | 'unplaced' | 'notPlaced' | 'otherPieces'> & { mode?: ReviewMode }, _outside?: { arrived: readonly unknown[] } | null): boolean {
  // Settled today and My edits are asked for (count menu, palette): they draw the margin even with nothing waiting.
  if (model.mode !== undefined && model.mode !== 'review') return true
  // Settled-this-visit rows do not keep the margin on their own: with nothing waiting there is no margin (frame `none`);
  // the last settled item stays reachable from Settled today.
  return model.cards.length > 0 || model.unplaced.length > 0
}

/** A comment-only item (no text change) is a note; anything that changes text is an edit. */
export function marginKind(change: Change): MarginKind {
  // A move keeps its words (old and new text are the same); it is still an edit with Accept and Decline.
  return change.oldText === change.newText && !change.newFile && !change.moveFrom ? 'note' : 'edit'
}

export function marginSource(change: Change): MarginSource {
  if (change.provenance === 'writer') return { key: 'you', type: 'you', label: 'You' }
  // A reader of a shared link (0.24 ticket 07): one source, Readers; the card names the reader.
  if (change.outsideSource === 'reader') return { key: 'readers', type: 'reader', label: 'Readers' }
  // From the command line (Claude Code, Codex, another outside agent): the label comes from the closed source list.
  if (change.outsideSource) {
    const label = sourceLabel(change.outsideSource)
    return { key: `outside:${label}`, type: 'outside', label }
  }
  if (change.provenance === 'reviewer') {
    const label = change.reviewerLabel?.trim() || 'Outside agent'
    return { key: `outside:${label}`, type: 'outside', label }
  }
  // A change WriteFlex filed itself for a part's title is not the agent's work.
  if (isPartTitleProposal(change)) return { key: 'writeflex', type: 'agent', label: 'WriteFlex' }
  return { key: 'agent', type: 'agent', label: 'Agent' }
}

const SOURCE_RANK: Record<MarginSourceType, number> = { reader: 0, agent: 1, outside: 2, you: 3 }

function tally(items: MarginItem[]): SourceCount[] {
  const map = new Map<string, SourceCount>()
  for (const item of items) {
    const existing = map.get(item.source.key)
    if (existing) existing.count += 1
    else map.set(item.source.key, { ...item.source, count: 1 })
  }
  return [...map.values()].sort((a, b) => SOURCE_RANK[a.type] - SOURCE_RANK[b.type] || a.label.localeCompare(b.label))
}

/**
 * Where a reader's closed edit sits (0.24 ticket 07): the words it was placed beside when collected,
 * at its stored place when they still stand there, else where they stand once. Null when they are no
 * longer in the text (it then waits in the review line, under "could not be placed").
 */
export function closedReaderRange(document: string, change: Change): { from: number; to: number } | null {
  const words = change.readerNote?.words
  if (typeof words !== 'string' || !words.trim()) return null
  const at = change.anchor
  if (at && at.from >= 0 && at.to <= document.length && at.to > at.from && document.slice(at.from, at.to) === words) return { from: at.from, to: at.to }
  return uniqueRange(document, words)
}

/** A reader's proposed edit the app closed because it could not be applied (words changed, gone, repeated, formatted). */
export const isClosedReaderEdit = (change: Change): boolean => change.outsideSource === 'reader' && change.readerNote?.kind === 'edit' && isNotApplied(change)

/** A command-line change's request id (its changes share it); a reviewer's changes share a session. */
const requestIdOf = (change: Change): string | undefined => change.outsideRequest?.id ?? change.sessionId
const requestTimeOf = (change: Change): number => change.outsideRequest?.at ?? change.ts

function otherPiecesOf(others: Change[]): OtherPiece[] {
  const byPath = new Map<string, Change[]>()
  for (const change of others) {
    if (!isUndecided(change)) continue
    const list = byPath.get(change.path) ?? []
    list.push(change)
    byPath.set(change.path, list)
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, list]) => {
      const sources = new Map<string, { key: string; label: string; count: number }>()
      for (const change of list) {
        const source = marginSource(change)
        const row = sources.get(source.key) ?? { key: source.key, label: source.label, count: 0 }
        row.count += 1
        sources.set(source.key, row)
      }
      const first = list[0]
      return {
        path,
        name: fileNameOf(path),
        count: list.length,
        bySource: [...sources.values()],
        firstId: first.id,
        firstWords: (first.newText || first.oldText || first.summary || '').slice(0, 60),
      }
    })
}

/**
 * The margin's model and the facts the status bar and the unread dots need whatever the filters say (ticket 16): the
 * model under the writer's mode and filter, and the same changes with no filter, no mode and no selection. Both come
 * from one resolution of the changes against the document; when no filter or mode narrows anything, they are one model.
 */
export function buildMarginModels(input: MarginInput): { model: MarginModel; unfiltered: MarginModel } {
  marginPerf.builds += 1
  const resolver = input.resolver && input.resolver.document === input.document ? input.resolver : makeAnchorResolver(input.document)
  const shared = { ...input, resolver }
  const model = buildMarginModel(shared)
  const mode: ReviewMode = input.mode ?? 'review'
  if (mode === 'review' && isUnfiltered(input.filter)) return { model, unfiltered: model }
  const { filter: _filter, selectedId: _selectedId, mode: _mode, waitingAgain: _waitingAgain, ...rest } = shared
  return { model, unfiltered: buildMarginModel(rest) }
}

export function buildMarginModel(input: MarginInput): MarginModel {
  const resolver = input.resolver && input.resolver.document === input.document ? input.resolver : makeAnchorResolver(input.document)
  const mode: ReviewMode = input.mode ?? 'review'
  const waitingAgain = input.waitingAgain ?? new Set<string>()
  const { changes, document, view, showQuietFixes = false, selectedId = null, now = Date.now() } = input
  // My edits is your recorded edits and nothing else; Settled today draws only what was reopened in it. Neither is filtered.
  const filter: MarginFilter | undefined = mode === 'mine' ? { sources: new Set(['you']) } : mode === 'settled' ? undefined : input.filter
  const showOwnEdits = mode === 'mine' || mode === 'settled' || (input.showOwnEdits ?? false)
  const live = changes.filter((change) => !change.snapshotId)
  const dismissed = input.dismissedIds
  const buckets = reviewBuckets(live)

  const quiet = buckets.quietFixes.filter((change) => change.status === 'pending' || change.status === 'held')
  const quietIds = new Set(quiet.map((change) => change.id))
  const ownIds = new Set(buckets.writerChanges.map((change) => change.id))

  // Reviewable = held + provisional + the writer's own + anything else pending + quiet fixes. Deduplicated by id.
  const reviewable = new Map<string, Change>()
  for (const change of [...buckets.heldChanges, ...buckets.provisionalChanges, ...buckets.writerChanges, ...buckets.otherWorkingChanges, ...quiet]) {
    reviewable.set(change.id, change)
  }

  let hiddenOwnEdits = 0
  let hiddenQuietFixes = 0
  const quietWaiting: MarginModel['quietWaiting'] = []
  const eligible: Array<{ change: Change; sourceIndex: number }> = []
  live.forEach((change, sourceIndex) => {
    if (!reviewable.has(change.id)) return
    if (mode === 'settled') { if (waitingAgain.has(change.id)) eligible.push({ change, sourceIndex }); return }
    if (quietIds.has(change.id) && !showQuietFixes) {
      hiddenQuietFixes += 1
      const anchor = resolver.range(change)
      if (anchor) quietWaiting.push({ id: change.id, anchor })
      return
    }
    if (ownIds.has(change.id) && !showOwnEdits) { hiddenOwnEdits += 1; return }
    eligible.push({ change, sourceIndex })
  })

  const resolved = eligible.map(({ change, sourceIndex }) => {
    const exact = resolver.range(change)
    const changed = exact ? null : resolver.stale(change)
    const reader = change.readerNote
    // A reader's note placed beside the nearest match says Passage changed itself; here it is marked stale too, so Accept is off alike.
    const stale: MarginStale | undefined = changed || (exact && reader?.anchored === 'changed') ? 'changed' : exact ? undefined : 'gone'
    const item = {
      id: change.id,
      change,
      kind: marginKind(change),
      source: marginSource(change),
      status: change.status === 'held' ? 'held' : 'pending',
      anchor: exact ?? changed,
      ...(stale ? { stale } : {}),
      ...(exact || changed ? {} : { at: unplacedAt(document, change) }),
      ...(mode === 'settled' ? { again: true } : {}),
    } as MarginItem
    return { sourceIndex, item }
  })
  // A reader's edit that could not be applied stays beside the words it was written on, closed
  // (frame `review-cannot-apply`), until dismissed; when those words are gone it waits under "could not be placed".
  const closedPlaced = new Set<string>()
  live.forEach((change, sourceIndex) => {
    if (mode !== 'review' || !isClosedReaderEdit(change) || dismissed?.has(change.id)) return
    const anchor = resolver.closedReader(change)
    if (!anchor) return
    closedPlaced.add(change.id)
    resolved.push({ sourceIndex, item: { id: change.id, change, kind: 'edit', source: marginSource(change), status: 'closed', anchor } })
  })

  const wantSources = filter?.sources && filter.sources.size > 0 ? filter.sources : null
  const wantKinds = filter?.kinds && filter.kinds.size > 0 ? filter.kinds : null
  const wantCategories = filter?.categories && filter.categories.size > 0 ? filter.categories : null
  const wantRequests = filter?.requests && filter.requests.size > 0 ? filter.requests : null
  const wantLinks = filter?.links && filter.links.size > 0 ? filter.links : null
  const direction = filter?.direction ?? null
  const status = filter?.status ?? null
  const passes = (item: Pick<MarginItem, 'change' | 'source' | 'kind'>): boolean => {
    const change = item.change
    if (wantSources && !wantSources.has(item.source.key)) return false
    if (wantKinds && !wantKinds.has(item.kind)) return false
    if (wantCategories && !wantCategories.has(categoryKey(change))) return false
    const requestId = requestIdOf(change)
    if (wantRequests && !(requestId && wantRequests.has(requestId))) return false
    if (wantLinks && !(change.readerNote && wantLinks.has(change.readerNote.shareId))) return false
    if (direction === 'insertions' && !isInsertionChange(change)) return false
    if (direction === 'deletions' && !isDeletionChange(change)) return false
    return true
  }
  const kept = resolved.filter(({ item }) => {
    if (!passes(item)) return false
    if (status === 'held' && item.status !== 'held') return false
    if (status === 'waiting' && item.status !== 'pending') return false
    return true
  })

  const allItems = resolved.map(({ item }) => item)
  const requestMap = new Map<string, RequestFacet>()
  for (const item of allItems) {
    const sessionId = requestIdOf(item.change)
    if (item.source.type !== 'outside' || !sessionId) continue
    const key = `${item.source.key}|${sessionId}`
    const existing = requestMap.get(key)
    if (existing) { existing.count += 1; existing.ts = Math.min(existing.ts, requestTimeOf(item.change)) }
    else requestMap.set(key, { key: sessionId, sourceKey: item.source.key, label: item.source.label, ts: requestTimeOf(item.change), count: 1 })
  }
  const linkMap = new Map<string, LinkFacet>()
  for (const item of allItems) {
    const reader = item.source.type === 'reader' ? item.change.readerNote : undefined
    if (!reader) continue
    const existing = linkMap.get(reader.shareId)
    if (existing) existing.count += 1
    else linkMap.set(reader.shareId, { shareId: reader.shareId, label: reader.link, count: 1 })
  }
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  const settledToday = [...buckets.acceptedChanges, ...buckets.rejectedChanges]
    .filter((change) => change.ts >= startOfToday)
    .sort((a, b) => b.ts - a.ts)

  const quietApplied = buckets.quietFixes.filter((change) => change.status === 'accepted').sort((a, b) => b.ts - a.ts)

  const notPlaced = sortNotApplied(live.filter((change) => isFromOutside(change) && isNotApplied(change) && !dismissed?.has(change.id) && !closedPlaced.has(change.id)))
  const otherPieces = otherPiecesOf((input.others ?? []).filter((change) => !change.snapshotId))

  const cards = kept
    .filter(({ item }) => item.anchor !== null)
    .sort((a, b) => a.item.anchor!.from - b.item.anchor!.from || a.sourceIndex - b.sourceIndex)
    .map(({ item }) => item as MarginCard)
  const unplaced = kept
    .filter(({ item }) => item.anchor === null)
    .sort((a, b) => a.sourceIndex - b.sourceIndex)
    .map(({ item }) => item as MarginUnplaced)

  const shownItems: MarginItem[] = [...cards, ...unplaced]
  const byKind: Record<MarginKind, number> = { edit: 0, note: 0 }
  for (const item of shownItems) byKind[item.kind] += 1

  // Settled this visit: dim rows beside where their words stand now. The filter hides them as it hides cards.
  const settledIds = input.settledHere
  const settled: MarginSettledRow[] = []
  const quietToday = quietApplied.filter((change) => change.ts >= startOfToday)
  if (mode === 'settled') {
    // Settled today (ticket 08): every item settled today beside where its words stand now, quiet fixes when included.
    const today = [...settledToday, ...(showQuietFixes ? quietToday : [])].filter((change) => !waitingAgain.has(change.id))
    const ids = new Set(today.map((change) => change.id))
    live.forEach((change) => {
      if (!ids.has(change.id)) return
      const kind = marginKind(change)
      const anchor = resolver.range(change)
      const outcome: MarginOutcome = change.status === 'rejected' ? 'Declined' : change.editClass === 'copy' ? 'Applied' : kind === 'note' ? 'Done' : 'Accepted'
      settled.push({ id: change.id, change, kind, source: marginSource(change), outcome, anchor, at: anchor ? null : unplacedAt(document, change) })
    })
  } else if (settledIds && settledIds.size > 0) {
    live.forEach((change) => {
      if (!settledIds.has(change.id) || (change.status !== 'accepted' && change.status !== 'rejected')) return
      const kind = marginKind(change)
      const row = { id: change.id, change, kind, source: marginSource(change) }
      if (!passes(row)) return
      const anchor = resolver.range(change)
      settled.push({ ...row, outcome: change.status === 'rejected' ? 'Declined' : kind === 'note' ? 'Done' : 'Accepted', anchor, at: anchor ? null : unplacedAt(document, change) })
    })
  }

  // One numbering for everything drawn: cards and settled rows in document order (a settled item keeps its number), then the unplaced.
  const markers = new Map<string, number>()
  const placedOrder = [
    ...cards.map((card, index) => ({ id: card.id, pos: card.anchor.from, tie: index })),
    ...settled.map((row, index) => ({ id: row.id, pos: row.anchor?.from ?? row.at ?? -1, tie: cards.length + index })),
  ].sort((a, b) => a.pos - b.pos || a.tie - b.tie)
  for (const entry of placedOrder) markers.set(entry.id, markers.size + 1)
  for (const item of unplaced) markers.set(item.id, markers.size + 1)

  const atCard = cards.findIndex((card) => card.id === selectedId)
  const atUnplaced = atCard === -1 ? unplaced.findIndex((item) => item.id === selectedId) : -1
  const at = atCard !== -1 ? atCard : atUnplaced === -1 ? -1 : cards.length + atUnplaced
  return {
    view,
    cards,
    unplaced,
    counts: { bySource: tally(shownItems), byKind, shown: shownItems.length, total: resolved.length },
    sourceFacets: tally(allItems),
    categoryFacets: categoryOptions(allItems.map((item) => item.change)),
    requestFacets: [...requestMap.values()].sort((a, b) => a.ts - b.ts),
    linkFacets: [...linkMap.values()],
    directionFacets: {
      insertions: allItems.filter((item) => isInsertionChange(item.change)).length,
      deletions: allItems.filter((item) => isDeletionChange(item.change)).length,
    },
    heldCount: allItems.filter((item) => item.status === 'held').length,
    notPlaced,
    otherPieces,
    otherWaiting: otherPieces.reduce((sum, piece) => sum + piece.count, 0),
    settledToday,
    quietApplied,
    hiddenOwnEdits,
    hiddenQuietFixes,
    quietWaiting: quietWaiting.sort((a, b) => a.anchor.from - b.anchor.from),
    position: at === -1 ? null : { index: at + 1, of: cards.length + unplaced.length },
    settled,
    markers,
    mode,
    settledQuiet: quietToday.length,
    othersWaiting: mode === 'mine' ? resolved.filter(({ item }) => item.source.type !== 'you').length : 0,
  }
}
