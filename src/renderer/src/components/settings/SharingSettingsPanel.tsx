// Settings › Sharing (sharing ticket 02; locked frame `settings`). After set-up the token is changed
// only here. This ticket's rows: the Cloudflare account and token (Replace token, Check token), the
// sharing service and its build (Update), what the service is doing now, and Remove sharing from this
// account; the own-address card (ticket 05, components/sharing/OwnAddress.tsx). "New links start with" (ticket 03) and the counts of
// links, notes and other Macs (tickets 03, 07, 10) are added by those tickets.
//
// Remove (components/sharing/RemoveSharing.tsx) is offered wherever this Mac wrote on the account
// (rule R4): set up, an interrupted set-up that already wrote, and a removal that did not finish
// (Retry, never "not set up"). A removal that did not finish always shows the token row above Retry:
// open (paste, Check) when the token is missing or rejected; otherwise Replace token and Check token,
// for a saved token that turns out to lack a permission when Retry is pressed.
import { useCallback, useEffect, useState } from 'react'
import { Cloud, Download, KeyRound, RefreshCw, Server, ShieldCheck, Trash2, Link } from 'lucide-react'
import { REMOVAL_PENDING, UPLOAD_UNCONFIRMED, type SharingResult, type SharingSetupStatus } from '../../../../shared/sharing-setup'
import { ProblemBox } from '../sharing/SharingSetup'
import { RemoveSharing } from '../sharing/RemoveSharing'
import { shortTime } from '../sharing/sharing-view-model'
import { OwnAddressCard } from '../sharing/OwnAddress'

type Failure = { problem: { reason: string; fix: string }; details?: string }

export function SharingSettingsPanel({ onOpenSetup, onFlash, initialStatus, initialDomains }: { onOpenSetup?: () => void; onFlash: (message: string) => void; initialStatus?: SharingSetupStatus; initialDomains?: string[] }): JSX.Element {
  const [status, setStatus] = useState<SharingSetupStatus | null>(initialStatus ?? null)
  const [busy, setBusy] = useState<'check' | 'replace' | 'update' | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [token, setToken] = useState('')
  const [failure, setFailure] = useState<{ where: 'token' | 'service'; failure: Failure } | null>(null)

  useEffect(() => {
    let live = true
    // First paint from the record; then the service and Cloudflare are asked (your own address, ticket 05).
    void window.writeflex.sharing.status().then((first) => {
      if (live) setStatus((shown) => shown ?? first)
      return window.writeflex.sharing.status({ askService: true })
    }).then((next) => { if (live) setStatus(next) }).catch(() => {})
    return () => { live = false }
  }, [])

  const run = useCallback(async (what: 'check' | 'replace' | 'update', where: 'token' | 'service', call: () => Promise<SharingResult>, done?: (result: SharingResult) => void) => {
    setBusy(what)
    setFailure(null)
    try {
      const result = await call()
      setStatus(result.status)
      if (result.ok) done?.(result)
      else setFailure({ where, failure: { problem: result.problem, details: result.details } })
    } catch {
      setFailure({ where, failure: { problem: { reason: 'That did not work.', fix: 'Try again.' } } })
    } finally { setBusy(null) }
  }, [])

  const checkToken = () => void run('check', 'token', () => window.writeflex.sharing.checkSavedToken(), () => onFlash('Cloudflare accepts the token.'))
  const replaceToken = () => {
    const pasted = token
    setToken('')
    void run('replace', 'token', () => window.writeflex.sharing.checkToken(pasted), () => { setReplacing(false); onFlash('The new token is kept in the macOS Keychain.') })
  }
  const update = () => void run('update', 'service', () => window.writeflex.sharing.setUp(), (result) => onFlash(result.ok && result.notice ? result.notice : 'The sharing service is up to date.'))
  const removal = (retry = false, small = false) => (
    <RemoveSharing retry={retry} small={small} onStatus={setStatus} onRemoved={onFlash} />
  )

  const failed = (where: 'token' | 'service') => {
    if (failure?.where !== where) return null
    if (where === 'service' && failure.failure.problem.reason === UPLOAD_UNCONFIRMED.reason) {
      return <ProblemBox failure={failure.failure}><button type="button" className="shr-btn small" disabled={busy !== null} onClick={update}><RefreshCw className="icon" aria-hidden="true" />Check again</button></ProblemBox>
    }
    return <ProblemBox failure={failure.failure} />
  }

  /**
   * The token's problem, the paste field (Replace token), and Check. `open`: the paste field is shown
   * without pressing Replace token (a removal that did not finish and has no working token to finish with).
   */
  const tokenRow = (open: boolean) => {
    if (status === null) return null
    const pasting = replacing || open
    return (
      <>
        {status.token.problem && <ProblemBox failure={{ problem: status.token.problem }} />}
        {pasting && (
          <div className="shr-row">
            <label className="shr-inp mono" style={{ flex: 1 }}>
              <KeyRound className="icon" aria-hidden="true" />
              <input type="password" autoComplete="off" spellCheck={false} aria-label="New Cloudflare token" placeholder="Paste the new token here" value={token}
                onChange={(event) => setToken(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && token.trim()) { event.preventDefault(); replaceToken() } }} />
            </label>
            <button type="button" className="shr-btn primary" disabled={busy !== null || token.trim() === ''} onClick={replaceToken}><ShieldCheck className="icon" aria-hidden="true" />{busy === 'replace' ? 'Checking…' : 'Check'}</button>
            {!open && <button type="button" className="shr-btn" onClick={() => { setReplacing(false); setToken('') }}>Cancel</button>}
          </div>
        )}
        {failed('token')}
        <div className="shr-row">
          <button type="button" className="shr-btn small" onClick={() => setReplacing(true)} disabled={pasting}><KeyRound className="icon" aria-hidden="true" />Replace token</button>
          {(!open || status.token.stored) && <button type="button" className="shr-btn small" onClick={checkToken} disabled={busy !== null}><RefreshCw className="icon" aria-hidden="true" />{busy === 'check' ? 'Checking…' : 'Check token'}</button>}
        </div>
      </>
    )
  }

  if (status === null) {
    return <div className="set-sec" id="sec-sharing"><h3>Sharing</h3><p className="sub">Loading…</p></div>
  }

  if (status.removalPending) {
    return (
      <div className="set-sec" id="sec-sharing">
        <h3>Sharing</h3>
        <p className="sub">Removing sharing from {status.account?.name ?? 'your Cloudflare account'} did not finish.</p>
        <div className="shr-panel problem danger-zone" data-panel="removal-pending">
          <div className="shr-panel-h"><Trash2 className="icon" aria-hidden="true" /><span>Removing sharing did not finish</span></div>
          <div className="shr-panel-b">
            <p className="shr-p">{REMOVAL_PENDING.reason}</p>
            {/* Replace token is always offered here: Retry can fail on a token that is missing, rejected, or
                active but lacking a permission, and only the first two are known before Retry is pressed. */}
            {status.token.problem || !status.token.stored
              ? <>
                <p className="shr-p" data-testid="sharing-removal-needs-token">Retry needs a working Cloudflare token.</p>
                {tokenRow(true)}
              </>
              : tokenRow(false)}
            {removal(true)}
          </div>
        </div>
      </div>
    )
  }

  if (!status.ready) {
    return (
      <div className="set-sec" id="sec-sharing">
        <h3>Sharing</h3>
        <p className="sub">Share a piece or a Folio by link, through a small sharing service on your own Cloudflare account.</p>
        <div className="card">
          <div className="crow">
            <Link className="icon" aria-hidden="true" />
            <span className="grow">
              <span className="lbl">{status.interrupted ? 'Set-up did not finish' : 'Sharing is not set up on this Mac'}</span>
              <small>{status.interrupted ? 'Carry on where it stopped; nothing is sent twice.' : 'Set-up takes a few minutes: a Cloudflare token, your account, and one button.'}</small>
            </span>
            <button type="button" className="shr-btn primary" onClick={onOpenSetup} disabled={!onOpenSetup}>{status.interrupted ? 'Carry on setting up' : 'Set up sharing'}</button>
          </div>
        </div>
        {status.accountLocked && (
          <div className="shr-panel problem danger-zone" data-panel="remove">
            <div className="shr-panel-h"><Trash2 className="icon" aria-hidden="true" /><span>Remove sharing from this account</span></div>
            <div className="shr-panel-b">
              <p className="shr-p">Set-up already wrote on {status.account?.name ?? 'your Cloudflare account'}. Removing deletes the sharing service and everything in it from that account.</p>
              {removal()}
            </div>
          </div>
        )}
      </div>
    )
  }

  const service = status.service
  const serviceChip = service?.compare === 'update'
    ? <span className="shr-chip warn">Update available</span>
    : service?.compare === 'newer'
      ? <span className="shr-chip warn">From a newer WriteFlex</span>
      : service?.compare === 'current' ? <span className="shr-chip ok">Up to date</span> : <span className="shr-chip off">Not answering</span>

  return (
    <div className="set-sec" id="sec-sharing">
      <h3>Sharing</h3>
      <p className="sub">Your Cloudflare account and token, your own address, the sharing service and its version, and removing sharing from the account.</p>
      <div className="shr-settings">
        <div className="shr-settings-col">
          <div className="shr-panel" data-panel="account">
            <div className="shr-panel-h">
              <Cloud className="icon" aria-hidden="true" /><span className="grow">Cloudflare account</span>
              {status.token.problem ? <span className="shr-chip bad">Token rejected</span> : <span className="shr-chip ok"><ShieldCheck className="icon" aria-hidden="true" />Token accepted</span>}
            </div>
            <div className="shr-panel-b">
              <div>
                <div className="shr-kv"><span className="shr-k">Account</span><span className="shr-v">{status.account?.name}</span></div>
                <div className="shr-kv"><span className="shr-k">Token</span><span className="shr-v">Kept in the macOS Keychain{status.token.acceptedAt ? ` · checked ${shortTime(status.token.acceptedAt)}` : ''}</span></div>
              </div>
              {tokenRow(false)}
            </div>
          </div>

          <OwnAddressCard status={status} onStatus={setStatus} onFlash={onFlash} initialDomains={initialDomains} onReplaceToken={() => setReplacing(true)} />

          <div className="shr-panel" data-panel="service">
            <div className="shr-panel-h"><Server className="icon" aria-hidden="true" /><span className="grow">Sharing service</span>{serviceChip}</div>
            <div className="shr-panel-b">
              <div>
                <div className="shr-kv"><span className="shr-k">Installed on your account</span><span className="shr-v">{service?.installedBuild ? `Build ${service.installedBuild}` : 'Not answering'}</span></div>
                <div className="shr-kv"><span className="shr-k">Offered by this WriteFlex</span><span className="shr-v">Build {service?.appBuild}</span></div>
              </div>
              {service?.compare === 'newer' && <p className="shr-p">Your sharing service was installed by a newer WriteFlex. Update WriteFlex on this Mac; links keep working.</p>}
              {failed('service')}
              {service?.compare === 'update' && (
                <div className="shr-row">
                  <button type="button" className="shr-btn primary" disabled={busy !== null} onClick={update}><Download className="icon" aria-hidden="true" />{busy === 'update' ? 'Updating…' : 'Update sharing service'}</button>
                  <span className="shr-p shr-dim">Your links keep working while it updates.</span>
                </div>
              )}
            </div>
          </div>

          <div className="shr-panel problem danger-zone" data-panel="remove">
            <div className="shr-panel-h"><Trash2 className="icon" aria-hidden="true" /><span>Remove sharing from this account</span></div>
            <div className="shr-panel-b">
              <p className="shr-p">Deletes the sharing service and everything in it from your Cloudflare account. Every link stops working and comments not yet collected are lost. Your pieces on this Mac are not touched.</p>
              {removal()}
            </div>
          </div>
        </div>
        <div className="shr-settings-col">
          <div className="shr-panel" data-panel="now">
            <div className="shr-panel-h"><Server className="icon" aria-hidden="true" /><span>Service now</span></div>
            <div className="shr-panel-b">
              <div>
                <div className="shr-kv"><span className="shr-k">State</span><span className="shr-v">{service?.installedBuild ? <span className="shr-chip ok">Running</span> : <span className="shr-chip off">Not answering</span>}</span></div>
                <div className="shr-kv"><span className="shr-k">Address</span><span className="shr-v">{status.address?.replace(/^https:\/\//, '')}</span></div>
                {status.linksAddress && status.linksAddress !== status.address && <div className="shr-kv"><span className="shr-k">Links read</span><span className="shr-v">{status.linksAddress.replace(/^https:\/\//, '')}</span></div>}
                {status.setUpAt && <div className="shr-kv"><span className="shr-k">Set up</span><span className="shr-v">{shortTime(status.setUpAt)}</span></div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
