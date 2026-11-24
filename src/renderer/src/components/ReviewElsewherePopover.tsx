import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpRight, FileText, SkipForward } from 'lucide-react'
import { elsewhereRows, waitingInOtherPieces, REVIEW_ELSEWHERE_HELP } from './status-bar-model'
import type { OtherPiece } from '../app/margin-model'
import type { Change } from '../../../preload'
import type { BatchResult, BatchTarget } from '../../../shared/outside-batch-review'
import { OutsideBatchGroups, useMissingOutsidePaths, type ElsewhereView } from './OutsideBatchGroups'
import './review-elsewhere.css'

const VIEWS: Array<{ value: ElsewhereView; label: string }> = [
  { value: 'documents', label: 'Documents' }, { value: 'source', label: 'Source' },
  { value: 'kind', label: 'Kind' }, { value: 'folder', label: 'Folder' },
]

/**
 * "Waiting in N other pieces" (ticket 07, frame `elsewhere`): the popover the review line opens. One row per piece with
 * its count, who it is from and its first item's words, an Open button, and Next document with changes to review (the chord
 * beside it). It decides nothing itself: Open and Next piece go through callbacks.
 */
export type ElsewhereControls = {
  pieces: OtherPiece[]
  changes: Change[]
  onBatch: (action: 'accept' | 'reject' | 'clear', targets: BatchTarget[]) => Promise<BatchResult>
  onBatchSummary: (summary: string) => void
  onOpen: (path: string, firstId: string) => void
  onNextPiece: () => void
  nextPieceChord: string
}

export function ElsewherePopover({ controls, onClose }: { controls: ElsewhereControls; onClose: () => void }): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [view, setView] = useState<ElsewhereView>('documents')
  const { missing, checked, error } = useMissingOutsidePaths(controls.changes)
  const rows = elsewhereRows(controls.pieces)
  const available = rows.filter(row => !missing.has(row.path))
  const openOne = (path: string, id: string) => { onClose(); controls.onOpen(path, id) }
  const heading = waitingInOtherPieces(rows.length)
  useEffect(() => {
    const root = rootRef.current
    const first = root?.querySelector<HTMLButtonElement>('[data-margin-action="open-piece"]') ?? root?.querySelector<HTMLButtonElement>('button')
    first?.focus()
  }, [])
  const firstPath = available[0]?.path
  useEffect(() => {
    if (view === 'documents' && firstPath && document.activeElement === document.body) {
      rootRef.current?.querySelector<HTMLButtonElement>('[data-margin-action="open-piece"]')?.focus()
    }
  }, [firstPath, view])
  useEffect(() => {
    const away = (event: MouseEvent): void => {
      const target = event.target as HTMLElement
      if (!rootRef.current?.contains(target) && !target.closest('[data-testid="status-review-elsewhere"]')) closeRef.current()
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [])
  useEffect(() => { if (rows.length === 0) closeRef.current() }, [rows.length])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
    event.stopPropagation()
  }
  return (
    <div ref={rootRef} className="rbp rbp-elsewhere" role="dialog" aria-modal="false" aria-label={heading} data-testid="review-elsewhere" onKeyDown={onKeyDown}>
      <div className="rnp-h">{heading}</div>
      <p className="rnp-hint">{REVIEW_ELSEWHERE_HELP}</p>
      <div className="rel-views" role="group" aria-label="Group proposals by">
        {VIEWS.map(item => <button type="button" key={item.value} aria-pressed={view === item.value} onClick={() => setView(item.value)}>{item.label}</button>)}
      </div>
      {error && <p role="status" className="rnp-hint">{error}</p>}
      {!checked && view !== 'documents' && !error && <p className="rnp-hint" role="status">Checking documents…</p>}
      <OutsideBatchGroups changes={controls.changes} view={view} missing={missing} checked={checked}
        onBatch={controls.onBatch} onSummary={controls.onBatchSummary} onOpen={openOne} />
      {view === 'documents' && <div className="rnp-list">
        {available.map((row) => (
          <div key={row.path} className="rel-row" data-elsewhere-piece={row.path}>
            <FileText className="icon" aria-hidden="true" />
            <div className="rel-main">
              <b title={row.path}>{row.name}</b>
              <span>{row.sources}</span>
              {row.first && <span>{row.first}</span>}
            </div>
            <span className="rel-n">{row.count} {row.count === 1 ? 'change' : 'changes'}</span>
            <button type="button" className="rbp-btn" data-margin-action="open-piece" aria-label={`Open ${row.name}`} onClick={() => openOne(row.path, row.firstId)}><ArrowUpRight className="icon" aria-hidden="true" />Open</button>
          </div>
        ))}
      </div>}
      {view === 'documents' && available.length > 0 && <button type="button" className="rel-next" data-margin-action="next-piece" onClick={() => { onClose(); controls.onNextPiece() }}>
        <SkipForward className="icon" aria-hidden="true" />
        <span>Next document with changes to review</span>
        {controls.nextPieceChord && <kbd className="sb-review-kbd">{controls.nextPieceChord}</kbd>}
      </button>}
    </div>
  )
}
