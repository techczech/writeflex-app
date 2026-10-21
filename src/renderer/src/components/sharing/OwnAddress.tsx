// Your own address (sharing ticket 05; locked frames `setup` b, `setup-problem` 3b, `settings`). The
// fields "Use your own address · optional", Name in front + Domain on this account, used in set-up
// step 3 and in Settings › Sharing; and the Settings card with the address's state. The main process
// decides (src/main/sharing-own-address.ts): what is typed here is checked there before any request.
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, Globe, KeyRound, Pencil, RefreshCw, X, XCircle } from 'lucide-react'
import {
  ownCheckingText, ownLapsedText, ownNotAttachedText, ownUnconfirmedText, ownWaitingText, type SharingProblem, type SharingResult, type SharingSetupStatus,
} from '../../../../shared/sharing-setup'
import { ProblemBox, type Failure } from './SharingSetup'

export type OwnAddressDraft = { on: boolean; name: string; domain: string }
export const emptyDraft = (): OwnAddressDraft => ({ on: false, name: '', domain: '' })

/** The domains the token reaches on the chosen account, asked for once the switch is on. */
function useDomains(on: boolean, initial?: string[] | SharingProblem): { domains: string[] | null; problem: SharingProblem | null } {
  const [domains, setDomains] = useState<string[] | null>(Array.isArray(initial) ? initial : null)
  const [problem, setProblem] = useState<SharingProblem | null>(initial && !Array.isArray(initial) ? initial : null)
  useEffect(() => {
    if (!on || domains !== null || problem !== null) return
    let live = true
    void window.writeflex.sharing.domains().then((result) => {
      if (!live) return
      if (result.ok) setDomains(result.domains)
      else setProblem(result.problem)
    }).catch(() => { if (live) setProblem({ reason: 'Your domains could not be listed.', fix: 'Try again.' }) })
    return () => { live = false }
  }, [on, domains, problem])
  return { domains, problem }
}

export type OwnAddressFieldsProps = {
  draft: OwnAddressDraft
  onDraft: (next: OwnAddressDraft) => void
  disabled?: boolean
  /** The attach was refused: the name field is drawn as in error (frame `setup-problem` 3b). */
  refused?: boolean
  /** Tests: the domain list (or its problem) before the main process answers. */
  initialDomains?: string[] | SharingProblem
  /** The switch can be left out (Settings, where the card is already about the own address). */
  withSwitch?: boolean
}

export function OwnAddressFields({ draft, onDraft, disabled, refused, initialDomains, withSwitch = true }: OwnAddressFieldsProps): JSX.Element {
  const { domains, problem } = useDomains(draft.on, initialDomains)
  // The first domain is picked for the person when there is one and none is picked yet.
  useEffect(() => {
    if (draft.on && domains && domains.length > 0 && !domains.includes(draft.domain)) onDraft({ ...draft, domain: domains[0] })
  }, [draft, domains, onDraft])
  return (
    <div className="shr-own" data-testid="sharing-own-address-fields">
      {withSwitch && (
        <div className="shr-row">
          <button type="button" role="switch" aria-checked={draft.on} className="shr-sw" disabled={disabled} onClick={() => onDraft({ ...draft, on: !draft.on })}>
            <span className="trk" aria-hidden="true" />{draft.on ? 'On' : 'Off'}
          </button>
          <b className="shr-own-t">Use your own address</b><span className="shr-dim shr-p">optional</span>
        </div>
      )}
      {draft.on && problem && <ProblemBox failure={{ problem }} />}
      {draft.on && !problem && (
        <div className="shr-own-grid">
          <div className="shr-fld">
            <span className="shr-lbl" id="shr-own-name">Name in front</span>
            <label className={`shr-inp${refused ? ' err' : ''}`}>
              <input aria-labelledby="shr-own-name" placeholder="drafts" maxLength={63} spellCheck={false} autoComplete="off" value={draft.name} disabled={disabled}
                onChange={(event) => onDraft({ ...draft, name: event.target.value })} />
            </label>
          </div>
          <span className="shr-own-plus" aria-hidden="true">+</span>
          <div className="shr-fld">
            <span className="shr-lbl" id="shr-own-domain">Domain on this account</span>
            <label className="shr-inp">
              <select aria-labelledby="shr-own-domain" value={draft.domain} disabled={disabled || domains === null} onChange={(event) => onDraft({ ...draft, domain: event.target.value })}>
                {domains === null && <option value="">Loading your domains…</option>}
                {domains?.map((domain) => <option key={domain} value={domain}>{domain}</option>)}
              </select>
            </label>
          </div>
        </div>
      )}
    </div>
  )
}

/** The address the draft would give, for "Your links will read". */
export const draftHostname = (draft: OwnAddressDraft): string | null =>
  draft.on && draft.name.trim() && draft.domain ? `${draft.name.trim().toLowerCase()}.${draft.domain}` : null

/** Settings › Sharing, "Your own address" (frame `settings`). */
export function OwnAddressCard({ status, onStatus, onFlash, initialDomains, onReplaceToken }: {
  status: SharingSetupStatus
  onStatus: (status: SharingSetupStatus) => void
  onFlash: (message: string) => void
  initialDomains?: string[] | SharingProblem
  /** Opens the token's paste field (Settings › Sharing, Replace token); offered when the address cannot be confirmed. */
  onReplaceToken?: () => void
}): JSX.Element {
  const own = status.ownAddress ?? null
  const left = status.ownAddressesLeft ?? []
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<OwnAddressDraft>({ on: true, name: own?.name ?? '', domain: own?.domain ?? '' })
  const [busy, setBusy] = useState<'attach' | 'remove' | 'check' | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const card = useRef<HTMLDivElement | null>(null)
  /** A button that ran is disabled or gone afterwards: keep the keyboard in the card, so Esc still closes Settings. */
  const settle = useCallback(() => {
    const keep = (): void => {
      const at = document.activeElement as HTMLElement | null
      if (card.current && (!at || at === document.body || (at as HTMLButtonElement).disabled === true || !at.isConnected)) card.current.focus()
    }
    keep()
    requestAnimationFrame(keep)
  }, [])

  const run = useCallback(async (what: 'attach' | 'remove' | 'check', call: () => Promise<SharingResult>, done?: (result: SharingResult) => void) => {
    setBusy(what)
    setFailure(null)
    try {
      const result = await call()
      onStatus(result.status)
      if (result.ok) done?.(result)
      else setFailure({ problem: result.problem, details: result.details })
    } catch {
      setFailure({ problem: { reason: 'That did not go through.', fix: 'Try again.' } })
    } finally { setBusy(null); settle() }
  }, [onStatus, settle])

  const attach = () => void run('attach', () => window.writeflex.sharing.attachAddress({ name: draft.name, domain: draft.domain }), (result) => {
    setEditing(false)
    if (result.ok && result.notice) onFlash(result.notice)
  })
  const remove = () => void run('remove', () => window.writeflex.sharing.removeAddress(), (result) => {
    setConfirming(false)
    if (result.ok && result.notice) onFlash(result.notice)
  })
  // State `not-attached`: the attach got no clear answer. Try again sends it again through the same path
  // (main checks the record, the domain and the name again; one already there for the service is attached).
  const tryAgain = () => { if (own) void run('attach', () => window.writeflex.sharing.attachAddress({ name: own.name, domain: own.domain }), (result) => {
    if (result.ok && result.notice) onFlash(result.notice)
  }) }
  const check = () => void run('check', async () => {
    const next = await window.writeflex.sharing.status({ askService: true })
    return { ok: true, status: next }
  })

  const chip = !own
    ? <span className="shr-chip off">Not used</span>
    : own.state === 'attached'
      ? <span className="shr-chip ok"><CheckCircle2 className="icon" aria-hidden="true" />Attached</span>
      : own.state === 'waiting'
        ? <span className="shr-chip warn"><Clock className="icon" aria-hidden="true" />Waiting for Cloudflare</span>
        : own.state === 'not-attached'
          ? <span className="shr-chip bad"><XCircle className="icon" aria-hidden="true" />Address not attached</span>
        : own.state === 'checking'
          ? <span className="shr-chip warn"><Clock className="icon" aria-hidden="true" />Checking…</span>
          : own.state === 'unconfirmed'
            ? <span className="shr-chip warn"><AlertTriangle className="icon" aria-hidden="true" />Not confirmed</span>
            : <span className="shr-chip bad"><XCircle className="icon" aria-hidden="true" />Not answering</span>
  const showFields = !own || editing

  return (
    <div className="shr-panel" data-panel="own-address" ref={card} tabIndex={-1}>
      <div className="shr-panel-h"><Globe className="icon" aria-hidden="true" /><span className="grow">Your own address</span>{chip}</div>
      <div className="shr-panel-b">
        {showFields && <>
          {!own && <p className="shr-p">Links use the address Cloudflare gives your account{status.address ? `, ${status.address.replace(/^https:\/\//, '')}` : ''}. A domain on the same Cloudflare account can be used instead, with a name in front of it for sharing alone.</p>}
          <OwnAddressFields draft={draft} onDraft={setDraft} withSwitch={false} disabled={busy !== null} refused={failure !== null} initialDomains={initialDomains} />
          {failure && <ProblemBox failure={failure} />}
          <div className="shr-row">
            <button type="button" className="shr-btn primary" disabled={busy !== null || !draft.name.trim() || !draft.domain} onClick={attach}>
              <Globe className="icon" aria-hidden="true" />{busy === 'attach' ? 'Attaching…' : own ? 'Use this address' : 'Use your own address'}
            </button>
            {editing && <button type="button" className="shr-btn" onClick={() => { setEditing(false); setFailure(null) }}>Cancel</button>}
          </div>
          {own && <p className="shr-p shr-dim">Links sent on {own.hostname} keep opening: it stays attached.</p>}
          {!own && left.length > 0 && (
            <div className="shr-row" data-testid="sharing-own-left">
              <span className="shr-p">Not removed yet: {left.join(', ')}. New links do not use {left.length === 1 ? 'it' : 'them'}.</span>
              <button type="button" className="shr-btn small" disabled={busy !== null} onClick={remove}><X className="icon" aria-hidden="true" />{busy === 'remove' ? 'Removing…' : 'Finish removing'}</button>
            </div>
          )}
        </>}
        {!showFields && own && <>
          <div className="shr-own-grid" data-testid="sharing-own-address">
            <div className="shr-inp"><span className="shr-tx">{own.name}</span></div>
            <span className="shr-own-plus" aria-hidden="true">+</span>
            <div className="shr-inp"><span className="shr-tx">{own.domain}</span></div>
          </div>
          {own.state === 'attached' && <p className="shr-p shr-dim">Links sent on the earlier address still open.</p>}
          {own.state === 'waiting' && <p className="shr-p">{ownWaitingText(own.hostname)}</p>}
          {own.state === 'not-attached' && <p className="shr-p" role="alert" data-testid="sharing-own-not-attached">{ownNotAttachedText(own.hostname)}</p>}
          {own.state === 'lapsed' && <p className="shr-p" role="alert" data-testid="sharing-own-lapsed">{ownLapsedText(own.hostname)}</p>}
          {own.state === 'checking' && <p className="shr-p" data-testid="sharing-own-checking">{ownCheckingText(own.hostname)}</p>}
          {own.state === 'unconfirmed' && <p className="shr-p" role="alert" data-testid="sharing-own-unconfirmed">{ownUnconfirmedText(own.hostname)}</p>}
          {own.earlier.length > 0 && <p className="shr-p shr-dim">Also attached, so links sent on them still open: {own.earlier.join(', ')}.</p>}
          {failure && <ProblemBox failure={failure} />}
          {confirming ? (
            <div className="shr-row" data-testid="sharing-own-remove-confirm">
              <span className="shr-p">Links sent on {[own.hostname, ...own.earlier].join(', ')} stop opening. New links use the address Cloudflare gives your account.</span>
              <button type="button" className="shr-btn danger small" disabled={busy !== null} onClick={remove}><X className="icon" aria-hidden="true" />{busy === 'remove' ? 'Removing…' : 'Remove own address'}</button>
              <button type="button" className="shr-btn small" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          ) : (
            <div className="shr-row">
              {own.state === 'not-attached' && <button type="button" className="shr-btn small" disabled={busy !== null} onClick={tryAgain}><RefreshCw className="icon" aria-hidden="true" />{busy === 'attach' ? 'Trying…' : 'Try again'}</button>}
              {own.state !== 'attached' && own.state !== 'not-attached' && <button type="button" className="shr-btn small" disabled={busy !== null} onClick={check}><RefreshCw className="icon" aria-hidden="true" />{busy === 'check' ? 'Checking…' : 'Check again'}</button>}
              {own.state === 'unconfirmed' && onReplaceToken && <button type="button" className="shr-btn small" disabled={busy !== null} onClick={onReplaceToken}><KeyRound className="icon" aria-hidden="true" />Replace token</button>}
              <button type="button" className="shr-btn small" disabled={busy !== null} onClick={() => { setDraft({ on: true, name: '', domain: own.domain }); setEditing(true) }}><Pencil className="icon" aria-hidden="true" />Change address</button>
              <button type="button" className="shr-btn small" disabled={busy !== null} onClick={() => setConfirming(true)}><X className="icon" aria-hidden="true" />Remove own address</button>
            </div>
          )}
        </>}
      </div>
    </div>
  )
}
