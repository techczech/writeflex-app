// The Limits panel (0.24 ticket 07; spec 6.1 "Limits reached"; locked frame `problems`, "Limit reached:
// 14 notes refused"): a row in the right column of the Sharing page when readers on a link ran into a
// limit since the writer last acted on it, with its three actions: Clear handled notes, Raise the limit
// for this link, Turn comments off. Main decides every figure (sharing-piece-ipc.ts `sharing:notes`) and
// acts only on a link this window's page has bound; the panel draws and asks.
import { Ban, Eraser, Gauge, MessageSquare, TriangleAlert } from 'lucide-react'
import { RAISE_AT_MOST, countLabel, limitHeading, limitText, type LimitReached } from '../../../../shared/sharing-notes'

export function LimitsPanel({ linkName, limit, comments, busy, onClear, onRaise, onCommentsOff }: {
  linkName: string
  limit: LimitReached
  /** Readers can leave notes on this link now (Turn comments off is offered only then). */
  comments: boolean
  busy: string | null
  onClear: () => void
  onRaise: () => void
  onCommentsOff: () => void
}): JSX.Element {
  return (
    <div className="shr-panel problem" data-problem="limit-reached" data-testid="sharing-limits">
      <div className="shr-panel-h"><TriangleAlert className="icon" aria-hidden="true" /><span>{limitHeading(limit)}</span></div>
      <div className="shr-panel-b">
        <p className="shr-p" data-testid="sharing-limits-text">{limitText(linkName, limit).map((run, index) => (run.bold ? <b key={index}>{run.text}</b> : <span key={index}>{run.text}</span>))}</p>
        <div className="shr-row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" className="shr-btn small" disabled={busy !== null} onClick={onClear}><Eraser className="icon" aria-hidden="true" />{busy === 'clear' ? 'Clearing…' : 'Clear handled comments'}</button>
          <button type="button" className="shr-btn small" disabled={busy !== null || !limit.raisable} title={limit.raisable ? undefined : RAISE_AT_MOST} onClick={onRaise}><Gauge className="icon" aria-hidden="true" />{busy === 'raise' ? 'Raising…' : 'Raise the limit for this link'}</button>
          {comments && <button type="button" className="shr-btn small" disabled={busy !== null} onClick={onCommentsOff}><Ban className="icon" aria-hidden="true" />Turn comments off</button>}
        </div>
      </div>
    </div>
  )
}

/** The Notes waiting cell (frames `shared-one`, `shares-list`): the count, with the note mark when some wait. */
export function WaitingCell({ count, shareId }: { count: number | null | undefined; shareId: string }): JSX.Element {
  const hot = typeof count === 'number' && count > 0
  return (
    <span role="cell" className={`shr-num${hot ? ' hot' : ''}`} data-notes-waiting={shareId}>
      {hot && <MessageSquare className="icon" aria-hidden="true" />}{countLabel(count)}
    </span>
  )
}
