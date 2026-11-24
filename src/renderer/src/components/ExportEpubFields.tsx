import { useCallback, useEffect, useRef, useState } from 'react'
import type { EpubMetadata, EpubPreparationOptions, EpubPrepareReply, EpubProblem, EpubSummary } from '../../../shared/publication-export'

type Prepare = (options: EpubPreparationOptions) => Promise<EpubPrepareReply>
type Ready = Extract<EpubPrepareReply, { status: 'ready' }>

export function useEpubExport(prepare: Prepare | undefined, keepLineBreaks: boolean, orderChanged: unknown) {
  const [metadata, setMetadata] = useState<Partial<EpubMetadata>>({})
  const [omissions, setOmissions] = useState<string[]>([])
  const [useExportOrder, setUseExportOrder] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [ready, setReady] = useState<Ready | null>(null)
  const [checked, setChecked] = useState<string | null>(null)
  const [problem, setProblem] = useState<EpubProblem | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [complete, setComplete] = useState<{ name: string; warning?: string } | null>(null)
  const generation = useRef(0)
  const latestToken = useRef<string | null>(null)
  const savingRef = useRef(false)
  const key = JSON.stringify([metadata, omissions, useExportOrder, keepLineBreaks, refresh, orderChanged])

  useEffect(() => {
    if (!prepare) return
    const mine = ++generation.current
    setProblem(null)
    setCancelled(false)
    setPreparing(true)
    const timer = window.setTimeout(() => {
      void prepare({ metadata, omissions, keepLineBreaks, useExportOrder }).then(answer => {
        if (mine !== generation.current) return
        if (answer.status === 'ready') {
          latestToken.current = answer.token
          setReady(answer)
          setChecked(key)
        } else setProblem(answer.problem)
      }).catch(() => {
        if (mine === generation.current) setProblem({ code: 'source', message: 'The Folio could not be checked. Try again.' })
      }).finally(() => {
        if (mine === generation.current) setPreparing(false)
      })
    }, 140)
    return () => {
      ++generation.current
      window.clearTimeout(timer)
    }
  }, [key, keepLineBreaks, metadata, omissions, prepare, useExportOrder])

  useEffect(() => {
    if (!prepare) return
    return () => {
      void window.writeflex.folioEpub.release(null).catch(() => {})
      latestToken.current = null
    }
  }, [prepare])

  const valid = ready !== null && checked === key && !ready.summary.problems.length && !preparing && !cancelling && !saving
  const checkAgain = () => setRefresh(value => value + 1)

  const save = useCallback(async () => {
    if (!valid || !ready || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setCancelled(false)
    setProblem(null)
    try {
      const answer = await window.writeflex.folioEpub.save(ready.token)
      if (answer.status === 'complete') setComplete(answer)
      if (answer.status === 'cancelled') setCancelled(true)
      if (answer.status === 'error') {
        setProblem(answer.problem)
        if (answer.problem.code === 'stale' || answer.problem.code === 'source') setChecked(null)
      }
    } catch {
      setProblem({ code: 'destination', message: 'WriteFlex could not save the ebook. Choose another location.' })
    } finally {
      setSaving(false)
      setCancelling(false)
      savingRef.current = false
    }
  }, [ready, valid])

  function cancel(): void {
    if (cancelling) return
    setCancelling(true)
    const wasSaving = savingRef.current
    if (!wasSaving) ++generation.current
    void window.writeflex.folioEpub.cancel(wasSaving ? latestToken.current : null).finally(() => {
      // Save owns its outcome, including a commit which won against cancellation.
      if (!wasSaving) {
        setChecked(null)
        setPreparing(false)
        setCancelling(false)
        setCancelled(true)
      }
    }).catch(() => {})
  }

  return {
    ready: ready?.summary ?? null, metadata, setMetadata, omissions, setOmissions, useExportOrder: () => setUseExportOrder(true),
    valid, preparing, saving, cancelling, complete, cancelled, problem, save, cancel, checkAgain
  }
}

const labels = { title: 'Title', author: 'Author', language: 'Language' } as const
const roles = { title: 'Title page', front: 'Front matter', continues: 'Continues chapter', chapter: 'Chapter', section: 'Section' } as const
type FieldsProps = {
  folio: string
  summary: EpubSummary | null
  metadata: Partial<EpubMetadata>
  setMetadata: (next: Partial<EpubMetadata>) => void
  keepLineBreaks: boolean
  setKeepLineBreaks: (keep: boolean) => void
  disabled: boolean
  omissions: string[]
  setOmissions: (omissions: string[]) => void
}

export function ExportEpubFields({ folio, summary, metadata, setMetadata, keepLineBreaks, setKeepLineBreaks, disabled, omissions, setOmissions }: FieldsProps): JSX.Element {
  const changed = summary?.lastSourceMetadata && Object.keys(labels).some(key => {
    const field = key as keyof EpubMetadata
    return summary.lastSourceMetadata?.[field] !== summary.sourceMetadata[field]
  })
  return <>
    <div className="export-field">
      <div className="export-flabel">What</div>
      <div className="export-fhint"><strong>The whole Folio</strong> · {folio}</div>
    </div>
    <fieldset className="export-epub-details" disabled={disabled}>
      <legend className="export-flabel">Book details</legend>
      {(Object.keys(labels) as (keyof EpubMetadata)[]).map(field => {
        const value = metadata[field] ?? summary?.metadata[field] ?? ''
        const required = summary !== null && field !== 'language' && !value.trim()
        const invalidLanguage = field === 'language' && (summary?.problems.some(problem => problem.message === 'Choose a valid book language.') ?? false)
        return <label key={field} className="export-epub-field">
          <span>{labels[field]}</span>
          <input
            value={value}
            required
            maxLength={1000}
            list={field === 'language' ? 'export-epub-languages' : undefined}
            aria-invalid={(required || invalidLanguage) || undefined}
            onChange={event => setMetadata({ ...metadata, [field]: event.currentTarget.value })}
          />
          {required && <small>Enter a book {field}.</small>}
          {invalidLanguage && <small>Choose a valid book language.</small>}
        </label>
      })}
      <datalist id="export-epub-languages">
        <option value="en-GB">English (United Kingdom)</option>
        <option value="en-US">English (United States)</option>
        <option value="cs">Czech</option>
        <option value="fr">French</option>
        <option value="de">German</option>
        <option value="es">Spanish</option>
      </datalist>
      <p className="export-fhint">These details are saved for this ebook. Your Folio text stays as it is.</p>
      {changed && <div className="export-warn">
        <span>The Folio’s book details have changed since the last export.</span>{' '}
        <button type="button" className="btn small" onClick={() => setMetadata({ ...summary.sourceMetadata })}>Use current Folio details</button>
      </div>}
    </fieldset>
    {summary && <details className="export-epub-contents">
      <summary>Contents <span>{summary.parts.length} parts · {summary.chapters} chapters</span></summary>
      <ul>{summary.parts.map((part, index) => <li key={index} style={{ paddingInlineStart: Math.min(part.depth, 8) * 12 }}>
        <span>{part.title}</span><small>{roles[part.role]}</small>
      </li>)}</ul>
    </details>}
    {summary?.planned.map(part => <label key={part.id} className="export-fhint export-epub-checkbox">
      <input type="checkbox" checked={omissions.includes(part.id)} disabled={disabled}
        onChange={event => setOmissions(event.currentTarget.checked ? [...omissions, part.id] : omissions.filter(id => id !== part.id))} />
      Leave out “{part.title}”
    </label>)}
    {summary?.omitted.map(name => <p key={name} className="export-fhint">Leaving out “{name}”.</p>)}
    <div>
      <label className="export-fhint export-epub-checkbox">
        <input type="checkbox" checked={keepLineBreaks} disabled={disabled} aria-describedby="export-epub-line-breaks"
          onChange={event => setKeepLineBreaks(event.currentTarget.checked)} /> Keep my line breaks
      </label>
      <p className="export-fhint" id="export-epub-line-breaks">Off joins consecutive lines into standard Markdown paragraphs.</p>
    </div>
  </>
}
