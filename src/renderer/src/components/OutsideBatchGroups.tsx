import { useEffect, useMemo, useRef, useState } from 'react'
import { groupOutsideReview, pendingOutsideBatchChange, type BatchResult, type BatchTarget, type OutsideGrouping, type OutsideReviewGroup } from '../../../shared/outside-batch-review'
import type { Change } from '../../../preload'
import { diffSegments } from '../app/margin-card'

export type ElsewhereView = 'documents' | OutsideGrouping
export type BatchAction = 'accept' | 'reject' | 'clear'
const PREVIEW_COUNT = 5
const ACTION_LABEL: Record<BatchAction, string> = { accept: 'Accept all', reject: 'Reject all', clear: 'Clear' }

export function useMissingOutsidePaths(changes: Change[]): { missing: ReadonlySet<string>; checked: boolean; error: string } {
  const paths = useMemo(() => [...new Set(changes.filter(pendingOutsideBatchChange).map(change => change.path))].sort(), [changes])
  const [diskRevision, setDiskRevision] = useState(0)
  useEffect(() => window.writeflex.onCollectionChanged(() => setDiskRevision(value => value + 1)), [])
  const key = JSON.stringify(paths)
  const [answer, setAnswer] = useState<{ key: string; missing: ReadonlySet<string>; error: string }>({ key: '', missing: new Set(), error: '' })
  useEffect(() => {
    let cancelled = false
    void window.writeflex.missingOutsideBatchPaths(JSON.parse(key) as string[]).then(
      paths => { if (!cancelled) setAnswer({ key, missing: new Set(paths), error: '' }) },
      () => { if (!cancelled) setAnswer({ key, missing: new Set(), error: 'Could not check which documents are available.' }) },
    )
    return () => { cancelled = true }
  }, [key, diskRevision])
  return { missing: answer.missing, checked: answer.key === key && !answer.error, error: answer.error }
}

function ProposalPreview({ change, onOpen }: { change: Change; onOpen: () => void }): JSX.Element {
  const diff = useMemo(() => diffSegments(change.oldText, change.newText), [change.oldText, change.newText])
  return (
    <article className="rel-proposal">
      <div className="rel-proposal-title">
        <b title={change.path}>{change.path}</b>
        <button type="button" className="rbp-btn" aria-label={`Review ${change.summary} in ${change.path}`} onClick={onOpen}>Review</button>
      </div>
      <div className="rel-proposal-summary">{change.summary}</div>
      <div className="rel-proposal-diff" aria-label="Proposed differences">
        {change.editClass === 'move' ? <><del>{change.oldText}</del><span>{'\nMove after: '}</span><ins>{change.outsideMoveAfter ?? 'recorded destination'}</ins></>
          : diff.map(({ kind, text }, index) => kind === 'del' ? <del key={index}>{text}</del>
            : kind === 'ins' ? <ins key={index}>{text}</ins> : <span key={index}>{text}</span>)}
      </div>
    </article>
  )
}

function Group({ group, isOpen, busy, onToggle, onAsk, onOpen }: {
  group: OutsideReviewGroup
  isOpen: boolean
  busy: boolean
  onToggle: () => void
  onAsk: (action: BatchAction, group: OutsideReviewGroup) => void
  onOpen: (path: string, id: string) => void
}): JSX.Element {
  const [limit, setLimit] = useState(PREVIEW_COUNT)
  const documents = new Set(group.changes.map(change => change.path)).size
  const count = group.changes.length
  return (
    <section className="rel-group">
      <div className="rel-group-header">
        <button type="button" className="rel-group-toggle" aria-expanded={isOpen} onClick={onToggle}>
          <span>
            <span className="rel-disclosure" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
            <b>{group.title}</b>
            {group.detail && <small>{group.detail}</small>}
          </span>
          <span className="rel-count">{count} {count === 1 ? 'proposal' : 'proposals'} · {documents} {documents === 1 ? 'document' : 'documents'}</span>
        </button>
        {group.missing && <button type="button" className="rbp-btn" disabled={busy} onClick={() => onAsk('clear', group)}>Clear</button>}
      </div>
      {isOpen && (group.missing ? (
        <div className="rel-group-body">
          <ul className="rel-missing">{[...new Set(group.changes.map(change => change.path))].map(path => <li key={path}>{path}</li>)}</ul>
        </div>
      ) : (
        <div className="rel-group-body">
          <div className="rel-preview">
            {group.changes.slice(0, limit).map(change =>
              <ProposalPreview key={change.id} change={change} onOpen={() => onOpen(change.path, change.id)} />)}
          </div>
          <div className="rel-group-actions">
            <div className="rel-pagination">
              <span>Showing {Math.min(limit, count)} of {count}</span>
              {limit < count && <button type="button" className="rbp-btn" onClick={() => setLimit(limit + PREVIEW_COUNT)}>Show {Math.min(PREVIEW_COUNT, count - limit)} more</button>}
            </div>
            <button type="button" className="rbp-btn" disabled={busy} onClick={() => onAsk('reject', group)}>Reject all</button>
            <button type="button" className="rbp-btn primary" disabled={busy} onClick={() => onAsk('accept', group)}>Accept all</button>
          </div>
        </div>
      ))}
    </section>
  )
}

export function OutsideBatchGroups({ changes, view, missing, checked, onBatch, onSummary, onOpen }: {
  changes: Change[]
  view: ElsewhereView
  missing: ReadonlySet<string>
  checked: boolean
  onBatch: (action: BatchAction, targets: BatchTarget[]) => Promise<BatchResult>
  onSummary: (summary: string) => void
  onOpen: (path: string, id: string) => void
}): JSX.Element {
  const groups = useMemo(() => groupOutsideReview(changes, view === 'documents' ? 'source' : view, missing)
    .filter(group => view !== 'documents' || group.missing), [changes, view, missing])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [ask, setAsk] = useState<{ action: BatchAction; group: OutsideReviewGroup } | null>(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<{ message: string; left: BatchResult['left'] } | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const askedDocuments = ask ? new Set(ask.group.changes.map(change => change.path)).size : 0
  const individualOnly = changes.filter(change => change.outsideSource &&
    (change.status === 'pending' || change.status === 'held') && !pendingOutsideBatchChange(change)).length
  useEffect(() => { if (ask) cancelRef.current?.focus() }, [ask])
  const cancel = () => { setAsk(null); trigger.current?.focus() }
  const run = async (action: BatchAction, group: OutsideReviewGroup) => {
    if (busy) return
    if (ask) cancel()
    setBusy(true)
    setReport(null)
    try {
      const result = await onBatch(action, group.changes.map(({ id, path }) => ({ id, path })))
      const actionWord = action === 'accept' ? 'Accepted' : action === 'reject' ? 'Rejected' : 'Cleared'
      const message = `${actionWord} ${result.decided} of ${group.changes.length} proposals.${result.left.length ? ` ${result.left.length} left undecided.` : ''}`
      setReport({ message, left: result.left })
      onSummary(message)
    } catch (error) {
      setReport({ message: error instanceof Error ? error.message : 'Could not decide this batch.', left: [] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {ask && <div className="rel-confirm" role="alertdialog" aria-label={`${ACTION_LABEL[ask.action]} proposals?`}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); cancel() } }}>
        <b>{ACTION_LABEL[ask.action]} {ask.group.changes.length} {ask.group.changes.length === 1 ? 'proposal' : 'proposals'}?</b>
        <p>{ask.group.title} · {askedDocuments} {askedDocuments === 1 ? 'document' : 'documents'}</p>
        <p>{ask.action === 'accept' ? 'Each edit is checked against the current text. History keeps a restore point before each edit.' :
          ask.action === 'clear' ? 'This removes the proposals from pending review and records that their documents were missing.' :
            'This rejects the selected proposals. No document text is changed.'}</p>
        <div className="rel-group-actions">
          <button type="button" ref={cancelRef} className="rbp-btn" onClick={cancel}>Cancel</button>
          <button type="button" className="rbp-btn primary" onClick={() => void run(ask.action, ask.group)}>{ACTION_LABEL[ask.action]}</button>
        </div>
      </div>}
      {busy && <div role="status" className="rel-report">Deciding proposals…</div>}
      {report && <div role="status" className="rel-report">{report.message}
        {report.left.length > 0 && <details><summary>See what happened</summary>
          <ul>{report.left.map(item => <li key={item.id}><b>{item.path}</b> {item.reason}</li>)}</ul>
        </details>}
      </div>}
      {groups.length === 0 && view !== 'documents' && !busy && checked && <p className="rnp-hint">No proposals available for batch review.</p>}
      {view !== 'documents' && individualOnly > 0 && <p className="rnp-hint">{individualOnly} {individualOnly === 1 ? 'proposal needs' : 'proposals need'} individual review in Documents.</p>}
      {groups.map(group => <Group key={group.key} group={group} busy={busy || !checked || ask !== null}
        isOpen={expanded === group.key} onToggle={() => setExpanded(expanded === group.key ? null : group.key)}
        onAsk={(action, group) => {
          trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          setAsk({ action, group })
        }}
        onOpen={onOpen} />)}
    </>
  )
}
