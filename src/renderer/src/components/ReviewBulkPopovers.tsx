import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Send, X } from 'lucide-react'
import type { DeclineQuestion, SendBackScope } from '../app/margin-bulk'
import { SourceBulkSheet, type SourceSheet } from './ReviewSourceSheet'

/**
 * The two popovers the review line opens over the status bar (ADR-0046, frames `bulk-decline-confirm` and `send-back`).
 * They decide nothing themselves: Decline all writes only through `onConfirm`, Send back only through `onSend`; Esc,
 * Cancel and a click away call `onCancel` and nothing else.
 */

export type ReviewAsk =
  | { kind: 'decline'; question: DeclineQuestion; onConfirm: () => void; onCancel: () => void }
  | { kind: 'send-back'; scope: SendBackScope; onSend: (note: string) => void; onCancel: () => void }
  /** Accept all / Decline all from one source, across the collection (ReviewSourceSheet.tsx). */
  | { kind: 'outside-source'; sheet: SourceSheet }

/** A click outside the popover cancels it. */
function useClickAway(ref: React.RefObject<HTMLElement | null>, onAway: () => void): void {
  const awayRef = useRef(onAway)
  awayRef.current = onAway
  useEffect(() => {
    const away = (event: MouseEvent): void => { if (!ref.current?.contains(event.target as Node)) awayRef.current() }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [ref])
}

/** "Decline 3 edits?": ↵ confirms (the Decline button holds the focus), Esc cancels. Nothing is written before ↵ or a click on Decline. */
export function DeclineConfirm({ question, onConfirm, onCancel }: { question: DeclineQuestion; onConfirm: () => void; onCancel: () => void }): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const doneRef = useRef(false)
  const confirm = (): void => { if (doneRef.current) return; doneRef.current = true; onConfirm() }
  useEffect(() => { rootRef.current?.querySelector<HTMLButtonElement>('[data-review-confirm-decline]')?.focus() }, [])
  useClickAway(rootRef, onCancel)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); return }
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      // ↵ confirms unless Cancel holds the focus.
      if ((event.target as HTMLElement).closest('[data-review-cancel]')) return
      event.preventDefault(); event.stopPropagation(); confirm()
      return
    }
    event.stopPropagation()
  }
  return (
    <div ref={rootRef} className="rbp rbp-confirm" role="alertdialog" aria-modal="false" aria-labelledby="rbp-confirm-title" aria-describedby="rbp-confirm-detail" data-testid="review-decline-confirm" onKeyDown={onKeyDown}>
      <div className="rbp-h"><X className="icon dz" aria-hidden="true" /><b id="rbp-confirm-title">{question.title}</b></div>
      {question.detail && <p className="rbp-p" id="rbp-confirm-detail" data-review-confirm-detail>{question.detail}</p>}
      <p className="rbp-p sm">{question.reassurance}</p>
      <div className="rbp-actions">
        <button type="button" className="rbp-btn danger" data-review-confirm-decline onClick={confirm}><X className="icon" aria-hidden="true" />Decline {question.count}<kbd>↵</kbd></button>
        <button type="button" className="rbp-btn" data-review-cancel onClick={onCancel}>Cancel<kbd>Esc</kbd></button>
      </div>
    </div>
  )
}

/** Send back to the agent: one note with the agent's waiting items. ⌘↵ sends, Esc cancels; an empty note sends nothing. */
export function SendBackPopover({ scope, onSend, onCancel }: { scope: SendBackScope; onSend: (note: string) => void; onCancel: () => void }): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [note, setNote] = useState('')
  useClickAway(rootRef, onCancel)
  const send = (): void => { if (note.trim()) onSend(note) }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); return }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); send(); return }
    event.stopPropagation()
  }
  return (
    <div ref={rootRef} className="rbp rbp-sendback" role="dialog" aria-modal="false" aria-labelledby="rbp-sendback-title" data-testid="review-send-back" onKeyDown={onKeyDown}>
      <div className="rbp-h"><Send className="icon" aria-hidden="true" /><b id="rbp-sendback-title">Send back to the agent</b></div>
      <p className="rbp-p" data-review-send-back-scope>{scope.text}</p>
      <textarea value={note} autoFocus rows={3} aria-label="Note for the agent" placeholder="What should the agent change?" onChange={(event) => setNote(event.target.value)} />
      <div className="rbp-actions">
        <button type="button" className="rbp-btn primary" data-review-send disabled={note.trim() === ''} onClick={send}><Send className="icon" aria-hidden="true" />Send back<kbd>⌘↵</kbd></button>
        <button type="button" className="rbp-btn" data-review-cancel onClick={onCancel}>Cancel<kbd>Esc</kbd></button>
      </div>
    </div>
  )
}

/** The one popover the review line holds, if any. */
export function ReviewAskPopover({ ask }: { ask: ReviewAsk }): JSX.Element {
  return (
    <div className="rbp-wrap" data-review-ask={ask.kind}>
      {ask.kind === 'decline'
        ? <DeclineConfirm question={ask.question} onConfirm={ask.onConfirm} onCancel={ask.onCancel} />
        : ask.kind === 'outside-source'
          ? <SourceBulkSheet sheet={ask.sheet} />
          : <SendBackPopover scope={ask.scope} onSend={ask.onSend} onCancel={ask.onCancel} />}
    </div>
  )
}
