import { Terminal } from 'lucide-react'
import type { Change } from '../../../preload'
import { tagLabelOf, tagTitle } from './outside-dock-model'

/** A change that only ADDS text (agent insertion, or any edit whose old side is empty). */
export const isInsertionChange = (c: Change): boolean => c.editClass === 'insert' || (c.oldText === '' && c.newText !== '')
/** A change that only REMOVES text (nothing added). */
export const isDeletionChange = (c: Change): boolean => c.newText === '' && c.oldText !== ''

/** Compact "when" for list rows: minutes/hours today, then day-month. */
export function relativeTime(ts: number): string {
  const delta = Date.now() - ts
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return 'just now'
  if (delta < hour) return `${Math.max(1, Math.round(delta / minute))} min ago`
  if (delta < day) return `${Math.max(1, Math.round(delta / hour))} hr ago`
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(ts))
}

/** The source tag of the locked outside-changes design: `Claude Code 2/5`, the label alone for a request of one. */
export function SourceTag({ change, now }: { change: Change; now?: number }): JSX.Element {
  const label = tagLabelOf(change)
  const ref = change.outsideRequest
  const count = ref?.count ?? 1
  const title = tagTitle(label, ref?.at, ref?.index ?? 1, count, now)
  return (
    <span className="srctag" title={title} aria-label={title}>
      <Terminal className="icon" aria-hidden="true" />
      <span className="nm">{label}</span>
      {count > 1 && ref && <span className="of">{ref.index}/{count}</span>}
    </span>
  )
}
