import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Copy, FileText, Link2, RotateCcw, X } from 'lucide-react'
import type { Change } from '../../../preload'
import { copyWordingLabel } from '../app/margin-card'
import { SourceTag, relativeTime } from './change-cards'
import { LONG_TEXT_NOTE, intendedOf, num, reasonSentence } from './outside-dock-model'

/**
 * "N could not be placed" (ticket 06, frame `stale`): the popover the review line opens over the status bar.
 * Changes asked for from outside that never reached the text, each with Try again (the existing reopen: it waits
 * again and is checked again), Copy intended text, and Dismiss; Dismiss all at the foot. The functions of the old
 * head row, moved. It decides nothing itself: every action goes through its callbacks.
 */
export type NotPlacedControls = {
  entries: Change[]
  /** The existing Reopen: the change returns to pending and is checked again. */
  onTryAgain: (id: string) => void
  onCopy: (text: string) => void
  onDismiss: (ids: string[]) => void
}

const Excerpt = ({ oldText, newText }: { oldText: string; newText: string }): JSX.Element => {
  if (!oldText) return <i>+ “{newText}”</i>
  if (!newText) return <s>{oldText}</s>
  return <><s>{oldText}</s> <span aria-hidden="true">→</span> <i>{newText}</i></>
}

export function NotPlacedPopover({ controls, onClose }: { controls: NotPlacedControls; onClose: () => void }): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const { entries } = controls
  useEffect(() => { rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [])
  useEffect(() => {
    const away = (event: MouseEvent): void => {
      const target = event.target as HTMLElement
      if (!rootRef.current?.contains(target) && !target.closest('[data-testid="status-review-not-placed"]')) closeRef.current()
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [])
  // The last one dismissed: nothing left to show.
  useEffect(() => { if (entries.length === 0) closeRef.current() }, [entries.length])
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
    event.stopPropagation()
  }
  return (
    <div ref={rootRef} className="rbp rbp-notplaced" role="dialog" aria-modal="false" aria-label="Could not be placed" data-testid="review-not-placed" onKeyDown={onKeyDown}>
      <div className="rnp-h">Could not be placed · nothing in your piece changed</div>
      <div className="rnp-list">
        {entries.map((entry) => {
          const intended = intendedOf(entry)
          // A reader's edit whose words are gone (0.24 ticket 07): the reader's name and link, as text.
          const reader = entry.outsideSource === 'reader' ? entry.readerNote ?? null : null
          const request = entry.outsideRequest
          const at = request ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(request.at)) : null
          return (
            <div key={entry.id} className="rnp-entry nap-entry" data-notplaced-id={entry.id}>
              <div className="nap-top">
                <SourceTag change={entry} />
                {reader && <span className="nap-reader" data-notplaced-reader><b>{reader.name}</b> <span className="mg-link" title="Link"><Link2 className="icon" aria-hidden="true" />{reader.link}</span></span>}
                <span className="nap-when">{at && !reader ? `request of ${at} · ` : ''}{relativeTime(entry.closedAt ?? entry.ts)}</span>
              </div>
              <div className="nap-path"><FileText className="icon" aria-hidden="true" /><span className="fn"><bdi>{entry.path}</bdi></span></div>
              <div className="nap-excerpt"><Excerpt oldText={intended.oldText} newText={intended.newText} /></div>
              {intended.cut && <div className="nap-cut">{LONG_TEXT_NOTE}</div>}
              <div className="nap-reason">{reasonSentence(entry)}</div>
              <div className="nap-actions">
                {!entry.outsideRefused && <button type="button" className="rbp-btn" data-margin-action="try-again" onClick={() => controls.onTryAgain(entry.id)}><RotateCcw className="icon" aria-hidden="true" />Try again</button>}
                {intended.newText !== '' && <button type="button" className="rbp-btn" data-margin-action={reader ? 'copy-wording' : 'copy-intended'} onClick={() => controls.onCopy(intended.newText)}><Copy className="icon" aria-hidden="true" />{reader ? copyWordingLabel(reader.name) : 'Copy intended text'}</button>}
                <button type="button" className="rbp-btn" data-margin-action="dismiss-notplaced" onClick={() => controls.onDismiss([entry.id])}><X className="icon" aria-hidden="true" />Dismiss</button>
              </div>
            </div>
          )
        })}
      </div>
      <button type="button" className="rnp-all" data-margin-action="dismiss-all-notplaced" onClick={() => controls.onDismiss(entries.map((entry) => entry.id))}><X className="icon" aria-hidden="true" />Dismiss all {num(entries.length)}</button>
    </div>
  )
}
