// Remove sharing from this account (sharing ticket 02): the one control for it, used wherever the app
// offers removal (rule R4): Settings › Sharing when set up, when an interrupted set-up already wrote on
// the account, and when a removal did not finish (Retry); and the set-up page's locked-account
// message.
//
// Rule R3: the confirmation is asked for when the question is shown, and main binds it to the removal
// the question names (sharing-removal.ts); the question names the account main reported with it. A
// removal that stops at a service this Mac cannot confirm as its own comes back with the
// confirmation for "Remove it anyway", bound to what was found; nothing here can make one.
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import type { SharingResult, SharingSetupStatus } from '../../../../shared/sharing-setup'
import { ProblemBox, type Failure } from './SharingSetup'

type Asked = { confirmation: string; accountName: string | null }
type Stopped = Failure & { anywayConfirmation?: string }

export type RemoveSharingProps = {
  /** A removal that did not finish: one Retry button, its confirmation asked for as it is shown. */
  retry?: boolean
  /** Every answer's status. */
  onStatus: (status: SharingSetupStatus) => void
  onRemoved: (notice: string) => void
  /** Smaller buttons (the set-up page). */
  small?: boolean
}

export function RemoveSharing({ retry = false, onStatus, onRemoved, small = false }: RemoveSharingProps): JSX.Element {
  const [question, setQuestion] = useState<Asked | null>(null)
  const [stopped, setStopped] = useState<Stopped | null>(null)
  const [busy, setBusy] = useState(false)
  const size = small ? ' small' : ''

  /** Ask main for the confirmation of the question now shown. */
  const ask = useCallback(() => {
    setQuestion(null)
    void window.writeflex.sharing.removalConfirmation().then((issued) => {
      if (issued.confirmation) setQuestion({ confirmation: issued.confirmation, accountName: issued.accountName })
    }).catch(() => {})
  }, [])
  // Retry is its own question: shown, so confirmed for what it shows.
  useEffect(() => { if (retry) ask() }, [retry, ask])

  const send = useCallback(async (confirmation: string) => {
    setBusy(true)
    setStopped(null)
    setQuestion(null)
    try {
      const result: SharingResult = await window.writeflex.sharing.remove({ confirmation })
      onStatus(result.status)
      if (result.ok) { onRemoved(result.notice ?? 'Sharing was removed.'); return }
      setStopped({ problem: result.problem, details: result.details, ...(result.removeAnyway && result.anywayConfirmation ? { anywayConfirmation: result.anywayConfirmation } : {}) })
      // Retry asks for its next confirmation now, except while "Remove it anyway" is on offer: "Keep it"
      // asks then, and Retry is usable again.
      if (retry && result.status.removalPending && !result.removeAnyway) ask()
    } catch {
      setStopped({ problem: { reason: 'That did not work.', fix: 'Try again.' } })
    } finally { setBusy(false) }
  }, [onStatus, onRemoved, retry, ask])

  const anyway = stopped?.anywayConfirmation
  return (
    <>
      {stopped && (
        <ProblemBox failure={stopped}>
          {anyway && <>
            <button type="button" className="shr-btn danger small" disabled={busy} onClick={() => void send(anyway)}><Trash2 className="icon" aria-hidden="true" />{busy ? 'Removing…' : 'Remove it anyway'}</button>
            <button type="button" className="shr-btn small" disabled={busy} onClick={() => { setStopped(null); if (retry) ask() }}>Keep it</button>
          </>}
        </ProblemBox>
      )}
      {retry
        ? (
          <div className="shr-row">
            <button type="button" className={`shr-btn danger${size}`} disabled={busy || question === null} onClick={() => question && void send(question.confirmation)}><RefreshCw className="icon" aria-hidden="true" />{busy ? 'Removing…' : 'Retry'}</button>
          </div>
        )
        : question === null
          ? <div className="shr-row"><button type="button" className={`shr-btn danger${size}`} disabled={busy} onClick={() => { setStopped(null); ask() }}><Trash2 className="icon" aria-hidden="true" />{busy ? 'Removing…' : 'Remove sharing from this account'}</button></div>
          : (
            <div className="shr-row" role="group" aria-label="Confirm removing sharing">
              <span className="shr-p"><b>Remove sharing from {question.accountName ?? 'your Cloudflare account'}?</b> This cannot be undone.</span>
              <button type="button" className={`shr-btn danger${size}`} disabled={busy} onClick={() => void send(question.confirmation)}><Trash2 className="icon" aria-hidden="true" />Remove sharing</button>
              <button type="button" className={`shr-btn${size}`} disabled={busy} onClick={() => setQuestion(null)}>Keep sharing</button>
            </div>
          )}
    </>
  )
}
