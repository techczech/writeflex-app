import { Fragment } from 'react'
import { Check, Inbox, X } from 'lucide-react'
import type { OutsideSource, OutsideSummary } from '../../../preload'
import { allowanceStrip, stripRuns, type ScopedOutsideSummary } from './outside-dock-model'

/** The allowance strip at the top of the margin head (nearly full, full, not held, look limit). With
 *  `onSourceBulk`, each outside source it is about (never readers) gets Accept all… and Decline all…, which
 *  open the confirm sheet for the whole collection; nothing is decided from the strip itself. */
export function AllowanceStrip({ summary, onSourceBulk }: { summary: OutsideSummary | null; onSourceBulk?: (action: 'accept' | 'decline', source: OutsideSource) => void }): JSX.Element | null {
  const text = allowanceStrip(summary)
  if (!text) return null
  const scoped = summary as ScopedOutsideSummary | null
  const sources = onSourceBulk ? (scoped?.bySource ?? []).filter((row) => row.source !== 'reader' && row.undecided > 0 && (!scoped?.relevantSources || scoped.relevantSources.includes(row.source))) : []
  return (
    <div className="outside-room" role="status">
      <Inbox className="icon" aria-hidden="true" />
      <span>
        {stripRuns(text).map((run, index) => (run.bold ? <b key={index}>{run.text}</b> : <Fragment key={index}>{run.text}</Fragment>))}
        {sources.length > 0 && (
          <span className="outside-room-actions" data-outside-source-actions>
            {sources.map((row) => (
              <Fragment key={row.source}>
                <button type="button" className="mg-btn" data-outside-source-accept={row.source} onClick={() => onSourceBulk?.('accept', row.source)}><Check className="icon" aria-hidden="true" />Accept all from {row.label}…</button>
                <button type="button" className="mg-btn" data-outside-source-decline={row.source} onClick={() => onSourceBulk?.('decline', row.source)}><X className="icon" aria-hidden="true" />Decline all from {row.label}…</button>
              </Fragment>
            ))}
          </span>
        )}
      </span>
    </div>
  )
}
