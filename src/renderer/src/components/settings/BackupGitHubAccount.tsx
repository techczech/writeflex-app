/** Compact account row in the existing Backup panel. Countdown lives only while code is waiting. */
import { useEffect, useState } from 'react'
import type { GitHubView } from '../../../../shared/backup-github'
const words: Partial<Record<NonNullable<GitHubView['reason']>, string>> = {
  cancelled: 'GitHub sign-in cancelled.', denied: 'GitHub sign-in was not approved.', expired: 'This code expired. Request a new code.',
  offline: 'GitHub could not be reached. Check your connection and try again.', 'invalid-response': 'GitHub sign-in could not be checked. Try again.',
  'browser-failed': 'GitHub could not be opened. Open github.com/login/device in your browser.',
  'other-window': 'Sign-in is in progress in another window.',
  'shutdown-unconfirmed': "GitHub backup is paused because the previous helper’s shutdown could not be confirmed.",
  storage: 'The GitHub sign-in could not be saved or read securely. GitHub backup is held.',
  disconnected: 'GitHub disconnected on this Mac. Your backups remain on GitHub.',
}
export function GitHubAccountBody({ view, action, remaining }: { view: GitHubView; action: (name: string, id?: string) => void; remaining: number }): JSX.Element {
  const button = (label: string, name: string, id?: string) => <button type="button" className="shr-btn" onClick={() => action(name, id)}>{label}</button>
  const waiting = view.waiting, repo = view.repository
  return <div className="shr-panel" data-panel="backup-github"><div className="shr-panel-b">
    <div role="status" aria-live="polite">
      {view.state === 'unconfigured' ? <p className="shr-p">GitHub sign-in is not configured in this build.</p>
        : view.state === 'starting' ? <p className="shr-p">Requesting a GitHub sign-in code…</p>
        : view.state === 'waiting' && waiting ? <><p className="shr-p">Enter this code on GitHub: <strong>{waiting.userCode}</strong></p><p className="shr-p">Waiting for approval. Return to WriteFlex when you have finished.</p></>
        : view.state === 'disconnecting' ? <p className="shr-p">Disconnect is not finished. GitHub backup is held. Try again.</p>
        : view.state === 'reauth-required' && view.reason !== 'shutdown-unconfirmed' ? <p className="shr-p">GitHub sign-in expired or was revoked. Connect GitHub again.</p>
        : view.login ? <p className="shr-p">Connected as {view.login}{view.reason === 'offline' ? ' · Connection not checked' : ''}</p>
        : view.state !== 'error' ? <p className="shr-p">Sign in in your browser, then choose which repositories WriteFlex may use. Backup stays off until you turn it on for this vault.</p> : null}
      {view.reason && words[view.reason] && <p className="shr-p">{words[view.reason]}</p>}
    </div>
    {waiting && <p className="shr-p" aria-live="off">Code expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}. github.com/login/device</p>}
    <div className="shr-row">
      {view.state === 'waiting' && waiting && <>{button('Open GitHub', 'openBrowser', waiting.attemptId)}{button('Copy code', 'copy', waiting.userCode)}</>}
      {(view.state === 'starting' || view.state === 'waiting') && view.attemptId && button('Cancel', 'cancel', view.attemptId)}
      {(view.state === 'disconnected' || view.state === 'error' || view.state === 'reauth-required') && view.reason !== 'shutdown-unconfirmed' && view.reason !== 'other-window' && button('Connect GitHub', 'connect')}
      {view.reason === 'shutdown-unconfirmed' && button('Read shutdown confirmation again', 'recover')}
      {(view.login || view.state === 'disconnecting') && button(view.state === 'disconnecting' ? 'Try disconnect again' : 'Disconnect GitHub', 'disconnect')}
      {view.reason === 'disconnected' && button('Manage GitHub authorisation', 'openAuthorisations')}
    </div>
    {view.state === 'connected' && <>
      {repo.repository && <p className="shr-p">{repo.state === 'ready' ? `GitHub access is ready for ${repo.repository}.` : repo.state === 'candidate' ? `WriteFlex can reach ${repo.repository}. Click Use ${repo.repository} within five minutes to back up this vault there.` : repo.state === 'not-authorised' ? `Almost there: WriteFlex is signed in but cannot use ${repo.repository} yet. Click Give WriteFlex access on GitHub, select this repository and save. Then come back and click Check repository access.` : `This vault uses ${repo.repository}.`}</p>}
      {repo.state === 'unknown' && <p className="shr-p">Repository access could not be confirmed. Check repository access again.</p>}
      {repo.state === 'checking' && <p className="shr-p">Checking repository access…</p>}
      {repo.state === 'selecting' && <p className="shr-p">Saving repository selection…</p>}
      {repo.state === 'expired' && <p className="shr-p">Repository selection expired. Check repository access again.</p>}
      <div className="shr-row">
        {repo.state === 'candidate' && repo.candidateId && button(`Use ${repo.repository}`, 'useRepository', repo.candidateId)}
        {repo.state !== 'no-folder' && repo.state !== 'checking' && repo.state !== 'selecting' && button('Check repository access', 'repository')}
        {repo.state === 'not-authorised' && button('Give WriteFlex access on GitHub', 'openRepositoryAccess')}
      </div>
      {repo.state === 'not-authorised' && <p className="shr-p">If this repository belongs to an organisation, an owner may need to approve access.</p>}
    </>}
  </div></div>
}
export function BackupGitHubAccount(): JSX.Element {
  const [view, setView] = useState<GitHubView | null>(null), [tick, setTick] = useState(Date.now())
  useEffect(() => {
    let live = true
    const refresh = () => { void window.writeflex.backupGitHub.status().then(v => { if (live) setView(v) }).catch(() => undefined) }
    refresh(); const unsubscribe = window.writeflex.backupGitHub.onChanged(refresh)
    return () => { live = false; unsubscribe() }
  }, [])
  useEffect(() => {
    if (view?.state !== 'waiting') return
    setTick(Date.now()); const timer = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [view?.state, view?.waiting?.expiresAt])
  const action = (name: string, id?: string) => {
    const port = window.writeflex.backupGitHub
    const answer = name === 'copy' ? window.writeflex.copyToClipboard(id!, 'plain').then(() => null)
      : name === 'cancel' ? port.cancel({ attemptId: id! }) : name === 'openBrowser' ? port.openBrowser({ attemptId: id! })
      : name === 'useRepository' ? port.useRepository({ candidateId: id! })
      : port[name as 'connect' | 'repository' | 'recover' | 'disconnect' | 'openAuthorisations' | 'openRepositoryAccess']()
    void answer.then(v => { if (v) setView(v) }).catch(() => undefined)
  }
  return view ? <GitHubAccountBody view={view} action={action} remaining={Math.max(0, Math.ceil(((view.waiting?.expiresAt ?? 0) - tick) / 1000))} /> : <p className="sub">Loading GitHub sign-in…</p>
}
