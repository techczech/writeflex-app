import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Download, FileCode2, FileText } from 'lucide-react'
import type { ExportFormat, HtmlExportOptions } from '../../../preload'
import { ExportOptionControls } from './ExportOptionControls'
import { ExportPresetControls } from './ExportPresetControls'
import {
  DEFAULT_EXPORT_SHEET_OPTIONS,
  exportDisclosure,
  exportedPhrase,
  exportLeftOutLines,
  exportPresetChoice,
  exportSheetChoice,
  exportSheetOptions,
  loadExportSheetOptions,
  loadExportPresetLastUsed,
  saveExportPresetLastUsed,
  saveExportSheetOptions,
  type ExportLeftOut,
  type ExportSheetOptions,
} from './export-sheet-options'
import {
  createExportPresetState,
  reduceExportPresetState,
  shippedExportPresetSettings,
  snapshotExportPresetLastUsed,
  snapshotExportPresetSettings,
  type ExportPresetAction,
  type ExportPresetState,
} from '../../../shared/export-presets'

export { ExportOptionControls } from './ExportOptionControls'
export {
  DEFAULT_EXPORT_SHEET_OPTIONS,
  exportDisclosure,
  exportedPhrase,
  exportLeftOutLines,
  exportPresetChoice,
  exportSheetChoice,
  exportSheetOptions,
  exportSheetStorageKey,
  loadExportSheetOptions,
  loadExportPresetLastUsed,
  saveExportPresetLastUsed,
  saveExportSheetOptions,
  type ExportLeftOut,
  type ExportSheetOptions,
} from './export-sheet-options'

/**
 * The Export sheet, extended to locked frame (a) of
 * `docs/design/2026-08-05-html-export-documents/mockups/export-sheet-states.html`.
 *
 * It keeps the existing modal, scope and format paths, then adds HTML document features, treatment
 * and masthead fields. The complete HTML choice crosses one props/events seam and rides the existing
 * export channel. The sheet still hands naming to the system save dialog; it never accepts a path.
 *
 * Copy never opens this sheet: a copy is instant or it is not a copy.
 */

export type ExportScope = 'piece' | 'collection'

/** What came back from an attempt. `cancelled` is the save dialog being dismissed: nothing written,
 *  nothing said — the sheet simply returns to its choices. */
export type ExportSheetOutcome =
  | { status: 'cancelled' }
  | { status: 'done'; target: string; missingImages: string[]; unreadableImages: string[]; pieces: number; listed: number }
  | { status: 'error'; message: string }

export type ExportSheetProps = {
  /** Scopes the remembered switch combination to this Workspace. */
  workspaceRoot: string
  /** The active piece's title (its `title:`, else its first heading, else the file's name). */
  title: string
  /** The active piece's word count, shown where the mockup shows it. */
  words: number
  /** The Collection this piece sits in, or null — which is what decides whether scope rows exist.
   *  `pieces` is what Word writes (the Collection's own rows); `htmlPieces` is what HTML writes (for a
   *  Folio, its listed pieces that exist inside its folder); `leftOut` names the listed Folio entries
   *  HTML will not write. */
  collection: { name: string; pieces: number; htmlPieces?: number; leftOut?: ExportLeftOut[] } | null
  onExport: (choice: { scope: ExportScope; format: ExportFormat; html?: HtmlExportOptions }) => Promise<ExportSheetOutcome>
  onReveal: () => void
  onClose: () => void
  /** Palette commands reopen the sheet directly at the action's owning mode. */
  initialPresetAction?: ExportPresetOpenAction
}

export type ExportPresetOpenAction = 'apply' | 'update' | 'save-as' | 'manage' | 'rename' | 'delete' | 'move-up' | 'move-down'

const FORMATS: ExportFormat[] = ['html', 'docx']
const FORMAT_LABELS: Record<ExportFormat, string> = { html: 'HTML', docx: 'Word' }
const FORMAT_HINTS: Record<ExportFormat, string> = {
  html: 'One self-contained file — styles and images travel inside it, so it opens anywhere, offline.',
  docx: 'A real Word document — headings, lists and tables as Word’s own styles, with the images inside it.',
}

/** 2,140 rather than 2140 — the mockup's own counting. */
const count = (value: number): string => value.toLocaleString('en-GB')

/** The files, named. */
function nameList(sources: string[]): string {
  const names = sources.map((source) => source.split('/').pop() || source)
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The amber line (the mockup's sentence, for one or for many). Two facts, said differently, because
 * A usability review found "were not found" was generous about a file that was sitting right there: MISSING
 * is nothing at that address; UNREADABLE is a file that is there and could not be understood.
 */
function missingLine(missing: string[], unreadable: string[]): string {
  const said = (sources: string[], what: string): string =>
    `${nameList(sources)} ${sources.length === 1 ? 'was' : 'were'} ${what}, so ${sources.length === 1 ? 'its caption' : 'their captions'} travelled alone.`
  return [
    missing.length ? said(missing, 'not found') : '',
    unreadable.length ? said(unreadable, 'not readable as a picture') : '',
  ].filter(Boolean).join(' ')
}

/** How many pictures did not travel, for either reason. */
const left = (done: { missingImages: string[]; unreadableImages: string[] }): number =>
  done.missingImages.length + done.unreadableImages.length

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
const spell = (value: number): string => NUMBER_WORDS[value] ?? count(value)

function rendererStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

export function ExportSheet({ workspaceRoot, title, words, collection, onExport, onReveal, onClose, initialPresetAction }: ExportSheetProps): JSX.Element {
  const [scope, setScope] = useState<ExportScope>('piece')
  const [presetState, setPresetState] = useState<ExportPresetState | null>(null)
  const presetStateRef = useRef<ExportPresetState | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ target: string; missingImages: string[]; unreadableImages: string[]; pieces: number; listed: number; bundled: boolean } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const running = useRef(false)

  useEffect(() => {
    let cancelled = false
    const storage = rendererStorage()
    const lastUsed = storage ? loadExportPresetLastUsed(workspaceRoot, storage) : null
    void window.writeflex.getExportPresetSettings()
      .catch(() => shippedExportPresetSettings())
      .then((settings) => {
        if (cancelled) return
        let next = createExportPresetState(settings, lastUsed)
        let presetsChanged = false
        if (initialPresetAction === 'update') {
          const updated = reduceExportPresetState(next, { type: 'update' })
          presetsChanged = updated !== next
          next = updated
        }
        if (initialPresetAction === 'save-as') next = reduceExportPresetState(next, { type: 'begin-save-as' })
        if (initialPresetAction === 'delete' && next.sourcePresetId) {
          next = reduceExportPresetState(next, { type: 'delete', presetId: next.sourcePresetId })
          presetsChanged = true
        }
        if ((initialPresetAction === 'move-up' || initialPresetAction === 'move-down') && next.sourcePresetId) {
          const moved = reduceExportPresetState(next, {
            type: 'move',
            presetId: next.sourcePresetId,
            direction: initialPresetAction === 'move-up' ? -1 : 1,
          })
          presetsChanged ||= moved !== next
          next = moved
        }
        if (initialPresetAction && ['manage', 'rename', 'delete', 'move-up', 'move-down'].includes(initialPresetAction)) {
          next = reduceExportPresetState(next, { type: 'manage' })
        }
        if (presetsChanged) void window.writeflex.setExportPresetSettings(snapshotExportPresetSettings(next))
        if (storage) saveExportPresetLastUsed(workspaceRoot, snapshotExportPresetLastUsed(next), storage)
        presetStateRef.current = next
        setPresetState(next)
      })
    return () => { cancelled = true }
  }, [initialPresetAction, workspaceRoot])

  const dispatchPreset = useCallback((action: ExportPresetAction): void => {
    const current = presetStateRef.current
    if (!current) return
    const next = reduceExportPresetState(current, action)
    presetStateRef.current = next
    setPresetState(next)
    const storage = rendererStorage()
    if (storage) saveExportPresetLastUsed(workspaceRoot, snapshotExportPresetLastUsed(next), storage)
    if (next.presets !== current.presets) {
      void window.writeflex.setExportPresetSettings(snapshotExportPresetSettings(next))
        .catch(() => setProblem('WriteFlex could not save that preset change. Try again.'))
    }
  }, [workspaceRoot])

  const format = presetState?.choice.format ?? 'html'
  const collectionPieces = collection ? (format === 'html' ? collection.htmlPieces ?? collection.pieces : collection.pieces) : 0
  // Only HTML follows a Folio's manifest, so only HTML can leave a listed entry out.
  const leftOut = collection && format === 'html' ? exportLeftOutLines(collection.leftOut ?? []) : null
  const options = presetState ? exportSheetOptions(presetState.choice) : DEFAULT_EXPORT_SHEET_OPTIONS
  const setOptions = useCallback((next: ExportSheetOptions): void => {
    if (!presetState) return
    dispatchPreset({ type: 'change', choice: exportPresetChoice(format, next) })
  }, [dispatchPreset, format, presetState])

  const setFormat = useCallback((next: ExportFormat): void => {
    if (!presetState) return
    dispatchPreset({ type: 'change', choice: { ...presetState.choice, format: next } })
  }, [dispatchPreset, presetState])

  const run = useCallback(() => {
    if (running.current) return
    running.current = true
    setBusy(true)
    setProblem(null)
    void onExport(exportSheetChoice(scope, format, options))
      .then((outcome) => {
        if (outcome.status === 'done') setDone({ ...outcome, bundled: scope === 'collection' && collection !== null })
        if (outcome.status === 'error') setProblem(outcome.message)
      })
      .catch(() => setProblem('WriteFlex could not export that. Choose somewhere else, or try again.'))
      .finally(() => {
        running.current = false
        setBusy(false)
      })
  }, [collection, format, onExport, options, scope])

  // ADR-0029: "↵ is Choose where…". The scope rows and Format buttons are type="button", so a plain ↵ on
  // one would only re-press it; on these choice fields ↵ submits the sheet, as a native radio does.
  const chooseWhere = (event: KeyboardEvent<HTMLButtonElement>): boolean => {
    if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
    return true
  }

  const move = (event: KeyboardEvent, forward: boolean, list: 'scope' | 'format'): void => {
    event.preventDefault()
    if (list === 'format') {
      setFormat(FORMATS[(FORMATS.indexOf(format) + (forward ? 1 : FORMATS.length - 1)) % FORMATS.length])
      return
    }
    if (collection) setScope(forward ? 'collection' : 'piece')
  }

  // Esc remains sheet-wide. Arrow keys live on their own field sets so operating Design or the
  // masthead chips can never silently change Format or scope.
  const keys = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      // Esc steps back from preset naming/managing to the sheet, and otherwise cancels (ADR-0029) —
      // including while the choices are still loading, when there is no sub-mode to step back from.
      if (!busy && presetState !== null && presetState.mode !== 'sheet') dispatchPreset({ type: 'show-sheet' })
      else if (!busy) onClose()
      return
    }
    if (presetState?.mode === 'sheet' && /^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const preset = presetState.presets[Number(event.key) - 1]
      if (preset) { event.preventDefault(); dispatchPreset({ type: 'apply', presetId: preset.id }) }
    }
  }

  const bundling = scope === 'collection' && collection !== null
  const subject = bundling && collection
    ? <><b>{collection.name}</b> · {collectionPieces} {collectionPieces === 1 ? 'piece' : 'pieces'}</>
    : collection
      ? <><b>{title}</b> · in <b>{collection.name}</b></>
      : <><b>{title}</b> · {count(words)} words</>

  return (
    <div className="version-modal-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose() }}>
      <form
        className="version-modal export-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-sheet-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); if (done) onClose(); else if (!busy) run() }}
        onKeyDown={keys}
      >
        <div className="vm-head">
          <Download className="icon" aria-hidden="true" />
          <h2 id="export-sheet-title">{presetState?.mode === 'managing' ? 'Export · Manage presets' : 'Export'}</h2>
          <button className="export-close" type="button" aria-label="Close export sheet" onClick={() => { if (!busy) onClose() }}>×</button>
        </div>
        <p className="export-subject">
          {presetState?.mode === 'saving-as'
            ? <>Current export choices remain in place</>
            : presetState?.mode === 'managing'
              ? <>All presets are editable. Their order becomes the order in the export sheet.</>
              : subject}
        </p>

        {done === null && presetState === null && <p className="export-loading" role="status">Loading export choices…</p>}

        {done === null && presetState !== null && (
          <>
            <div className="export-fields">
              <ExportPresetControls
                state={presetState}
                onAction={dispatchPreset}
                initialManagementAction={initialPresetAction === 'rename' ? 'rename' : undefined}
              />
              {presetState.mode === 'sheet' && <>
              <ExportOptionControls format={format} options={options} changedFields={presetState.changedFields} onChange={setOptions} />
              {collection && (
                <div className="export-field">
                  <div className="export-flabel" id="export-scope-label">What</div>
                  <div className="export-scope" role="radiogroup" aria-labelledby="export-scope-label">
                    <button
                      type="button"
                      className={`export-srow${scope === 'piece' ? ' on' : ''}`}
                      role="radio"
                      aria-checked={scope === 'piece'}
                      onClick={() => setScope('piece')}
                      onKeyDown={(event) => {
                        if (chooseWhere(event)) return
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') move(event, event.key === 'ArrowDown', 'scope')
                      }}
                    >
                      <span className="dot" aria-hidden="true" />
                      <span className="txt">This piece<small>{count(words)} words</small></span>
                    </button>
                    <button
                      type="button"
                      className={`export-srow${scope === 'collection' ? ' on' : ''}`}
                      role="radio"
                      aria-checked={scope === 'collection'}
                      onClick={() => setScope('collection')}
                      onKeyDown={(event) => {
                        if (chooseWhere(event)) return
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') move(event, event.key === 'ArrowDown', 'scope')
                      }}
                    >
                      <span className="dot" aria-hidden="true" />
                      <span className="txt">
                        The whole collection — {collectionPieces} {collectionPieces === 1 ? 'piece' : 'pieces'}
                        <small>
                          {collectionPieces === 0 && format === 'docx'
                            ? 'Word export writes the pieces directly in this folder, and there are none. HTML export writes the pieces this Folio lists.'
                            : <>One file, in the collection’s order, with a contents list. Links between these{' '}
                              {collectionPieces === 1 ? 'pieces' : `${collectionPieces} pieces`} keep working; links to
                              anything outside become plain words.</>}
                        </small>
                      </span>
                    </button>
                  </div>
                  {leftOut && scope === 'collection' && (
                    <div className="export-fhint export-left-out" role="note">
                      {leftOut.heading}
                      {leftOut.rows.map((row, index) => <div key={index}>{row}</div>)}
                    </div>
                  )}
                </div>
              )}
              <div className="export-field">
                <div className="export-flabel" id="export-format-label">Format</div>
                <div className="sw-seg export-seg" role="group" aria-labelledby="export-format-label">
                  {FORMATS.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      aria-pressed={format === candidate}
                      onClick={() => setFormat(candidate)}
                      onKeyDown={(event) => {
                        if (chooseWhere(event)) return
                        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') move(event, event.key === 'ArrowRight', 'format')
                      }}
                    >
                      {candidate === 'html'
                        ? <FileCode2 className="ic" aria-hidden="true" />
                        : <FileText className="ic" aria-hidden="true" />}
                      {FORMAT_LABELS[candidate]}
                    </button>
                  ))}
                </div>
                <div className="export-fhint">{FORMAT_HINTS[format]}</div>
              </div>
              </>}
            </div>
            {/* The honest line is derived from the current payload, so it cannot drift from the file. */}
            {presetState.mode === 'sheet' && <p className="export-leaves" aria-live="polite">{exportDisclosure(format, options)}</p>}
          </>
        )}

        {done !== null && left(done) === 0 && (
          <p className="export-done" role="status">
            <b>{exportedPhrase(done, done.bundled)}.</b> {done.target} —{' '}
            <button type="button" className="linkish" onClick={onReveal}>show in Finder</button>
          </p>
        )}
        {done !== null && left(done) > 0 && (
          <p className="export-warn" role="status">
            <b>
              {exportedPhrase(done, done.bundled)}, with {spell(left(done))}{' '}
              {left(done) === 1 ? 'image' : 'images'} left behind.
            </b>{' '}
            {missingLine(done.missingImages, done.unreadableImages)}
          </p>
        )}
        {problem !== null && <p className="export-error" role="alert">{problem}</p>}

        <div className="vm-actions">
          {busy && (
            <span className="export-working" role="status">
              <span className="export-spin" aria-hidden="true" />
              Writing {bundling && collection ? `${spell(collectionPieces)} pieces` : 'the file'}…
            </span>
          )}
          <span className="grow" aria-hidden="true" />
          {done === null && presetState?.mode === 'sheet' && (
            <>
              <button className="btn ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn primary" type="submit" disabled={busy} autoFocus>
                <Download className="icon" aria-hidden="true" />
                Choose where…
              </button>
            </>
          )}
          {done !== null && (
            <>
              {left(done) > 0 && (
                <button className="btn ghost" type="button" onClick={onReveal}>Show in Finder</button>
              )}
              <button className="btn primary" type="submit" autoFocus>Done</button>
            </>
          )}
        </div>
      </form>
    </div>
  )
}
