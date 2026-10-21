import { Fragment } from 'react'
import { Inbox } from 'lucide-react'
import type { OutsideSummary } from '../../../preload'
import { allowanceStrip, stripRuns } from './outside-dock-model'

/** The allowance strip at the top of the margin head (nearly full, full, not held, look limit). */
export function AllowanceStrip({ summary }: { summary: OutsideSummary | null }): JSX.Element | null {
  const text = allowanceStrip(summary)
  if (!text) return null
  return (
    <div className="outside-room" role="status">
      <Inbox className="icon" aria-hidden="true" />
      <span>
        {stripRuns(text).map((run, index) => (run.bold ? <b key={index}>{run.text}</b> : <Fragment key={index}>{run.text}</Fragment>))}
      </span>
    </div>
  )
}
