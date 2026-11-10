import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Copy, FileText, GitCompare, Globe, History, Image as ImageIcon, Pencil, RotateCcw, Save, Table2, TriangleAlert, X } from 'lucide-react'
import {
  FILE_KIND_LABEL, FILE_VERSION_CAP_LABEL, WORKING_COPY, restoredName, suggestedCopyName, usedBySentence, versionTitle, workingSentence,
  type FileCompare, type FileKind, type FileVersionRow, type FileVersionsListing,
} from '../../../shared/file-versions'
import { versionWhen } from '../../../shared/folio-versions-view'
import { useModalFocus } from '../hooks/useModalFocus'
import { FILE_VERSIONS_COMMAND_EVENT, type FileVersionsAction, type FileVersionsCommandDetail } from '../plan/file-versions-focus'

/**
 * The versions of one inserted file: a table, a widget page, an image (ADR-0052 § How members reference per-file versions; Folio versions ticket 19;
 * the locked mockup's scene `asset`). It lists the working copy, then each version with the Folio versions that used it (DERIVED in main, never
 * stored), and offers Save version…, Compare with the working copy, Restore, and Save as a copy…. Surface: a docked panel in the Folio Inspector;
 * Restore and Save as a copy are modals (the ADR's surface list), which hold the keyboard (`useModalFocus`).
 *
 * KEYS. The panel is drawn inside the Folio's sidebar, whose controls the room reads as part rows: a chord that moves, adds or bins a part must
 * never act from here. `data-own-keys="file-versions"` marks the panel; the room refuses its part commands while focus is inside it.
 *
 * WRITES. Nothing here writes but through the four doors (`window.writeflex.fileVersions`), each bound in main to the Collection the window held when
 * it began. A restore carries the two fingerprints the writer was looking at; if either file changed since, main writes nothing and says so.
 */

const KIND_ICON = { table: Table2, image: ImageIcon, widget: Globe, file: FileText } as const
/** How long a burst of changes is gathered before the list is read again. */
const REREAD_MS = 250

const sizeLabel = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`)
const nameOf = (path: string): string => path.split('/').pop() ?? path

/** When, who and any note; a version a Folio save took says so in its title and is not credited to a person's naming. */
function metaOf(row: FileVersionRow): string {
  return [versionWhen(row.ts), row.automatic ? 'kept automatically' : row.author, row.note?.trim() ? row.note.trim() : null].filter((part): part is string => part !== null && part !== '').join(' · ')
}
const titleOf = versionTitle

/** Escape closes a modal wherever focus is inside it (capture, so nothing behind sees it); not while a write runs. */
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

function CompareTable({ result }: { result: Extract<FileCompare, { kind: 'table' }> }): JSX.Element {
  const cell = (value: { before: string | null; after: string | null }): JSX.Element => {
    if (value.before === value.after) return <>{value.after ?? ''}</>
    if (value.before === null) return <ins title="Added">{value.after}</ins>
    if (value.after === null) return <del title="Removed">{value.before}</del>
    return <><span className="old">{value.before}</span> → <ins>{value.after}</ins></>
  }
  return (
    <div className="fvp-scroll" role="region" aria-label="The two tables, cell by cell" tabIndex={0}>
      <table className="fvp-table" data-testid="file-compare-table">
        <thead><tr>{result.header.map((value, at) => <th key={at} scope="col" className={value.before !== value.after ? 'c' : undefined}>{cell(value)}</th>)}</tr></thead>
        <tbody>{result.rows.map((row, r) => <tr key={r}>{row.map((value, c) => <td key={c} className={value.before !== value.after ? 'c' : undefined} data-changed={value.before !== value.after ? 'true' : undefined}>{cell(value)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

function CompareView({ result, onClose }: { result: FileCompare; onClose: () => void }): JSX.Element {
  const noun = (count: number, one: string, many: string): string => `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`
  return (
    <div className="fvp-compare" data-testid="file-compare">
      <h4>{result.from.label} → {result.to.label}<button type="button" className="fvp-btn" onClick={onClose} aria-label="Close the comparison"><X aria-hidden="true" />Close</button></h4>
      {result.kind === 'table' ? (
        <>
          <p className="fvp-note" data-testid="file-compare-summary">{result.cellsDiffering === 0 ? 'No cells differ.' : `${noun(result.cellsDiffering, 'cell differs', 'cells differ')}. The cells that differ are marked.`}</p>
          {result.cellsDiffering > 0 && <CompareTable result={result} />}
          {result.rowsNotShown > 0 && <p className="fvp-note">{noun(result.rowsNotShown, 'more row', 'more rows')} not shown.</p>}
        </>
      ) : (
        <p className="fvp-note" data-testid="file-compare-summary">
          {result.same ? 'These are the same file, byte for byte.' : `They differ (${sizeLabel(result.from.bytes)} → ${sizeLabel(result.to.bytes)}${result.linesChanged !== null ? `, ${noun(result.linesChanged, 'line', 'lines')} changed` : ''}).`}
        </p>
      )}
    </div>
  )
}

type ModalProps = { file: string; busy: boolean; problem: string; onClose: () => void }

function RestoreSheet({ file, version, listing, busy, problem, onClose, onConfirm }: ModalProps & { version: FileVersionRow; listing: FileVersionsListing; onConfirm: () => void }): JSX.Element {
  const backdrop = useRef<HTMLDivElement | null>(null)
  useModalFocus(backdrop)
  useEscape(onClose, busy)
  const working = listing.working
  const keepsFirst = working.state === 'changed'
  return createPortal(
    <div ref={backdrop} className="fvs-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose() }}>
      <form className="fvs-sheet fvs-file" role="dialog" aria-modal="true" aria-labelledby="fvr-title" data-testid="file-restore-sheet" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onSubmit={(event: FormEvent) => { event.preventDefault(); if (!busy) onConfirm() }}>
        <div className="fvs-head"><RotateCcw className="icon" aria-hidden="true" /><h2 id="fvr-title">Restore v{version.number}{version.automatic ? '' : ` “${version.name}”`}?</h2></div>
        <div className="fvs-body">
          <p className="fvs-question">This puts v{version.number} back as {file}. It is added as a new version, “{restoredName(version)}”; v{version.number} and every other version stay.</p>
          <ul className="fvs-file-list">
            {keepsFirst && <li>The working copy has changes no version holds. WriteFlex saves it first as “Before restoring v{version.number}”, so nothing is lost.</li>}
            {working.state === 'missing' && <li>There is no file at this name now. It will be created.</li>}
            <li>Folio versions keep the copies they used. This changes none of them.</li>
          </ul>
          {problem && <p className="fvs-error" role="alert" data-testid="file-restore-error">{problem}</p>}
        </div>
        <div className="fvs-foot">
          <span className="fvs-foot-hint" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy} data-testid="file-restore-confirm" autoFocus><RotateCcw className="icon" aria-hidden="true" /> {busy ? 'Restoring…' : `Restore v${version.number}`}</button>
        </div>
      </form>
    </div>,
    document.body,
  )
}

function CopySheet({ file, version, path, busy, problem, onClose, onConfirm }: ModalProps & { version: FileVersionRow; path: string; onConfirm: (name: string) => void }): JSX.Element {
  const backdrop = useRef<HTMLDivElement | null>(null)
  useModalFocus(backdrop)
  useEscape(onClose, busy)
  const [name, setName] = useState(() => suggestedCopyName(path, version.number))
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : 'the Collection folder'
  return createPortal(
    <div ref={backdrop} className="fvs-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose() }}>
      <form className="fvs-sheet fvs-file" role="dialog" aria-modal="true" aria-labelledby="fvc-title" data-testid="file-copy-sheet" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onSubmit={(event: FormEvent) => { event.preventDefault(); if (!busy) onConfirm(name) }}>
        <div className="fvs-head"><Copy className="icon" aria-hidden="true" /><h2 id="fvc-title">Save v{version.number} of {file} as a copy</h2></div>
        <div className="fvs-body">
          <label className="fvs-field">
            <span>Name of the copy</span>
            <input autoFocus value={name} maxLength={200} disabled={busy} aria-invalid={problem !== ''} data-testid="file-copy-name" onChange={(event) => setName(event.target.value)} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <p className="fvs-note">Saves one new file in {folder}, the same kind of file as {file}. If a file already has that name, nothing is overwritten and you choose another.</p>
          {problem && <p className="fvs-error" role="alert" data-testid="file-copy-error">{problem}</p>}
        </div>
        <div className="fvs-foot">
          <span className="fvs-foot-hint" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || name.trim() === ''} data-testid="file-copy-confirm"><Copy className="icon" aria-hidden="true" /> {busy ? 'Saving…' : 'Save copy'}</button>
        </div>
      </form>
    </div>,
    document.body,
  )
}

export type FileVersionsPanelProps = {
  /** The file's Collection-relative path. */
  path: string
  /** What the panel is asked to do once it shows the file (a command that came before it was drawn, or for another file). A new `seq` asks again. */
  request?: { action: FileVersionsAction; seq: number } | null
  /** Told when a command reaches the panel, so the Inspector holding it can come to the front. */
  onReveal?: () => void
  /** The app's status line. */
  onStatus?: (message: string) => void
}

export function FileVersionsPanel({ path, request = null, onReveal, onStatus }: FileVersionsPanelProps): JSX.Element {
  const [listing, setListing] = useState<FileVersionsListing | null>(null)
  const [problem, setProblem] = useState('')
  const [tick, setTick] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [saveProblem, setSaveProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const [compare, setCompare] = useState<FileCompare | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [copying, setCopying] = useState(false)
  const [modalProblem, setModalProblem] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const running = useRef(false)

  // Read again after a collection or file change or a new version, gathered into one read.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const soon = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; setTick((value) => value + 1) }, REREAD_MS)
    }
    const offs = [window.writeflex.onCollectionChanged(soon), window.writeflex.onFileChangedOnDisk(soon), window.writeflex.onVersionsChanged(soon)]
    return () => { for (const off of offs) off(); if (timer !== null) clearTimeout(timer) }
  }, [])
  useEffect(() => {
    let live = true
    void window.writeflex.fileVersions.list(path).then((answer) => {
      if (!live) return
      if (answer.ok) { setListing(answer.listing); setProblem('') } else { setListing(null); setProblem(answer.message) }
    }, () => { if (live) { setListing(null); setProblem('The versions of this file could not be read.') } })
    return () => { live = false }
  }, [path, tick])
  // A different file starts again.
  useEffect(() => { setSelected(null); setNaming(false); setName(''); setSaveProblem(''); setCompare(null); setRestoring(false); setCopying(false); setModalProblem('') }, [path])
  // The field takes focus when it opens, and takes it back after a save that was refused (a disabled field gives focus up).
  useEffect(() => { if (naming && !busy) nameRef.current?.focus() }, [naming, busy])

  const rows = listing?.versions ?? []
  const chosen = rows.find((row) => row.id === selected) ?? rows[0] ?? null
  const file = nameOf(path)
  const kind: FileKind = listing?.kind ?? 'file'
  const KindIcon = KIND_ICON[kind]
  const refresh = useCallback(() => setTick((value) => value + 1), [])

  const doSave = useCallback(async (): Promise<void> => {
    if (running.current) return
    const trimmed = name.trim()
    if (trimmed === '') { setSaveProblem('Name the version before saving.'); return }
    running.current = true
    setBusy(true)
    const answer = await window.writeflex.fileVersions.save({ path, name: trimmed }).catch(() => ({ ok: false as const, code: 'unavailable' as const, message: 'The version could not be saved. Nothing was changed.' }))
    running.current = false
    setBusy(false)
    if (!answer.ok) { setSaveProblem(answer.message); return }
    setNaming(false); setName(''); setSaveProblem(''); setSelected(answer.version.id); setCompare(null)
    onStatus?.(`Version “${answer.version.name}” of ${file} saved`)
    refresh()
  }, [name, path, file, onStatus, refresh])

  const doCompare = useCallback(async (versionId: string): Promise<void> => {
    const answer = await window.writeflex.fileVersions.compare(path, versionId, WORKING_COPY).catch(() => null)
    if (!answer) { setProblem('The comparison could not be made.'); return }
    if (!answer.ok) { setProblem(answer.message); return }
    setProblem(''); setCompare(answer.compare)
  }, [path])

  const doRestore = useCallback(async (): Promise<void> => {
    if (running.current || !listing || !chosen || chosen.sha256 === null) return
    running.current = true
    setBusy(true)
    setModalProblem('')
    const answer = await window.writeflex.fileVersions.restore({ path, versionId: chosen.id, expectVersionSha256: chosen.sha256, expectWorkingSha256: listing.workingSha256 })
      .catch(() => ({ ok: false as const, code: 'unavailable' as const, message: 'The restore could not be made. Nothing was changed.' }))
    running.current = false
    setBusy(false)
    if (!answer.ok) { setModalProblem(answer.message); refresh(); return }
    setRestoring(false); setCompare(null); setSelected(null)
    onStatus?.(`Restored v${chosen.number} as ${file}${answer.safety ? `; the working copy was saved first as “${answer.safety.name}”` : ''}`)
    refresh()
  }, [listing, chosen, path, file, onStatus, refresh])

  const doCopy = useCallback(async (copyName: string): Promise<void> => {
    if (running.current || !chosen || chosen.sha256 === null) return
    running.current = true
    setBusy(true)
    setModalProblem('')
    const answer = await window.writeflex.fileVersions.copy({ path, versionId: chosen.id, expectVersionSha256: chosen.sha256, name: copyName })
      .catch(() => ({ ok: false as const, code: 'unavailable' as const, message: 'The copy could not be saved. Nothing was written.' }))
    running.current = false
    setBusy(false)
    if (!answer.ok) { setModalProblem(answer.message); return }
    setCopying(false)
    onStatus?.(`Saved v${chosen.number} as a copy: ${answer.path}`)
    refresh()
  }, [chosen, path, onStatus, refresh])

  const canCompare = listing !== null && chosen !== null && listing.workingSha256 !== null && !chosen.isWorking
  const canRestore = listing !== null && chosen !== null && chosen.sha256 !== null && !chosen.isWorking && listing.working.state !== 'too-large' && listing.working.state !== 'unreadable'
  const compareReason = !chosen ? 'No version holds a copy of this file yet.' : chosen.isWorking ? 'The working copy is this version, so there is nothing to compare.' : 'There is no working copy to compare.'
  const restoreReason = !chosen ? 'No version holds a copy of this file yet.' : chosen.isWorking ? 'The working copy already holds this version.' : 'This file cannot be restored over right now.'

  // The commands (palette, menu, chord) reach the panel as an event; the panel answers when it shows a file.
  const run = useCallback((action: FileVersionsAction): void => {
    if (action === 'save') setNaming(true)
    else if (action === 'compare') { if (canCompare && chosen) void doCompare(chosen.id); else setProblem(compareReason) }
    else if (action === 'restore') { if (canRestore) { setModalProblem(''); setRestoring(true) } else setProblem(restoreReason) }
    else if (action === 'copy') { if (chosen && chosen.sha256 !== null) { setModalProblem(''); setCopying(true) } else setProblem('No version holds a copy of this file yet.') }
  }, [canCompare, canRestore, chosen, doCompare, compareReason, restoreReason])
  const runRef = useRef(run)
  runRef.current = run
  const onRevealRef = useRef(onReveal)
  onRevealRef.current = onReveal
  useEffect(() => {
    const onCommand = (event: Event): void => {
      const detail = (event as CustomEvent<FileVersionsCommandDetail>).detail
      if (detail.handled) return
      detail.handled = true
      onRevealRef.current?.()
      runRef.current(detail.action)
    }
    window.addEventListener(FILE_VERSIONS_COMMAND_EVENT, onCommand)
    return () => window.removeEventListener(FILE_VERSIONS_COMMAND_EVENT, onCommand)
  }, [])
  // A command that came before the panel was drawn (from the cursor panel, a palette command) waits for the list, then runs once.
  const pending = useRef<FileVersionsAction>(request?.action ?? 'show')
  useEffect(() => { pending.current = request?.action ?? 'show' }, [request?.action, request?.seq, path])
  useEffect(() => {
    if (listing === null || pending.current === 'show') return
    const action = pending.current
    pending.current = 'show'
    run(action)
  }, [listing, run])

  // Arrow keys move through the versions; every other key stays here (it is never a command on a part).
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.altKey && !event.metaKey && !event.ctrlKey && target.closest('[data-version-row]')) {
      const buttons = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('button[data-version-row]') ?? [])]
      const at = buttons.indexOf(target as HTMLButtonElement)
      const next = buttons[at + (event.key === 'ArrowDown' ? 1 : -1)]
      if (next) { event.preventDefault(); next.focus(); setSelected(next.dataset.versionRow ?? null) }
      event.stopPropagation()
    }
  }

  const working = listing?.working
  return (
    <section ref={rootRef} className="fvp" aria-label={`Versions of ${file}`} data-testid="file-versions-panel" data-own-keys="file-versions" data-path={path} onKeyDown={onKeyDown}>
      <h3 className="fvp-head"><KindIcon aria-hidden="true" />{FILE_KIND_LABEL[kind]} · {file}<span className="path" title={path}>{path}</span></h3>
      {problem && <p className="fvp-err" role="alert" data-testid="file-versions-problem">{problem}</p>}
      {listing === null && !problem && <p className="fvp-note" role="status">Reading the versions…</p>}
      {listing !== null && working && (
        <>
          <ul className="fvp-rows" aria-label="Versions, newest first">
            <li>
              <div className="fvp-row" data-testid="file-working">
                <Pencil aria-hidden="true" />
                <div className="t">
                  <div className="nm">Working copy{working.state === 'changed' && <span className="fvp-chip warn">unsaved</span>}{working.state === 'same' && <span className="fvp-chip">saved</span>}</div>
                  <div className="meta" data-testid="file-working-state">{workingSentence(working, kind)}</div>
                </div>
              </div>
            </li>
            {rows.map((row) => (
              <li key={row.id}>
                <button type="button" className="fvp-row" data-version-row={row.id} data-testid="file-version-row" data-number={row.number} aria-pressed={chosen?.id === row.id} onClick={() => setSelected(row.id)}>
                  <History aria-hidden="true" />
                  <div className="t">
                    <div className="nm">v{row.number} · {titleOf(row)}<span className="fvp-chip acc" data-testid="file-version-used">{usedBySentence(row.usedBy)}</span>{row.isWorking && <span className="fvp-chip">same as working copy</span>}</div>
                    <div className="meta">{metaOf(row)}</div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {rows.length === 0 && working.state !== 'too-large' && <p className="fvp-note" data-testid="file-no-versions">No version of this file yet. A Folio version that inserts it also keeps a copy.</p>}
          {working.state === 'too-large' && (
            <p className="fvp-err" role="status" data-testid="file-too-large"><TriangleAlert aria-hidden="true" style={{ width: 13, height: 13, verticalAlign: '-2px' }} /> {file} is over {FILE_VERSION_CAP_LABEL}, so a Folio version lists it as a reference and keeps no copy of it. It has no file versions.</p>
          )}
          {naming ? (
            <form className="fvp-name" data-testid="file-version-name" onSubmit={(event) => { event.preventDefault(); void doSave() }}
              onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setNaming(false); setName(''); setSaveProblem('') } }}>
              <input ref={nameRef} value={name} aria-label={`Name for the version of ${file}`} placeholder="Name this version" disabled={busy}
                onChange={(event) => { setName(event.target.value); setSaveProblem('') }} />
              <button type="submit" className="fvp-btn pri" disabled={busy} data-testid="file-version-name-save"><Save aria-hidden="true" />Save</button>
            </form>
          ) : (
            <div className="fvp-actions" role="group" aria-label={`What to do with ${file}`}>
              <button type="button" className="fvp-btn" data-testid="file-save-version" disabled={working.state === 'too-large' || working.state === 'missing' || working.state === 'unreadable'} onClick={() => run('save')}><History aria-hidden="true" />Save version…</button>
              <button type="button" className="fvp-btn" data-testid="file-compare-button" aria-disabled={canCompare ? undefined : true} title={canCompare ? undefined : compareReason} onClick={() => run('compare')}><GitCompare aria-hidden="true" />{chosen ? `Compare v${chosen.number} with working` : 'Compare with working'}</button>
              <button type="button" className="fvp-btn" data-testid="file-restore-button" aria-disabled={canRestore ? undefined : true} title={canRestore ? undefined : restoreReason} onClick={() => run('restore')}><RotateCcw aria-hidden="true" />{chosen ? `Restore v${chosen.number}` : 'Restore'}</button>
              <button type="button" className="fvp-btn" data-testid="file-copy-button" aria-disabled={chosen && chosen.sha256 !== null ? undefined : true} title={chosen ? undefined : 'No version holds a copy of this file yet.'} onClick={() => run('copy')}><Copy aria-hidden="true" />{chosen ? `Save v${chosen.number} as a copy…` : 'Save as a copy…'}</button>
            </div>
          )}
          {saveProblem && <p className="fvp-err" role="alert" data-testid="file-version-name-error">{saveProblem}</p>}
          {compare && <CompareView result={compare} onClose={() => setCompare(null)} />}
          <p className="fvp-note" data-testid="file-versions-note">The text always shows the current file; a saved Folio version keeps the file as it was. A backup carries a version once a Folio version has used it.</p>
        </>
      )}
      {restoring && listing && chosen && <RestoreSheet file={file} version={chosen} listing={listing} busy={busy} problem={modalProblem} onClose={() => { setRestoring(false); setModalProblem('') }} onConfirm={() => void doRestore()} />}
      {copying && chosen && <CopySheet file={file} path={path} version={chosen} busy={busy} problem={modalProblem} onClose={() => { setCopying(false); setModalProblem('') }} onConfirm={(copyName) => void doCopy(copyName)} />}
    </section>
  )
}
