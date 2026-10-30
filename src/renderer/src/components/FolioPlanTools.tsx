import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDownAZ, FilePlus2, Heading, ListPlus, X, Lightbulb } from 'lucide-react'
import type { Folio, Plan, StubPreview, TitleFixDirection } from '../../../preload'
import type { FolioRunningOrder } from '../app/folio-running-order'
import { useTitleConflictContext, type TitleFixTarget } from '../app/title-conflict-actions'
import { HANDOVER_PART_GONE, type PlanCommandName } from '../plan/plan-commands'
import { dispatchSidebar } from '../plan/folio-sidebar'
import { addAllCandidates } from '../../../shared/folio-add-all'
import { TITLE_PAGE_SET_IN_MANIFEST, isFrontMatterRole } from '../../../shared/folio-front-matter'
import { buildPlanRows, materialisationPreview } from '../plan/plan-view-model'
import { type FolioAgentPillHandle, FolioAgentInstructionsPill } from './FolioAgentInstructions'
import { type FolioDetailsCardHandle, FolioDetailsCard } from './FolioDetailsCard'
import { FolioFrontMatterSlot, type FrontMatterOffer } from './FolioRail'
import { PlanAddAllSheet } from './PlanAddAllSheet'
import { PartHeadingControl, PartRoleControl, planActionFailure, titleFixTargetOf, titleFixUnavailable } from './PlanView'

/**
 * What the Folio page did that the workspace's other surfaces do not (ADR-0049, spec folio-workspace § 4), moved here as
 * it was and drawn in its new homes:
 *   - the Outline tab's toolbar: Add all from this folder, Sort by chapter number, Use headings as titles for all;
 *   - the part inspector: the part's role, its heading choice and title fix, and a preview of the file a planned part
 *     would start (the Folio page's "Write this part" pane);
 *   - the Folio inspector (the title row selected): Details, and front matter with Choose a file;
 *   - Add to outline for a file under Not in the outline.
 * Every write is the page's own call (`plan.*`, the running-order writer, the title-conflict actions), so each keeps its
 * check against a stale view and its one Undo step. The Plan is read here only while a surface that needs it is on
 * screen (`active`), again after each of the room's reads.
 */
export type FolioPlanTools = {
  indexPath: string | null
  /** Buttons for the Outline tab's toolbar (null when none apply). */
  toolbar: ReactNode
  /** Sheets and panes the tools open over the workspace (Add all, the start preview). */
  overlays: ReactNode
  /** The Folio's own details and front matter, for the inspector with the title row selected. */
  folioInspector: ReactNode
  /** Role, heading and start-preview controls for the part at running-order `index`. */
  partExtras: (index: number) => ReactNode
  /** The files under Not in the outline, as the Folio page listed them (refusal, front matter offer and heading choice included); null until the Plan is read. */
  unlisted: Plan['unlisted'] | null
  /** The heading choice of a file (the page's own control). */
  chooseHeading: (path: string, mode: 'own' | 'none') => void
  /** Add the file at `path` (under Not in the outline) to the running order. */
  adopt: (path: string, asFrontMatter?: boolean) => void
  runCommand: (command: PlanCommandName, key: { title: string; path: string | null } | null, loosePath: string | null) => void
}

export function useFolioPlanTools({ dir, active, model, runningOrder, onStatus, onOpenPiece, onLeave, onSelectPart }: {
  dir: string
  active: boolean
  /** Changes with every read of the room: the Plan is read again after it. */
  model: unknown
  runningOrder?: Pick<FolioRunningOrder, 'write' | 'sortPlan' | 'addToPlan' | 'removeToBin'>
  onStatus: (message: string) => void
  onSelectPart: (index: number) => void
  onLeave: () => void
  onOpenPiece: (path: string) => void
}): FolioPlanTools {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [busy, setBusy] = useState(false)
  const [addAllOpen, setAddAllOpen] = useState(false)
  const [preview, setPreview] = useState<{ index: number; stub: StubPreview; manifestLine: string } | null>(null)
  const [chooseFrontOpen, setChooseFrontOpen] = useState(false)
  const titleActions = useTitleConflictContext()
  const addAllButton = useRef<HTMLButtonElement>(null)
  const detailsRef = useRef<FolioDetailsCardHandle>(null)
  const agentRef = useRef<FolioAgentPillHandle>(null)
  const partRef = useRef<HTMLDivElement>(null)
  const [pendingFocus, setPendingFocus] = useState<PlanCommandName | null>(null)
  const loaded = useRef(dir)
  loaded.current = dir

  const reload = useCallback(async (): Promise<Plan | null> => {
    const asked = dir
    try {
      const next = await window.writeflex.plan.read(dir)
      if (loaded.current === asked) setPlan(next)
      return next
    } catch { return null }
  }, [dir])
  useEffect(() => { if (active) void reload() }, [active, reload, model])
  useEffect(() => { setPlan(null); setPreview(null); setAddAllOpen(false) }, [dir])

  const seen = useCallback((from: Plan) => from.parts.map((part) => ({ title: part.title, path: part.path })), [])
  const frontFlags = useCallback((from: Plan) => from.parts.map((part) => isFrontMatterRole(part.role)), [])
  const rows = useMemo(() => (plan ? buildPlanRows(plan, []) : []), [plan])
  const writtenRows = rows.filter((row) => row.written).length
  const addAllRows = useMemo(() => addAllCandidates(plan?.unlisted ?? []), [plan])
  const titleConflicts = useMemo(() => {
    const found = new Map<string, TitleFixTarget>()
    for (const part of plan?.parts ?? []) {
      const target = titleFixTargetOf(part)
      if (target && !found.has(target.path)) found.set(target.path, target)
    }
    return [...found.values()]
  }, [plan])

  const run = useCallback(async (work: () => Promise<unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try { await work() } finally { setBusy(false); await reload() }
  }, [busy, reload])

  const sortByChapter = (): void => { if (runningOrder && plan) void run(() => runningOrder.sortPlan(dir, seen(plan), frontFlags(plan))) }
  const openAddAll = (): void => {
    if (addAllRows.length === 0) { onStatus('Every file in this folder that can join the running order is already in it.'); return }
    setAddAllOpen(true)
  }
  const closeAddAll = (): void => { setAddAllOpen(false); requestAnimationFrame(() => { if (addAllButton.current?.isConnected) addAllButton.current.focus() }) }
  const fixAll = (direction: TitleFixDirection): void => { if (titleActions) void run(() => titleActions.fixAll(dir, titleConflicts, direction)) }
  const fixOne = (target: TitleFixTarget, direction: TitleFixDirection): void => { if (titleActions) void run(() => titleActions.fixPart(dir, target, direction)) }
  const chooseHeading = (path: string, mode: 'own' | 'none'): void => {
    void run(async () => {
      try { await window.writeflex.plan.setHeadingMode(dir, path, mode) } catch (error) { onStatus(planActionFailure(error, 'Could not change that part’s heading choice. Nothing was changed.')) }
    })
  }
  const [roleUndo, setRoleUndo] = useState<{ token: string; title: string } | null>(null)
  const chooseRole = (index: number, role: string): void => {
    const part = plan?.parts[index]
    if (!part) return
    void run(async () => {
      try { const next = await window.writeflex.plan.setPartRole(dir, index, role, { title: part.title, path: part.path, gloss: part.gloss, role: part.role, tags: [...part.tags] }); setRoleUndo(next.sectionRoleUndoToken ? { token: next.sectionRoleUndoToken, title: part.title } : null) }
      catch (error) { onStatus(planActionFailure(error, 'Could not change that part’s role. Nothing was changed.')) }
    })
  }
  const adoptAt = (index: number, asFrontMatter = false): void => {
    const row = plan?.unlisted[index]
    if (!row?.path) return
    const path = row.path
    void run(async () => {
      try { await window.writeflex.plan.adoptPart(dir, index, { title: row.title, path }, asFrontMatter) }
      catch (error) { onStatus(planActionFailure(error, 'Could not add that existing part to the Folio outline. Reload the Folio and try again.')) }
    })
  }
  const adopt = (path: string, asFrontMatter = false): void => {
    void (async () => {
      const current = plan ?? await reload()
      const at = current?.unlisted.findIndex((row) => row.path === path) ?? -1
      if (current && at >= 0) {
        if (!plan) setPlan(current)
        try { await window.writeflex.plan.adoptPart(dir, at, { title: current.unlisted[at].title, path }, asFrontMatter); await reload() }
        catch (error) { onStatus(planActionFailure(error, 'Could not add that existing part to the Folio outline. Reload the Folio and try again.')) }
      } else onStatus('That file is no longer under Not in the outline.')
    })()
  }
  const startPreview = (index: number, from?: Plan): void => {
    void (async () => {
      const asked = dir
      const current = from ?? plan ?? await reload()
      if (!current || loaded.current !== asked) return
      try {
        const folio: Folio | null = await window.writeflex.readFolio(dir)
        const target = materialisationPreview(current, folio, index)
        const stub = await window.writeflex.collection.previewStub(target.stubInput)
        if (loaded.current !== asked) return
        setPreview({ index, stub, manifestLine: target.manifestLine })
      } catch (error) { onStatus(planActionFailure(error, 'Could not prepare this part for writing. Reload the Folio and try again.')) }
    })()
  }
  const materialise = (): void => {
    if (!preview) return
    const at = preview.index
    void run(async () => {
      try {
        const result = await window.writeflex.plan.materialisePart(dir, at)
        setPreview(null)
        onOpenPiece(result.path)
      } catch (error) { onStatus(planActionFailure(error, 'Could not create that part. Check whether a file with the same title already exists, then try again.')) }
    })
  }

  const frontRows = useMemo(() => rows.filter((row) => row.frontMatter === true), [rows])
  const frontOffers = useMemo((): FrontMatterOffer[] => (plan?.unlisted ?? []).flatMap((part, index) => (part.frontMatterOffer && part.path ? [{ index, title: part.heading?.title ?? part.title, path: part.path, refusal: part.putBackRefusal ?? null }] : [])), [plan])

  useEffect(() => {
    if (!pendingFocus || !plan) return
    const frame = requestAnimationFrame(() => {
      if (pendingFocus === 'details') detailsRef.current?.focus()
      else if (pendingFocus === 'role') partRef.current?.querySelector<HTMLSelectElement>('.part-role select')?.focus()
      else if (pendingFocus === 'agents-both') agentRef.current?.run('both')
      else if (pendingFocus === 'agents-agents') agentRef.current?.run('agents')
      else if (pendingFocus === 'agents-claude') agentRef.current?.run('claude')
      setPendingFocus(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [pendingFocus, plan])

  const runCommand: FolioPlanTools['runCommand'] = (command, key, loosePath): void => {
    void (async () => {
      const current = await reload()
      if (!current || loaded.current !== dir) return
      const at = key ? current.parts.findIndex(part => part.title === key.title && part.path === key.path) : -1
      if (key && at < 0) { onStatus(HANDOVER_PART_GONE); return }
      if (command === 'title-heading-to-title' || command === 'title-title-to-heading') {
        const part = current.parts[at]
        const target = part ? titleFixTargetOf(part) : null
        if (target) fixOne(target, command === 'title-heading-to-title' ? 'heading-to-title' : 'title-to-heading')
        else onStatus(part ? titleFixUnavailable(part) : 'Select a part first.')
      } else if (command === 'titles-heading-to-title' || command === 'titles-title-to-heading') {
        const targets = [...new Map(current.parts.flatMap(part => { const target = titleFixTargetOf(part); return target ? [[target.path, target] as const] : [] })).values()]
        if (targets.length < 2) onStatus(targets.length === 1 ? 'Only one part has a title that differs from its heading. Select it and choose a fix.' : 'Every part’s title matches its heading.')
        else if (titleActions) void run(() => titleActions.fixAll(dir, targets, command === 'titles-heading-to-title' ? 'heading-to-title' : 'title-to-heading'))
      } else if (command === 'open-part') {
        if (at >= 0) startPreview(at, current)
      } else if (command === 'add-all') {
        if (addAllCandidates(current.unlisted).length) setAddAllOpen(true)
        else onStatus('Every file in this folder that can join the running order is already in it.')
      } else if (command === 'sort') {
        if (runningOrder) void run(() => runningOrder.sortPlan(dir, seen(current), frontFlags(current)))
      } else if (command === 'adopt' || command === 'adopt-front-matter') {
        const index = current.unlisted.findIndex(part => part.path === loosePath)
        if (index < 0) { onStatus('Select a file under Not in the outline first.'); return }
        const part = current.unlisted[index]
        void run(async () => {
          try { await window.writeflex.plan.adoptPart(dir, index, { title: part.title, path: part.path! }, command === 'adopt-front-matter') }
          catch (error) { onStatus(planActionFailure(error, 'Could not add that existing part to the Folio outline.')) }
        })
      } else if (command === 'front-matter-choose') {
        dispatchSidebar('select-title-row')
        if (current.unlisted.some(part => part.frontMatterOffer && part.path)) setChooseFrontOpen(true)
        else onStatus('No file under Not in the outline can be front matter yet. Give a part the Front matter role, or add a title page to the folder.')
      } else {
        if (command === 'role') { dispatchSidebar('select-part'); dispatchSidebar('show-inspector') }
        else dispatchSidebar('select-title-row')
        setPendingFocus(command)
      }
    })()
  }

  const toolbar = (
    <>
      {runningOrder && addAllRows.length > 0 && <button type="button" ref={addAllButton} className="fr-tb" data-plan-add-all="true" disabled={busy} onClick={openAddAll}><ListPlus aria-hidden="true" />Add all from this folder</button>}
      {runningOrder && writtenRows > 1 && <button type="button" className="fr-tb" data-plan-sort="true" disabled={busy} onClick={sortByChapter}><ArrowDownAZ aria-hidden="true" />Sort by chapter number</button>}
      {titleActions && titleConflicts.length >= 2 && (['heading-to-title', 'title-to-heading'] as const).map((direction) => (
        <button key={direction} type="button" className="fr-tb" data-plan-title-fix-all={direction} disabled={busy} onClick={() => fixAll(direction)}>
          <Heading aria-hidden="true" />{direction === 'heading-to-title' ? `Use headings as titles for all ${titleConflicts.length}` : `Use titles as headings for all ${titleConflicts.length}`}
        </button>
      ))}
    </>
  )

  const overlays = (
    <>
      {addAllOpen && runningOrder && <PlanAddAllSheet folderName={dir.split('/').at(-1) || 'this folder'} candidates={addAllRows} busy={busy} onClose={closeAddAll}
        onAdd={(chosen) => { if (plan) void run(async () => { if (await runningOrder.addToPlan(dir, seen(plan), chosen)) closeAddAll() }) }} />}
      {preview && plan && <div className="materialise-layer plan-materialise-layer">
        <section className="idea-pop">
          <div className="ip-head"><Lightbulb /><span className="ip-t">Part {preview.index + 1} — not written yet</span><span className="ip-tag">{plan.parts[preview.index]?.role}</span></div>
          <h2 className="ip-title">{plan.parts[preview.index]?.title}</h2>
          <p className="ip-sub">Creates the file and adds it to the Folio at position {preview.index + 1}. The rest of the running order is untouched.</p>
          <div className="ip-act"><button type="button" className="btn idea-action" onClick={materialise}><FilePlus2 />Write this part</button><button type="button" className="btn" onClick={() => setPreview(null)}><X />Dismiss</button></div>
        </section>
        <aside className="stub-pane">
          <div className="stub-head"><div className="sh-k"><FilePlus2 />Will create · {preview.stub.path}</div><h3>Two files change</h3></div>
          <div className="stub-body"><div className="lbl">the new part</div><pre>{preview.stub.content}</pre><div className="lbl">_report-structure.json</div><pre>{`  "files": [\n    …\n    ${preview.manifestLine}\n    …\n  ]`}</pre></div>
        </aside>
      </div>}
    </>
  )

  const folioInspector = (
    <div className="fr-folio-insp" data-testid="folio-inspector">
      <FolioAgentInstructionsPill ref={agentRef} dir={dir} onOpenPiece={onOpenPiece} onStatus={onStatus} />
      <FolioDetailsCard ref={detailsRef} dir={dir} onLeave={onLeave} onStatus={onStatus} {...(runningOrder ? { write: runningOrder.write } : {})} />
      <FolioFrontMatterSlot rows={frontRows} selected={null} offers={frontOffers} busy={busy} menuOpen={chooseFrontOpen} onMenuOpen={setChooseFrontOpen}
        onSelect={onSelectPart} takeOutDescription="Take this out of the Folio outline and move its file to the Folio bin" onChoose={(offer) => adoptAt(offer.index, true)}
        onTakeOut={(index) => { const part = plan?.parts[index]; if (part && runningOrder) void run(() => runningOrder.removeToBin(dir, [index], plan!.parts.map((item) => ({ title: item.title, path: item.path, gloss: item.gloss, role: item.role, tags: [...item.tags] })))) }} />
    </div>
  )

  const partExtras = (index: number): ReactNode => {
    const part = plan?.parts[index]
    if (!part) return null
    const row = rows[index]
    return (
      <div ref={partRef} className="fr-part-tools" data-testid="part-tools">
        <PartRoleControl title={part.title} role={part.sectionPage && !isFrontMatterRole(part.role) ? 'section-page' : part.role} onChoose={(role) => chooseRole(index, role)} lockedReason={row?.manifestTitlePage ? TITLE_PAGE_SET_IN_MANIFEST : undefined} />
        {roleUndo && <button type="button" className="fr-btn" onClick={() => void run(async () => { const answer = await window.writeflex.folioRoom.author(dir, { op: 'undo', token: roleUndo.token }); if (answer.ok) setRoleUndo(null); else onStatus(answer.message) })}>Undo role change for {roleUndo.title}</button>}
        {part.path !== null && <PartHeadingControl part={part} onChoose={chooseHeading} {...(titleActions ? { onFixTitle: fixOne } : {})} />}
        {part.path === null && <button type="button" className="fr-btn" data-action="preview-start" disabled={busy} onClick={() => startPreview(index)}>Preview the file this part would start</button>}
      </div>
    )
  }

  return { indexPath: plan?.indexPath ?? null, toolbar, overlays, folioInspector, partExtras, unlisted: plan?.unlisted ?? null, chooseHeading, adopt, runCommand }
}
