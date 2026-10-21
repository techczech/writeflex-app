import type { MarginFilter, MarginModel, MarginView } from './margin-model'
import { bulkTargets, toggleIn, visibleSelection } from './margin-bulk'
import { marginFits } from './margin-geometry'
import { categoryLabel } from '../components/change-review'
import type { HeadFilterState } from './margin-head-state'
import { reviewModeOf, toggleMode } from './margin-mode'

/**
 * The count menu (ADR-0046, frames `filter-who`, `narrow-1000`, `component-sheet`): what the count in the status bar's
 * review line opens. Pure: the margin's state in, the rows out (label, count, check, enabled, the action a row runs).
 * The component draws them and keeps the focus; the app runs the actions.
 */

export type CountMenuAction =
  | { type: 'step'; direction: -1 | 1 }
  | { type: 'next-piece' }
  /** Accept all N edits / Mark all N comments done, by kind; no kind: the picked cards. */
  | { type: 'accept'; kind?: 'edit' | 'note' }
  | { type: 'decline' }
  | { type: 'send-back' }
  /** A choice that is only a new filter state (who, kind of edit, held, settled, my edits, quiet fixes). */
  | { type: 'state'; state: HeadFilterState }
  | { type: 'view'; view: MarginView }
  | { type: 'toggle-margin' }
  /** Save version…: the existing `file.nameVersion` command and its naming dialog. */
  | { type: 'save-version' }

export type CountMenuIcon =
  | 'next' | 'previous' | 'next-piece' | 'accept' | 'done' | 'decline' | 'send-back'
  | 'everyone' | 'agent' | 'readers' | 'link' | 'outside' | 'request' | 'kind' | 'held'
  | 'settled' | 'mine' | 'quiet' | 'margin' | 'under' | 'hide' | 'version'

export type CountMenuRow =
  | { kind: 'separator' }
  | { kind: 'heading'; label: string }
  | {
      kind: 'item'
      id: string
      label: string
      icon?: CountMenuIcon
      /** The chord shown at the right, as the writer has it set. */
      shortcut?: string
      count?: number
      checked?: boolean
      enabled: boolean
      /** One level in: "Through <link>", "Request of hh:mm". */
      nested?: boolean
      /** Why a row is off, drawn under it. */
      reason?: string
      action?: CountMenuAction
      /** A row that opens a second panel (Kind of edit ›). */
      submenu?: CountMenuRow[]
    }

export type CountMenuChords = {
  next?: string
  previous?: string
  nextPiece?: string
  acceptAll?: string
  declineAll?: string
  sendBack?: string
  switchView?: string
  toggleMargin?: string
  saveVersion?: string
}

export type CountMenuInput = {
  /** The margin model under the current filter, with the Yours / quiet switches. */
  model: MarginModel
  state: HeadFilterState
  /** The writer's choice, margin or under the passage; too little room beside the text may overrule it. */
  preferredView: MarginView
  /** The room the editor leaves for the text beside the margin (margin-geometry's textRoomBesideMargin); null: not measured. */
  textRoom: number | null
  marginHidden: boolean
  chords?: CountMenuChords
  /** Cards picked for a bulk action (Space or ⌘-click). While any are shown, the bulk rows act on them and say so. */
  picked?: ReadonlySet<string>
  /** The counts beside Settled today, My edits and Show quiet fixes, from the review model (ticket 08: in a mode the
   *  model is the mode's). Omitted: read from `model`. */
  viewCounts?: ViewCounts
}

export type ViewCounts = { settled: number; mine: number; quiet: number }

/** The counts beside Settled today, My edits and Show quiet fixes, from a review-mode model. */
export function viewCountsOf(model: MarginModel): ViewCounts {
  return {
    settled: model.settledToday.length,
    mine: (model.sourceFacets.find((source) => source.type === 'you')?.count ?? 0) + model.hiddenOwnEdits,
    quiet: model.hiddenQuietFixes + model.quietApplied.length + model.cards.filter((card) => card.change.editClass === 'copy').length,
  }
}

export const NARROW_REASON = 'Not enough room beside the text: widen the window or close a side pane'

const hhmm = (ts: number): string => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts))

/** The who part of a filter, cleared. */
export const withoutWho = (state: HeadFilterState): HeadFilterState => ({
  ...state,
  showOwnEdits: false,
  filter: { ...state.filter, sources: undefined, requests: undefined, links: undefined },
})

/** The words on the who chip ("Readers", "Claude Code", "Through “Seminar group”", "Request of 21:12"), or null when nothing narrows by who. */
export function whoChipLabel(filter: MarginFilter | undefined, model: Pick<MarginModel, 'sourceFacets' | 'linkFacets' | 'requestFacets'>): string | null {
  if (filter?.links?.size) {
    const names = model.linkFacets.filter((link) => filter.links!.has(link.shareId)).map((link) => link.label)
    if (names.length) return names.map((name) => `Through “${name}”`).join(', ')
  }
  if (filter?.requests?.size) {
    const times = model.requestFacets.filter((request) => filter.requests!.has(request.key)).map((request) => `Request of ${hhmm(request.ts)}`)
    if (times.length) return times.join(', ')
  }
  if (filter?.sources?.size) {
    const names = model.sourceFacets.filter((source) => filter.sources!.has(source.key)).map((source) => source.label)
    if (names.length) return names.join(', ')
  }
  return null
}

export const hasWho = (filter: MarginFilter | undefined): boolean => !!(filter?.sources?.size || filter?.links?.size || filter?.requests?.size)

export function countMenu(input: CountMenuInput): CountMenuRow[] {
  const { model, state, chords = {} } = input
  const { filter } = state
  const rows: CountMenuRow[] = []
  const item = (row: Omit<Extract<CountMenuRow, { kind: 'item' }>, 'kind'>): void => { rows.push({ kind: 'item', ...row }) }
  const separate = (): void => { if (rows.length > 0 && rows[rows.length - 1].kind !== 'separator') rows.push({ kind: 'separator' }) }
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

  const hasCards = model.cards.length > 0
  item({ id: 'next', label: 'Next item', icon: 'next', shortcut: chords.next, enabled: hasCards, action: { type: 'step', direction: 1 } })
  item({ id: 'previous', label: 'Previous item', icon: 'previous', shortcut: chords.previous, enabled: hasCards, action: { type: 'step', direction: -1 } })
  if (model.otherPieces.length > 0) item({ id: 'next-piece', label: 'Next piece with items waiting', icon: 'next-piece', shortcut: chords.nextPiece, enabled: true, action: { type: 'next-piece' } })

  // Bulk rows act on the picked cards when any are picked, else on what is shown (runTargets: label and action agree).
  const picked = input.picked ?? new Set<string>()
  const pickedShown = visibleSelection(model, picked).length
  const targets = bulkTargets(model, picked, filter)
  separate()
  if (pickedShown > 0) {
    if (targets.ids.length > 0) item({ id: 'accept-picked', label: `Accept ${targets.ids.length} picked`, icon: 'accept', shortcut: chords.acceptAll, enabled: true, action: { type: 'accept' } })
    if (targets.declinable.length > 0) item({ id: 'decline-all', label: `Decline ${targets.declinable.length} picked…`, icon: 'decline', shortcut: chords.declineAll, enabled: true, action: { type: 'decline' } })
  } else if (targets.edits > 0) item({ id: 'accept-edits', label: `Accept all ${plural(targets.edits, 'edit', 'edits')}`, icon: 'accept', shortcut: chords.acceptAll, enabled: true, action: { type: 'accept', kind: 'edit' } })
  if (pickedShown === 0 && targets.notes > 0) item({ id: 'accept-comments', label: `Mark all ${plural(targets.notes, 'comment', 'comments')} done`, icon: 'done', enabled: true, action: { type: 'accept', kind: 'note' } })
  if (pickedShown === 0 && targets.declinable.length > 0) item({ id: 'decline-all', label: 'Decline all…', icon: 'decline', shortcut: chords.declineAll, enabled: true, action: { type: 'decline' } })
  const agentShown = [...model.cards, ...model.unplaced].some((shown) => shown.source.type === 'agent')
  if (agentShown) item({ id: 'send-back', label: 'Send back to the agent…', icon: 'send-back', shortcut: chords.sendBack, enabled: true, action: { type: 'send-back' } })

  // Who: one choice among Everyone, each source, and under a source its links or requests.
  separate()
  rows.push({ kind: 'heading', label: 'Show items from' })
  // The drawn order: the agent, then readers, then outside sources.
  const ORDER = { agent: 0, reader: 1, outside: 2, you: 3 } as const
  const sourceFacets = model.sourceFacets.filter((source) => source.type !== 'you').sort((a, b) => ORDER[a.type] - ORDER[b.type] || a.label.localeCompare(b.label))
  const everyone = sourceFacets.reduce((sum, source) => sum + source.count, 0)
  const who = (patch: Pick<MarginFilter, 'sources' | 'links' | 'requests'>): CountMenuAction => ({ type: 'state', state: { ...withoutWho(state), filter: { ...withoutWho(state).filter, ...patch } } })
  const noWho = !hasWho(filter) && !state.showOwnEdits
  item({ id: 'who-everyone', label: 'Everyone', icon: 'everyone', count: everyone, checked: noWho, enabled: true, action: { type: 'state', state: withoutWho(state) } })
  const onlySource = (key: string): boolean => filter.sources?.size === 1 && filter.sources.has(key) && !filter.links?.size && !filter.requests?.size && !state.showOwnEdits
  for (const source of sourceFacets) {
    item({
      id: `who-source:${source.key}`, label: source.label, count: source.count, checked: onlySource(source.key), enabled: true,
      icon: source.type === 'reader' ? 'readers' : source.type === 'outside' ? 'outside' : 'agent',
      action: who({ sources: new Set([source.key]) }),
    })
    if (source.type === 'reader') {
      for (const link of model.linkFacets) {
        item({ id: `who-link:${link.shareId}`, label: `Through “${link.label}”`, icon: 'link', count: link.count, nested: true, checked: filter.links?.has(link.shareId) === true, enabled: true, action: who({ links: new Set([link.shareId]) }) })
      }
    }
    if (source.type === 'outside') {
      for (const request of model.requestFacets.filter((candidate) => candidate.sourceKey === source.key)) {
        item({ id: `who-request:${request.key}`, label: `Request of ${hhmm(request.ts)}`, icon: 'request', count: request.count, nested: true, checked: filter.requests?.has(request.key) === true, enabled: true, action: who({ requests: new Set([request.key]) }) })
      }
    }
  }

  // Kind of edit: these filter the model (insertions, deletions, categories), unlike the mockup.
  const set = (patch: Partial<MarginFilter>): CountMenuAction => ({ type: 'state', state: { ...state, filter: { ...filter, ...patch } } })
  const { insertions, deletions } = model.directionFacets
  const kindRows: CountMenuRow[] = [
    { kind: 'item', id: 'kind-insertions', label: 'Insertions only', count: insertions, checked: filter.direction === 'insertions', enabled: true, action: set({ direction: filter.direction === 'insertions' ? null : 'insertions' }) },
    { kind: 'item', id: 'kind-deletions', label: 'Deletions only', count: deletions, checked: filter.direction === 'deletions', enabled: true, action: set({ direction: filter.direction === 'deletions' ? null : 'deletions' }) },
  ]
  if (model.categoryFacets.length > 0) kindRows.push({ kind: 'heading', label: 'By category' })
  for (const category of model.categoryFacets) {
    kindRows.push({ kind: 'item', id: `kind-category:${category.key}`, label: categoryLabel(category.key), count: category.count, checked: filter.categories?.has(category.key) === true, enabled: true, action: set({ categories: toggleIn(filter.categories, category.key) }) })
  }
  const kindActive = !!filter.direction || !!filter.categories?.size
  item({ id: 'kind-of-edit', label: 'Kind of edit', icon: 'kind', checked: kindActive, enabled: insertions + deletions > 0 || model.categoryFacets.length > 0 || kindActive, submenu: kindRows })
  if (model.heldCount > 0) item({ id: 'held', label: 'Held both', icon: 'held', count: model.heldCount, checked: filter.status === 'held', enabled: true, action: set({ status: filter.status === 'held' ? null : 'held' }) })

  // The modes (ticket 08): Settled today and My edits, each a switch back to review when on; then Show quiet fixes.
  separate()
  const counts = input.viewCounts ?? viewCountsOf(model)
  const mode = reviewModeOf(state)
  const settled = counts.settled
  item({ id: 'settled', label: 'Settled today', icon: 'settled', count: settled, checked: mode === 'settled', enabled: settled > 0 || mode === 'settled', action: { type: 'state', state: toggleMode(state, 'settled') } })
  const mine = counts.mine
  const mineOn = mode === 'mine'
  item({ id: 'my-edits', label: 'My edits', icon: 'mine', count: mine, checked: mineOn, enabled: mine > 0 || mineOn, action: { type: 'state', state: toggleMode(state, 'mine') } })
  const quiet = counts.quiet
  item({ id: 'quiet', label: 'Show quiet fixes', icon: 'quiet', count: quiet, checked: state.showQuiet, enabled: quiet > 0 || state.showQuiet, action: { type: 'state', state: { ...state, showQuiet: !state.showQuiet } } })

  // Where the cards sit. Margin is off while the text has too little room beside it, and says why.
  separate()
  const narrow = !marginFits(input.textRoom)
  const under = input.preferredView === 'under' || narrow
  item({ id: 'view-margin', label: 'Margin', icon: 'margin', shortcut: chords.switchView, checked: !under && !input.marginHidden, enabled: !narrow, reason: narrow ? NARROW_REASON : undefined, action: { type: 'view', view: 'margin' } })
  item({ id: 'view-under', label: 'Inline', icon: 'under', checked: under && !input.marginHidden, enabled: true, action: { type: 'view', view: 'under' } })
  item({ id: 'toggle-margin', label: input.marginHidden ? 'Show the margin' : 'Hide the margin', icon: 'hide', shortcut: chords.toggleMargin, enabled: true, action: { type: 'toggle-margin' } })
  // Ticket 15: Save version… sits directly below the view rows, with the chord the writer has set.
  item({ id: 'save-version', label: 'Save version…', icon: 'version', shortcut: chords.saveVersion, enabled: true, action: { type: 'save-version' } })
  return rows
}
