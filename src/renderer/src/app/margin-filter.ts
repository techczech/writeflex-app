import type { MarginFilter, MarginKind, MarginModel } from './margin-model'
import { isUnfiltered } from './margin-model'
import { showingLine } from './margin-bulk'

/**
 * The All / Comments / Edits segment as a view of the margin filter's `kinds`. The status bar's segment and the margin's
 * old Kind chips both read and write that one field, so they cannot disagree.
 */
export type KindSegment = 'all' | 'comments' | 'edits'

const KIND_OF: Record<KindSegment, MarginKind | null> = { all: null, comments: 'note', edits: 'edit' }

export function kindSegmentOf(filter: MarginFilter | undefined): KindSegment {
  if (filter?.kinds?.size === 1) return filter.kinds.has('note') ? 'comments' : 'edits'
  return 'all'
}

/** The filter with the segment applied; pressing the pressed segment goes back to All. */
export function withKindSegment(filter: MarginFilter, segment: KindSegment, toggle = true): MarginFilter {
  const kind = KIND_OF[segment]
  const next = kind === null || (toggle && kindSegmentOf(filter) === segment) ? undefined : new Set<MarginKind>([kind])
  return { ...filter, kinds: next }
}

export const withoutKinds = (filter: MarginFilter): MarginFilter => ({ ...filter, kinds: undefined })

/** The ids the review cursor may step through, or null when nothing is filtered out. Cards first, then the unplaced. */
export function shownIds(model: Pick<MarginModel, 'cards' | 'unplaced'>, filter: MarginFilter | undefined): ReadonlySet<string> | null {
  if (isUnfiltered(filter)) return null
  return new Set([...model.cards, ...model.unplaced].map((item) => item.id))
}

/** The line at the top of the margin while a filter hides items: what is shown, what is hidden. Null when nothing is filtered. */
export function filterLine(model: MarginModel, filter: MarginFilter | undefined, total: number): { label: string; hidden: string } | null {
  if (isUnfiltered(filter)) return null
  const segment = kindSegmentOf(filter)
  const hiddenCount = Math.max(0, total - model.counts.shown)
  const others = showingLine(model, withoutKinds(filter ?? {})).because
  const kindWord = segment === 'comments' ? 'Comments' : segment === 'edits' ? 'Edits' : ''
  const label = kindWord ? (others ? `${kindWord} ${others}` : `${kindWord} only`) : (others ? others.charAt(0).toUpperCase() + others.slice(1) : 'Filtered')
  // When only the kind narrows the margin, name what is hidden: "3 edits hidden".
  const onlyKind = segment !== 'all' && !others
  const hiddenWord = onlyKind ? `${hiddenCount} ${segment === 'comments' ? (hiddenCount === 1 ? 'edit' : 'edits') : (hiddenCount === 1 ? 'comment' : 'comments')}` : `${hiddenCount}`
  return { label, hidden: `${hiddenWord} hidden` }
}
