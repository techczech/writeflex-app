import { useEffect, useRef, useState } from 'react'
import type { ConfirmSpec } from '../../../shared/confirm-card'
import { askConfirm, registerConfirmHost, settleConfirm, type PendingConfirm } from './confirm-bus'

/**
 * The one confirm card (R11). Names the item (the title), says what is replaced or where it goes (the detail) and
 * how to get it back (the recovery line). Cancel is on the left and takes the focus, so Enter on it never confirms;
 * the red verb is on the right and runs only when pressed or focused and activated. Esc cancels.
 */
export function ConfirmCard({ spec, onConfirm, onCancel }: { spec: ConfirmSpec; onConfirm: () => void; onCancel: () => void }): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { cancelRef.current?.focus() }, [])
  return (
    <div className="overlay confirm-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <div
        className="confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-detail"
        data-testid="confirm-card"
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
          else if (event.key === 'Tab') {
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
            const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
            if (buttons.length) { event.preventDefault(); buttons[(at + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]!.focus() }
          }
        }}
      >
        <h2 id="confirm-title">{spec.title}</h2>
        <p id="confirm-detail" className="confirm-detail">{spec.detail}</p>
        <p className="confirm-recover" data-testid="confirm-recover">{spec.recover}</p>
        <div className="confirm-actions">
          <button type="button" ref={cancelRef} className="btn confirm-cancel" data-testid="confirm-cancel" onClick={onCancel}>{spec.cancelLabel ?? 'Cancel'}</button>
          <button type="button" className={`btn confirm-go ${spec.tone === 'neutral' ? 'neutral' : 'danger'}`} data-testid="confirm-go" onClick={onConfirm}>{spec.confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

/** Mounted once at the app root: draws the card for `askConfirm` and for requests main sends. */
export function ConfirmHost(): JSX.Element | null {
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  useEffect(() => {
    registerConfirmHost(setPending)
    return () => registerConfirmHost(null)
  }, [])
  useEffect(() => window.writeflex.onConfirmAsk?.((ask) => {
    void askConfirm(ask.spec).then((ok) => window.writeflex.answerConfirm(ask.id, ok))
  }), [])
  if (!pending) return null
  // Keyed by the request: a queued card is a new card, so its Cancel takes the focus (Sol S2).
  return <ConfirmCard key={pending.id} spec={pending.spec} onConfirm={() => settleConfirm(true)} onCancel={() => settleConfirm(false)} />
}
