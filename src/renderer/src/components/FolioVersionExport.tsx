import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { CircleCheck, FileCode2, FileText, Lock, Send, TriangleAlert, Upload } from 'lucide-react'
import type { ExportFormat } from '../../../preload'
import { DEFAULT_EXPORT_SHEET_OPTIONS, exportSheetChoice } from './export-sheet-options'
import { useModalFocus } from '../hooks/useModalFocus'
import {
  exportedLine, madeFromLine, markNote, partsChangedSince, replacesLine, sentToProblem, SENT_TO_MAX,
  type FolioVersionExportAnswer,
} from '../../../shared/folio-version-export'
import { COMPARE_WORKING } from '../../../shared/folio-version-compare'
import { versionWhen } from '../../../shared/folio-versions-view'

/**
 * Export this Folio version, and Mark as sent (Folio versions ticket 11), drawn after the locked mockup
 * (docs/design/2026-11-02-folio-versions/mockup/locked/, scene `export`). Both are modals that end in one choice and write nothing until
 * their main button; Escape and Cancel close with nothing changed. The Word or HTML file is made in main from the version's saved text
 * (never the working files); the sheet never names a file (the system save dialog does). No key typed here reaches a part-editing command of the
 * Folio room it sits in: the room ignores its own keys and commands while a version sheet is open (FolioRoom `versionSheetRef`); the reserved
 * chords (the palette, the cheat sheet) still work.
 */

/** What the sheets need of a version. */
export type SheetVersion = { id: string; name: string; ts: number; author: string; sentTo?: string }

const FORMATS: ExportFormat[] = ['docx', 'html']
const LABELS: Record<ExportFormat, string> = { docx: 'Word (.docx)', html: 'HTML' }

/** Escape closes the modal wherever focus is inside it (capture, so nothing behind sees it); not while a write runs. */
function useEscape(onCancel: () => void, busy: boolean): void {
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onCancel, busy])
}

/** Every name a version was sent to, newest first, once each, for the name field's suggestions. */
export function sentNames(versions: ReadonlyArray<Pick<SheetVersion, 'sentTo'>>): string[] {
  return [...new Set(versions.flatMap((version) => (version.sentTo ? [version.sentTo] : [])))]
}

export type ExportVersionSheetProps = {
  dir: string
  version: SheetVersion
  /** Every version of the Folio, for the names it was sent to before. */
  versions: ReadonlyArray<SheetVersion>
  onClose: () => void
}

export function ExportVersionSheet({ dir, version, versions, onClose }: ExportVersionSheetProps): JSX.Element {
  const backdrop = useRef<HTMLDivElement | null>(null)
  const nameField = useRef<HTMLInputElement | null>(null)
  useModalFocus(backdrop)
  const [format, setFormat] = useState<ExportFormat>('docx')
  const [markOn, setMarkOn] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const [nameError, setNameError] = useState('')
  const [done, setDone] = useState<Extract<FolioVersionExportAnswer, { status: 'done' }> | null>(null)
  const [changed, setChanged] = useState<number | null>(null)
  const running = useRef(false)
  useEscape(onClose, busy)

  // How much of the Folio has changed since this version: the same comparison the Versions tab makes. Reading only; nothing waits on it.
  useEffect(() => {
    let live = true
    void window.writeflex.folioVersions.compare(dir, version.id, COMPARE_WORKING).then((result) => { if (live) setChanged(partsChangedSince(result)) }, () => undefined)
    return () => { live = false }
  }, [dir, version.id])

  const known = useMemo(() => sentNames(versions), [versions])
  const replaces = markOn ? replacesLine(version.sentTo, name) : null

  const run = useCallback(() => {
    if (running.current || done) return
    if (markOn) {
      const bad = sentToProblem(name)
      if (bad !== null) { setNameError(bad); nameField.current?.focus(); return }
    }
    running.current = true
    setBusy(true)
    setProblem('')
    setNameError('')
    const html = format === 'html' ? exportSheetChoice('collection', 'html', DEFAULT_EXPORT_SHEET_OPTIONS, null).html : undefined
    void window.writeflex.folioVersions.export({ dir, id: version.id, format, ...(html ? { html } : {}), ...(markOn ? { markSentTo: name } : {}) })
      .then((answer) => {
        if (answer.status === 'done') setDone(answer)
        else if (answer.status === 'error') setProblem(answer.message)
      })
      .catch(() => setProblem('WriteFlex could not export that version. Choose somewhere else, or try again.'))
      .finally(() => { running.current = false; setBusy(false) })
  }, [dir, done, format, markOn, name, version.id])

  const submit = (event: FormEvent): void => { event.preventDefault(); if (done) onClose(); else run() }
  const move = (event: KeyboardEvent<HTMLButtonElement>, forward: boolean): void => {
    event.preventDefault()
    setFormat(FORMATS[(FORMATS.indexOf(format) + (forward ? 1 : FORMATS.length - 1)) % FORMATS.length])
  }
  const label = markOn ? 'Export and mark as sent…' : 'Export…'

  return (
    <div ref={backdrop} className="fvs-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose() }}>
      <form className="fvs-sheet fvs-export" role="dialog" aria-modal="true" aria-labelledby="fve-title" data-testid="folio-export-sheet" onMouseDown={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="fvs-head"><Upload className="icon" aria-hidden="true" /><h2 id="fve-title">Export “{version.name}”</h2></div>
        <div className="fvs-body">
          <div className="fvs-banner lock" data-testid="folio-export-made-from"><Lock className="icon" aria-hidden="true" /><span>{madeFromLine(versionWhen(version.ts), changed)}</span></div>
          {done === null && (
            <>
              <div className="fvs-field">
                <span id="fve-format">Format</span>
                <div className="sw-seg fve-seg" role="group" aria-labelledby="fve-format">
                  {FORMATS.map((candidate) => (
                    <button key={candidate} type="button" aria-pressed={format === candidate} disabled={busy} data-format={candidate} onClick={() => setFormat(candidate)}
                      onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') move(event, event.key === 'ArrowRight') }}>
                      {candidate === 'html' ? <FileCode2 className="ic" aria-hidden="true" /> : <FileText className="ic" aria-hidden="true" />}{LABELS[candidate]}
                    </button>
                  ))}
                </div>
              </div>
              <section className="fvs-card" aria-labelledby="fve-mark">
                <div className="fvs-card-body">
                  <div className="fve-markrow">
                    <label className="fvs-check" id="fve-mark">
                      <input type="checkbox" checked={markOn} disabled={busy} data-testid="folio-export-mark" onChange={(event) => { setMarkOn(event.target.checked); setNameError(''); if (event.target.checked) requestAnimationFrame(() => nameField.current?.focus()) }} />
                      <b>Mark as sent to</b>
                    </label>
                    <input ref={nameField} className="fve-name" list="fve-known" value={name} maxLength={SENT_TO_MAX} placeholder="Sam Rowe" disabled={!markOn || busy} aria-label="Who it is sent to" aria-invalid={nameError !== ''} aria-describedby={nameError ? 'fve-name-error' : undefined} data-testid="folio-export-sent-to"
                      onChange={(event) => { setName(event.target.value); if (nameError) setNameError('') }} />
                    <datalist id="fve-known">{known.map((entry) => <option key={entry} value={entry} />)}</datalist>
                  </div>
                  {nameError && <p className="fvs-error" id="fve-name-error" role="alert">{nameError}</p>}
                  <div className="fvs-note">{markNote(markOn ? name : '')}</div>
                  {replaces && <div className="fvs-note" data-testid="folio-export-replaces">{replaces}</div>}
                </div>
              </section>
              <p className="fvs-note fve-working">Needs a save of the working draft first? Exporting the working draft offers to save a version before it goes.</p>
            </>
          )}
          {done !== null && (
            <div className={`fvs-banner ${done.markRefused !== undefined || done.missingImages.length + done.unreadableImages.length > 0 ? '' : 'info'}`} role="status" data-testid="folio-export-done">
              {done.markRefused !== undefined || done.missingImages.length + done.unreadableImages.length > 0 ? <TriangleAlert className="icon" aria-hidden="true" /> : <CircleCheck className="icon" aria-hidden="true" />}
              <span><b>Exported.</b> {exportedLine(done)} {done.target}
                {done.missingImages.length + done.unreadableImages.length > 0 && <> {done.missingImages.length + done.unreadableImages.length === 1 ? '1 picture' : `${done.missingImages.length + done.unreadableImages.length} pictures`} could not be included.</>}
              </span>
            </div>
          )}
          {problem && <p className="fvs-error" role="alert" data-testid="folio-export-error">{problem}</p>}
        </div>
        <div className="fvs-foot">
          <span className="fvs-note fvs-foot-hint">{done === null ? 'A save dialog asks where the file goes.' : ''}</span>
          {done === null ? (
            <>
              <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="submit" className="btn primary" disabled={busy} autoFocus data-testid="folio-export-submit"><Upload className="icon" aria-hidden="true" /> {busy ? 'Writing…' : label}</button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => { void window.writeflex.revealExport().catch(() => undefined) }}>Show in Finder</button>
              <button type="submit" className="btn primary" autoFocus data-testid="folio-export-done-close">Done</button>
            </>
          )}
        </div>
      </form>
    </div>
  )
}

export type MarkSentSheetProps = {
  dir: string
  version: SheetVersion
  versions: ReadonlyArray<SheetVersion>
  onClose: () => void
}

/** Mark as sent… on its own: the writer sent a file by other means (or exported earlier) and says who has it. */
export function MarkSentSheet({ dir, version, versions, onClose }: MarkSentSheetProps): JSX.Element {
  const backdrop = useRef<HTMLDivElement | null>(null)
  useModalFocus(backdrop)
  const [name, setName] = useState(version.sentTo ?? '')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const running = useRef(false)
  useEscape(onClose, busy)
  const known = useMemo(() => sentNames(versions), [versions])
  const replaces = replacesLine(version.sentTo, name)
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (running.current) return
    const bad = sentToProblem(name)
    if (bad !== null) { setProblem(bad); return }
    running.current = true
    setBusy(true)
    setProblem('')
    void window.writeflex.folioVersions.markSent(dir, version.id, name)
      .then((answer) => { if (answer.status === 'done') onClose(); else setProblem(answer.message) })
      .catch(() => setProblem('WriteFlex could not mark that version. Try again.'))
      .finally(() => { running.current = false; setBusy(false) })
  }
  return (
    <div ref={backdrop} className="fvs-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose() }}>
      <form className="fvs-sheet fvs-mark" role="dialog" aria-modal="true" aria-labelledby="fvm-title" data-testid="folio-mark-sheet" onMouseDown={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="fvs-head"><Send className="icon" aria-hidden="true" /><h2 id="fvm-title">Mark “{version.name}” as sent</h2></div>
        <div className="fvs-body">
          <label className="fvs-field">
            <span>Sent to</span>
            <input autoFocus list="fvm-known" value={name} maxLength={SENT_TO_MAX} placeholder="Sam Rowe" disabled={busy} aria-invalid={problem !== ''} data-testid="folio-mark-name" onChange={(event) => { setName(event.target.value); if (problem) setProblem('') }} />
            <datalist id="fvm-known">{known.map((entry) => <option key={entry} value={entry} />)}</datalist>
          </label>
          <div className="fvs-note">{markNote(name)}</div>
          {replaces && <div className="fvs-note" data-testid="folio-mark-replaces">{replaces}</div>}
          {problem && <p className="fvs-error" role="alert" data-testid="folio-mark-error">{problem}</p>}
        </div>
        <div className="fvs-foot">
          <span className="fvs-foot-hint" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy} data-testid="folio-mark-submit"><Send className="icon" aria-hidden="true" /> {busy ? 'Marking…' : 'Mark as sent'}</button>
        </div>
      </form>
    </div>
  )
}

/** Which sheet is open, for which version. */
export type VersionSheet = { kind: 'export' | 'mark-sent'; id: string }

/**
 * The sheet for one version. The version is looked up in the Folio's own list by id (an id that is not there closes the sheet), so the
 * sheet shows what the history says now: the name, the date and who it was last sent to. A mark written meanwhile refreshes the list.
 */
export function FolioVersionSheetHost({ dir, sheet, onClose }: { dir: string; sheet: VersionSheet; onClose: () => void }): JSX.Element | null {
  const [versions, setVersions] = useState<SheetVersion[] | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => window.writeflex.onVersionsChanged(() => setTick((value) => value + 1)), [])
  useEffect(() => {
    let live = true
    void window.writeflex.folioVersions.list(dir).then((listing) => { if (live) setVersions(listing ? listing.versions : []) }, () => { if (live) setVersions([]) })
    return () => { live = false }
  }, [dir, tick])
  const version = versions?.find((candidate) => candidate.id === sheet.id) ?? null
  // The history had no such version: nothing to show.
  useEffect(() => { if (versions !== null && version === null) onClose() }, [versions, version, onClose])
  if (version === null) return null
  return sheet.kind === 'export'
    ? <ExportVersionSheet dir={dir} version={version} versions={versions ?? []} onClose={onClose} />
    : <MarkSentSheet dir={dir} version={version} versions={versions ?? []} onClose={onClose} />
}
