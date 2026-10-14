import { useEffect, useRef } from 'react'
import { ChevronUp } from 'lucide-react'
import type { StatusBarEvent } from './status-bar-model'

type DisclosureRow = { label: string; value: string }

export type StatusBarDisclosureProps = {
  rows: DisclosureRow[]
  absorbedEvents: StatusBarEvent[]
  absorbedModes: Array<{ id: string; label: string }>
  openRequest: number
  open: boolean
  onOpen: () => void
  onClose: () => void
  onRestoreEditorFocus: () => void
}

export function StatusBarDisclosure({
  rows,
  absorbedEvents,
  absorbedModes,
  openRequest,
  open,
  onOpen,
  onClose,
  onRestoreEditorFocus,
}: StatusBarDisclosureProps): JSX.Element {
  const seenRequest = useRef(openRequest)
  const panelRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLSpanElement>(null)
  const openRef = useRef(open)
  const closeRef = useRef(onClose)
  openRef.current = open
  closeRef.current = onClose
  const absorbedCount = (absorbedEvents.length > 0 ? 1 : 0) + absorbedModes.length

  useEffect(() => () => {
    if (openRef.current) closeRef.current()
  }, [])

  useEffect(() => {
    if (seenRequest.current === openRequest) return
    seenRequest.current = openRequest
    if (open) {
      onClose()
      onRestoreEditorFocus()
    } else onOpen()
  }, [onClose, onOpen, onRestoreEditorFocus, open, openRequest])

  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return
      onClose()
      const target = event.target
      if (!(target instanceof Element) || !target.closest('button,a,input,select,textarea,[tabindex]')) onRestoreEditorFocus()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [onClose, onRestoreEditorFocus, open])

  const close = (): void => {
    onClose()
    onRestoreEditorFocus()
  }

  return (
    <span className="sb-disclosure" ref={rootRef}>
      <button
        type="button"
        className="sb-disclosure-button"
        title="Status details"
        aria-label="Show status details"
        aria-expanded={open}
        onClick={() => open ? close() : onOpen()}
      >
        <ChevronUp aria-hidden="true" />
        {absorbedCount > 0 && <span className="sb-disclosure-badge">{absorbedCount}</span>}
      </button>
      {open && (
        <div
          className="sb-disclosure-popover"
          role="dialog"
          aria-label="Status details"
          ref={panelRef}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            close()
          }}
        >
          {rows.map((row) => (
            <div className="sb-disclosure-row" key={row.label}>
              <span className="key">{row.label}</span>
              <span className="value">{row.value}</span>
            </div>
          ))}
          {absorbedEvents.map((event) => event.onSelect ? (
            <button className="sb-disclosure-row absorbed" key={event.id} type="button" onClick={() => { close(); event.onSelect?.() }}>
              <span className="key">attention</span><span className="value">{event.detailLabel ?? event.label}</span>
            </button>
          ) : (
            <div className="sb-disclosure-row absorbed" key={event.id} data-event-kind={event.kind}>
              <span className="key">attention</span><span className="value">{event.detailLabel ?? event.label}</span>
            </div>
          ))}
          {absorbedModes.map((mode) => (
            <div className="sb-disclosure-row absorbed" key={mode.id}>
              <span className="key">mode</span><span className="value">{mode.label}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  )
}
