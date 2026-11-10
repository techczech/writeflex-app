import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowRight, CircleCheck, FileText, History, TriangleAlert } from 'lucide-react'
import {
  needsLine, importedLine, safetyVersionName,
  type ImportBases, type ImportDone, type ImportPrepared, type ImportRefused,
} from '../../../shared/folio-version-import'
import { versionWhen } from '../../../shared/folio-versions-view'

/**
 * Import a co-author's Word revision, steps 1 and 2 (Folio versions ticket 14), after the locked mockup
 * (docs/design/2026-11-02-folio-versions/mockup/locked/, scenes import-start, import-match, error). A workspace view in the Versions tab, not a
 * modal: it takes the tab's main column and leaves the timeline where it is. Step 1 chooses the file (the system dialog: the window never names
 * a path), who it is from and which version she started from. Step 2 shows how her sections match the parts of that version and asks the
 * writer to decide every close match and every ambiguous section. NOTHING is written until "Bring changes into the Folio": Match sections, Back,
 * Cancel and every decision only read. Step 3, deciding what to take, is its own view (FolioVersionDecide.tsx); this one offers it when the revision is stored.
 *
 * Keys. Every key typed in this view that is not a chord with ⌘ or Control stops here, so none reaches the Folio room's own keys (a part's
 * removal, its move, its opening). The reserved chords (⌘⇧P, ⌘/ and the rest) still work. Escape leaves the import with nothing written, except
 * on an open drop-down, which takes it first, and while a write runs.
 */

type Phase = 'start' | 'match' | 'done'
type Busy = null | 'choosing' | 'matching' | 'deciding' | 'writing'

export type FolioVersionImportProps = {
  dir: string
  /** Leave the import (Cancel, Escape, Close). Main forgets the file first. */
  onClose: () => void
  /** The incoming version was stored: the tab shows it. */
  onDone: (id: string) => void
  /** Opens the save sheet, for a refusal that asks for a saved version first. Absent: that button is not drawn. */
  onSaveVersion?: () => void
  /** Step 3 (ticket 16): the writer goes on to decide what to take. Absent: the button is not drawn. */
  onDecide?: (id: string) => void
}

/** The drop-down value for "none of the parts: a new section" (a part is named by its path, which cannot be this). */
const NO_PART = '\u0000none'

const sizeText = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('en-GB')} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`)

export function FolioVersionImport({ dir, onClose, onDone, onSaveVersion, onDecide }: FolioVersionImportProps): JSX.Element {
  const root = useRef<HTMLDivElement | null>(null)
  const [phase, setPhase] = useState<Phase>('start')
  const [busy, setBusy] = useState<Busy>(null)
  const [file, setFile] = useState<{ name: string; bytes: number } | null>(null)
  const [from, setFrom] = useState('')
  const [bases, setBases] = useState<ImportBases | null>(null)
  const [basesRefused, setBasesRefused] = useState<ImportRefused | null>(null)
  const [pickedBase, setPickedBase] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<ImportPrepared | null>(null)
  const [decisions, setDecisions] = useState<Array<{ section: number; part: string | null }>>([])
  const [refused, setRefused] = useState<ImportRefused | null>(null)
  const [done, setDone] = useState<ImportDone | null>(null)
  const seq = useRef(0)

  const base = pickedBase ?? bases?.baseId

  // Step 1: the versions she could have started from, for this name. Reads only.
  useEffect(() => {
    if (phase !== 'start') return
    const name = from.trim()
    if (name === '') { setBases(null); setBasesRefused(null); return }
    const mine = ++seq.current
    const timer = setTimeout(() => {
      void window.writeflex.folioVersions.importBases({ dir, from: name, ...(pickedBase ? { base: pickedBase } : {}) }).then((answer) => {
        if (mine !== seq.current) return
        if (answer.status === 'ready') { setBases(answer); setBasesRefused(null) } else { setBases(null); setBasesRefused(answer) }
      }, () => { if (mine === seq.current) { setBases(null); setBasesRefused(null) } })
    }, 200)
    return () => clearTimeout(timer)
  }, [dir, from, pickedBase, phase])

  const leave = useCallback((): void => {
    void window.writeflex.folioVersions.importForget().catch(() => false)
    onClose()
  }, [onClose])

  useEffect(() => { requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-testid="import-choose"]')?.focus()) }, [])

  const choose = useCallback(async (): Promise<void> => {
    setBusy('choosing'); setRefused(null)
    try {
      const answer = await window.writeflex.folioVersions.importChoose(dir)
      if (answer.status === 'chosen') { setFile({ name: answer.name, bytes: answer.bytes }); setPrepared(null); setDecisions([]) }
      else if (answer.status === 'error') setRefused({ status: 'refused', code: 'unreadable-file', message: `${answer.message} Nothing was changed.`, nothingWritten: true })
    } finally { setBusy(null) }
  }, [dir])

  /** The file changed on disk since the writer saw it: show it read afresh, every decision cleared, and say so in words. Nothing was written. */
  const showChanged = useCallback((answer: ImportRefused): void => {
    if (!answer.prepared) return
    setPrepared(answer.prepared); setDecisions([]); setRefused(answer); setPhase('match')
  }, [])

  /** Read her file and match it, with the writer's decisions so far. */
  const match = useCallback(async (next: Array<{ section: number; part: string | null }>, why: 'matching' | 'deciding'): Promise<void> => {
    if (!bases) return
    setBusy(why); setRefused(null)
    const mine = ++seq.current
    try {
      // A decision is made against the text the writer is looking at: the request names that file by its hash, and main refuses if the file is not those bytes any more.
      const seen = why === 'deciding' && prepared ? { fileSha256: prepared.file.sha256 } : {}
      const answer = await window.writeflex.folioVersions.importPrepare({ dir, from: from.trim(), base: base ?? bases.baseId, resolutions: next, ...seen })
      if (mine !== seq.current) return
      if (answer.status === 'refused' && answer.code === 'file-changed' && answer.prepared) { showChanged(answer); return }
      if (answer.status === 'refused') { setRefused(answer); if (why === 'matching') setPhase('start'); return }
      setPrepared(answer); setDecisions(next); setPhase('match')
    } catch {
      if (mine === seq.current) setRefused({ status: 'refused', code: 'unreadable-file', message: 'WriteFlex could not read that file. Nothing was changed.', nothingWritten: true })
    } finally { if (mine === seq.current) setBusy(null) }
  }, [bases, base, dir, from, prepared, showChanged])

  const decide = (section: number, part: string | null): void => {
    const next = [...decisions.filter((entry) => entry.section !== section), { section, part }]
    void match(next, 'deciding')
  }

  const bring = useCallback(async (): Promise<void> => {
    if (!prepared || !bases) return
    setBusy('writing'); setRefused(null)
    try {
      const answer = await window.writeflex.folioVersions.importCommit({ dir, from: from.trim(), base: base ?? bases.baseId, resolutions: decisions, fileSha256: prepared.file.sha256 })
      if (answer.status === 'done') { setDone(answer); setPhase('done') }
      else if (answer.code === 'file-changed' && answer.prepared) showChanged(answer)
      else setRefused(answer)
    } catch {
      setRefused({ status: 'refused', code: 'not-recorded', message: 'Something went wrong, and WriteFlex cannot say what was written. Check the Versions list.', nothingWritten: false })
    } finally { setBusy(null) }
  }, [prepared, bases, base, dir, from, decisions, showChanged])

  useEffect(() => {
    if (refused) requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-testid="import-refused"]')?.focus())
  }, [refused])
  useEffect(() => {
    if (phase === 'match') requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-testid="import-step-heading"]')?.focus())
    if (phase === 'done') requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[data-testid="import-done"]')?.focus())
  }, [phase])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Nothing typed here reaches the Folio room's own keys. A chord with ⌘ or Control is the app's (the palette, the cheat sheet).
    if (!(event.metaKey || event.ctrlKey)) event.stopPropagation()
    if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !(event.target as HTMLElement).closest('select') && busy !== 'writing') {
      event.preventDefault()
      leave()
    }
  }

  const ready = file !== null && from.trim() !== '' && bases !== null && busy === null
  const stepper = (
    <ol className="fvi-stepper" aria-label="Import steps">
      <li className={phase === 'start' ? 'on' : 'done'} aria-current={phase === 'start' ? 'step' : undefined}>1 Choose the file</li>
      <li className={phase === 'match' ? 'on' : phase === 'done' ? 'done' : ''} aria-current={phase === 'match' ? 'step' : undefined}>2 Match sections</li>
      <li className={phase === 'done' ? 'on' : ''}>3 Decide</li>
    </ol>
  )

  return (
    <div className="fvi" data-testid="folio-import" data-phase={phase} data-busy={busy ?? undefined} aria-busy={busy !== null || undefined} ref={root} onKeyDown={onKeyDown}>
      {stepper}
      {refused && (
        <div className="fvs-banner bad fvi-banner" role="alert" tabIndex={-1} data-testid="import-refused" data-code={refused.code}>
          <TriangleAlert className="icon" aria-hidden="true" />
          <div>
            {refused.message}
            <div className="fvi-banner-actions">
              {(refused.code === 'version-unsettled' || refused.code === 'no-versions') && onSaveVersion && <button type="button" className="fv-btn" onClick={onSaveVersion} data-testid="import-save-version"><History aria-hidden="true" />Save Folio version…</button>}
              {phase !== 'done' && !['version-unsettled', 'no-versions', 'needs-decision', 'file-changed', 'safety-not-saved', 'not-recorded', 'collection-closed'].includes(refused.code) && <button type="button" className="fv-btn" onClick={() => { void choose() }} data-testid="import-choose-another"><FileText aria-hidden="true" />Choose another file…</button>}
            </div>
          </div>
        </div>
      )}

      {phase === 'start' && (
        <section className="fvi-card" data-testid="import-step-1">
          <h3 className="fvs-card-head">Revision from a co-author</h3>
          <div className="fvi-kv">
            <span className="fvi-k">Word file</span>
            <span className="fvi-v">
              {file ? <span data-testid="import-file"><FileText aria-hidden="true" className="fvi-ico" /> {file.name} <span className="fvi-muted">· {sizeText(file.bytes)}</span> </span> : <span className="fvi-muted" data-testid="import-file">None chosen yet</span>}
              <button type="button" className="fv-btn" data-testid="import-choose" disabled={busy !== null} onClick={() => { void choose() }}>{file ? 'Choose another…' : 'Choose a file…'}</button>
            </span>
            <label className="fvi-k" htmlFor="fvi-from">From</label>
            <span className="fvi-v"><input id="fvi-from" className="fvi-input" data-testid="import-from" value={from} placeholder="Who it is from, for example Sam Rowe" maxLength={120} autoComplete="off" spellCheck={false} onChange={(event) => { setFrom(event.target.value); setPickedBase(null) }} /></span>
            <label className="fvi-k" htmlFor="fvi-base">Started from</label>
            <span className="fvi-v">
              {bases ? (
                <>
                  <select id="fvi-base" className="fvi-input" data-testid="import-base" value={base ?? bases.baseId} onChange={(event) => setPickedBase(event.target.value)}>
                    {bases.bases.map((version) => <option key={version.id} value={version.id}>{version.name} · {versionWhen(version.ts)}{version.sentTo ? ` · sent to ${version.sentTo}` : ''}</option>)}
                  </select>
                  {bases.bases.find((version) => version.id === (base ?? bases.baseId))?.sentTo !== undefined && <span className="fv-chip acc" data-chip="sent">sent to {bases.bases.find((version) => version.id === (base ?? bases.baseId))?.sentTo}</span>}
                  {bases.baseNote !== null && pickedBase === null && <span className="fvi-note" data-testid="import-base-note">{bases.baseNote}</span>}
                </>
              ) : <span className="fvi-muted" data-testid="import-base">{basesRefused ? 'Not available' : 'Say who it is from first.'}</span>}
            </span>
            <span className="fvi-k">Your text now</span>
            <span className="fvi-v" data-testid="import-now">
              {bases ? (
                <>
                  {bases.changedSince !== null && <span className={`fv-chip${bases.changedSince > 0 ? ' warn' : ''}`} data-chip="changed-since">{bases.changedSince === 0 ? 'no parts changed since then' : `${bases.changedSince.toLocaleString('en-GB')} ${bases.changedSince === 1 ? 'part' : 'parts'} changed since then`}</span>}
                  {' '}will be saved first as <b>{bases.safetyName}</b>
                </>
              ) : from.trim() !== '' ? <span className="fvi-muted">It will be saved first as <b>{safetyVersionName(from.trim())}</b>.</span> : <span className="fvi-muted">It is saved first as a version, so nothing can be lost.</span>}
            </span>
          </div>
          {basesRefused && !refused && <div className="fvs-banner bad fvi-banner-inline" role="status" data-testid="import-bases-refused" data-code={basesRefused.code}><TriangleAlert className="icon" aria-hidden="true" /><div>{basesRefused.message}{(basesRefused.code === 'version-unsettled' || basesRefused.code === 'no-versions') && onSaveVersion && <div className="fvi-banner-actions"><button type="button" className="fv-btn" onClick={onSaveVersion} data-testid="import-save-version"><History aria-hidden="true" />Save Folio version…</button></div>}</div></div>}
          <div className="fvi-foot">
            <button type="button" className="fv-btn" data-testid="import-cancel" onClick={leave}>Cancel</button>
            <button type="button" className="fv-btn pri" data-testid="import-match" aria-disabled={ready ? undefined : true} title={ready ? undefined : file === null ? 'Choose the Word file first.' : from.trim() === '' ? 'Say who it is from first.' : undefined} onClick={() => { if (ready) void match([], 'matching') }}>Match sections<ArrowRight aria-hidden="true" /></button>
          </div>
        </section>
      )}

      {phase === 'match' && prepared && (
        <MatchStep prepared={prepared} decisions={decisions} busy={busy} onDecide={decide} onBack={() => { setPhase('start'); setRefused(null) }} onCancel={leave} onBring={() => { if (prepared.needs === 0 && busy === null) void bring() }} />
      )}

      {phase === 'done' && done && (
        <section className="fvi-card" data-testid="import-done" tabIndex={-1}>
          <h3 className="fvs-card-head">Stored</h3>
          <div className="fvi-done"><CircleCheck className="icon" aria-hidden="true" /><p data-testid="import-done-line">{importedLine(done)}</p></div>
          {done.staged.notStaged.length > 0 && (
            <ul className="fvi-notstaged" data-testid="import-not-staged">
              {done.staged.notStaged.slice(0, 20).map((item, at) => <li key={`${item.section}-${at}`}><b>{item.heading === '' ? 'A section' : `“${item.heading}”`}</b>: {item.why}</li>)}
              {done.staged.notStaged.length > 20 && <li>and {(done.staged.notStaged.length - 20).toLocaleString('en-GB')} more.</li>}
            </ul>
          )}
          <div className="fvi-foot">
            <button type="button" className="fv-btn" data-testid="import-close" onClick={leave}>Close</button>
            {onDecide && <button type="button" className="fv-btn pri" data-testid="import-decide" onClick={() => { void window.writeflex.folioVersions.importForget().catch(() => false); onDecide(done.id) }}>Decide what to take</button>}
            <button type="button" className="fv-btn" data-testid="import-show" onClick={() => { void window.writeflex.folioVersions.importForget().catch(() => false); onDone(done.id) }}>Show it in the timeline</button>
          </div>
        </section>
      )}
    </div>
  )
}

export function MatchStep({ prepared, decisions, busy, onDecide, onBack, onCancel, onBring }: {
  prepared: ImportPrepared
  decisions: Array<{ section: number; part: string | null }>
  busy: Busy
  onDecide: (section: number, part: string | null) => void
  onBack: () => void
  onCancel: () => void
  onBring: () => void
}): JSX.Element {
  const counts = {
    exact: prepared.items.filter((item) => item.status === 'exact').length,
    confirmed: prepared.items.filter((item) => item.status === 'confirmed').length,
    close: prepared.items.filter((item) => item.status === 'proposed').length,
    fresh: prepared.items.filter((item) => item.status === 'new').length,
  }
  const waiting = prepared.needs > 0
  const decided = (section: number): boolean => decisions.some((entry) => entry.section === section)
  const unused = (section: number): string | undefined => prepared.unusedResolutions.find((entry) => entry.section === section)?.why
  const taken = new Set(prepared.items.flatMap((item) => (item.status === 'exact' || item.status === 'confirmed' ? [item.part.path] : [])))
  const label = (heading: string | null): string => (heading === null || heading.trim() === '' ? '(no heading)' : heading)

  return (
    <section className="fvi-card" data-testid="import-step-2">
      <h3 className="fvs-card-head" tabIndex={-1} data-testid="import-step-heading">{prepared.file.name} · {prepared.file.sections.toLocaleString('en-GB')} sections · tracked changes: {prepared.file.changes.toLocaleString('en-GB')} found{prepared.file.reviewers.length > 0 ? ` (${prepared.file.reviewers.join(', ')})` : ''}</h3>
      <p className="fvi-sum" data-testid="import-summary">
        {counts.exact + counts.confirmed} matched · {counts.close} close · {prepared.items.filter((item) => item.status === 'ambiguous').reduce((sum, item) => sum + (item.status === 'ambiguous' ? item.sections.length : 0), 0)} to place · {counts.fresh} new · {prepared.missing.length} not in the Word file
      </p>
      <div className="fvi-scroll">
        <table className="fvi-table" data-testid="import-table">
          <thead><tr><th scope="col">In the Word file</th><th scope="col"><span className="fvc-sr">Matched to</span></th><th scope="col">In the Folio</th><th scope="col">Match</th></tr></thead>
          <tbody>
            {prepared.items.map((item) => {
              if (item.status === 'ambiguous') {
                return item.sections.map((section) => (
                  <tr key={`a${section.index}`} data-testid="import-row" data-status="ambiguous" data-section={section.index}>
                    <td>{label(section.heading)}</td>
                    <td aria-hidden="true"><ArrowRight className="fvi-ico" /></td>
                    <td>
                      <select className="fvi-input" aria-label={`Which part is “${label(section.heading)}”?`} data-testid="import-place" value="" disabled={busy !== null} onChange={(event) => onDecide(section.index, event.target.value === NO_PART ? null : event.target.value)}>
                        <option value="" disabled>Choose a part…</option>
                        {item.candidates.map((part) => <option key={`c${part.path}`} value={part.path} disabled={taken.has(part.path)}>{part.title}</option>)}
                        {prepared.parts.filter((part) => !item.candidates.some((c) => c.path === part.path)).map((part) => <option key={part.path} value={part.path} disabled={taken.has(part.path)}>{part.title}{part.role === 'unlisted' ? ' (not in the outline)' : ''}</option>)}
                        <option value={NO_PART}>No part: a new section</option>
                      </select>
                    </td>
                    <td><span className="fv-chip warn" data-chip="ambiguous">needs you</span><div className="fvi-why">{item.message}</div>{unused(section.index) && <div className="fvi-why bad" role="status">{unused(section.index)}</div>}</td>
                  </tr>
                ))
              }
              const heading = label(item.section.heading)
              if (item.status === 'new') {
                return (
                  <tr key={`n${item.section.index}`} data-testid="import-row" data-status="new" data-section={item.section.index}>
                    <td>{heading}</td><td aria-hidden="true"><ArrowRight className="fvi-ico" /></td><td className="fvi-muted">—</td>
                    <td><span className="fv-chip acc" data-chip="new">new section</span><div className="fvi-why">{decided(item.section.index) ? 'You said it is none of the parts. It becomes a new part, decided later.' : 'Becomes a new part, decided later.'}{item.note ? ` ${item.note}` : ''}</div></td>
                  </tr>
                )
              }
              const moved = item.moved
              if (item.status === 'proposed') {
                return (
                  <tr key={`p${item.section.index}`} data-testid="import-row" data-status="close" data-section={item.section.index}>
                    <td>{heading}</td><td aria-hidden="true"><ArrowRight className="fvi-ico" /></td><td>{item.part.title}</td>
                    <td>
                      <span className="fv-chip warn" data-chip="close">close · {prepared.confidenceWords[item.confidence ?? 'possible']}</span>{moved && <span className="fv-chip" data-chip="moved"> moved</span>}
                      <div className="fvi-why">{item.reason}</div>
                      <div className="fvi-actions">
                        <button type="button" className="fv-btn" data-testid="import-same" disabled={busy !== null} onClick={() => onDecide(item.section.index, item.part.path)}>Same part</button>
                        <select className="fvi-input" aria-label={`Something else for “${heading}”`} data-testid="import-different" value="" disabled={busy !== null} onChange={(event) => onDecide(item.section.index, event.target.value === NO_PART ? null : event.target.value)}>
                          <option value="" disabled>Different…</option>
                          {prepared.parts.filter((part) => part.path !== item.part.path).map((part) => <option key={part.path} value={part.path} disabled={taken.has(part.path)}>{part.title}{part.role === 'unlisted' ? ' (not in the outline)' : ''}{taken.has(part.path) ? ' · already matched' : ''}</option>)}
                          <option value={NO_PART}>None: a new section</option>
                        </select>
                      </div>
                      {unused(item.section.index) && <div className="fvi-why bad" role="status">{unused(item.section.index)}</div>}
                    </td>
                  </tr>
                )
              }
              return (
                <tr key={`m${item.section.index}`} data-testid="import-row" data-status={item.status} data-section={item.section.index}>
                  <td>{heading}</td><td aria-hidden="true"><ArrowRight className="fvi-ico" /></td><td>{item.part.title}</td>
                  <td>
                    {item.status === 'exact' ? <span className="fv-chip acc" data-chip="exact">exact heading</span> : <span className="fv-chip acc" data-chip="confirmed">{item.source === 'writer' ? 'your choice' : 'confirmed by you'}</span>}
                    {moved && <span className="fv-chip" data-chip="moved"> moved</span>}
                    <div className="fvi-why">{item.status === 'exact' ? 'Matched by its heading.' : item.source === 'writer' ? 'You chose this part.' : 'You confirmed the close match.'}{moved ? ' The Word file’s order differs from yours; decided later.' : ''}</div>
                  </td>
                </tr>
              )
            })}
            {prepared.missing.map((part) => (
              <tr key={`x${part.path}`} data-testid="import-row" data-status="missing">
                <td className="fvi-muted">—</td><td aria-hidden="true"><ArrowRight className="fvi-ico" /></td><td>{part.title}</td>
                <td><span className="fv-chip warn" data-chip="missing">not in the Word file</span><div className="fvi-why">Possible removal, decided later.</div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {prepared.mechanism === 'judgement-stub' && <p className="fvi-note" data-testid="import-mechanism">Exact headings are matched by WriteFlex. Close matches are a guess from the words in the headings and the text before their tracked changes, not a reading of what the sections mean. You decide each one.</p>}
      <div className="fvi-foot">
        <span className="fvi-need" data-testid="import-need" role="status">{waiting ? needsLine(prepared.needs) : 'Nothing is applied yet. The Word file’s sections are stored with the version, and you decide what to take next.'}</span>
        <button type="button" className="fv-btn" data-testid="import-back" disabled={busy !== null} onClick={onBack}>Back</button>
        <button type="button" className="fv-btn" data-testid="import-cancel" disabled={busy === 'writing'} onClick={onCancel}>Cancel</button>
        <button type="button" className="fv-btn pri" data-testid="import-bring" aria-disabled={waiting || busy !== null ? true : undefined} title={waiting ? needsLine(prepared.needs) : undefined} onClick={onBring}>Bring changes into the Folio<ArrowRight aria-hidden="true" /></button>
      </div>
    </section>
  )
}
