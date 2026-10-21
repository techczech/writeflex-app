import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Library, Plus, X } from 'lucide-react'
import { DEFAULT_SUPPORT_FOLDERS, type VaultStep } from '../../../shared/vault'
import {
  canMakeVault, draftToCreateInput, HIDE_GROUPS, hiddenForGroups, initialDraft, normaliseSupportName, reconcileSteps, refreshedPreview, STEP_CHOICES,
  type VaultDraft, type VaultPreview,
} from '../../../shared/vault-preview'

/**
 * "Make this folder a vault" (vaults ticket 03; locked frame `locked-vault-make-this-folder-a-vault-preview`).
 * Main reports what it found in the folder (`previewVault`); this sheet holds the draft (the pure model
 * in shared/vault-preview.ts) and, on Make vault, makes ONE `vault.create` call. Cancel and Esc write
 * nothing. There is no agent suggestion yet: every picker starts at No step.
 *
 * Keyboard: Tab runs name, switches, chips, Add, pickers, Cancel, Make vault. A picker is a native
 * select (arrows, Enter). Esc cancels (Esc inside the Add field only closes that field).
 *
 * A hide switch changes what counts as a work, so it re-reads the preview with the draft's hide list
 * (debounced; the last request's answer wins) and reconciles the step pickers with the statuses found.
 */

const REFRESH_DELAY_MS = 150

const STEP_VAR: Record<VaultStep, string> = { Idea: 's-idea', Notes: 's-note', Drafting: 's-prog', 'In review': 's-edit', Final: 's-ready', Done: 's-pub' }

export type MakeVaultSheetProps = {
  /** The root's full path, shown top right. */
  rootPath: string
  onClose: () => void
  /** The vault file was written. */
  onMade: (name: string) => void
  /** Render seam: a preview already read, so the sheet can be drawn without the preload bridge. */
  initialPreview?: VaultPreview
}

const count = (n: number): string => n.toLocaleString('en-GB')
const foundText = (id: string, n: number): string => {
  if (n === 0) return 'none found'
  const group = HIDE_GROUPS.find((candidate) => candidate.id === id)
  return `${count(n)} ${group?.kind === 'folder' ? (n === 1 ? 'folder' : 'folders') : (n === 1 ? 'file' : 'files')}`
}
const homeRelative = (path: string): string => path.replace(/^\/Users\/[^/]+/, '~')

export function MakeVaultSheet({ rootPath, onClose, onMade, initialPreview }: MakeVaultSheetProps): JSX.Element {
  const [preview, setPreview] = useState<VaultPreview | null>(initialPreview ?? null)
  const [draft, setDraft] = useState<VaultDraft | null>(initialPreview ? initialDraft(initialPreview) : null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addText, setAddText] = useState('')
  /** True from a hide switch's scheduled refresh until the latest refresh's reply is applied. */
  const [previewPending, setPreviewPending] = useState(false)
  /** True when the latest refresh failed (rejected or returned nothing). */
  const [previewFailed, setPreviewFailed] = useState(false)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshSeq = useRef(0)

  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshSeq.current += 1
  }, [])

  /** Re-read the preview for this hide list; only the latest request's answer is applied. */
  const refreshForHide = (hideOn: string[], supportFolders: string[]): void => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    const seq = ++refreshSeq.current
    setPreviewPending(true)
    setPreviewFailed(false)
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null
      void window.writeflex.previewVault({ hidden: hiddenForGroups(hideOn), supportFolders }).then(
        (next) => {
          if (seq !== refreshSeq.current) return
          if (!next) { setPreviewPending(false); setPreviewFailed(true); return }
          setPreview((current) => (current ? refreshedPreview(current, next, hideOn) : next))
          setDraft((current) => (current ? { ...current, steps: reconcileSteps(current.steps, next.statuses) } : current))
          setPreviewPending(false)
        },
        () => { if (seq === refreshSeq.current) { setPreviewPending(false); setPreviewFailed(true) } },
      )
    }, REFRESH_DELAY_MS)
  }
  const retryPreview = (): void => {
    if (draft) refreshForHide(draft.hideOn, draft.supportFolders)
  }
  const toggleHide = (id: string): void => {
    if (!draft) return
    const hideOn = draft.hideOn.includes(id) ? draft.hideOn.filter((other) => other !== id) : [...draft.hideOn, id]
    setDraft({ ...draft, hideOn })
    refreshForHide(hideOn, draft.supportFolders)
  }

  useEffect(() => {
    if (initialPreview) return
    let live = true
    void window.writeflex.previewVault({ supportFolders: [...DEFAULT_SUPPORT_FOLDERS] }).then(
      (next) => {
        if (!live) return
        if (!next) { setProblem('This folder could not be read, so nothing was changed.'); return }
        setPreview(next)
        setDraft(initialDraft(next))
      },
      () => { if (live) setProblem('This folder could not be read, so nothing was changed.') },
    )
    return () => { live = false }
  }, [initialPreview])

  const ready = draft !== null
  useEffect(() => { if (ready) nameRef.current?.focus() }, [ready])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (adding) { setAdding(false); setAddText(''); return }
      if (!busy) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [adding, busy, onClose])

  const addSupport = (): void => {
    if (!draft) return
    const name = normaliseSupportName(addText, draft.supportFolders)
    setAdding(false)
    setAddText('')
    if (name === null) return
    const supportFolders = [...draft.supportFolders, name]
    setDraft({ ...draft, supportFolders })
    void window.writeflex.previewVault({ supportFolders }).then(
      (next) => { if (next) setPreview((current) => (current ? { ...current, supportCounts: next.supportCounts } : current)) },
      () => {},
    )
  }
  const removeSupport = (name: string): void => {
    if (draft) setDraft({ ...draft, supportFolders: draft.supportFolders.filter((other) => other !== name) })
  }

  const makeOpen = draft !== null && canMakeVault({ busy, previewPending, previewFailed, name: draft.name })
  const make = (): void => {
    if (!draft || !makeOpen) return
    setBusy(true)
    setProblem(null)
    void window.writeflex.vault.create(draftToCreateInput(draft)).then(
      (result) => {
        if (result.ok) { onMade(result.vault.settings.name); return }
        setProblem(result.message)
        setBusy(false)
      },
      () => { setProblem('The vault file could not be written, so nothing was changed.'); setBusy(false) },
    )
  }

  const defaults = new Set<string>(DEFAULT_SUPPORT_FOLDERS)
  return (
    <div className="overlay open" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <div className="sheet mv-sheet" role="dialog" aria-modal="true" aria-labelledby="mv-title" data-testid="make-vault-sheet">
        <header>
          <Library className="icon" aria-hidden="true" />
          <h2 id="mv-title">Make this folder a vault</h2>
          <span className="grow" />
          <span className="mv-path" title={rootPath}>{homeRelative(rootPath)}</span>
        </header>
        {preview === null || draft === null ? (
          <div className="mv-wait" role={problem ? 'alert' : 'status'}>{problem ?? 'Reading the folder…'}</div>
        ) : (
          <div className="cols">
            <div className="col">
              <div>
                <h3><label htmlFor="mv-name">Name</label></h3>
                <input id="mv-name" ref={nameRef} className="mv-field" value={draft.name} spellCheck={false}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </div>
              <div>
                <h3>What WriteFlex found</h3>
                <div className="mv-summary" data-testid="mv-found">
                  <div><small>Works</small><b data-found="works">{count(preview.works)}</b></div>
                  <div><small>With a status</small><b data-found="with-status">{count(preview.withStatus)}</b></div>
                  <div><small>Files</small><b data-found="files">{count(preview.files)}</b></div>
                </div>
                <p className="mv-note" style={{ marginTop: 6 }}>Each folder with a Folio is one work; its parts are counted as its words.</p>
              </div>
              <div>
                <h3>Hide from the sidebar and from works</h3>
                {HIDE_GROUPS.map((group) => {
                  const on = draft.hideOn.includes(group.id)
                  return (
                    <div className="mv-pat" key={group.id} data-group={group.id}>
                      <code>{group.label}</code>
                      <span>{group.description}</span>
                      <span className="mv-found">{foundText(group.id, preview.hideCounts[group.id] ?? 0)}</span>
                      <label className="switch">
                        <input type="checkbox" role="switch" checked={on} aria-label={`Hide ${group.label}`}
                          onChange={() => toggleHide(group.id)} />
                        <span className="knob" />
                      </label>
                    </div>
                  )
                })}
              </div>
              <div>
                <h3>Supporting folders</h3>
                <p className="hint">Counted on their work, never listed as works.</p>
                <div className="mv-sup">
                  {draft.supportFolders.map((name) => {
                    const n = preview.supportCounts[name]
                    return (
                      <span key={name} data-support={name}>
                        {name}/{n ? <i>{count(n)} {n === 1 ? 'file' : 'files'}</i> : null}
                        {!defaults.has(name) && (
                          <button type="button" className="mv-x" aria-label={`Remove ${name}/`} onClick={() => removeSupport(name)}><X className="icon sm" aria-hidden="true" /></button>
                        )}
                      </span>
                    )
                  })}
                  {adding ? (
                    <input className="mv-add-field" autoFocus value={addText} placeholder="folder name" aria-label="Supporting folder name"
                      onChange={(event) => setAddText(event.target.value)}
                      onBlur={() => { if (addText.trim() === '') setAdding(false); else addSupport() }}
                      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addSupport() } }} />
                  ) : (
                    <button type="button" className="mv-add" data-action="add-support" onClick={() => setAdding(true)}><Plus className="icon sm" aria-hidden="true" />Add</button>
                  )}
                </div>
              </div>
            </div>
            <div className="col">
              <div><h3>Status steps</h3></div>
              <table className="mv-map">
                <thead><tr><th>Status in the files</th><th className="n">Works</th><th>Step</th></tr></thead>
                <tbody>
                  {preview.statuses.map((row) => {
                    const step = draft.steps[row.raw] ?? ''
                    const colour = step === '' ? undefined : { color: `var(--${STEP_VAR[step]})`, background: `var(--${STEP_VAR[step]}-bg)` }
                    return (
                      <tr key={row.raw} data-status={row.raw}>
                        <td><code>{row.raw}</code></td>
                        <td className="n">{count(row.works)}</td>
                        <td>
                          <span className={`mv-pick${step === '' ? ' grey' : ''}`}>
                            <select value={step} aria-label={`Step for ${row.raw}`} style={colour}
                              onChange={(event) => setDraft({ ...draft, steps: { ...draft.steps, [row.raw]: event.target.value as VaultStep | '' } })}>
                              {STEP_CHOICES.map((choice) => <option key={choice || 'none'} value={choice}>{choice === '' ? 'No step, shown grey' : choice}</option>)}
                            </select>
                            <ChevronDown className="icon" aria-hidden="true" />
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                  <tr data-status="(no status)">
                    <td><code>(no status)</code></td>
                    <td className="n">{count(preview.noStatusWorks)}</td>
                    <td><span className="mv-pick grey fixed">No step, shown grey</span></td>
                  </tr>
                </tbody>
              </table>
              <p className="hint">Steps in order: Idea · Notes · Drafting · In review · Final · Done. A value with no step keeps its own name, in grey.</p>
              <p className="mv-note">The steps you choose are saved in this folder&apos;s <code>.writeflex/vault.json</code>. Make vault writes that one file in this folder. The files themselves are not changed. Settings and pins travel with the folder, so every Mac sees the same vault.</p>
            </div>
          </div>
        )}
        <footer>
          <span className="grow">
            {problem && draft ? <span className="mv-problem" role="alert">{problem}</span>
              : previewFailed && draft ? (
                <span className="mv-problem" role="alert">The preview could not be updated. <button type="button" className="link" data-action="retry-preview" onClick={retryPreview}>Try again</button></span>
              ) : 'Nothing is saved until you choose Make vault.'}
          </span>
          <button type="button" className="btn" data-action="cancel" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" data-action="make-vault" disabled={!makeOpen} aria-busy={previewPending ? 'true' : undefined} onClick={make}>
            <Library className="icon sm" aria-hidden="true" />Make vault
          </button>
        </footer>
      </div>
    </div>
  )
}
