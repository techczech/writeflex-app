import { useCallback, useEffect, useRef, useState } from 'react'
import { gitState, heldSentence, largeCheckSentence, leftAtQuitSentence, stopSentences, stopSentence, shortReason, documents, shortPath, type GitView, type GitSyncAction } from '../../../shared/git-sync-view'
import { calendarTime } from '../components/relative-time'
import type { ReactNode } from 'react'
import { presentProtection } from '../../../shared/remote-protection'
import './git-sync.css'
export function useGitSync(root: string | null, readDirty: () => string[]) {
  const [view, setView] = useState<GitView | null>(null), current = useRef({ root, readDirty })
  current.current = { root, readDirty }
  const call = useCallback(async (action: GitSyncAction, value?: unknown) => {
    const captured = current.current.root
    const next = await window.writeflex.gitSync.call({ action, value })
    if (current.current.root === captured && next?.root === captured) setView(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
  }, [])
  useEffect(() => {
    setView(null)
    const off = window.writeflex.gitSync.onPrepare(input => {
      if (input.root === current.current.root) void window.writeflex.gitSync.buffers({ ...input, paths: current.current.readDirty() })
    })
    if (root) void call('open')
    const timer = setInterval(() => { if (current.current.root) void call('status') }, 1000)
    const clock = setInterval(() => setView(v => v ? { ...v } : v), 60000)
    return () => { off(); clearInterval(timer); clearInterval(clock) }
  }, [root])
  return { view: view?.root === root ? view : null, call }
}
export type GitController = ReturnType<typeof useGitSync>
const age = (time?: number) => time === undefined ? 'not yet' : calendarTime(time)
const source = (name?: string) => !name || name === 'other copy' ? 'another computer' : name
const needs = (n: number) => `${documents(n)} ${n === 1 ? 'needs' : 'need'} you`
function Heading({ tone, children }: { tone: string; children: ReactNode }) {
  return <h2 className="sync-heading"><i className={`sync-dot ${tone}`} aria-hidden="true" />{children}</h2>
}
function Rows({ rows }: { rows: Array<[string, string]> }) {
  return <dl className="sync-list git-rows">{rows.map(([name, value]) => <div className="trow" key={name}><dt>{name} </dt><dd>{value}</dd></div>)}</dl>
}
const routeOf = (v: GitView) => ({ enabled: v.result.enabled, state: v.result.enabled ? (gitState(v)===6 ? 5 : gitState(v)) : null, lastSentAt: v.result.lastSentAt, busy: v.busy })
/** Issue 257: the remote copy of this folder, from the backup tool's records and WriteFlex sync's sends; never from a save. */
export function ProtectionSection({ view }: { view: GitView }) {
  const p = presentProtection(view.protection, routeOf(view), Date.now(), view.protection?.tool ?? view.backupTool)
  return <section className="git-state git-protection" aria-label="Remote copy" data-protection={p.tone}>
    <Heading tone={p.tone}>{p.heading}</Heading>
    <ul className="git-routes">{p.routes.map(r => <li key={r.name} data-route={r.name}><i className={`sync-dot ${r.tone}`} aria-hidden="true" /><span><strong>{r.name}:</strong> {r.text}</span></li>)}</ul>
    {p.lines.map(line => <p key={line}>{line}</p>)}
    {p.gaps.length > 0 && <div className="git-protection-gaps" role="note">{p.gaps.map(line => <p key={line}>{line}</p>)}</div>}
  </section>
}
/** Status-bar mark for a Git vault whose WriteFlex sync is off: what the backup tool's records say, in a few words. */
export function ProtectionMark({ view, onOpen }: { view: GitView; onOpen: () => void }) {
  const p = presentProtection(view.protection, routeOf(view), Date.now(), view.protection?.tool ?? view.backupTool)
  const detail = `${p.heading}. ${[...p.routes.map(r => `${r.name}: ${r.text}`), ...p.lines, ...p.gaps].join(' ')}`
  return <button className={`git-sync-mark protection-mark ${p.tone}`} aria-label={`Remote copy: ${p.label}`} title={detail} onClick={onOpen}><i aria-hidden="true" /><strong>{p.label}</strong><span className="sync-announcement" role="status" aria-live="polite">{p.heading}</span></button>
}
export function GitMark({ controller, onOpen }: { controller: GitController; onOpen: () => void }) {
  const v = controller.view
  if (!v?.result.enabled) return null
  const state = gitState(v), r = v.result, tone = state === 4 ? 'red' : state === 5 || state === 6 ? 'amber' : v.busy || state === 3 ? 'blue' : 'green'
  const label = state === 4 ? `Sync stopped: ${shortReason[r.reason!.code]}` : state === 5 ? `${r.pairs.length} ${r.pairs.length === 1 ? 'needs' : 'need'} you` : state === 6 ? `${r.held!.length} held back` : v.busy ? 'Updating…' : state === 3 ? `${r.pending.length} to send` : 'Up to date'
  const detail = state === 4 ? `Sync stopped: ${stopSentence(r.reason!)}` : state === 6 ? r.held!.map(file=>heldSentence(file,!r.reason)).join(' ') : v.leftAtQuit ? leftAtQuitSentence[v.leftAtQuit] : state === 2 ? `${documents(r.incoming.length)} updated from ${source(r.lastReceived?.from)}` : label
  return <button className={`git-sync-mark ${tone}`} aria-label={detail} title={detail} onClick={onOpen}><i aria-hidden="true" /><strong>{label}</strong><span className="sync-announcement" role="status" aria-live="polite">{detail}</span></button>
}
/** Shown instead of anything that would run Git: on a Mac without the tools, `/usr/bin/git` opens Apple's installer. */
export function MissingTools({ call }: { call: (action: 'install-tools' | 'check-tools') => unknown }) {
  return <><p>{stopSentences['tools-missing']}</p><div className="git-actions"><button className="btn primary" onClick={() => void call('install-tools')}>Install Command Line Tools</button><button className="btn" onClick={() => void call('check-tools')}>Check again</button></div></>
}
export function GitPanel({ controller, open, modifiedAt = {} }: { controller: GitController; open: (path: string) => void; modifiedAt?: Record<string, number> }) {
  const [change, setChange] = useState(false), v = controller.view
  if (!v) return null
  const r = v.result, call = controller.call, state = gitState(v)
  const location = r.location ?? (v.discovery.state === 'ready' ? v.discovery : undefined)
  const localRemote = v.discovery.state === 'ready' ? v.discovery.localPath : location?.localPath
  const destination = localRemote ? shortPath(localRemote) : location ? `${location.host} repository ${location.repository} (Git)` : 'previously connected repository (Git)'
  const edited = (path: string) => { const time = modifiedAt[path] ?? v.edits?.[path]; return time === undefined ? 'edit time not known' : `edited ${age(time)}` }
  const button = (label: string, action: GitSyncAction, primary = true) => <button className={`btn${primary ? ' primary' : ''}`} disabled={v.busy && action !== 'disable'} onClick={() => void call(action)}>{label}</button>
  if (v.discovery.state === 'tools-missing') return <section className="sync-panel git-panel" aria-label="Vault sync"><ProtectionSection view={v} /><Heading tone="blue">Sync this vault</Heading><MissingTools call={call} />{v.paused && <p>Sync is switched on for this vault and is paused until then. Nothing is sent or received. <button className="git-link" onClick={() => void call('disable')}>Turn sync off</button></p>}</section>
  // Vault sync with Git switched off at launch: the remote copy (issue 257), what a save means, and one plain line when
  // this vault has been part of sync. Nothing here offers to turn sync on or runs it.
  if (v.experimentalOff) return <section className="sync-panel git-panel" aria-label="Vault sync"><ProtectionSection view={v} /><p>WriteFlex sync is off for this vault. WriteFlex saves your writing on this Mac only and sends nothing anywhere.</p>{v.syncMarker && <p>Vault sync with Git is switched off (experimental).</p>}</section>
  if (!r.enabled) return <section className="sync-panel git-panel" aria-label="Vault sync"><ProtectionSection view={v} /><Heading tone="blue">Sync this vault</Heading>{r.warnings.filter(w=>w.message.includes("while sync is off")).map(w=><p className="git-history-notice" key={w.path}>{w.message}</p>)}{r.reason ? <p>{stopSentence(r.reason)}</p> : v.discovery.state === 'ready' ? <><p>WriteFlex sync is off for this vault. WriteFlex saves your writing on this Mac only and sends nothing anywhere.</p><p>Turn it on and WriteFlex sends this folder&rsquo;s changes to <span title={localRemote}>{localRemote ? shortPath(localRemote) : `${v.discovery.host} repository ${v.discovery.repository}`}</span>, branch {v.discovery.branch}: it checks when you open the vault, sends three minutes after your last save, and sends when you quit.</p>{button('Turn on sync for this vault', 'enable')}</> : <p>{v.discovery.state === 'unsupported' ? stopSentences.unsupported : v.discovery.state === 'detached' ? 'Choose a branch for this folder with Git before turning on sync.' : v.discovery.state === 'operation-in-progress' ? 'Another update is unfinished in this folder. Finish it with Git before turning on sync.' : v.discovery.state === 'no-remote' ? 'This folder has no place to send changes. Connect it to a repository with Git before turning on sync.' : v.discovery.state === 'ambiguous-remote' ? 'This folder has more than one possible place to send changes. Choose one with Git before turning on sync.' : 'This folder cannot be safely updated here. Check its location and arrangement with Git.'}</p>}</section>
  const waiting = r.pending.length > 0 || r.internalPending.length > 0
  return <section className="sync-panel git-panel" aria-label="Vault sync" aria-busy={v.busy}>
    <div role="status" aria-live="polite" className="sync-announcement">{state === 4 ? 'Sync has stopped' : state === 5 ? needs(r.pairs.length) : state === 3 ? `${documents(r.pending.length)} waiting to be sent` : state === 6 ? 'Large files are held back' : state === 2 ? `${documents(r.incoming.length)} updated from ${source(r.lastReceived?.from)}` : 'Up to date'}</div>
    {state === 1 && <section className="git-state"><Heading tone="green">Up to date</Heading><p>Everything here is also {localRemote ? `in ${shortPath(localRemote)}` : `on ${location?.host}`}. Last sent {age(r.lastSentAt)}.</p><Rows rows={[
      ['This Mac:', r.computerName], ['Last change from elsewhere:', r.lastReceived ? `${source(r.lastReceived.from)}, ${age(r.lastReceived.at)}` : 'None yet'],
    ]} />{button('Sync now', 'fetch', false)}</section>}
    {state === 4 && <section className="git-state"><Heading tone="red">Sync has stopped</Heading><p>{stopSentence(r.reason!)}</p><p>{r.lastSentAt === undefined ? 'Nothing has been sent yet.' : `Nothing has been sent since ${age(r.lastSentAt)}.`} Your writing is saved on this Mac only.</p>{r.pending.length > 0 && <Rows rows={[[ 'Waiting to be sent:', documents(r.pending.length) ]]} />}{button('Try now', 'send')}</section>}
    {!!r.pairs.length && <section className="git-state"><Heading tone="amber">{needs(r.pairs.length)}</Heading>{r.pairs.map((pair, i) => <article key={pair.id}><p>{pair.local} was changed here and on {source(pair.from)}. Both versions are kept. Nothing was merged for you.</p><div className="git-actions"><button className={`btn${i === 0 ? ' primary' : ''}`} onClick={() => { open(pair.local); open(pair.other) }}>Open both</button><button className="btn" onClick={() => void call('done', pair.id)}>Done</button></div></article>)}{state === 5 && !r.reason && !waiting && !r.held?.length && <p>Everything else is up to date.</p>}</section>}
    {(r.pending.length > 0 || state === 3) && <section className="git-state"><Heading tone="blue">{documents(r.pending.length)} waiting to be sent</Heading><p>WriteFlex sends {v.wait} minute{v.wait === 1 ? '' : 's'} after you stop typing, and when you quit.</p>{r.reason?.code === 'network-unavailable' && state !== 4 && <p>Will send when you are back online.</p>}<Rows rows={r.pending.map(d => [d.path, edited(d.path)])} />{button('Send now', 'send')}</section>}
    {!!r.held?.length && <section className="git-state"><Heading tone="amber">Large files held back</Heading>{r.held.map(file=><p key={file.path}>{heldSentence(file,!r.reason)}</p>)}{button('Check large files now','check-large-files',false)}</section>}
    {r.largeChecks?.map(check=><p key={check.path} role="status">{largeCheckSentence(check)}</p>)}
    {!!r.incoming.length && <section className="git-state"><Heading tone="green">{documents(r.incoming.length)} updated from {source(r.lastReceived?.from)}</Heading><p>Brought in {age(r.lastReceived?.at)}.</p><Rows rows={r.incoming.map(d => [d.path, d.kind === 'new' ? 'new' : d.kind === 'removed' ? 'removed' : 'changed'])} /><button className="btn primary" disabled={!r.incoming.some(d => d.kind !== 'removed')} title={r.incoming.every(d => d.kind === 'removed') ? 'These documents were removed. Their names are listed above.' : undefined} onClick={() => { const d = r.incoming.find(d => d.kind !== 'removed'); if (d) open(d.path) }}>Show what changed</button><p>Nothing of yours was overwritten.</p></section>}
    {v.leftAtQuit && <p className="git-history-notice" role="status" aria-live="polite">{leftAtQuitSentence[v.leftAtQuit]}</p>}
    {[...new Set(r.warnings.filter(w => w.code === 'history-kept').map(w => w.message))].map(message => <p className="git-history-notice" role="status" aria-live="polite" key={message}>{message}</p>)}
    <ProtectionSection view={v} />
    <footer><p title={localRemote}>Kept in: {destination}</p><p>Sends automatically · <button className="git-link" onClick={() => setChange(!change)}>Change</button></p>{change && <><label>Send after <select value={v.wait} onChange={e => void call('wait', Number(e.target.value))}>{[1,3,10].map(n => <option key={n} value={n}>{n} minute{n === 1 ? '' : 's'}</option>)}</select></label>{button('Turn sync off', 'disable', false)}</>}</footer>
  </section>
}
