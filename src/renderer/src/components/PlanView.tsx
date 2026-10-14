import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BookOpenText, Columns3, FilePlus2, Library, Lightbulb, ListOrdered, ListTree, Plus, TriangleAlert, X } from 'lucide-react'
import type { Collection, Folio, Plan, StubPreview } from '../../../preload'
import { MANIFEST_NAME } from '../../../shared/folio-constants'
import { shortcutCaptureActive, type OverrideMap } from '../commands/chords'
import { humanReadableError } from '../error-text'
import { PLAN_COMMAND_EVENT, type PlanCommandName } from '../plan/plan-commands'
import { REPORT_SKILL_COMMAND } from '../plan/report-skill'
import { registryCommand } from '../commands/registry'
import { SkillTriggerButton } from './AgentSkillSurfaces'
import { planCommandForEvent } from '../plan/plan-shortcuts'
import {
  buildPlanRows,
  composerPosition,
  materialisationPreview,
  planSummary,
  pluralisedSummary,
  type PlanDisplayRow,
} from '../plan/plan-view-model'

const ROLES = ['section', 'vignette', 'appendix', 'summary'] as const

const STAGE_CLASS = {
  idea: 'idea',
  jottings: 'jot',
  'partial draft': 'partial',
  'rough draft': 'rough',
  'final draft': 'final',
  published: 'pub',
} as const

type ComposerState = { at: number; title: string; gloss: string; role: typeof ROLES[number] }
type PreviewState = { index: number; stub: StubPreview; manifestLine: string }

export type PlanViewProps = {
  dir: string
  onOpenPiece: (path: string) => void
  onStatus: (message: string) => void
  onOpenBoard: () => void
  shortcutOverrides?: OverrideMap
  startWithComposer?: boolean
  manifestUnreadable?: boolean
  /** Start the report skill on this Plan's folder (ticket 10). Absent: no button. */
  onHelpWithReport?: () => void
}

export type PlanPartListProps = {
  rows: PlanDisplayRow[]
  selected: number | null
  composer: ReactNode
  composerAt?: number | null
  onSelect: (index: number) => void
  onOpen: (index: number) => void
  onDragStart: (index: number) => void
  onDrop: (index: number) => void
}

export type PlanUnlistedListProps = {
  parts: Plan['unlisted']
  selected?: number | null
  onSelect?: (index: number) => void
  onAdopt: (index: number) => void
}

function wordsLabel(words: number): string {
  return `${words.toLocaleString('en-GB')} ${words === 1 ? 'word' : 'words'}`
}

export function FolioManifestWarning(): JSX.Element {
  return (
    <span className="hint plan-manifest-warning">
      <TriangleAlert className="icon sm" />
      Folio manifest unreadable. Fix or move {MANIFEST_NAME} before changing this Folio. Plan edits cannot reach the compiled report until it is fixed.
    </span>
  )
}

export function planActionFailure(error: unknown, fallback: string): string {
  const message = humanReadableError(error, fallback)
  return /nothing else was changed/i.test(message) ? message : `${message} Nothing else was changed.`
}

export function PlanPartList({ rows, selected, composer, composerAt = null, onSelect, onOpen, onDragStart, onDrop }: PlanPartListProps): JSX.Element {
  return (
    <div className="parts" role="listbox" aria-label="Running order">
      {rows.map((row, index) => {
        const stageClass = row.stage ? STAGE_CLASS[row.stage] : 'idea'
        return (
          <div key={`${row.title}-${row.line}`}>
            {composer && index === composerAt ? composer : null}
            <button
              type="button"
              role="option"
              aria-selected={selected === index}
              className={`part s-${stageClass}${row.written ? '' : ' unwritten'}${selected === index ? ' sel' : ''}`}
              draggable
              onDragStart={() => onDragStart(index)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); onDrop(index) }}
              onFocus={() => onSelect(index)}
              onClick={() => onSelect(index)}
              onDoubleClick={() => onOpen(index)}
            >
              <span className="rule" />
              <span className="num">{row.number}</span>
              <span className="body">
                <span className="ptitle">{!row.written && <Lightbulb className="idea-mark" />}{row.title}</span>
                <span className="pgloss">{row.gloss || '— no gloss yet'}</span>
                <span className="pfoot">
                  {row.written && row.stage ? (
                    <span className={`stage ${STAGE_CLASS[row.stage]}`}><span className="sd" />{row.stage}</span>
                  ) : !row.written ? <span className="unw">not written</span> : null}
                  <span className="role">{row.role}</span>
                  {row.words !== null && <span className="words">{wordsLabel(row.words)}</span>}
                </span>
                <span className="kbhint"><kbd>⏎</kbd> {row.written ? 'open' : 'write this part'} · <kbd>⌥↑↓</kbd> move in the order · <kbd>⌘⌫</kbd> remove from the Plan</span>
              </span>
            </button>
          </div>
        )
      })}
      {composer && rows.length === composerAt ? composer : null}
    </div>
  )
}

export function PlanUnlistedList({ parts, selected = null, onSelect = () => {}, onAdopt }: PlanUnlistedListProps): JSX.Element {
  const groups = [
    {
      key: 'manifest',
      title: 'In the compiled report, not in your running order',
      note: 'These parts are already in the report manifest.',
      parts: parts.map((part, index) => ({ part, index })).filter(({ part }) => part.manifestBacked === true),
    },
    {
      key: 'folder',
      title: 'In the folder, not yet part of the report',
      note: 'Add a part to include it in the running order. Written parts also join an existing report manifest.',
      parts: parts.map((part, index) => ({ part, index })).filter(({ part }) => part.manifestBacked !== true),
    },
  ].filter((group) => group.parts.length > 0)
  return (
    <section className="unlisted-parts" aria-label="Parts outside the running order">
      {groups.map((group) => <div className="unlisted-group" key={group.key}>
        <div className="plan-bar"><h2>{group.title}</h2></div>
        <p className="unlisted-note">{group.note}</p>
        <div className="parts">
        {group.parts.map(({ part, index }) => (
          <div className={`part unlisted-part${selected === index ? ' sel' : ''}`} key={`${part.path}-${index}`}>
            <span className="rule" />
            <span className="body">
              <span className="ptitle">{part.title}</span>
              <span className="pgloss">{part.gloss || '— no gloss yet'}</span>
              <span className="pfoot"><span className="role">{part.role}</span></span>
            </span>
            <button
              type="button"
              className="iconbtn"
              onFocus={() => onSelect(index)}
              onClick={() => { onSelect(index); onAdopt(index) }}
            >
              <Plus />Add to plan <kbd>A</kbd>
            </button>
          </div>
        ))}
        </div>
      </div>
      )}
    </section>
  )
}

export function PlanProjectionNav({ onOpenBoard, onHelpWithReport }: { onOpenBoard: () => void; onHelpWithReport?: () => void }): JSX.Element {
  return (
    <div className="plan-projection-nav">
      {onHelpWithReport && <SkillTriggerButton label={registryCommand(REPORT_SKILL_COMMAND).label} onRun={onHelpWithReport} />}
      <div className="seg-view" aria-label="Collection projection">
        <button type="button" aria-pressed="false" onClick={onOpenBoard}><Columns3 aria-hidden="true" /> Board</button>
        <button type="button" aria-pressed="true"><ListOrdered aria-hidden="true" /> Plan</button>
        <button type="button" disabled title="Outline comes in a later release"><ListTree aria-hidden="true" /> Outline</button>
      </div>
    </div>
  )
}

export function PlanEmptyState({ kind, onStart }: { kind: 'absent' | 'empty'; onStart: () => void }): JSX.Element {
  return (
    <div className="plan-empty">
      <div className="art" aria-hidden="true"><i /><i /><i /><i /></div>
      <h2>{kind === 'absent' ? 'Start a plan' : 'Nothing in the running order yet'}</h2>
      <p>{kind === 'absent'
        ? 'Create an Index Note for this folder, then plan its parts before any files need to exist.'
        : 'Add the first part to shape the running order. It can stay unwritten until you are ready.'}</p>
      <div className="be-act">
        <button type="button" className="btn idea-action" onClick={onStart}><Plus />{kind === 'absent' ? 'Start a plan' : 'Add the first part'}</button>
      </div>
      <span className="note">{kind === 'absent' ? 'The Plan will live in the folder’s Index Note.' : 'Nothing is written until you press Return.'}</span>
    </div>
  )
}

export function PlanView({ dir, onOpenPiece, onStatus, onOpenBoard, shortcutOverrides = {}, startWithComposer = false, manifestUnreadable = false, onHelpWithReport }: PlanViewProps): JSX.Element {
  const [plan, setPlan] = useState<Plan | null | undefined>(undefined)
  const [collection, setCollection] = useState<Collection | null>(null)
  const [folio, setFolio] = useState<Folio | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [selectedUnlisted, setSelectedUnlisted] = useState<number | null>(null)
  const [composer, setComposer] = useState<ComposerState | null>(null)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragged, setDragged] = useState<number | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const startedRef = useRef(false)

  const reload = useCallback(async () => {
    try {
      const [nextPlan, nextCollection, nextFolio] = await Promise.all([
        window.writeflex.plan.read(dir),
        window.writeflex.listCollection(dir),
        window.writeflex.readFolio(dir),
      ])
      setPlan(nextPlan)
      setCollection(nextCollection)
      setFolio(nextFolio)
      setSelected((current) => nextPlan?.parts.length ? Math.min(current ?? 0, nextPlan.parts.length - 1) : null)
      setSelectedUnlisted((current) => nextPlan?.unlisted.length ? Math.min(current ?? 0, nextPlan.unlisted.length - 1) : null)
    } catch {
      setPlan(null)
      onStatus('Could not read this Plan. Close and reopen the folder, then try again.')
    }
  }, [dir, onStatus])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => window.writeflex.onCollectionChanged(() => { void reload() }), [reload])

  const rows = useMemo(() => plan ? buildPlanRows(plan, collection?.rows ?? []) : [], [collection, plan])
  const summary = useMemo(() => planSummary(rows), [rows])

  const beginAdd = useCallback((at?: number) => {
    if (!plan) return
    const position = Math.max(0, Math.min(at ?? (selected === null ? plan.parts.length : selected + 1), plan.parts.length))
    setPreview(null)
    setComposer({ at: position, title: '', gloss: '', role: 'section' })
  }, [plan, selected])

  useEffect(() => {
    if (!composer) return
    requestAnimationFrame(() => titleRef.current?.focus())
  }, [composer])

  const startPlan = useCallback(async () => {
    if (plan) {
      beginAdd(0)
      return
    }
    setBusy(true)
    try {
      await window.writeflex.createCollectionIndex(dir)
      const next = await window.writeflex.plan.read(dir)
      setPlan(next)
      if (next) setComposer({ at: 0, title: '', gloss: '', role: 'section' })
    } catch (error) {
      onStatus(planActionFailure(error, 'Could not create the Index Note for this Plan. Check that the folder is writable, then try again.'))
    } finally {
      setBusy(false)
    }
  }, [beginAdd, dir, onStatus, plan])

  useEffect(() => {
    if (!startWithComposer || startedRef.current || plan === undefined) return
    startedRef.current = true
    if (plan) beginAdd(plan.parts.length)
    else void startPlan()
  }, [beginAdd, plan, startPlan, startWithComposer])

  const commitComposer = useCallback(async (materialise: boolean) => {
    if (!composer || !plan || busy) return
    const title = composer.title.trim()
    if (!title) {
      onStatus('Give this part a title, then press Return again.')
      titleRef.current?.focus()
      return
    }
    setBusy(true)
    try {
      const inserted = await window.writeflex.plan.insertPart(dir, composer.at, {
        title,
        ...(composer.gloss.trim() ? { gloss: composer.gloss.trim() } : {}),
        role: composer.role,
      })
      setPlan(inserted)
      setComposer(null)
      setSelected(composer.at)
      if (materialise) {
        const result = await window.writeflex.plan.materialisePart(dir, composer.at)
        setPlan(result.plan)
        onOpenPiece(result.path)
      }
    } catch (error) {
      onStatus(planActionFailure(error, 'Could not add that part. Check the title and try again; nothing else was changed.'))
    } finally {
      setBusy(false)
    }
  }, [busy, composer, dir, onOpenPiece, onStatus, plan])

  const moveSelected = useCallback(async (delta: -1 | 1) => {
    if (!plan || selected === null || busy) return
    const to = selected + delta
    if (to < 0 || to >= plan.parts.length) return
    setBusy(true)
    try {
      setPlan(await window.writeflex.plan.movePart(dir, selected, to))
      setSelected(to)
    } catch (error) {
      onStatus(planActionFailure(error, 'Could not move that part. Reload the Plan and try again.'))
    } finally {
      setBusy(false)
    }
  }, [busy, dir, onStatus, plan, selected])

  const moveByDrag = useCallback(async (to: number) => {
    if (dragged === null || dragged === to) return
    const from = dragged
    setDragged(null)
    setBusy(true)
    try {
      setPlan(await window.writeflex.plan.movePart(dir, from, to))
      setSelected(to)
    } catch (error) {
      onStatus(planActionFailure(error, 'Could not move that part. Reload the Plan and try again.'))
    } finally {
      setBusy(false)
    }
  }, [dir, dragged, onStatus])

  const openPart = useCallback(async (index: number) => {
    const part = plan?.parts[index]
    if (!part) return
    setSelected(index)
    if (part.path) {
      onOpenPiece(part.path)
      return
    }
    try {
      const target = materialisationPreview(plan, folio, index)
      const stub = await window.writeflex.collection.previewStub(target.stubInput)
      setPreview({ index, stub, manifestLine: target.manifestLine })
    } catch (error) {
      onStatus(planActionFailure(error, 'Could not prepare this part for writing. Reload the Plan and try again.'))
    }
  }, [folio, onOpenPiece, onStatus, plan])

  const materialise = useCallback(async () => {
    if (!preview || busy) return
    setBusy(true)
    try {
      const result = await window.writeflex.plan.materialisePart(dir, preview.index)
      setPlan(result.plan)
      setPreview(null)
      onOpenPiece(result.path)
    } catch (error) {
      onStatus(planActionFailure(error, 'Could not create that part. Check whether a file with the same title already exists, then try again.'))
    } finally {
      setBusy(false)
    }
  }, [busy, dir, onOpenPiece, onStatus, preview])

  const removeSelected = useCallback(async () => {
    const index = selected
    if (index === null || busy) return
    const part = plan?.parts[index]
    if (!part) return
    const confirmed = window.confirm(`Remove “${part.title}” from the Plan?\n\nThis removes the Plan line only. The file will not be deleted.`)
    if (!confirmed) return
    setBusy(true)
    try {
      const next = await window.writeflex.plan.removePart(dir, index)
      setPlan(next)
      setSelected(next.parts.length ? Math.min(index, next.parts.length - 1) : null)
    } catch (error) {
      onStatus(planActionFailure(error, 'Could not remove that Plan line. Reload the Plan and try again; no file was deleted.'))
    } finally {
      setBusy(false)
    }
  }, [busy, dir, onStatus, plan, selected])

  const adoptUnlisted = useCallback(async (index: number) => {
    if (!plan?.unlisted[index] || busy) return
    setBusy(true)
    try {
      const next = await window.writeflex.plan.adoptPart(dir, index)
      setPlan(next)
      setSelected(next.parts.length - 1)
      setSelectedUnlisted(next.unlisted.length ? Math.min(index, next.unlisted.length - 1) : null)
    } catch (error) {
      onStatus(planActionFailure(error, 'Could not add that existing part to the Plan. Reload the Plan and try again.'))
    } finally {
      setBusy(false)
    }
  }, [busy, dir, onStatus, plan])

  const runCommand = useCallback((command: PlanCommandName) => {
    if (composer) return
    if (command === 'add') beginAdd()
    else if (command === 'adopt' && selectedUnlisted !== null) void adoptUnlisted(selectedUnlisted)
    else if (command === 'move-up') void moveSelected(-1)
    else if (command === 'move-down') void moveSelected(1)
    else if (command === 'open-part' && selected !== null) void openPart(selected)
    else if (command === 'remove') void removeSelected()
  }, [adoptUnlisted, beginAdd, composer, moveSelected, openPart, removeSelected, selected, selectedUnlisted])

  useEffect(() => {
    const onCommand = (event: Event): void => runCommand((event as CustomEvent<PlanCommandName>).detail)
    window.addEventListener(PLAN_COMMAND_EVENT, onCommand)
    return () => window.removeEventListener(PLAN_COMMAND_EVENT, onCommand)
  }, [runCommand])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (shortcutCaptureActive.current) return
      const target = event.target
      const editing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)
      if (editing) return
      if (target instanceof Element && target.closest('.overlay.open')) return
      if (event.key === 'Escape') {
        if (preview) setPreview(null)
        else if (composer) setComposer(null)
        return
      }
      if (preview && event.key === 'Enter' && event.metaKey) {
        event.preventDefault()
        void materialise()
        return
      }
      if (preview) return
      const command = planCommandForEvent(event, shortcutOverrides)
      if (command) {
        event.preventDefault()
        runCommand(command)
        return
      }
      if (!event.metaKey && !event.altKey && !event.ctrlKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp') && rows.length) {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        setSelected((current) => Math.max(0, Math.min((current ?? 0) + delta, rows.length - 1)))
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [composer, materialise, preview, rows.length, runCommand, shortcutOverrides])

  if (plan === undefined) return <div className="plan plan-loading" aria-busy="true" />

  const composerNode = composer ? (
    <div className="compose" data-at={composer.at}>
      <input
        ref={titleRef}
        className="ct"
        value={composer.title}
        aria-label="Part title"
        placeholder="Part title"
        onChange={(event) => setComposer({ ...composer, title: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); setComposer(null) }
          else if (event.key === 'Enter') { event.preventDefault(); void commitComposer(event.shiftKey) }
        }}
      />
      <input
        className="cg"
        value={composer.gloss}
        aria-label="Part gloss"
        placeholder="A line of gloss"
        onChange={(event) => setComposer({ ...composer, gloss: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); setComposer(null) }
          else if (event.key === 'Enter') { event.preventDefault(); void commitComposer(event.shiftKey) }
        }}
      />
      <div className="cbar">
        <span className="cwhere">{composerPosition(plan?.parts ?? [], composer.at).ordinal} · {composerPosition(plan?.parts ?? [], composer.at).between}<br />recorded in <b>{plan?.indexPath.split('/').at(-1)}</b></span>
        <span className="roles">{ROLES.map((role) => <button type="button" key={role} className={composer.role === role ? 'on' : ''} onClick={() => setComposer({ ...composer, role })}>{role}</button>)}</span>
        <span className="compose-keys"><kbd>⏎</kbd><kbd>⇧⏎</kbd></span>
      </div>
    </div>
  ) : null

  return (
    <div className="plan">
      <PlanProjectionNav onOpenBoard={onOpenBoard} {...(onHelpWithReport ? { onHelpWithReport } : {})} />
      {manifestUnreadable && <FolioManifestWarning />}
      {plan && (rows.length > 0 || composer || plan.unlisted.length > 0) && <div className="plan-scroll"><div className="plan-inner">
        <div className="plan-kind"><Library />Folder · one document <span className="badge">Folio</span></div>
        <h1>{collection?.name ?? dir.split('/').at(-1) ?? 'Plan'}</h1>
        {collection?.cover?.text && <p className="cover">{collection.cover.text}</p>}
        {plan && <div className="plan-meta">
          {folio?.output && <span className="mchip"><BookOpenText />compiles to {folio.output}</span>}
          <span className="mchip">{pluralisedSummary(summary)}</span>
          {summary.words > 0 && <span className="mchip">{summary.words.toLocaleString('en-GB')} words</span>}
        </div>}

        {plan && rows.length > 0 && <>
          <div className="plan-bar"><h2>Running order</h2><button type="button" className="iconbtn primary" onClick={() => beginAdd()}><Plus />Add a part <kbd>N</kbd></button></div>
          <PlanPartList rows={rows} selected={selected} composer={composerNode} composerAt={composer?.at} onSelect={setSelected} onOpen={(index) => void openPart(index)} onDragStart={setDragged} onDrop={(index) => void moveByDrag(index)} />
        </>}
        {plan && rows.length === 0 && plan.unlisted.length > 0 && <>
          <div className="plan-bar"><h2>Running order</h2><button type="button" className="iconbtn primary" onClick={() => beginAdd(0)}><Plus />Add a part <kbd>N</kbd></button></div>
          <p className="unlisted-note">Nothing is in the running order yet.</p>
        </>}
        {plan && plan.unlisted.length > 0 && <PlanUnlistedList
          parts={plan.unlisted}
          selected={selectedUnlisted}
          onSelect={setSelectedUnlisted}
          onAdopt={(index) => void adoptUnlisted(index)}
        />}
      </div></div>}

      {!plan && <PlanEmptyState kind="absent" onStart={() => { if (!busy) void startPlan() }} />}
      {plan && rows.length === 0 && plan.unlisted.length === 0 && !composer && <PlanEmptyState kind="empty" onStart={() => beginAdd(0)} />}
      {plan && rows.length === 0 && composer && <div className="plan-first-composer">{composerNode}</div>}

      <div className="plan-foot">
        {composer ? <><span className="kb"><kbd>⏎</kbd> record the part</span><span className="kb"><kbd>⇧⏎</kbd> create the file now</span><span className="kb"><kbd>esc</kbd> cancel</span></>
          : <><span className="kb"><kbd>N</kbd> add a part</span><span className="kb"><kbd>⏎</kbd> {selected !== null && rows[selected]?.written ? 'open' : 'start writing'}</span><span className="kb"><kbd>⌥↑↓</kbd> reorder</span></>}
        <span className="right">{plan ? `Plan lives in ${plan.indexPath.split('/').at(-1)}` : 'No Plan yet'}</span>
      </div>

      {preview && <div className="materialise-layer plan-materialise-layer">
        <section className="idea-pop">
          <div className="ip-head"><Lightbulb /><span className="ip-t">Part {preview.index + 1} — not written yet</span><span className="ip-tag">{plan?.parts[preview.index]?.role}</span></div>
          <h2 className="ip-title">{plan?.parts[preview.index]?.title}</h2>
          <p className="ip-sub">Creates the file and adds it to the Folio at position {preview.index + 1}. The rest of the running order is untouched.</p>
          <div className="ip-act"><button type="button" className="btn idea-action" onClick={() => void materialise()}><FilePlus2 />Write this part <kbd>⌘↵</kbd></button><button type="button" className="btn" onClick={() => setPreview(null)}><X />Dismiss</button></div>
        </section>
        <aside className="stub-pane">
          <div className="stub-head"><div className="sh-k"><FilePlus2 />Will create · {preview.stub.path}</div><h3>Two files change</h3></div>
          <div className="stub-body"><div className="lbl">the new part</div><pre>{preview.stub.content}</pre><div className="lbl">_report-structure.json</div><pre>{`  "files": [\n    …\n    ${preview.manifestLine}\n    …\n  ]`}</pre></div>
          <div className="stub-foot"><button type="button" className="btn idea-action" onClick={() => void materialise()}><FilePlus2 />Write this part</button></div>
        </aside>
      </div>}
    </div>
  )
}
