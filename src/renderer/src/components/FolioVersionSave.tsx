import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, FileSpreadsheet, FileText, History, Image as ImageIcon, TriangleAlert, Globe } from 'lucide-react'
import type { FolioSheetFacts, FolioSheetInserted } from '../../../main/folio-version-sheet'
import {
  chooserOrder, factsFor, insertedVersionLabel, LEFT_OUT_NOTE, leftOutLine, notKeptLine, textLine, waitingBlocks,
  type SaveChoice,
} from '../app/folio-version-save'
import { useModalFocus } from '../hooks/useModalFocus'

/**
 * The ⇧⌘S choice and the Save Folio version sheet (Folio versions ticket 04), drawn after the locked mockup
 * (docs/design/2026-11-02-folio-versions/mockup/locked/, scenes `choose-save` and `save`). Both are modals
 * that end in one choice. Neither writes anything until its main button; Escape and Cancel close with nothing
 * changed. The words are in app/folio-version-save.ts.
 */

const modalKeys = (onCancel: () => void, busy: boolean) => (event: KeyboardEvent): void => {
  if (event.key !== 'Escape' || busy) return
  event.preventDefault()
  event.stopPropagation()
  onCancel()
}

/** Escape closes the modal wherever focus is inside it (capture, so the editor behind never sees it). */
function useEscape(onCancel: () => void, busy = false): void {
  useEffect(() => {
    const handler = modalKeys(onCancel, busy)
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [onCancel, busy])
}

const CHOICE_TEXT: Record<SaveChoice, { name: string; note: (partName: string, parts: number | null) => string; chord: string }> = {
  folio: {
    name: 'Whole Folio',
    note: (_partName, parts) => `The text of ${parts === null ? 'all the' : `all ${parts}`} parts in running order, with the tables and widgets the text inserts. Research, offcuts and the archive stay out.`,
    chord: '⌘1',
  },
  part: {
    name: 'This part only',
    note: (partName) => `${partName ? `“${partName}”, as` : 'As'} the per-part Save Version does today.`,
    chord: '⌘2',
  },
}

export type SaveChooserProps = {
  /** The last answer (app state); the list puts it first and highlights it. */
  last: SaveChoice
  /** The open part's name for the second option, and the Folio's part count for the first, when known. */
  partName: string
  parts: number | null
  onChoose: (choice: SaveChoice) => void
  onCancel: () => void
}

export function SaveChooser({ last, partName, parts, onChoose, onCancel }: SaveChooserProps): JSX.Element {
  const order = useMemo(() => chooserOrder(last), [last])
  const [highlight, setHighlight] = useState<SaveChoice>(order[0])
  const dialog = useRef<HTMLDivElement | null>(null)
  const backdrop = useRef<HTMLDivElement | null>(null)
  useEscape(onCancel)
  useModalFocus(backdrop)
  useEffect(() => { dialog.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus() }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const meta = event.metaKey || event.ctrlKey
      if (meta && !event.shiftKey && !event.altKey && (event.key === '1' || event.key === '2')) {
        event.preventDefault()
        event.stopPropagation()
        onChoose(event.key === '1' ? 'folio' : 'part')
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((current) => (current === 'folio' ? 'part' : 'folio'))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onChoose])
  useEffect(() => { dialog.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus() }, [highlight])
  return (
    <div ref={backdrop} className="fvs-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        ref={dialog}
        className="fvs-sheet fvs-chooser"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fvs-chooser-title"
        data-testid="folio-save-chooser"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="fvs-head"><History className="icon" aria-hidden="true" /><h2 id="fvs-chooser-title">Save a version</h2></div>
        <div className="fvs-body">
          <p className="fvs-question" id="fvs-chooser-question">Whole Folio or this part only?</p>
          <div role="radiogroup" aria-labelledby="fvs-chooser-question" className="fvs-options">
            {order.map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={highlight === choice}
                className={`fvs-opt${highlight === choice ? ' on' : ''}`}
                data-choice={choice}
                onClick={() => setHighlight(choice)}
                onDoubleClick={() => onChoose(choice)}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onChoose(highlight) } }}
              >
                <span className="fvs-radio" aria-hidden="true" />
                <span className="fvs-opt-text">
                  <span className="fvs-opt-name">{CHOICE_TEXT[choice].name}{choice === last && <span className="fvs-chip">your last choice</span>}</span>
                  <span className="fvs-note">{CHOICE_TEXT[choice].note(partName, parts)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="fvs-foot">
          <span className="fvs-note fvs-foot-hint"><kbd>Return</kbd> uses the highlighted choice · <kbd>⌘1</kbd> Whole Folio · <kbd>⌘2</kbd> This part</span>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn primary" data-testid="folio-save-chooser-continue" onClick={() => onChoose(highlight)}>Continue</button>
        </div>
      </div>
    </div>
  )
}

const INSERT_ICON: Record<FolioSheetInserted['kind'], typeof FileText> = { table: FileSpreadsheet, image: ImageIcon, widget: Globe, file: FileText }

export type FolioVersionSheetProps = {
  facts: FolioSheetFacts
  /** The Folio's name, for the title line. */
  folioName: string
  /** A name to start with (the decide step's finishing offer proposes “After <name>’s revision”); the writer can change it. */
  initialName?: string
  /** Today, for the footer (a Date, so a test can fix it). */
  today: Date
  busy: boolean
  /** A sentence from a refused save (nothing was written). */
  error: string
  /** What moved since the writer read the sheet, when a go-ahead found the Folio changed (nothing was saved); null otherwise. The facts shown are already the new ones. */
  changed?: string[] | null
  onCancel: () => void
  /** `expect` is the fingerprint of the facts as shown for this choice of the tick box: the save checks it under the Folio's lock. */
  onSave: (input: { name: string; note: string; includeUnlisted: boolean; expect: string }) => void
}

const dateLine = (date: Date): string => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

export function FolioVersionSheet({ facts: read, folioName, initialName = '', today, busy, error, changed = null, onCancel, onSave }: FolioVersionSheetProps): JSX.Element {
  const backdrop = useRef<HTMLDivElement | null>(null)
  const nameField = useRef<HTMLInputElement | null>(null)
  useModalFocus(backdrop)
  const [name, setName] = useState(initialName)
  const [note, setNote] = useState('')
  const [includeUnlisted, setIncludeUnlisted] = useState(true)
  const [nameError, setNameError] = useState('')
  useEscape(onCancel, busy)
  // The fields are switched off while a save runs, which drops focus; when it ends (refused, or the Folio had changed) the writer is back at the name.
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) nameField.current?.focus()
    wasBusy.current = busy
  }, [busy])
  // Everything the tick box changes is recomputed in main for each choice; the sheet shows the facts for the choice made.
  const facts = useMemo(() => factsFor(read, includeUnlisted), [read, includeUnlisted])
  const blocks = useMemo(() => waitingBlocks(facts, includeUnlisted), [facts, includeUnlisted])
  const keptFiles = facts.inserted.filter((entry) => entry.handling === 'kept')
  const notKept = facts.inserted.filter((entry) => entry.handling === 'too-large')
  const left = facts.backup.state === 'ok' ? facts.backup.leftOut : []
  const refused = facts.refused !== undefined
  const submit = (): void => {
    if (busy || refused) return
    if (name.trim() === '') { setNameError('Name the version before saving.'); return }
    onSave({ name: name.trim(), note: note.trim(), includeUnlisted, expect: facts.fingerprint })
  }
  return (
    <div ref={backdrop} className="fvs-backdrop" role="presentation" onMouseDown={() => { if (!busy) onCancel() }}>
      <form
        className="fvs-sheet fvs-save"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fvs-save-title"
        data-testid="folio-save-sheet"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); submit() }}
      >
        <div className="fvs-head"><History className="icon" aria-hidden="true" /><h2 id="fvs-save-title">Save Folio version</h2><span className="fvs-folio">{folioName}</span></div>
        <div className="fvs-body">
          {refused && (
            <div className="fvs-banner bad" role="alert" data-testid="folio-save-refused"><CircleAlert className="icon" aria-hidden="true" /><span><b>This Folio cannot be saved as a version yet.</b> {facts.refused} Nothing was saved.</span></div>
          )}
          <label className="fvs-field">
            <span>Name</span>
            <input
              ref={nameField}
              autoFocus
              value={name}
              placeholder="After pilot numbers"
              disabled={refused || busy}
              aria-invalid={nameError !== ''}
              aria-describedby={nameError ? 'fvs-name-error' : undefined}
              onChange={(event) => { setName(event.target.value); if (nameError) setNameError('') }}
              data-testid="folio-save-name"
            />
          </label>
          {nameError && <p className="fvs-error" id="fvs-name-error">{nameError}</p>}
          <label className="fvs-field">
            <span>Note (optional)</span>
            <input value={note} placeholder="What this version is for" disabled={refused || busy} onChange={(event) => setNote(event.target.value)} data-testid="folio-save-note" />
          </label>

          {changed && changed.length > 0 && (
            <div className="fvs-banner warn" role="alert" data-testid="folio-save-changed">
              <TriangleAlert className="icon" aria-hidden="true" />
              <span><b>The Folio changed while this sheet was open, so nothing was saved.</b> The sheet now shows it as it is. Check it, then save again.<ul>{changed.map((line) => <li key={line}>{line}</li>)}</ul></span>
            </div>
          )}
          {blocks.own && (
            <div className="fvs-banner warn" data-testid="folio-save-waiting-own">
              <TriangleAlert className="icon" aria-hidden="true" />
              <span><b>{blocks.own.headline}</b> {blocks.own.body}{blocks.own.lines.length > 0 && <ul>{blocks.own.lines.map((line) => <li key={line}>{line}</li>)}</ul>}</span>
            </div>
          )}
          {blocks.agent && (
            <div className="fvs-banner info" data-testid="folio-save-waiting-agent">
              <TriangleAlert className="icon" aria-hidden="true" />
              <span><b>{blocks.agent.headline}</b> {blocks.agent.body}{blocks.agent.lines.length > 0 && <ul>{blocks.agent.lines.map((line) => <li key={line}>{line}</li>)}</ul>}</span>
            </div>
          )}

          {!refused && (
            <>
              <section className="fvs-card" aria-labelledby="fvs-frozen">
                <h3 className="fvs-card-head" id="fvs-frozen">Frozen in this version</h3>
                <dl className="fvs-kv" data-testid="folio-save-frozen">
                  <dt>Text</dt>
                  <dd data-testid="folio-save-text">{textLine(facts)}</dd>
                  <dt>Inserted files</dt>
                  <dd>
                    {facts.inserted.length === 0
                      ? <span className="fvs-note">No tables, widgets or images are inserted.</span>
                      : (
                        <>
                          {keptFiles.length > 0 && (
                            <>
                              <ul className="fvs-files" data-testid="folio-save-inserted">
                                {keptFiles.map((entry) => {
                                  const Icon = INSERT_ICON[entry.kind]
                                  return <li key={entry.path}><Icon className="icon" aria-hidden="true" /><span className="fvs-file">{entry.name}</span><span className="fvs-note"> · {insertedVersionLabel(entry)}</span></li>
                                })}
                              </ul>
                              <div className="fvs-note">Each kept as it is now; the version records which file version it used.</div>
                            </>
                          )}
                          {notKept.length > 0 && (
                            <ul className="fvs-files" data-testid="folio-save-not-kept">
                              {notKept.map((entry) => {
                                const Icon = INSERT_ICON[entry.kind]
                                return <li key={entry.path}><Icon className="icon" aria-hidden="true" /><span className="fvs-note">{notKeptLine(entry, facts.insertedCapBytes)}</span></li>
                              })}
                            </ul>
                          )}
                        </>
                      )}
                    {facts.linked.length > 0 && <div className="fvs-note" data-testid="folio-save-linked">Only linked, so listed and not kept: {facts.linked.join(', ')}.</div>}
                  </dd>
                  <dt>Not in the outline</dt>
                  <dd>
                    {facts.unlisted.length === 0
                      ? <span className="fvs-note">No Markdown files outside the running order.</span>
                      : (
                        <label className="fvs-check">
                          <input type="checkbox" checked={includeUnlisted} disabled={busy} onChange={(event) => setIncludeUnlisted(event.target.checked)} data-testid="folio-save-unlisted" />
                          <span>Include the {facts.unlisted.length} Markdown {facts.unlisted.length === 1 ? 'file' : 'files'} that {facts.unlisted.length === 1 ? 'is' : 'are'} not in the outline</span>
                        </label>
                      )}
                    {facts.unlisted.length > 0 && includeUnlisted && <div className="fvs-note" data-testid="folio-save-unlisted-list">{facts.unlisted.map((entry) => entry.path.split('/').at(-1)).join(', ')}</div>}
                  </dd>
                </dl>
              </section>
              <section className="fvs-card plain" aria-labelledby="fvs-left">
                <h3 className="fvs-card-head" id="fvs-left">Left out, never copied</h3>
                <div className="fvs-card-body fvs-note" data-testid="folio-save-left-out">{leftOutLine(facts)}. {LEFT_OUT_NOTE}</div>
              </section>
              {left.length > 0 && (
                <section className="fvs-card plain" aria-labelledby="fvs-backup" data-testid="folio-save-backup-left-out">
                  <h3 className="fvs-card-head" id="fvs-backup">Earlier versions the backup holds back</h3>
                  <ul className="fvs-card-body fvs-reasons">{left.map((entry) => <li key={entry.id}>{entry.reason}</li>)}</ul>
                </section>
              )}
              {facts.backup.state === 'unavailable' && facts.versionCount > 0 && (
                <p className="fvs-note" data-testid="folio-save-backup-unavailable">What the backup keeps could not be checked just now: {facts.backup.reason}</p>
              )}
            </>
          )}
          {error && <p className="fvs-error" role="alert" data-testid="folio-save-error">{error}</p>}
        </div>
        <div className="fvs-foot">
          <span className="fvs-note fvs-foot-hint">Saved as you · {facts.author} · {dateLine(today)}</span>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || refused} data-testid="folio-save-submit"><History className="icon" aria-hidden="true" /> {busy ? 'Saving…' : 'Save Folio version'}</button>
        </div>
      </form>
    </div>
  )
}
