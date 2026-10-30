import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Check, CheckCheck, X } from 'lucide-react'
import type { OutsideSource } from '../../../preload'
import type { OutsideSourceRow, SourceBulkAction, SourceBulkQuestion, SourceBulkResult } from '../app/outside-source-bulk'

/**
 * Accept all / Decline all from one source, across the collection: the confirm sheet over the review line, in the
 * look of the margin's Decline all (`DeclineConfirm`). It decides nothing itself: only ↵ or a click on the confirm
 * button runs `onConfirm`; Esc, Cancel and a click away run `onCancel`. With more than one source waiting, the
 * sources are a row of choices (← → move between them). After the run it shows what was done until closed.
 */
export type SourceSheet = {
  action: SourceBulkAction
  rows: OutsideSourceRow[]
  source: OutsideSource
  question: SourceBulkQuestion
  running: boolean
  result: SourceBulkResult | null
  onPickSource: (source: OutsideSource) => void
  onConfirm: () => void
  onCancel: () => void
}

export function SourceBulkSheet({ sheet }: { sheet: SourceSheet }): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const cancelRef = useRef(sheet.onCancel)
  cancelRef.current = sheet.onCancel
  const { action, rows, source, question, running, result } = sheet
  const accept = action === 'accept'
  useEffect(() => {
    rootRef.current?.querySelector<HTMLButtonElement>(result ? '[data-review-source-close]' : '[data-review-source-confirm]')?.focus()
  }, [result, source])
  useEffect(() => {
    const away = (event: MouseEvent): void => { if (!rootRef.current?.contains(event.target as Node)) cancelRef.current() }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [])
  const pick = (step: 1 | -1): void => {
    const index = rows.findIndex((row) => row.source === source)
    const next = rows[(index + step + rows.length) % rows.length]
    if (next && next.source !== source) sheet.onPickSource(next.source)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); sheet.onCancel(); return }
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      if ((event.target as HTMLElement).closest('[data-review-cancel]')) return
      event.preventDefault(); event.stopPropagation()
      if (result) sheet.onCancel()
      else if (!running && question.count > 0) sheet.onConfirm()
      return
    }
    if (!result && !running && rows.length > 1 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault(); event.stopPropagation(); pick(event.key === 'ArrowRight' ? 1 : -1)
      return
    }
    event.stopPropagation()
  }
  if (result) {
    return (
      <div ref={rootRef} className="rbp rbp-confirm rbp-source" role="dialog" aria-modal="false" aria-labelledby="rbp-source-title" data-testid="review-source-result" onKeyDown={onKeyDown}>
        <div className="rbp-h"><CheckCheck className="icon" aria-hidden="true" /><b id="rbp-source-title">{result.title}</b></div>
        {result.lines.length > 0 && (
          <ul className="rbp-source-lines" data-review-source-lines>
            {result.lines.map((line, index) => <li key={index}>{line}</li>)}
          </ul>
        )}
        <div className="rbp-actions">
          <button type="button" className="rbp-btn" data-review-source-close onClick={sheet.onCancel}>Close<kbd>↵</kbd></button>
        </div>
      </div>
    )
  }
  return (
    <div ref={rootRef} className="rbp rbp-confirm rbp-source" role="alertdialog" aria-modal="false" aria-labelledby="rbp-source-title" aria-describedby="rbp-source-detail" data-testid="review-source-confirm" data-review-source-action={action} onKeyDown={onKeyDown}>
      <div className="rbp-h">{accept ? <Check className="icon" aria-hidden="true" /> : <X className="icon dz" aria-hidden="true" />}<b id="rbp-source-title">{question.title}</b></div>
      {rows.length > 1 && (
        <div className="rbp-source-pick" role="radiogroup" aria-label="From">
          {rows.map((row) => (
            <button
              key={row.source}
              type="button"
              role="radio"
              aria-checked={row.source === source}
              className="rbp-btn rbp-source-choice"
              data-review-source-choice={row.source}
              disabled={running}
              onClick={() => sheet.onPickSource(row.source)}
            >
              {row.label}<span className="rbp-source-n">{row.undecided.toLocaleString('en-GB')}</span>
            </button>
          ))}
        </div>
      )}
      <p className="rbp-p" id="rbp-source-detail" data-review-source-detail>{question.detail}</p>
      <p className="rbp-p sm">{question.reassurance}</p>
      <div className="rbp-actions">
        <button type="button" className={`rbp-btn ${accept ? 'primary' : 'danger'}`} data-review-source-confirm disabled={running || question.count === 0} onClick={sheet.onConfirm}>
          {accept ? <Check className="icon" aria-hidden="true" /> : <X className="icon" aria-hidden="true" />}
          {running ? (accept ? 'Accepting…' : 'Declining…') : `${accept ? 'Accept' : 'Decline'} ${question.count.toLocaleString('en-GB')}`}
          {!running && <kbd>↵</kbd>}
        </button>
        <button type="button" className="rbp-btn" data-review-cancel disabled={running} onClick={sheet.onCancel}>Cancel<kbd>Esc</kbd></button>
      </div>
    </div>
  )
}
