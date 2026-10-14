import { useEffect, useRef } from 'react'
import { CornerDownLeft, X } from 'lucide-react'

export type InsertQueryConfirmProps = {
  label: string
  source: string
  disabledReason: string | null
  notice?: string
  onConfirm: () => void
  onClose: () => void
}

/** The source is the promise: this bubble shows the exact portable Query before it touches prose. */
export function InsertQueryConfirm({ label, source, disabledReason, notice, onConfirm, onClose }: InsertQueryConfirmProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    dialogRef.current?.focus()
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      } else if (event.key === 'Enter' && document.activeElement === dialogRef.current && disabledReason === null) {
        event.preventDefault()
        event.stopPropagation()
        onConfirm()
      }
    }
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [disabledReason, onClose, onConfirm])

  return (
    <div ref={dialogRef} tabIndex={-1} className="insert-query-confirm" role="dialog" aria-modal="false" aria-label={`Insert ${label} as query`}>
      <div className="insert-query-confirm-head">
        <div><span>Insert as query</span><strong>{label}</strong></div>
        <button type="button" aria-label="Cancel query insertion" onClick={onClose}><X aria-hidden="true" /></button>
      </div>
      <pre>{source}</pre>
      {notice && <p className="insert-query-notice">{notice}</p>}
      {disabledReason && <p className="insert-query-disabled" role="status">{disabledReason}</p>}
      <div className="insert-query-confirm-actions">
        <button type="button" className="cbtn" onClick={onClose}>Cancel</button>
        <button type="button" className="cbtn primary" disabled={disabledReason !== null} onClick={onConfirm}>
          <CornerDownLeft aria-hidden="true" /> Insert query
        </button>
      </div>
    </div>
  )
}
