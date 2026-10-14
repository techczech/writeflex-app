import { useEffect, useRef } from 'react'
import { AlertTriangle, LoaderCircle } from 'lucide-react'
import type { StatusBarEvent } from './status-bar-model'

export type StatusBarEventsProps = {
  events: StatusBarEvent[]
  open: boolean
  onOpen: () => void
  onClose: () => void
  onRestoreEditorFocus: () => void
}

export function StatusBarEvents({ events, open, onOpen, onClose, onRestoreEditorFocus }: StatusBarEventsProps): JSX.Element | null {
  const slotRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const openRef = useRef(open)
  const closeRef = useRef(onClose)
  openRef.current = open
  closeRef.current = onClose

  useEffect(() => () => {
    if (openRef.current) closeRef.current()
  }, [])

  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
    const outside = (event: PointerEvent): void => {
      if (slotRef.current?.contains(event.target as Node)) return
      onClose()
      const target = event.target
      if (!(target instanceof Element) || !target.closest('button,a,input,select,textarea,[tabindex]')) onRestoreEditorFocus()
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [onClose, onRestoreEditorFocus, open])

  if (events.length === 0) return null
  const only = events[0]
  const label = events.length === 1 ? only.label : `${events.length} attention events`
  const outboxKind = events.length === 1 && only.kind.startsWith('zotero-')
    ? only.kind.replace('zotero-', '')
    : undefined

  return (
    <span className="sb-event-slot" ref={slotRef}>
      <button
        type="button"
        className={`sb-event-chip${outboxKind ? ' sb-outbox' : ''}${only.glyphOnly && events.length === 1 ? ' glyph' : ''}`}
        data-outbox-kind={outboxKind}
        data-event-kind={events.length === 1 ? only.kind : 'multiple'}
        title={events.length === 1 ? only.title : label}
        aria-label={label}
        aria-expanded={events.length > 1 ? open : undefined}
        onClick={() => {
          if (events.length > 1) open ? onClose() : onOpen()
          else only.onSelect?.()
        }}
      >
        {only.kind === 'save-pending'
          ? <LoaderCircle className="icon" aria-hidden="true" />
          : only.kind === 'save-failed'
            ? <AlertTriangle className="icon" aria-hidden="true" />
            : null}
        {(!only.glyphOnly || events.length > 1) && <span className="sb-event-label">{label}</span>}
      </button>
      {open && events.length > 1 && (
        <div
          className="sb-event-list"
          role="menu"
          aria-label="Attention events"
          ref={panelRef}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            onClose()
            onRestoreEditorFocus()
          }}
        >
          {events.map((event) => event.onSelect ? (
            <button key={event.id} type="button" role="menuitem" onClick={() => { onClose(); event.onSelect?.() }}>
              <span>{event.detailLabel ?? event.label}</span>
            </button>
          ) : (
            <span key={event.id} role="menuitem" data-event-kind={event.kind}>{event.detailLabel ?? event.label}</span>
          ))}
        </div>
      )}
    </span>
  )
}
