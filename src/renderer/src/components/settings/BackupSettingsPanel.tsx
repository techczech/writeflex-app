// Settings › Backup: the approved per-vault switch for automatic backup (DTC 2026-10-24 sync-centre answer:
// backup is per vault, so a vault in OneDrive is never enrolled by accident). Off by default. It speaks only
// about this window's own vault; main resolves the folder (backup-helper/enrolment.ts). Before Turn on it
// shows the exact files that would be sent, what is left out, where they go, whether that repository is
// private, and what is published. Settings is the only place this is set; the Sync tab keeps its approved
// "not set up" state. Turning backup off keeps every backup already made. Turn on sends main the id of the
// preview shown here (used once): when anything changed since, main refuses and the vault is checked again.
import { BackupGitHubAccount } from './BackupGitHubAccount'
import { useCallback, useEffect, useState } from 'react'
import { CloudBackup, FolderGit2, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { BackupEnrolmentPreview, BackupEnrolmentResult, BackupEnrolmentStatus, BackupHelperRun, BackupRemoteView } from '../../../../shared/backup-enrolment'

const remoteText = (remote: BackupRemoteView): string =>
  remote.kind === 'github' ? `github.com/${remote.repository}` : remote.kind === 'local' ? (remote.path || 'a folder on this Mac') : remote.kind === 'unsupported' ? remote.display : 'none'

const runText = (run: BackupHelperRun): string => {
  switch (run.state) {
    case 'running': return 'Running while WriteFlex is open'
    case 'starting': return 'Starting'
    case 'stopped': return 'Not running'
    case 'restarting': return `Restarting${run.message ? ` · ${run.message}` : ''}`
    case 'failed': return `Stopped after repeated failures${run.message ? ` · ${run.message}` : ''}`
    case 'stop-overdue': return 'Still stopping'
  }
}

/** What Turn on reports: success only for `ok: true`; a known failure and an unknown outcome (`ok: null`) are problems. */
export function enableReport(result: BackupEnrolmentResult): { flash: string } | { problem: string } {
  switch (result.ok) {
    case true: return { flash: 'Automatic backup is on for this vault.' }
    case false: return { problem: result.reason }
    case null: return { problem: result.reason }
  }
}

const ProblemBox = ({ problem }: { problem: string | null }): JSX.Element | null =>
  problem ? <div className="shr-panel problem" role="alert"><div className="shr-panel-b"><p className="shr-p">{problem}</p></div></div> : null

/** Status unavailable. A Turn on whose outcome is unknown is not shown as off: its status says it may still be on. */
export function BackupUnavailableBody({ status, problem }: { status: Extract<BackupEnrolmentStatus, { state: 'unavailable' }>; problem: string | null }): JSX.Element {
  return (
    <>
      {status.activation === 'unconfirmed'
        ? (
          <div className="shr-panel problem" data-panel="backup-unconfirmed" role="alert">
            <div className="shr-panel-h"><ShieldAlert className="icon" aria-hidden="true" /><span>Turning backup on could not be confirmed</span></div>
            <div className="shr-panel-b"><p className="shr-p">{status.reason}</p></div>
          </div>
        )
        : <p className="sub">{status.reason}</p>}
      <ProblemBox problem={problem} />
    </>
  )
}

export function BackupSettingsPanel({ onFlash }: { onFlash: (message: string) => void }): JSX.Element {
  const [status, setStatus] = useState<BackupEnrolmentStatus | null>(null)
  const [preview, setPreview] = useState<BackupEnrolmentPreview | null>(null)
  const [busy, setBusy] = useState<'preview' | 'enable' | 'disable' | 'earlier' | null>(null)
  const [confirmEarlier, setConfirmEarlier] = useState(false)
  const [confirmPublic, setConfirmPublic] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void window.writeflex.backupEnrolment.status().then(setStatus).catch(() => setStatus({ state: 'unavailable', reason: 'Backup settings could not be read.' }))
  }, [])
  useEffect(() => {
    refresh()
    return window.writeflex.backupEnrolment.onChanged(refresh)
  }, [refresh])

  const check = async () => {
    setBusy('preview'); setProblem(null); setConfirmPublic(false); setConfirmEarlier(false)
    try { setPreview(await window.writeflex.backupEnrolment.preview()) } catch { setProblem('The vault could not be checked.') } finally { setBusy(null) }
  }
  const confirmLocations = async () => {
    if (preview?.state !== 'ready' || !confirmEarlier) return
    setBusy('earlier'); setProblem(null)
    try {
      const result = await window.writeflex.backupEnrolment.confirmEarlier({ previewId: preview.previewId, confirmEarlier })
      setStatus(result.status); setPreview(null); setConfirmEarlier(false)
      if (result.ok === true) await check()
      else setProblem(result.reason)
    } catch { setPreview(null); setConfirmEarlier(false); setProblem('Earlier locations could not be confirmed. Check this vault again.') } finally { setBusy(null) }
  }
  const turnOn = async () => {
    setBusy('enable'); setProblem(null)
    try {
      if (preview?.state !== 'ready') return
      const result = await window.writeflex.backupEnrolment.enable({ previewId: preview.previewId, confirmPublic })
      setStatus(result.status)
      // The shown preview was used: success or not, a further try needs a new check.
      setPreview(null); setConfirmPublic(false)
      const report = enableReport(result)
      if ('flash' in report) onFlash(report.flash)
      else setProblem(report.problem)
    } catch { setPreview(null); setProblem('Backup was not turned on.') } finally { setBusy(null) }
  }
  const turnOff = async () => {
    setBusy('disable'); setProblem(null)
    try {
      const result = await window.writeflex.backupEnrolment.disable()
      setStatus(result.status)
      if (result.ok === true) {
        setPreview(null); setConfirmEarlier(false); setConfirmPublic(false)
        onFlash('Automatic backup is off for this vault. Backups already made are kept.')
      }
      else setProblem(result.reason)
    } catch { setProblem('Backup was not turned off.') } finally { setBusy(null) }
  }

  const head = (
    <>
      <h3>Backup</h3>
      <BackupGitHubAccount />
      <p className="sub">Automatic backup of this vault to your own GitHub repository while WriteFlex is open. It is off until you turn it on here, for this vault only.</p>
    </>
  )
  const problemBox = <ProblemBox problem={problem} />

  if (status === null) return <div className="set-sec" id="sec-backup">{head}<p className="sub">Loading…</p></div>
  if (status.state === 'no-folder') return <div className="set-sec" id="sec-backup">{head}<p className="sub">Open a vault in this window to set up backup for it.</p></div>
  if (status.state === 'unavailable') return <div className="set-sec" id="sec-backup">{head}<BackupUnavailableBody status={status} problem={problem} /></div>

  const activeBackup = status.state === 'on' || status.state === 'moved' ? (
        <div className="shr-panel" data-panel="backup-on">
          <div className="shr-panel-h">
            <CloudBackup className="icon" aria-hidden="true" /><span className="grow">Backup is on for this vault</span>
            {status.state === 'moved' ? <span className="shr-chip bad">Folder moved</span> : status.helper.state === 'running' ? <span className="shr-chip ok">Running</span> : <span className="shr-chip warn">Not running</span>}
          </div>
          <div className="shr-panel-b">
            <div className="shr-kv"><span className="shr-k">Vault</span><span className="shr-v">{status.folder}</span></div>
            {status.state === 'on' && <>
              <div className="shr-kv"><span className="shr-k">Backs up to</span><span className="shr-v">{remoteText(status.remote)}{status.publicConfirmed ? ' · public, confirmed' : ''}</span></div>
              <div className="shr-kv"><span className="shr-k">Backup helper</span><span className="shr-v">{runText(status.helper)}</span></div>
            </>}
            {status.state === 'moved' && <p className="shr-p">This folder is no longer where backup was turned on for it (it was moved, renamed or replaced by a link), so backup does not run. Turn backup off, then on again here if the new place is right.</p>}
            <p className="shr-p">Backup runs only while WriteFlex is open. Turning it off keeps every backup already made and the record of edits that were not yet backed up.</p>
            <p className="shr-p">If sync is unavailable, check this vault to see whether named versions need confirmation.</p>
            <div className="shr-row">
              <button type="button" className="shr-btn" disabled={busy !== null} onClick={() => void check()}>{busy === 'preview' ? 'Checking…' : 'Check this vault'}</button>
              <button type="button" className="shr-btn" disabled={busy !== null} onClick={() => void turnOff()}>{busy === 'disable' ? 'Turning off…' : 'Turn off backup for this vault'}</button>
            </div>
          </div>
        </div>
    ) : null

  return (
    <div className="set-sec" id="sec-backup">
      {head}
      {activeBackup ?? <div className="card">
        <div className="crow">
          <FolderGit2 className="icon" aria-hidden="true" />
          <span className="grow">
            <span className="lbl">Backup is off for this vault</span>
            <small>{status.folder}</small>
          </span>
          <button type="button" className="shr-btn" disabled={busy !== null} onClick={() => void check()}><RefreshCw className="icon" aria-hidden="true" />{busy === 'preview' ? 'Checking…' : preview ? 'Check again' : 'Check this vault'}</button>
        </div>
      </div>}
      {preview?.state === 'refused' && (
        <div className="shr-panel problem" data-panel="backup-refused">
          <div className="shr-panel-h"><ShieldAlert className="icon" aria-hidden="true" /><span>Backup cannot proceed here</span></div>
          <div className="shr-panel-b">
            <p className="shr-p">{preview.reason}</p>
            {preview.prerequisites.filter((p) => !p.ok).map((p) => <div key={p.name} className="shr-kv"><span className="shr-k">{p.name}</span><span className="shr-v">{p.detail}</span></div>)}
          </div>
        </div>
      )}
      {preview?.state === 'ready' && (
        <div className="shr-panel" data-panel="backup-preview">
          <div className="shr-panel-h">
            <CloudBackup className="icon" aria-hidden="true" /><span className="grow">What backup would do</span>
            {preview.visibility === 'private' ? <span className="shr-chip ok"><ShieldCheck className="icon" aria-hidden="true" />Private</span> : preview.visibility === 'public' ? <span className="shr-chip warn">Public</span> : <span className="shr-chip bad">Not checked</span>}
          </div>
          <div className="shr-panel-b">
            <div className="shr-kv"><span className="shr-k">Backs up to</span><span className="shr-v">{remoteText(preview.remote)}</span></div>
            {preview.visibilityProblem && <div className="shr-kv"><span className="shr-k">Repository</span><span className="shr-v">{preview.visibilityProblem}</span></div>}
            <div className="shr-kv"><span className="shr-k">Files sent now</span><span className="shr-v">{preview.files.count}</span></div>
            <details>
              <summary>List the files</summary>
              <ul className="mono" aria-label="Files backup would send">
                {preview.files.items.map((path) => <li key={path}>{path}</li>)}
                {preview.files.omitted > 0 && <li>…and {preview.files.omitted} more</li>}
              </ul>
            </details>
            <div className="shr-kv"><span className="shr-k">Included</span><span className="shr-v mono">{preview.include.join(', ')}</span></div>
            <div className="shr-kv"><span className="shr-k">Never sent</span><span className="shr-v mono">{preview.exclude.join(', ')}</span></div>
            {(preview.skipped.length > 0 || preview.unreadable.length > 0) && <div className="shr-kv"><span className="shr-k">Not readable now</span><span className="shr-v mono">{[...preview.skipped, ...preview.unreadable].join(', ')}</span></div>}
            <p className="shr-p">Backup sends snapshots of these files only, on branches named {preview.publication.branchPrefix}…, in a history of their own. Your own commits are not sent. Anyone who can read the repository can read these snapshots. A secret check runs before every backup and holds back anything that looks like a password or key.</p>
            {preview.publication.problem && <p className="shr-p">{preview.publication.problem}</p>}
            <div className="shr-kv"><span className="shr-k">Named versions</span><span className="shr-v">{preview.history.included
              ? `Included: ${preview.history.namedVersions} named version${preview.history.namedVersions === 1 ? '' : 's'} (${preview.history.files} history file${preview.history.files === 1 ? '' : 's'}, ${preview.history.bytes} bytes). Other history on this Mac, such as agent sessions and pending changes, is not sent.`
              : `Cannot be backed up now: ${preview.history.reason}. Backup is held until they can.`}</span></div>
            {preview.earlierLocations && <EarlierLocationsConfirmation roots={preview.earlierLocations} checked={confirmEarlier} busy={busy !== null} onChecked={setConfirmEarlier} onConfirm={() => void confirmLocations()} />}
            {status.state === 'off' && preview.needsPublicConfirmation && (
              <label className="shr-row">
                <input type="checkbox" checked={confirmPublic} onChange={(e) => setConfirmPublic(e.target.checked)} />
                <span>This repository is public. Publish drafts of this vault there anyway.</span>
              </label>
            )}
            {preview.blocker && <p className="shr-p" role="note">{preview.blocker}</p>}
            {problemBox}
            {status.state === 'off' && <div className="shr-row">
              <button type="button" className="shr-btn primary" disabled={busy !== null || preview.blocker !== null || (preview.needsPublicConfirmation && !confirmPublic)} onClick={() => void turnOn()}>{busy === 'enable' ? 'Turning on…' : 'Turn on backup for this vault'}</button>
            </div>}
          </div>
        </div>
      )}
      {preview?.state !== 'ready' && problemBox}
    </div>
  )
}

/** Controlled acknowledgement: every fresh preview starts unchecked. */
export function EarlierLocationsConfirmation({ roots, checked, busy, onChecked, onConfirm }: { roots: { root: string; namedVersions: number }[]; checked: boolean; busy: boolean; onChecked(value: boolean): void; onConfirm(): void }): JSX.Element {
  return <div data-panel="backup-earlier-locations">
    <p className="shr-p"><strong>Named versions need confirmation</strong></p>
    <p className="shr-p">Some were recorded at these locations:</p>
    <ul>{roots.map(r => <li key={r.root}><span className="mono">{r.root}</span> — {r.namedVersions} named version{r.namedVersions === 1 ? '' : 's'}</li>)}</ul>
    <label className="shr-row"><input type="checkbox" checked={checked} disabled={busy} onChange={e => onChecked(e.target.checked)} /><span>These were earlier locations of this vault.</span></label>
    <button type="button" className="shr-btn" disabled={busy || !checked} onClick={onConfirm}>Confirm earlier locations and check again</button>
  </div>
}
