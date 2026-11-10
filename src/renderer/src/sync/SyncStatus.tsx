import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Info, RefreshCw } from 'lucide-react'
import { syncTime, type SyncInput, type SyncAction, type SyncRow } from './sync-status'
import { useSyncDisplay, type SyncStatusController } from './use-sync-status'
import './sync-status.css'

export function SyncMark({ row, end = false, rollup = false }: { row?: SyncRow; end?: boolean; rollup?: boolean }): JSX.Element | null {
  const [now, setNow] = useState(Date.now)
  const pending = row?.document.pendingSince
  useEffect(() => {
    if (pending === undefined || pending > Date.now()) return
    const next = pending + (Math.floor((Date.now() - pending) / 60_000) + 1) * 60_000
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, next - Date.now()))
    return () => clearTimeout(timer)
  }, [pending, now])
  if (!row?.mark) return null
  const detail = pending === undefined ? row.detail : row.detail.replace(/Waiting to send · \d+ min/, `Waiting to send · ${Math.max(1, Math.floor((Date.now() - pending) / 60_000))} min`)
  return <span className={`sync-mark-slot${end ? ' sync-end' : ''}${rollup ? ' sync-rollup' : ''}`} title={detail} role="img" aria-label={detail}>
    <span className={`sync-mark ${row.mark}`}>{row.mark === 'review' ? '!' : row.mark === 'new' ? '+' : ''}</span>
  </span>
}
function Action({ controller, action, children }: { controller: SyncStatusController; action: SyncAction; children: React.ReactNode }): JSX.Element {
  const reason = controller.reason(action)
  return <span title={reason ?? undefined} className="sync-action-wrap"><button type="button" className="sync-btn" aria-disabled={reason !== null} aria-description={reason ?? undefined} onClick={() => { if (!reason) void controller.run(action) }}>{children}</button></span>
}
function SourceInfo({ row }: { row: SyncRow }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])
  const sourceExplanation = row.sources.length > 1 ? 'Several sources changed this document at the same time.' : row.sources.length === 1 ? 'One source version is available for this document.' : 'Source details are not available yet.'
  return <div className="sync-info" ref={ref} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); button.current?.focus() } }}>
    <button ref={button} type="button" className="sync-info-button" title={sourceExplanation} aria-label={`Sources for ${row.document.title}`} aria-expanded={open} onClick={() => setOpen(!open)}><Info className="icon sm" /></button>
    {open && <div className="sync-sources" role="note"><p>{sourceExplanation}</p>
      {row.sources.length ? <ul>{row.sources.map(source => <li key={source.id}><strong>{source.name}</strong><span>{syncTime(source.changedAt)} · {source.revision}</span></li>)}</ul> : <p>Source details are not available yet.</p>}
    </div>}
  </div>
}
export function SyncPanel({ controller, selectedPath }: { controller: SyncStatusController; selectedPath?: string | null }): JSX.Element {
  const { input, error } = controller
  const p = useSyncDisplay(controller)
  const reviewReason = controller.reason('review')
  return <section className="sync-panel" aria-label="Vault sync" tabIndex={-1}>
    <header className={`sync-head ${p.tone}`}>
      <div className="sync-heading"><i className={`sync-dot ${p.tone}`} aria-hidden="true" />{p.heading}</div>
      <p>{p.description}</p>
      <div className="sync-actions"><Action controller={controller} action="syncNow">{input.connection === 'offline' ? 'Try again' : 'Sync now'}</Action><span>{p.checked} · Automatic backup is {input.automatic === null ? 'unknown' : input.automatic ? 'on' : 'off'}</span></div>
    </header>
    {controller.coverageExplanation && <details className="sync-coverage"><summary>What this does not cover</summary><p>{controller.coverageExplanation}</p></details>}
    {error && <p role="alert" className="sync-error">{error}</p>}
    <div className="sync-list">
      {p.groups.map(group => <section key={group.id} aria-label={group.label}>
        <h3><ChevronDown aria-hidden="true" />{group.label} · <b>{group.rows.length}</b></h3>
        {group.rows.map(row => <div className="sync-row-wrap" key={row.document.id}>
          <button type="button" className={`trow sync-row${selectedPath === row.document.path ? ' selected' : ''}${row.document.kind === 'deleted' ? ' deleted' : ''}`} aria-disabled={reviewReason !== null} title={reviewReason ?? row.detail} aria-description={reviewReason ?? undefined} onClick={() => { if (!reviewReason) void controller.run('review', row.document) }}>
            <span className="gtr"><SyncMark row={row} /></span>
            <span className="sync-row-text"><span className="sync-row-name">{row.document.title}</span><span className={`sync-row-detail ${row.mark ?? ''}`}>{row.detail}</span></span>
          </button>
          {row.document.review && <SourceInfo row={row} />}
        </div>)}
      </section>)}
      {p.unchangedDocuments !== null && p.unchangedDocuments > 0 && <h3 className="sync-unchanged">{p.unchangedDocuments} up to date</h3>}
      {!p.groups.length && <p className="sync-empty">{input.availability === 'ready' ? 'No document changes reported.' : 'Document sync status is not available yet.'}</p>}
    </div>
  </section>
}
export function SyncTitleStatus({ controller, onOpenSync, open, onOpenChange }: { controller: SyncStatusController; onOpenSync: () => void; open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const p = useSyncDisplay(controller)
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => { if (!ref.current?.contains(event.target as Node)) onOpenChange(false) }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); onOpenChange(false); button.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    const dialog = ref.current?.querySelector<HTMLElement>('.sync-popover')
    ;(dialog?.querySelector<HTMLElement>('button:not(:disabled):not([aria-disabled="true"])') ?? dialog)?.focus()
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [open, onOpenChange])
  return <div className="sync-title-status" ref={ref}>
    <span className="sync-announcement" role="status" aria-live="polite">{controller.error ? 'Sync status could not be read' : syncAnnouncement(controller.input)}</span>
    <button ref={button} type="button" className={`sync-status-button ${p.tone}`} aria-label={`Sync status: ${p.label}`} title="Sync status" aria-haspopup="dialog" aria-expanded={open} onClick={() => onOpenChange(!open)}><i className={`sync-dot ${p.tone}`} aria-hidden="true" /><span className="sync-label">{p.label}</span></button>
    {open && <div className="sync-popover" tabIndex={-1} role="dialog" aria-label="Sync status"><strong>{p.label}</strong>{p.summary && <p>{p.summary}</p>}<p>{p.facts.local}</p><p>{p.facts.backup}</p><p>{p.facts.branch}</p>{controller.coverageExplanation && <p className="sync-coverage">{controller.coverageExplanation}</p>}{controller.error && <p role="alert">{controller.error}</p>}
      <div className="sync-actions"><Action controller={controller} action="syncNow">Sync now</Action><Action controller={controller} action="check">Check</Action><Action controller={controller} action="history">History</Action></div>
      <button type="button" className="sync-open" onClick={() => { onOpenChange(false); onOpenSync() }}>Open Sync</button>
    </div>}
  </div>
}

/** Announce availability/urgency changes, never typing freshness or minute ages. */
export function syncAnnouncement(input: SyncInput, now = Date.now()): string {
  if (input.documents.some(d => d.recovery !== undefined)) return 'Recovery needed'
  if (input.documents.some(d => d.pendingSince !== undefined && now - d.pendingSince >= 300_000)) return 'Backup overdue'
  if (input.availability !== 'ready') return input.availability === 'unconfigured' ? 'Sync is not set up for this vault' : input.availability === 'auth-denied' ? 'Backup needs sign-in' : input.availability === 'scanner-missing' ? 'Backup safety check is unavailable' : 'Sync is unavailable'
  if (input.connection === 'offline') return 'Sync is offline'
  if (input.documents.some(d => d.review !== undefined)) return 'Sync needs review'
  if (input.documents.some(d => d.incoming !== undefined)) return 'Incoming changes'
  return input.connection === 'unknown' ? 'Sync connection unknown' : 'Sync is available'
}

/** The tab has its own display clock; minute changes never rebuild App commands. */
export function SyncTabStatus({ controller, selected, onOpen }: { controller: SyncStatusController; selected: boolean; onOpen: () => void }): JSX.Element {
  const p = useSyncDisplay(controller)
  return <button type="button" className={`pane-tab sync-tab${selected ? ' on' : ''}`} role="tab" aria-label={`Sync: ${p.label}`} aria-selected={selected} onClick={onOpen} title={`Sync · ${p.label}`}>
    <RefreshCw className="icon i sm" aria-hidden="true" /><i className={`sync-dot ${p.tone}`} aria-hidden="true" />
  </button>
}
