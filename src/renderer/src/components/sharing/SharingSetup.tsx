// Set up sharing, once (sharing ticket 02; locked frames `setup`, `setup-problem`, `problems`). The
// component the Sharing page shows when sharing is not set up (ticket 03 mounts it there); until then
// it opens from the "Set up sharing" command and from Settings › Sharing, as a page over the text.
//
// The pasted token goes to the main process once (Check) and is never shown again: the field is a
// password field and is emptied after every Check. Every answer is a status with no token in it.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  ArrowLeft, Check, CircleDot, Circle, Copy, Download, ExternalLink, KeyRound, Link, ListChecks, Lock, Pencil, RefreshCw, ShieldCheck, TriangleAlert, XCircle,
} from 'lucide-react'
import {
  REMOVAL_PENDING, SHARING_PERMISSIONS, UPLOAD_UNCONFIRMED, accountLocked, permissionListText,
  type SharingProblem, type SharingResult, type SharingSetupStatus,
} from '../../../../shared/sharing-setup'
import { RemoveSharing } from './RemoveSharing'
import { linksWillRead, problemRows, setupSteps, shortTime, type ProblemRow, type StepState } from './sharing-view-model'
import { OwnAddressFields, draftHostname, emptyDraft, type OwnAddressDraft } from './OwnAddress'

export type SharingSetupProps = {
  /** The piece Share was chosen on, for the subtitle; null when opened from elsewhere. */
  pieceName: string | null
  onBack: () => void
  onFlash: (message: string) => void
  /** Settings › Sharing (Paste a new token, Update, Remove). */
  onOpenSettings: () => void
  /** Called once set-up has finished (ticket 03: return to the Sharing page). Defaults to onBack. */
  onDone?: (status: SharingSetupStatus) => void
  /** Tests and ticket 03: the state to draw before the main process answers. */
  initial?: { status: SharingSetupStatus; tokenFailure?: Failure; setupFailure?: Failure; draft?: OwnAddressDraft; addressFailure?: Failure; domains?: string[] }
}

export type Failure = { problem: SharingProblem; details?: string }

export function ProblemBox({ failure, children }: { failure: Failure; children?: React.ReactNode }): JSX.Element {
  return (
    <div className="shr-errbox" role="alert">
      <XCircle className="icon" aria-hidden="true" />
      <div>
        <b>{failure.problem.reason}</b>
        <div className="shr-p">{failure.problem.fix}</div>
        {failure.details && <details><summary>Details</summary>{failure.details}</details>}
        {children && <div className="shr-row">{children}</div>}
      </div>
    </div>
  )
}

function StepNumber({ state, n }: { state: StepState; n: number }): JSX.Element {
  return <span className="shr-no">{state === 'done' ? <Check className="icon" aria-hidden="true" /> : n}</span>
}

function PermissionList(): JSX.Element {
  return (
    <div className="shr-perm" aria-label="Permissions the token needs">
      {SHARING_PERMISSIONS.map((permission) => [
        <div key={`${permission.name}-n`}><b>{permission.scope} · {permission.name}</b> <span className="shr-why">· {permission.purpose}</span></div>,
        <div key={`${permission.name}-l`} className="shr-a">{permission.level}</div>,
      ])}
    </div>
  )
}

/** The rows at the top of the right column (frame `problems`): only those that apply, in order. */
export function SharingProblemRows({ rows, onPasteToken, onUpdate, busy }: { rows: ProblemRow[]; onPasteToken: () => void; onUpdate: () => void; busy: boolean }): JSX.Element | null {
  if (rows.length === 0) return null
  return (
    <>
      {rows.map((row) => (
        <div key={row.kind} className={`shr-panel problem${row.tone === 'bad' ? ' bad' : ''}`} data-problem={row.kind}>
          <div className="shr-panel-h">{row.kind === 'token-rejected' ? <KeyRound className="icon" aria-hidden="true" /> : <TriangleAlert className="icon" aria-hidden="true" />}<span>{row.title}</span></div>
          <div className="shr-panel-b">
            <p className="shr-p">{row.text}</p>
            <div className="shr-row">
              {row.kind === 'token-rejected' && <>
                <button type="button" className="shr-btn primary small" onClick={onPasteToken}><KeyRound className="icon" aria-hidden="true" />Paste a new token</button>
                <button type="button" className="shr-btn small" onClick={() => void window.writeflex.sharing.openCloudflare()}><ExternalLink className="icon" aria-hidden="true" />Open Cloudflare</button>
              </>}
              {row.kind === 'service-out-of-date' && (
                <button type="button" className="shr-btn primary small" disabled={busy} onClick={onUpdate}><Download className="icon" aria-hidden="true" />{busy ? 'Updating…' : 'Update sharing service'}</button>
              )}
            </div>
          </div>
        </div>
      ))}
    </>
  )
}

export function SharingSetup({ pieceName, onBack, onFlash, onOpenSettings, onDone, initial }: SharingSetupProps): JSX.Element {
  const [status, setStatus] = useState<SharingSetupStatus | null>(initial?.status ?? null)
  const [token, setToken] = useState('')
  const [changingToken, setChangingToken] = useState(false)
  const [showList, setShowList] = useState(false)
  const [tokenFailure, setTokenFailure] = useState<Failure | null>(initial?.tokenFailure ?? null)
  const [setupFailure, setSetupFailure] = useState<Failure | null>(initial?.setupFailure ?? null)
  const [busy, setBusy] = useState<'check' | 'account' | 'setup' | 'attach' | null>(null)
  // Ticket 05: your own address, attached right after the service is installed. A refusal keeps the
  // page on step 3 with the reason (frame `setup-problem` 3b); sharing is set up either way.
  const [draft, setDraft] = useState<OwnAddressDraft>(initial?.draft ?? emptyDraft())
  const [addressFailure, setAddressFailure] = useState<Failure | null>(initial?.addressFailure ?? null)
  const tokenInput = useRef<HTMLInputElement | null>(null)
  const setUpButton = useRef<HTMLButtonElement | null>(null)
  const page = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let live = true
    // First paint from the record; then the service and Cloudflare are asked (your own address, ticket 05).
    void window.writeflex.sharing.status().then((first) => {
      if (live) setStatus((shown) => shown ?? first)
      return window.writeflex.sharing.status({ askService: true })
    }).then((next) => { if (live) setStatus(next) }).catch(() => {})
    return () => { live = false }
  }, [])

  const steps = setupSteps(status, changingToken)
  useEffect(() => {
    if (steps.paste === 'cur') tokenInput.current?.focus()
    else if (steps.account === 'cur' && setUpButton.current) setUpButton.current.focus()
    // Otherwise the page itself holds the keyboard, so Esc goes back to the text.
    if (page.current && !page.current.contains(document.activeElement)) page.current.focus()
  }, [steps.paste, steps.account, status?.ready])

  const take = useCallback((result: SharingResult): void => { setStatus(result.status) }, [])

  const check = useCallback(async () => {
    if (busy || token.trim() === '') return
    setBusy('check')
    setTokenFailure(null)
    try {
      const result = await window.writeflex.sharing.checkToken(token)
      take(result)
      if (result.ok) { setChangingToken(false); setShowList(false) }
      else setTokenFailure({ problem: result.problem, details: result.details })
    } catch {
      setTokenFailure({ problem: { reason: 'The token could not be checked.', fix: 'Try again.' } })
    } finally {
      setToken('')
      setBusy(null)
    }
  }, [busy, token, take])

  const choose = useCallback(async (accountId: string) => {
    setBusy('account')
    setSetupFailure(null)
    try {
      const result = await window.writeflex.sharing.chooseAccount(accountId)
      take(result)
      if (!result.ok) setSetupFailure({ problem: result.problem, details: result.details })
    } finally { setBusy(null) }
  }, [take])

  const finish = useCallback((done: SharingSetupStatus, notice?: string) => {
    onFlash(notice ? notice : `Sharing is set up. Links will read ${(done.linksAddress ?? done.address)?.replace(/^https:\/\//, '') ?? 'your workers.dev address'}.`)
    ;(onDone ?? (() => onBack()))(done)
  }, [onFlash, onDone, onBack])

  /** Attach the own address; true when it was (or there was none to attach). */
  const attach = useCallback(async (): Promise<SharingResult | null> => {
    setBusy('attach')
    setAddressFailure(null)
    try {
      const result = await window.writeflex.sharing.attachAddress({ name: draft.name, domain: draft.domain })
      take(result)
      if (!result.ok) { setAddressFailure({ problem: result.problem, details: result.details }); return null }
      return result
    } catch {
      setAddressFailure({ problem: { reason: `${draft.domain} cannot be attached.`, fix: 'Try again, or use the address Cloudflare gives your account.' } })
      return null
    } finally { setBusy(null) }
  }, [draft, take])

  const setUp = useCallback(async () => {
    if (busy) return
    setBusy('setup')
    setSetupFailure(null)
    let installed: SharingResult | null = null
    try {
      const result = await window.writeflex.sharing.setUp()
      take(result)
      if (result.ok) installed = result
      else setSetupFailure({ problem: result.problem, details: result.details })
    } catch {
      setSetupFailure({ problem: { reason: 'The sharing service could not be set up.', fix: 'Try again. Your token and account are kept.' } })
    } finally { setBusy(null) }
    if (!installed?.ok) return
    if (!draftHostname(draft)) { finish(installed.status, installed.notice); return }
    const attached = await attach()
    if (attached) finish(attached.status, attached.ok ? attached.notice : undefined)
  }, [busy, take, draft, attach, finish])

  const tryAttachAgain = useCallback(async () => {
    const attached = await attach()
    if (attached) finish(attached.status, attached.ok ? attached.notice : undefined)
  }, [attach, finish])

  const copyList = useCallback(() => {
    void window.writeflex.copyToClipboard(permissionListText(), 'plain').then(() => onFlash('Copied the permission list')).catch(() => onFlash('Could not copy the permission list.'))
  }, [onFlash])
  const openCloudflare = useCallback(() => { void window.writeflex.sharing.openCloudflare() }, [])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onBack(); return }
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    if (steps.paste === 'cur') {
      if (token.trim()) void check()
      else openCloudflare()
    } else if (steps.account === 'cur' && !status?.ready) void setUp()
  }, [steps.paste, steps.account, token, status?.ready, check, openCloudflare, onBack, setUp])

  const usable = status?.accounts.filter((account) => account.workers) ?? []
  // Set up, unless the own address is being attached or was refused: then step 3 stays, with the reason.
  const ready = status?.ready === true && !changingToken && addressFailure === null && busy !== 'setup' && busy !== 'attach'
  const drafted = addressFailure === null ? draftHostname(draft) : null
  const rows = problemRows(status)

  return (
    <div className="shr-overlay" data-testid="sharing-setup" ref={page} tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="shr-head">
        <button type="button" className="shr-btn" onClick={onBack}><ArrowLeft className="icon" aria-hidden="true" />Back to text<kbd>Esc</kbd></button>
        <div className="shr-title">
          <h2>{ready ? 'Sharing' : 'Set up sharing'}</h2>
          <span className="shr-sub">{ready ? 'Set up on this Mac' : 'First time only'}{pieceName ? ` · ${pieceName}` : ''}</span>
        </div>
      </header>
      <div className="shr-body">
        <section className="shr-left" aria-label={ready ? 'Sharing' : 'Set-up steps'}>
          {status === null && <p className="shr-p shr-dim">Loading…</p>}
          {status !== null && ready && (
            <div className="shr-step done" data-step="ready">
              <div className="shr-step-h">
                <StepNumber state="done" n={0} />
                <h3>Sharing is set up <span className="shr-dim">· {status.account?.name}{status.setUpAt ? ` · since ${shortTime(status.setUpAt)}` : ''}</span></h3>
                <button type="button" className="shr-btn small" onClick={onOpenSettings}>Settings › Sharing</button>
              </div>
              <div className="shr-step-b">
                <p className="shr-p">Links you make will use your sharing service on Cloudflare. Making a link is on the Sharing page of each piece.</p>
              </div>
            </div>
          )}
          {status !== null && !ready && status.removalPending && (
            <ProblemBox failure={{ problem: REMOVAL_PENDING }}>
              <button type="button" className="shr-btn small" onClick={onOpenSettings}>Settings › Sharing</button>
            </ProblemBox>
          )}
          {status !== null && !ready && !status.removalPending && <>
            {status.storageUnavailable && (
              <ProblemBox failure={{ problem: { reason: 'This Mac\'s secure storage is unavailable, so a token cannot be kept.', fix: 'Unlock the login Keychain, then reopen this page.' } }} />
            )}
            {/* Step 1 */}
            <div className={`shr-step ${steps.token}`} data-step="token">
              <div className="shr-step-h">
                <StepNumber state={steps.token} n={1} />
                <h3>Make a Cloudflare token{steps.token === 'done' && <span className="shr-dim"> · permissions listed</span>}</h3>
                {steps.token === 'cur'
                  ? <span className="shr-chip live"><CircleDot className="icon" aria-hidden="true" />Now</span>
                  : <button type="button" className="shr-btn small" onClick={() => setShowList((open) => !open)}><Pencil className="icon" aria-hidden="true" />{showList ? 'Hide list' : 'Show list'}</button>}
              </div>
              {(steps.token === 'cur' || showList) && (
                <div className="shr-step-b">
                  <p className="shr-p">Make a token in Cloudflare with these permissions. Cloudflare opens in your browser.</p>
                  <PermissionList />
                  <div className="shr-row">
                    <button type="button" className="shr-btn primary" onClick={openCloudflare}><ExternalLink className="icon" aria-hidden="true" />Open Cloudflare{steps.paste === 'cur' && !token && <kbd>⌘↵</kbd>}</button>
                    <button type="button" className="shr-btn" onClick={copyList}><Copy className="icon" aria-hidden="true" />Copy the list</button>
                  </div>
                </div>
              )}
            </div>
            {/* Step 2 */}
            <div className={`shr-step ${steps.paste}`} data-step="paste">
              <div className="shr-step-h">
                <StepNumber state={steps.paste} n={2} />
                <h3>Paste the token{steps.paste === 'done' && status.token.acceptedAt && <span className="shr-dim"> · Token accepted at {shortTime(status.token.acceptedAt)}</span>}</h3>
                {steps.paste === 'done'
                  ? <button type="button" className="shr-btn small" onClick={() => { setChangingToken(true); setTokenFailure(null) }}><Pencil className="icon" aria-hidden="true" />Change token</button>
                  : tokenFailure
                    ? <span className="shr-chip bad"><XCircle className="icon" aria-hidden="true" />Token rejected</span>
                    : <span className="shr-chip off"><Circle className="icon" aria-hidden="true" />Next</span>}
              </div>
              {steps.paste === 'cur' && (
                <div className="shr-step-b">
                  <div className="shr-row">
                    <label className={`shr-inp mono${tokenFailure ? ' err' : ''}`} style={{ flex: 1 }}>
                      <KeyRound className="icon" aria-hidden="true" />
                      <input
                        ref={tokenInput}
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        aria-label="Cloudflare token"
                        placeholder="Paste the token here"
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                        onKeyDown={(event) => { if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); void check() } }}
                      />
                    </label>
                    <button type="button" className={`shr-btn${tokenFailure ? '' : ' primary'}`} disabled={busy === 'check' || token.trim() === ''} onClick={() => void check()}>
                      <ShieldCheck className="icon" aria-hidden="true" />{busy === 'check' ? 'Checking…' : 'Check'}<kbd>⌘↵</kbd>
                    </button>
                    {changingToken && <button type="button" className="shr-btn" onClick={() => { setChangingToken(false); setTokenFailure(null); setToken('') }}>Keep the saved token</button>}
                  </div>
                  {tokenFailure && (
                    <ProblemBox failure={tokenFailure}>
                      <button type="button" className="shr-btn small" onClick={openCloudflare}><ExternalLink className="icon" aria-hidden="true" />Open Cloudflare</button>
                      <button type="button" className="shr-btn small" onClick={() => setShowList(true)}><ListChecks className="icon" aria-hidden="true" />Show the permission list</button>
                    </ProblemBox>
                  )}
                </div>
              )}
            </div>
            {/* Step 3 */}
            <div className={`shr-step ${steps.account}`} data-step="account">
              <div className="shr-step-h">
                <StepNumber state={steps.account} n={3} />
                <h3>Choose the account and an address</h3>
                {steps.account === 'wait'
                  ? <span className="shr-chip off"><Lock className="icon" aria-hidden="true" />Waiting for step 2</span>
                  : addressFailure
                    ? <span className="shr-chip bad"><XCircle className="icon" aria-hidden="true" />Address not attached</span>
                  : setupFailure
                    ? <span className="shr-chip bad"><XCircle className="icon" aria-hidden="true" />Not set up</span>
                    : <span className="shr-chip live"><CircleDot className="icon" aria-hidden="true" />Now</span>}
              </div>
              {steps.account === 'cur' && (
                <div className="shr-step-b">
                  <div className="shr-fld">
                    <span className="shr-lbl" id="shr-account-label">Cloudflare account</span>
                    <label className="shr-inp">
                      <select
                        aria-labelledby="shr-account-label"
                        value={status.account?.id ?? ''}
                        disabled={busy !== null || status.accountLocked || status.ready}
                        onChange={(event) => void choose(event.target.value)}
                      >
                        {!status.account && <option value="" disabled>Choose an account</option>}
                        {status.accounts.map((account) => (
                          <option key={account.id} value={account.id} disabled={!account.workers}>
                            {account.name}{account.workers ? '' : ' (the token cannot install here)'}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {status.interrupted && !setupFailure && (
                    <p className="shr-p">Set-up did not finish last time. Press Set up sharing to carry on; nothing is sent twice.</p>
                  )}
                  {status.accountLocked && status.account && (
                    <div data-testid="sharing-account-locked">
                      {!setupFailure && <p className="shr-p shr-dim">{accountLocked(status.account.name).fix}</p>}
                      <RemoveSharing small onStatus={setStatus} onRemoved={onFlash} />
                    </div>
                  )}
                  <OwnAddressFields draft={draft} onDraft={setDraft} disabled={busy !== null} refused={addressFailure !== null}
                    initialDomains={initial?.domains} />
                  {addressFailure && (
                    <ProblemBox failure={addressFailure}>
                      <button type="button" className="shr-btn primary small" onClick={() => { if (status.ready) finish(status) }}><Link className="icon" aria-hidden="true" />Use the Cloudflare address</button>
                      <button type="button" className="shr-btn small" onClick={onOpenSettings}><KeyRound className="icon" aria-hidden="true" />Replace token</button>
                      <button type="button" className="shr-btn small" disabled={busy !== null} onClick={() => void tryAttachAgain()}><RefreshCw className="icon" aria-hidden="true" />{busy === 'attach' ? 'Trying…' : 'Try again'}</button>
                    </ProblemBox>
                  )}
                  {setupFailure && (
                    <ProblemBox failure={setupFailure}>
                      <button type="button" className="shr-btn small" onClick={() => void setUp()}><RefreshCw className="icon" aria-hidden="true" />{setupFailure.problem.reason === UPLOAD_UNCONFIRMED.reason ? 'Check again' : 'Try again'}</button>
                      <button type="button" className="shr-btn small" onClick={() => { setChangingToken(true); setSetupFailure(null) }}><KeyRound className="icon" aria-hidden="true" />Replace token</button>
                    </ProblemBox>
                  )}
                  {!status.ready && (
                    <div className="shr-row">
                      <button ref={setUpButton} type="button" className="shr-btn primary" disabled={busy !== null || !status.account || usable.length === 0} onClick={() => void setUp()}>
                        <Link className="icon" aria-hidden="true" />{busy === 'setup' ? 'Setting up…' : 'Set up sharing'}<kbd>⌘↵</kbd>
                      </button>
                      <button type="button" className="shr-btn" onClick={() => setChangingToken(true)}><ArrowLeft className="icon" aria-hidden="true" />Back</button>
                    </div>
                  )}
                  {busy === 'setup' && <p className="shr-p shr-dim" role="status">Installing the sharing service on your Cloudflare account. This can take up to a minute.</p>}
                  {busy === 'attach' && <p className="shr-p shr-dim" role="status">Attaching {draftHostname(draft) ?? 'your own address'} to your sharing service.</p>}
                </div>
              )}
            </div>
          </>}
        </section>
        <aside className="shr-right">
          <SharingProblemRows rows={rows} busy={busy === 'setup'} onPasteToken={() => { setChangingToken(true); setTokenFailure(null) }} onUpdate={() => void setUp()} />
          <div className="shr-panel">
            <div className="shr-panel-h"><Link className="icon" aria-hidden="true" /><span>Your links will read</span></div>
            <div className="shr-panel-b"><div className="shr-inp mono"><span className="shr-tx" data-testid="sharing-links-read">{drafted && !status?.ready ? `${drafted}/…` : linksWillRead(status)}</span></div></div>
          </div>
          <div className="shr-panel">
            <div className="shr-panel-h"><ShieldCheck className="icon" aria-hidden="true" /><span>What leaves this Mac</span></div>
            <div className="shr-panel-b">
              <div className="shr-kv"><span className="shr-k">Before you make a link</span><span className="shr-v">Nothing</span></div>
              <div className="shr-kv"><span className="shr-k">Your token</span><span className="shr-v">Stays in the macOS Keychain</span></div>
              <div className="shr-kv"><span className="shr-k">Installed on Cloudflare</span><span className="shr-v">A small sharing service</span></div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
