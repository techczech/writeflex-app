import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDownAZ, BookOpen, BookOpenText, ChevronDown, Columns3, CornerDownRight, FilePlus2, FileText, Heading, Lightbulb, ListOrdered, ListPlus, ListTree, Plus, TriangleAlert, X } from 'lucide-react'
import type { Collection, Folio, Plan, StubPreview } from '../../../preload'
import { continuesChip, folioOutlineFlow, type HeadingFlow } from '../../../shared/folio-heading-flow'
import { MANIFEST_NAME } from '../../../shared/folio-constants'
import { PLAN_ROLES } from '../../../shared/plan-line'
import { FRONT_MATTER_STAYS_LEADING, TITLE_PAGE_SET_IN_MANIFEST, isFrontMatterRole, moveStaysInBlock, placeInOrder, roleLabel } from '../../../shared/folio-front-matter'
import { shortcutCaptureActive, type OverrideMap } from '../commands/chords'
import { humanReadableError } from '../error-text'
import { FolioAgentInstructionsPill, type FolioAgentPillHandle } from './FolioAgentInstructions'
import { FolioFrontMatterSlot, FolioSelectedPanel, type FrontMatterOffer } from './FolioRail'
import { FolioDetailsCard, type FolioDetailsCardHandle } from './FolioDetailsCard'
import { PlanAddAllSheet } from './PlanAddAllSheet'
import type { FolioRunningOrder } from '../app/folio-running-order'
import { addAllCandidates, type AddAllCandidate } from '../../../shared/folio-add-all'
import { HANDOVER_PART_GONE, PLAN_COMMAND_EVENT, handoverStep, type PendingPlanCommand, type PlanCommandName } from '../plan/plan-commands'
import { TITLE_FIX_LABEL, titleConflictSentence } from '../../../shared/title-conflict'
import { useTitleConflictContext, type TitleFixTarget } from '../app/title-conflict-actions'
import type { TitleFixDirection } from '../../../preload'
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

const ROLES = PLAN_ROLES

const STAGE_CLASS = {
  idea: 'idea',
  jottings: 'jot',
  'partial draft': 'partial',
  'rough draft': 'rough',
  'final draft': 'final',
  published: 'pub',
} as const

const PLAN_READ_FAILED = 'Could not read this Folio outline. Close and reopen the folder, then try again.'

type ComposerState = { at: number; title: string; gloss: string; role: typeof ROLES[number] }
type PreviewState = { index: number; stub: StubPreview; manifestLine: string }

export type PlanViewProps = {
  headerActions?: ReactNode
  createActions?: ReactNode
  onOpenList?: () => void
  dir: string
  onOpenPiece: (path: string) => void
  onStatus: (message: string) => void
  onOpenBoard: () => void
  shortcutOverrides?: OverrideMap
  startWithComposer?: boolean
  /** A command handed over from the room: run once, on this part, as soon as the Plan has been read. */
  pendingCommand?: PendingPlanCommand | null
  /** Told (with the hand-over's number) that it has been taken, so the owner clears it. */
  onPendingCommandRun?: (seq: number) => void
  manifestUnreadable?: boolean
  /** Start the report skill on this Plan's folder (ticket 10). Absent: no button. */
  onHelpWithReport?: () => void
  /** The running-order writer with its one Undo step; absent: Add all and Sort are not offered. */
  runningOrder?: FolioRunningOrder
  /** The Open Folio button, drawn in the page's header strip beside the agent instructions pill (2026-10-19 redesign). */
  openFolio?: ReactNode
}

/** A Plan part whose title and heading disagree, as the title-conflict buttons name it; null when they agree. */
export function titleFixTargetOf(part: Pick<Plan['parts'][number], 'path' | 'heading'>): TitleFixTarget | null {
  return part.path && part.heading?.mismatch && part.heading.fingerprint ? { path: part.path, fingerprint: part.heading.fingerprint } : null
}

/**
 * Why the Plan offers no title fix for a part. A part that does not open with a heading is left to the waiting
 * "Add the heading" change (folio-part-proposals.ts), as in the open part: a second way to insert the same
 * heading would leave that change behind to add it twice.
 */
export function titleFixUnavailable(part: Pick<Plan['parts'][number], 'heading'>): string {
  const heading = part.heading
  if (heading?.frontMatter) return 'This part is front matter: its title comes from its frontmatter and it has no heading, so there is nothing to match.'
  if (heading?.mode === 'missing') return 'This part does not start with a heading. The change that adds its title as the heading is waiting in the Changes.'
  if (heading?.mode === 'none') return 'This part has no heading in the text, so there is nothing to match.'
  return 'The selected part’s title and heading already match.'
}

/** The part's heading line: a flag when its title and heading disagree (with the two fixes) or it has no heading, and the choice per part. */
export function PartHeadingControl({ part, onChoose, onFixTitle }: { part: Pick<Plan['parts'][number], 'path' | 'title' | 'heading'>; onChoose?: (path: string, mode: 'own' | 'none') => void; onFixTitle?: (target: TitleFixTarget, direction: TitleFixDirection) => void }): JSX.Element | null {
  const heading = part.heading
  if (!heading || !part.path) return null
  const path = part.path
  const flag = heading.mismatch
    ? titleConflictSentence({ title: heading.frontmatterTitle ?? '', heading: heading.headingText ?? '' })
    : heading.mode === 'missing' && !heading.frontMatter ? 'No heading in the text. A change that adds one is waiting in the Changes.' : null
  const target = titleFixTargetOf(part)
  return (
    <div className="part-heading" data-heading-mode={heading.mode}>
      {flag && <span className="hint plan-heading-flag" data-plan-flag={heading.mismatch ? 'title-differs' : 'no-heading'}><TriangleAlert className="icon sm" />{flag}</span>}
      {target && onFixTitle && (
        <span className="ph-title-fix" role="group" aria-label={`Make the title and the heading of ${heading.title} match`}>
          {(['heading-to-title', 'title-to-heading'] as const).map((direction) => (
            <button key={direction} type="button" data-plan-title-fix={direction} onClick={() => onFixTitle(target, direction)}>{TITLE_FIX_LABEL[direction]}</button>
          ))}
        </span>
      )}
      {onChoose && (
        <span className="ph-choice" role="group" aria-label={`Heading for ${heading.title}`}>
          <button type="button" aria-pressed={heading.mode !== 'none'} onClick={() => { if (heading.mode === 'none') onChoose(path, 'own') }}>Has its own heading</button>
          <button type="button" aria-pressed={heading.mode === 'none'} onClick={() => { if (heading.mode !== 'none') onChoose(path, 'none') }}>No heading in the text</button>
        </span>
      )}
    </div>
  )
}

/**
 * The part's role as a native menu beside its card (a button card cannot hold a select). Arrow keys or typing change it.
 * `lockedReason`: the menu is off, and says why (the manifest's title page stays front matter, ADR-0046).
 */
export function PartRoleControl({ title, role, onChoose, lockedReason, continues }: { title: string; role: string; onChoose: (role: string) => void; lockedReason?: string; /** "continues N · Chapter": the part nests under the chapter before it (the heading flow, ADR-0046). */ continues?: string | null }): JSX.Element {
  return (
    <label className="part-role" data-plan-role={role} data-plan-role-locked={lockedReason ? 'true' : undefined} title={lockedReason}>
      <span>Role</span>
      <select aria-label={`Role of ${title}`} aria-description={lockedReason} value={role} disabled={Boolean(lockedReason)} onChange={(event) => onChoose(event.target.value)}>
        <option value="section-page">Section page</option>
        {ROLES.map((name) => <option key={name} value={name}>{roleLabel(name)}</option>)}
      </select>
      <small className="part-role-description">Starts a section: every part after it belongs here until the next section page.</small>
      {continues && <span className="plan-continues-chip" data-plan-continues="true" title="Opens deeper than the chapter level, so it continues the chapter before it"><CornerDownRight />{continues}</span>}
    </label>
  )
}

export type PlanPartListProps = {
  rows: PlanDisplayRow[]
  selected: number | null
  composer: ReactNode
  /** The running-order index the composer is shown before (the end of this list: `endIndex`). */
  composerAt?: number | null
  /** The running-order index just after this list's last part; absent: the number of rows. */
  endIndex?: number
  /** The list's accessible name. */
  label?: string
  /** The running-order index of the front-matter title page that is the export's cover, if any. */
  coverIndex?: number | null
  onSelect: (index: number) => void
  onOpen: (index: number) => void
  onDragStart: (index: number) => void
  onDrop: (index: number) => void
  /** The "continues N · Chapter" chip per part path (the heading flow, ADR-0046). */
  chips?: ReadonlyMap<string, string>
  /** Each part's headings below its own title, as the card's tree (2026-10-19 redesign, element 4); by part path. */
  trees?: ReadonlyMap<string, ReadonlyArray<{ text: string; depth: number }>>
}

export type PlanUnlistedListProps = {
  parts: Plan['unlisted']
  selected?: number | null
  onSelect?: (index: number) => void
  onAdopt: (index: number) => void
  /** "Add as front matter" for a row offered as front matter (ADR-0046); absent: not offered. */
  onAdoptFrontMatter?: (index: number) => void
  onOpenFile?: (path: string) => void
  onHeadingMode?: (path: string, mode: 'own' | 'none') => void
  /** Element 5, option A: the section can be closed. `onToggle` absent: it is always open. */
  closed?: boolean
  onToggle?: () => void
}

function wordsLabel(words: number): string {
  return `${words.toLocaleString('en-GB')} ${words === 1 ? 'word' : 'words'}`
}

export function FolioManifestWarning(): JSX.Element {
  return (
    <span className="hint plan-manifest-warning">
      <TriangleAlert className="icon sm" />
      Folio manifest unreadable. Fix or move {MANIFEST_NAME} before changing this Folio. Folio outline edits cannot reach the compiled report until it is fixed.
    </span>
  )
}

/**
 * Whether the Plan's capture-phase shortcuts leave a key to the focused control: a text field, a text area,
 * a select (the role menu keeps its own Arrow, Enter and Space) or editable text. Duck-typed on `tagName`.
 */
export function planKeysYieldTo(target: EventTarget | null): boolean {
  const element = target as { tagName?: unknown; isContentEditable?: unknown } | null
  if (!element || typeof element.tagName !== 'string') return false
  return /^(?:INPUT|TEXTAREA|SELECT)$/i.test(element.tagName) || element.isContentEditable === true
}

export function planActionFailure(error: unknown, fallback: string): string {
  const message = humanReadableError(error, fallback)
  return /nothing else was changed/i.test(message) ? message : `${message} Nothing else was changed.`
}

/** A card's flag when the part's title and heading disagree or it has no heading; the buttons that fix it are in the side rail. */
function cardFlag(row: PlanDisplayRow): string | null {
  if (row.resolution) return row.resolution === 'missing' ? 'Missing file' : 'Ambiguous link'
  const heading = row.heading
  if (!heading) return null
  if (heading.mismatch) return 'title differs from heading'
  return heading.mode === 'missing' && !heading.frontMatter ? 'no heading in the text' : null
}

/**
 * The running order as cards (2026-10-19 redesign, element 4, option B): number, title, role and words, the gloss and
 * the part's headings as a tree. Role, file, length and the heading switch of the selected part are in the side rail
 * (FolioSelectedPanel); a front-matter part is a Cover band (element 3, option B).
 */
export function PlanPartList({ rows, selected, composer, composerAt = null, endIndex, label = 'Running order', coverIndex = null, onSelect, onOpen, onDragStart, onDrop, chips, trees }: PlanPartListProps): JSX.Element {
  const end = endIndex ?? rows.length
  return (
    <div className="parts" role="listbox" aria-label={label}>
      {rows.map((row, position) => {
        const index = row.index ?? position
        const stageClass = row.stage ? STAGE_CLASS[row.stage] : 'idea'
        const tree = row.path ? trees?.get(row.path) ?? [] : []
        const chip = row.path ? chips?.get(row.path) ?? null : null
        const flag = cardFlag(row)
        const isCover = row.frontMatter && index === coverIndex
        return (
          <div key={`${row.title}-${row.line}`} data-plan-front={row.frontMatter ? 'true' : undefined}>
            {composer && index === composerAt ? composer : null}
            <button
              type="button"
              role="option"
              aria-selected={selected === index}
              className={`part s-${stageClass}${row.written ? '' : ' unwritten'}${selected === index ? ' sel' : ''}`}
              data-plan-band={row.frontMatter ? 'true' : undefined}
              draggable
              onDragStart={() => onDragStart(index)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => { event.preventDefault(); onDrop(index) }}
              onFocus={() => onSelect(index)}
              onClick={() => onSelect(index)}
              onDoubleClick={() => onOpen(index)}
            >
              <span className="rule" />
              <span className="num">{row.frontMatter ? <BookOpen className="icon sm" aria-label="Front matter" /> : row.number}</span>
              <span className="body">
                <span className="phead">
                  {row.frontMatter && <span className="band-k">{isCover ? 'Cover' : 'Front matter'}</span>}
                  <span className="ptitle">{!row.written && <Lightbulb className="idea-mark" />}{row.title}</span>
                  {row.frontMatter
                    ? <span className="pmeta">
                      {isCover && <span className="role plan-front-tag plan-cover-tag" data-plan-cover="true">the export’s cover</span>}
                      <span className="role plan-front-tag" data-plan-not-in-contents="true">not in the contents</span>
                    </span>
                    : <span className="pmeta"><span className="role">{roleLabel(row.role)}</span>{row.words !== null && <span className="words"> · {wordsLabel(row.words)}</span>}</span>}
                </span>
                {!row.frontMatter && <span className="pgloss">{row.gloss || '— no gloss yet'}</span>}
                {tree.length > 0 && !row.frontMatter && (
                  <span className="ptree" data-plan-tree={row.path ?? undefined}>
                    {tree.map((node, at) => <span key={`${at}:${node.text}`} className="pnode" style={{ marginLeft: Math.max(node.depth - 1, 0) * 14 }}>{node.text}</span>)}
                  </span>
                )}
                {!row.frontMatter && (
                  <span className="pfoot">
                    {row.written && row.stage ? (
                      <span className={`stage ${STAGE_CLASS[row.stage]}`}><span className="sd" />{row.stage}</span>
                    ) : !row.written ? <span className="unw">{row.resolution ? (row.resolution === 'missing' ? 'Missing file' : 'Ambiguous link') : 'not written'}</span> : null}
                    {chip && <span className="plan-continues-chip" data-plan-continues="true" title="Opens deeper than the chapter level, so it continues the chapter before it"><CornerDownRight />{chip}</span>}
                    {flag && <span className="hint plan-card-flag" data-plan-card-flag={row.heading?.mismatch ? 'title-differs' : 'no-heading'}><TriangleAlert className="icon sm" />{flag}</span>}
                  </span>
                )}
              </span>
            </button>
          </div>
        )
      })}
      {composer && end === composerAt ? composer : null}
    </div>
  )
}

export function PlanUnlistedList({ parts, selected = null, onSelect = () => {}, onAdopt, onAdoptFrontMatter, onOpenFile, onHeadingMode, closed = false, onToggle }: PlanUnlistedListProps): JSX.Element {
  return (
    <section className="unlisted-parts" aria-label="Not in the outline">
      <div className="unlisted-group" data-plan-not-in-outline="true">
        <div className="plan-bar">
          {onToggle && <button type="button" className="unlisted-toggle" data-plan-unlisted-toggle="true" aria-expanded={!closed} aria-label={closed ? `Show the ${parts.length} files not in the outline` : 'Close the list of files not in the outline'} onClick={onToggle}><ChevronDown aria-hidden="true" /></button>}
          <h2>Not in the outline · {parts.length}</h2>
        </div>
        {!closed && <p className="unlisted-note">Markdown files in this Folio that are not in the running order. Putting one back never changes the file.</p>}
        {!closed && <div className="parts">
        {parts.map((part, index) => (
          <div className={`part unlisted-part${selected === index ? ' sel' : ''}`} key={`${part.path}-${index}`}>
            <span className="rule" />
            <span className="body">
              <span className="ptitle">{part.heading?.title ?? part.title}</span>
              {part.under && <span className="pgloss" data-plan-under={part.under}>in {part.under}/</span>}
              <span className="pgloss">{part.gloss || '— no gloss yet'}</span>
              <span className="pfoot">
                {part.titlePage && <span className="role plan-front-tag" data-plan-title-page="true">title page</span>}
                <span className="role">{part.role}</span>
                {part.path && <span className="role" data-plan-unlisted-path={part.path}>{part.path.split('/').slice(-2).join('/')}</span>}
              </span>
              {part.putBackRefusal && <span className="hint plan-putback-why" data-plan-putback-why="true">{part.putBackRefusal}</span>}
              <PartHeadingControl part={part} onChoose={onHeadingMode} />
            </span>
            {part.path && onOpenFile && (
              <button type="button" className="iconbtn" data-plan-open-file={part.path} onFocus={() => onSelect(index)} onClick={() => { onSelect(index); onOpenFile(part.path as string) }}>
                <FileText />Open
              </button>
            )}
            {part.frontMatterOffer && onAdoptFrontMatter && (
              <button
                type="button"
                className="iconbtn primary"
                data-plan-add-front-matter={part.path ?? undefined}
                disabled={Boolean(part.putBackRefusal)}
                title={part.putBackRefusal ?? 'Put this file back as front matter: it exports before the contents page and is never listed in it'}
                onFocus={() => onSelect(index)}
                onClick={() => { onSelect(index); onAdoptFrontMatter(index) }}
              >
                <BookOpen />Add as front matter <kbd>F</kbd>
              </button>
            )}
            <button
              type="button"
              className="iconbtn"
              data-plan-put-back={part.path ?? undefined}
              disabled={Boolean(part.putBackRefusal)}
              title={part.putBackRefusal ?? 'Put this file back at the end of the running order'}
              onFocus={() => onSelect(index)}
              onClick={() => { onSelect(index); onAdopt(index) }}
            >
              <Plus />Put back <kbd>A</kbd>
            </button>
          </div>
        ))}
        </div>}
      </div>
    </section>
  )
}

export function PlanProjectionNav({ onOpenBoard, onHelpWithReport, onOpenList }: { onOpenList?: () => void; onOpenBoard: () => void; onHelpWithReport?: () => void }): JSX.Element {
  return (
    <div className="plan-projection-nav">
      {onHelpWithReport && <SkillTriggerButton label={registryCommand(REPORT_SKILL_COMMAND).label} onRun={onHelpWithReport} />}
      <div className="seg-view" aria-label="Collection projection">
        {onOpenList && <button onClick={onOpenList}>List</button>}
        <button type="button" aria-pressed="false" onClick={onOpenBoard}><Columns3 aria-hidden="true" /> Board</button>
        <button type="button" aria-pressed="true"><ListOrdered aria-hidden="true" /> Folio outline</button>
        <button type="button" disabled title="Outline comes in a later release"><ListTree aria-hidden="true" /> Outline</button>
      </div>
    </div>
  )
}

export function PlanEmptyState({ kind, onStart }: { kind: 'absent' | 'empty'; onStart: () => void }): JSX.Element {
  return (
    <div className="plan-empty">
      <div className="art" aria-hidden="true"><i /><i /><i /><i /></div>
      <h2>{kind === 'absent' ? 'Start a Folio outline' : 'Nothing in the running order yet'}</h2>
      <p>{kind === 'absent'
        ? 'Create an Index Note for this folder, then plan its parts before any files need to exist.'
        : 'Add the first part to shape the running order. It can stay unwritten until you are ready.'}</p>
      <div className="be-act">
        <button type="button" className="btn idea-action" onClick={onStart}><Plus />{kind === 'absent' ? 'Start a Folio outline' : 'Add the first part'}</button>
      </div>
      <span className="note">{kind === 'absent' ? 'The Folio outline will live in the folder’s Index Note.' : 'Nothing is written until you press Return.'}</span>
    </div>
  )
}

export function PlanView({ headerActions, createActions, onOpenList, dir, onOpenPiece, onStatus, onOpenBoard, shortcutOverrides = {}, startWithComposer = false, pendingCommand = null, onPendingCommandRun, manifestUnreadable = false, onHelpWithReport, runningOrder, openFolio }: PlanViewProps): JSX.Element {
  const [plan, setPlan] = useState<Plan | null | undefined>(undefined)
  // "Start a Folio outline" (which creates an Index Note) is offered only when main said, affirmatively, that there is
  // no Folio here (`plan:read` answered null: no manifest and nothing at the Index Note's name). A read that failed is
  // not "no outline": its sentence is shown instead (`readFailure`), and Start is never offered for it.
  const [noFolio, setNoFolio] = useState(false)
  const [readFailure, setReadFailure] = useState<string | null>(null)
  const [collection, setCollection] = useState<Collection | null>(null)
  const [folio, setFolio] = useState<Folio | null>(null)
  const [flow, setFlow] = useState<HeadingFlow<{ level: number; text: string }> | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [selectedUnlisted, setSelectedUnlisted] = useState<number | null>(null)
  const [composer, setComposer] = useState<ComposerState | null>(null)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragged, setDragged] = useState<number | null>(null)
  const [addAllOpen, setAddAllOpen] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const detailsRef = useRef<FolioDetailsCardHandle>(null)
  const planRef = useRef<HTMLDivElement>(null)
  const addAllButtonRef = useRef<HTMLButtonElement>(null)
  const startedRef = useRef(false)
  const agentPillRef = useRef<FolioAgentPillHandle>(null)
  // Not in the outline is a section that can be closed (element 5, option A); open while there are loose files.
  const [looseClosed, setLooseClosed] = useState(false)
  const [chooseFrontOpen, setChooseFrontOpen] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [nextPlan, nextCollection, nextFolio] = await Promise.all([
        window.writeflex.plan.read(dir),
        window.writeflex.listCollection(dir),
        window.writeflex.readFolio(dir),
      ])
      setPlan(nextPlan)
      setNoFolio(nextPlan === null)
      setReadFailure(null)
      setCollection(nextCollection)
      setFolio(nextFolio)
      // The heading flow (chips and the chapter count) reads the same per-part headings as the sidebar Outline; a failure only hides them.
      setFlow(!nextPlan ? null : await window.writeflex.readFolioOutline(nextPlan.indexPath).then((outline) => (outline ? folioOutlineFlow(outline) : null)).catch(() => null))
      setSelected((current) => nextPlan?.parts.length ? Math.min(current ?? 0, nextPlan.parts.length - 1) : null)
      setSelectedUnlisted((current) => nextPlan?.unlisted.length ? Math.min(current ?? 0, nextPlan.unlisted.length - 1) : null)
    } catch (readError) {
      // Main's own sentence (a link where the Index Note should be, an unreadable manifest), else the general one.
      const message = humanReadableError(readError, PLAN_READ_FAILED)
      setPlan(null)
      setNoFolio(false)
      setReadFailure(message)
      onStatus(message)
    }
  }, [dir, onStatus])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => window.writeflex.onCollectionChanged(() => { void reload() }), [reload])

  const rows = useMemo(() => plan ? buildPlanRows(plan, collection?.rows ?? []) : [], [collection, plan])
  const summary = useMemo(() => planSummary(rows), [rows])
  const continuesChips = useMemo(() => {
    const chips = new Map<string, string>()
    if (flow) flow.parts.forEach((part, index) => { const chip = continuesChip(flow, index); if (chip) chips.set(part.path, chip) })
    return chips
  }, [flow])
  // Each part's headings below its own title, as the card's tree and the panel's heading count (the heading flow's children).
  const trees = useMemo(() => {
    const byPath = new Map<string, Array<{ text: string; depth: number }>>()
    if (flow) for (const part of flow.parts) byPath.set(part.path, part.children.map((child) => ({ text: child.text, depth: child.depth })))
    return byPath
  }, [flow])
  // Front matter (ADR-0046): listed in its own group above the running order; a part crosses by its role, never by a move.
  const frontFlags = useMemo(() => rows.map((row) => row.frontMatter === true), [rows])
  const frontRows = useMemo(() => rows.filter((row) => row.frontMatter === true), [rows])
  const contentsRows = useMemo(() => rows.filter((row) => row.frontMatter !== true), [rows])

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
      setNoFolio(next === null)
      if (next) setComposer({ at: 0, title: '', gloss: '', role: 'section' })
    } catch (error) {
      onStatus(planActionFailure(error, 'Could not create the Index Note for this Folio outline. Check that the folder is writable, then try again.'))
    } finally {
      setBusy(false)
    }
  }, [beginAdd, dir, onStatus, plan])

  useEffect(() => {
    if (!startWithComposer || startedRef.current || plan === undefined) return
    startedRef.current = true
    if (plan) beginAdd(plan.parts.length)
    else if (noFolio) void startPlan()
  }, [beginAdd, noFolio, plan, startPlan, startWithComposer])

  const commitComposer = useCallback(async (materialise: boolean) => {
    if (!composer || !plan || busy) return
    const title = composer.title.trim()
    if (!title) {
      onStatus('Give this part a title, then press Return again.')
      titleRef.current?.focus()
      return
    }
    setBusy(true)
    // Where main puts it: front matter at the edge of its block, a contents part no earlier than the contents.
    const at = placeInOrder(frontFlags, composer.at, isFrontMatterRole(composer.role))
    try {
      const inserted = await window.writeflex.plan.insertPart(dir, at, {
        title,
        ...(composer.gloss.trim() ? { gloss: composer.gloss.trim() } : {}),
        role: composer.role,
      })
      setPlan(inserted)
      setComposer(null)
      setSelected(at)
      if (materialise) {
        const result = await window.writeflex.plan.materialisePart(dir, at)
        setPlan(result.plan)
        onOpenPiece(result.path)
      }
    } catch (error) {
      onStatus(planActionFailure(error, 'Could not add that part. Check the title and try again; nothing else was changed.'))
    } finally {
      setBusy(false)
    }
  }, [busy, composer, dir, frontFlags, onOpenPiece, onStatus, plan])

  const moveSelected = useCallback(async (delta: -1 | 1) => {
    if (!plan || selected === null || busy) return
    const to = selected + delta
    if (to < 0 || to >= plan.parts.length) return
    if (!moveStaysInBlock(frontFlags, selected, to)) { onStatus(FRONT_MATTER_STAYS_LEADING); return }
    setBusy(true)
    try {
      setPlan(await window.writeflex.plan.movePart(dir, selected, to))
      setSelected(to)
    } catch (error) {
      onStatus(planActionFailure(error, 'Could not move that part. Reload the Folio outline and try again.'))
    } finally {
      setBusy(false)
    }
  }, [busy, dir, frontFlags, onStatus, plan, selected])

  const moveByDrag = useCallback(async (to: number) => {
    if (dragged === null || dragged === to) return
    const from = dragged
    setDragged(null)
    if (!moveStaysInBlock(frontFlags, from, to)) { onStatus(FRONT_MATTER_STAYS_LEADING); return }
    setBusy(true)
    try {
      setPlan(await window.writeflex.plan.movePart(dir, from, to))
      setSelected(to)
    } catch (error) {
      onStatus(planActionFailure(error, 'Could not move that part. Reload the Folio outline and try again.'))
    } finally {
      setBusy(false)
    }
  }, [dir, dragged, frontFlags, onStatus])

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
      onStatus(planActionFailure(error, 'Could not prepare this part for writing. Reload the Folio outline and try again.'))
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

  // Remove (ADR-0049): at once, no question asked. The part's file goes to the Folio bin and the flash offers Undo
  // (folio-bin.ts); a planned part only loses its line.
  const removeAt = useCallback(async (index: number | null) => {
    if (index === null || busy || !plan) return
    const part = plan.parts[index]
    if (!part) return
    const expected = plan.parts.map((item) => ({ title: item.title, path: item.path, gloss: item.gloss, role: item.role, tags: [...item.tags] }))
    setBusy(true)
    try {
      const answer = runningOrder
        ? await runningOrder.removeToBin(dir, [index], expected)
        : await window.writeflex.folioRoom.author(dir, { op: 'remove', indices: [index], expected })
      if (answer && !runningOrder) onStatus(answer.message)
      const next = await window.writeflex.plan.read(dir)
      if (next) {
        setPlan(next)
        setSelected(next.parts.length ? Math.min(index, next.parts.length - 1) : null)
      }
    } catch (error) {
      onStatus(planActionFailure(error, 'Could not remove that part. Reload the Folio outline and try again; no file was deleted.'))
    } finally {
      setBusy(false)
    }
  }, [busy, dir, onStatus, plan, runningOrder])
  const removeSelected = useCallback(() => removeAt(selected), [removeAt, selected])

  const adoptUnlisted = useCallback(async (index: number, asFrontMatter = false) => {
    const row = plan?.unlisted[index]
    if (!row?.path || busy) return
    if (asFrontMatter && !row.frontMatterOffer) {
      onStatus('Only a title page or a front-matter file can be added as front matter. Put it back, then change its role.')
      return
    }
    setBusy(true)
    try {
      const next = await window.writeflex.plan.adoptPart(dir, index, { title: row.title, path: row.path }, asFrontMatter)
      setPlan(next)
      // Front matter lands at the end of its block, not at the end of the running order.
      const placed = next.parts.findIndex((part) => part.path === row.path)
      setSelected(placed >= 0 ? placed : next.parts.length - 1)
      setSelectedUnlisted(next.unlisted.length ? Math.min(index, next.unlisted.length - 1) : null)
    } catch (error) {
      onStatus(planActionFailure(error, 'Could not add that existing part to the Folio outline. Reload the Folio outline and try again.'))
    } finally {
      setBusy(false)
    }
  }, [busy, dir, onStatus, plan])

  /** Files under Not in the outline that can become front matter: the choices of the rail's Choose a file. */
  const frontOffers = useMemo((): FrontMatterOffer[] => (plan?.unlisted ?? []).flatMap((part, index) => (part.frontMatterOffer && part.path ? [{ index, title: part.heading?.title ?? part.title, path: part.path, refusal: part.putBackRefusal ?? null }] : [])), [plan])
  useEffect(() => { if (plan && plan.unlisted.length === 0) setLooseClosed(false) }, [plan])

  const addAllRows = useMemo(() => addAllCandidates(plan?.unlisted ?? []), [plan])

  /** The running order as this Plan shows it: every part's title and file, so main can refuse a stale request. */
  const seenParts = useCallback(() => plan?.parts.map((part) => ({ title: part.title, path: part.path })) ?? [], [plan])

  const openAddAll = useCallback(() => {
    if (!runningOrder || composer) return
    if (addAllRows.length === 0) { onStatus('Every file in this folder that can join the running order is already in it.'); return }
    setAddAllOpen(true)
  }, [addAllRows.length, composer, onStatus, runningOrder])

  const closeAddAll = useCallback(() => {
    setAddAllOpen(false)
    // Back to the button that opened the sheet (the palette command opens it too; focus then lands there as well).
    requestAnimationFrame(() => { if (addAllButtonRef.current?.isConnected) addAllButtonRef.current.focus() })
  }, [])

  const commitAddAll = useCallback(async (chosen: AddAllCandidate[]) => {
    if (!runningOrder || !plan || busy || chosen.length === 0) return
    setBusy(true)
    try {
      const added = await runningOrder.addToPlan(dir, seenParts(), chosen)
      if (added) closeAddAll()
      await reload()
    } finally {
      setBusy(false)
    }
  }, [busy, closeAddAll, dir, plan, reload, runningOrder, seenParts])

  const sortByChapter = useCallback(async () => {
    if (!runningOrder || !plan || busy || composer) return
    setBusy(true)
    try {
      await runningOrder.sortPlan(dir, seenParts(), frontFlags)
      await reload()
    } finally {
      setBusy(false)
    }
  }, [busy, composer, dir, frontFlags, plan, reload, runningOrder, seenParts])

  const chooseHeadingMode = useCallback(async (path: string, mode: 'own' | 'none') => {
    if (busy) return
    setBusy(true)
    try {
      setPlan(await window.writeflex.plan.setHeadingMode(dir, path, mode))
    } catch (error) {
      onStatus(planActionFailure(error, 'Could not change that part’s heading choice. Nothing was changed.'))
    } finally {
      setBusy(false)
    }
  }, [busy, dir, onStatus])

  // Title-conflict buttons (2026-10-19): main writes; the Undo step and the flash are the app's (title-conflict-actions.ts).
  const titleActions = useTitleConflictContext()
  const titleConflicts = useMemo(() => {
    const seen = new Map<string, TitleFixTarget>()
    for (const part of plan?.parts ?? []) {
      const target = titleFixTargetOf(part)
      if (target && !seen.has(target.path)) seen.set(target.path, target)
    }
    return [...seen.values()]
  }, [plan])
  const fixTitle = useCallback(async (target: TitleFixTarget, direction: TitleFixDirection) => {
    if (!titleActions || busy) return
    setBusy(true)
    try {
      if (await titleActions.fixPart(dir, target, direction)) await reload()
    } finally {
      setBusy(false)
    }
  }, [busy, dir, reload, titleActions])
  const fixAllTitles = useCallback(async (direction: TitleFixDirection) => {
    if (!titleActions || busy) return
    if (titleConflicts.length < 2) { onStatus(titleConflicts.length === 1 ? 'Only one part has a title that differs from its heading. Select it and choose a fix.' : 'Every part’s title matches its heading.'); return }
    setBusy(true)
    try {
      if (await titleActions.fixAll(dir, titleConflicts, direction)) await reload()
    } finally {
      setBusy(false)
    }
  }, [busy, dir, onStatus, reload, titleActions, titleConflicts])
  const fixSelectedTitle = useCallback((direction: TitleFixDirection) => {
    const part = selected !== null ? plan?.parts[selected] : undefined
    const target = part ? titleFixTargetOf(part) : null
    if (!target) { onStatus(part ? titleFixUnavailable(part) : 'Select a part first.'); return }
    void fixTitle(target, direction)
  }, [fixTitle, onStatus, plan, selected])

  const [roleUndo, setRoleUndo] = useState<{ token: string; title: string } | null>(null)
  const undoRole = async (): Promise<void> => {
    if (!roleUndo) return
    const answer = await window.writeflex.folioRoom.author(dir, { op: 'undo', token: roleUndo.token })
    if (answer.ok) { setRoleUndo(null); await reload() } else onStatus(answer.message)
  }

  const chooseRole = useCallback(async (index: number, role: string) => {
    const part = plan?.parts[index]
    if (busy || !part) return
    setBusy(true)
    try {
      const next = await window.writeflex.plan.setPartRole(dir, index, role, { title: part.title, path: part.path, gloss: part.gloss, role: part.role, tags: [...part.tags] })
      setPlan(next)
      setRoleUndo(next.sectionRoleUndoToken ? { token: next.sectionRoleUndoToken, title: part.title } : null)
      // A role across the front-matter boundary moves the part to the edge of its new group: the selection follows it.
      const moved = part.path ? next.parts.findIndex((other) => other.path === part.path) : -1
      if (moved >= 0) setSelected(moved)
    } catch (error) {
      onStatus(planActionFailure(error, 'Could not change that part’s role. Nothing was changed.'))
    } finally {
      setBusy(false)
    }
  }, [busy, dir, onStatus, plan])

  /** Escape from the Details card: focus goes to the selected part (or the first), else stays on the page. */
  const focusRunningOrder = useCallback(() => {
    const options = [...(planRef.current?.querySelectorAll<HTMLElement>('.parts [role="option"]') ?? [])]
    const target = options.find((option) => option.getAttribute('aria-selected') === 'true') ?? options[0]
    if (target) target.focus()
    else (document.activeElement as HTMLElement | null)?.blur()
  }, [])

  /** R: focus goes to the selected part's role menu (its arrows and Enter then choose); with no part selected, a plain sentence says so. */
  const focusSelectedRole = useCallback(() => {
    // The role menu is in the side rail's Selected part panel (2026-10-19 redesign, element 4).
    const menu = planRef.current?.querySelector<HTMLSelectElement>('[data-plan-selected-panel] .part-role select')
    if (!menu) { onStatus('Select a part in the running order to choose its role.'); return }
    if (menu.disabled) { onStatus(TITLE_PAGE_SET_IN_MANIFEST); return }
    menu.focus()
  }, [onStatus])

  const runCommand = useCallback((command: PlanCommandName) => {
    if (composer) return
    if (command === 'title-heading-to-title' || command === 'title-title-to-heading') { fixSelectedTitle(command === 'title-heading-to-title' ? 'heading-to-title' : 'title-to-heading'); return }
    if (command === 'titles-heading-to-title' || command === 'titles-title-to-heading') { void fixAllTitles(command === 'titles-heading-to-title' ? 'heading-to-title' : 'title-to-heading'); return }
    if (command === 'add') beginAdd()
    else if (command === 'adopt' && selectedUnlisted !== null) void adoptUnlisted(selectedUnlisted)
    else if (command === 'adopt-front-matter') {
      if (selectedUnlisted !== null) void adoptUnlisted(selectedUnlisted, true)
      else onStatus('Select a title page or a front-matter file under Not in the outline to add it as front matter.')
    }
    else if (command === 'move-up') void moveSelected(-1)
    else if (command === 'move-down') void moveSelected(1)
    else if (command === 'open-part' && selected !== null) void openPart(selected)
    // Not in the outline: Enter on the file that has the keyboard opens it (the Open button's key).
    else if (command === 'open-part' && selectedUnlisted !== null && plan?.unlisted[selectedUnlisted]?.path) onOpenPiece(plan.unlisted[selectedUnlisted].path as string)
    else if (command === 'remove') void removeSelected()
    else if (command === 'add-all') openAddAll()
    else if (command === 'sort') void sortByChapter()
    else if (command === 'details') detailsRef.current?.focus()
    else if (command === 'role') focusSelectedRole()
    else if (command === 'agents-both') agentPillRef.current?.run('both')
    else if (command === 'agents-agents') agentPillRef.current?.run('agents')
    else if (command === 'agents-claude') agentPillRef.current?.run('claude')
    else if (command === 'front-matter-choose') {
      if (frontOffers.length === 0) onStatus('No file under Not in the outline can be front matter yet. Give a part the Front matter role, or add a title page to the folder.')
      else setChooseFrontOpen(true)
    }
    else if (command === 'not-in-outline-toggle') {
      if (!plan || plan.unlisted.length === 0) onStatus('Every Markdown file in this Folio is in the outline.')
      else setLooseClosed((closed) => !closed)
    }
  }, [adoptUnlisted, beginAdd, composer, frontOffers, fixAllTitles, fixSelectedTitle, focusSelectedRole, moveSelected, onOpenPiece, onStatus, openAddAll, openPart, plan, removeSelected, selected, selectedUnlisted, sortByChapter])

  // The hand-over from the room: once the Plan is read and the room's part is the selected one, run the command exactly once.
  const handedSeq = useRef<number | null>(null)
  useEffect(() => {
    if (!pendingCommand || handedSeq.current === pendingCommand.seq) return
    const step = handoverStep(plan, pendingCommand, selected)
    if (step.kind === 'wait') return
    if (step.kind === 'select') { setSelected(step.at); return }
    handedSeq.current = pendingCommand.seq
    onPendingCommandRun?.(pendingCommand.seq)
    if (step.kind === 'refuse') onStatus(HANDOVER_PART_GONE)
    else runCommand(pendingCommand.command)
  }, [onPendingCommandRun, onStatus, pendingCommand, plan, runCommand, selected])

  useEffect(() => {
    const onCommand = (event: Event): void => runCommand((event as CustomEvent<PlanCommandName>).detail)
    window.addEventListener(PLAN_COMMAND_EVENT, onCommand)
    return () => window.removeEventListener(PLAN_COMMAND_EVENT, onCommand)
  }, [runCommand])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (shortcutCaptureActive.current) return
      const target = event.target
      if (planKeysYieldTo(target)) return
      if (target instanceof Element && target.closest('.overlay.open')) return
      // The Details card keeps its own keys (Tab, ⌘Z, Escape); a display-only field there is not the running order.
      if (target instanceof Element && target.closest('[data-folio-details]')) return
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

  // The composer shows in the group its role puts the part in, where main will put it.
  const composerInFront = composer !== null && isFrontMatterRole(composer.role) && rows.length > 0
  const composerShownAt = composer ? placeInOrder(frontFlags, composer.at, isFrontMatterRole(composer.role)) : null
  const coverIndex = frontRows.find((row) => row.titlePage)?.index ?? null

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
        <span className="roles">{ROLES.map((role) => <button type="button" key={role} className={composer.role === role ? 'on' : ''} onClick={() => setComposer({ ...composer, role })}>{roleLabel(role).toLocaleLowerCase()}</button>)}</span>
        <span className="compose-keys"><kbd>⏎</kbd><kbd>⇧⏎</kbd></span>
      </div>
    </div>
  ) : null

  const showPage = plan && (rows.length > 0 || composer || plan.unlisted.length > 0)
  const selectedRow = selected !== null ? rows.find((row) => row.index === selected) ?? null : null
  const selectedHeadingCount = selectedRow?.path ? trees.get(selectedRow.path)?.length ?? null : null
  const showTrees = flow ? trees : undefined

  return (
    <div className="plan" ref={planRef}>
      <div className="cv-folio-actions">{createActions}<PlanProjectionNav onOpenList={onOpenList} onOpenBoard={onOpenBoard} {...(onHelpWithReport ? { onHelpWithReport } : {})} /></div>
      {manifestUnreadable && <FolioManifestWarning />}
      {!showPage && <div className="plan-title-row cv-empty-folio-head">{openFolio}{headerActions}</div>}
      {plan && showPage && <div className="plan-scroll"><div className="plan-inner plan-wide">
        {/* The header strip (2026-10-19 redesign): the title with only the word Folio as a tag, the agent instructions pill and Open Folio. */}
        <div className="plan-title-row">
          <h1>{collection?.name ?? dir.split('/').at(-1) ?? 'Folio outline'}</h1>
          <span className="badge plan-tag" data-plan-tag="true">Folio</span>
          <div className="plan-head-actions">
            <FolioAgentInstructionsPill ref={agentPillRef} dir={dir} onOpenPiece={onOpenPiece} onStatus={onStatus} />
            {openFolio}{headerActions}
          </div>
        </div>
        {collection?.cover?.text && <p className="cover">{collection.cover.text}</p>}
        <div className="plan-meta">
          {folio?.output && <span className="mchip"><BookOpenText />compiles to {folio.output}</span>}
          <span className="mchip" data-plan-counts="true">{pluralisedSummary(summary, flow ? flow.chapters : null)}</span>
          {summary.words > 0 && <span className="mchip">{summary.words.toLocaleString('en-GB')} words</span>}
        </div>

        <div className="plan-cols">
          <div className="plan-main">
            {(rows.length > 0 || plan.unlisted.length > 0) && <div className="plan-bar"><h2>Running order</h2>
              {runningOrder && addAllRows.length > 0 && <button type="button" ref={addAllButtonRef} className="iconbtn" data-plan-add-all="true" disabled={busy} onClick={openAddAll}><ListPlus />Add all from this folder</button>}
              {runningOrder && rows.filter((row) => row.written).length > 1 && <button type="button" className="iconbtn" data-plan-sort="true" disabled={busy} onClick={() => void sortByChapter()}><ArrowDownAZ />Sort by chapter number</button>}
              {titleActions && titleConflicts.length >= 2 && (['heading-to-title', 'title-to-heading'] as const).map((direction) => (
                <button key={direction} type="button" className="iconbtn" data-plan-title-fix-all={direction} disabled={busy} onClick={() => void fixAllTitles(direction)}>
                  <Heading />{direction === 'heading-to-title' ? `Use headings as titles for all ${titleConflicts.length}` : `Use titles as headings for all ${titleConflicts.length}`}
                </button>
              ))}
              <button type="button" className="iconbtn primary" onClick={() => beginAdd(rows.length > 0 ? undefined : 0)}><Plus />Add a part <kbd>N</kbd></button></div>}
            {/* The title page (and any other front matter) shows as a Cover band above the chapters (element 3, option B). */}
            {frontRows.length > 0
              ? <div className="plan-cover-band"><PlanPartList rows={frontRows} selected={selected} composer={composerInFront ? composerNode : null} composerAt={composerShownAt} endIndex={frontRows.length} label="Front matter" coverIndex={coverIndex} onSelect={setSelected} onOpen={(index) => void openPart(index)} onDragStart={setDragged} onDrop={(index) => void moveByDrag(index)} /></div>
              : composerInFront ? composerNode : null}
            {contentsRows.length > 0 && <PlanPartList rows={contentsRows} selected={selected} composer={composerInFront ? null : composerNode} composerAt={composerShownAt} endIndex={rows.length} onSelect={setSelected} onOpen={(index) => void openPart(index)} onDragStart={setDragged} onDrop={(index) => void moveByDrag(index)} {...(flow ? { chips: continuesChips } : {})} {...(showTrees ? { trees: showTrees } : {})} />}
            {contentsRows.length === 0 && rows.length > 0 && (composer && !composerInFront ? composerNode : <p className="unlisted-note" data-plan-contents-empty="true">Nothing is in the contents yet.</p>)}
            {rows.length === 0 && plan.unlisted.length > 0 && <p className="unlisted-note">Nothing is in the running order yet.</p>}
            {plan.unlisted.length > 0 && <PlanUnlistedList
              parts={plan.unlisted}
              selected={selectedUnlisted}
              closed={looseClosed}
              onToggle={() => setLooseClosed((closed) => !closed)}
              onSelect={setSelectedUnlisted}
              onAdopt={(index) => void adoptUnlisted(index)}
              onAdoptFrontMatter={(index) => void adoptUnlisted(index, true)}
              onOpenFile={onOpenPiece}
              onHeadingMode={(path, mode) => void chooseHeadingMode(path, mode)}
            />}
          </div>
          <aside className="plan-rail" aria-label="Details and settings">
            <FolioDetailsCard ref={detailsRef} dir={dir} onLeave={focusRunningOrder} onStatus={onStatus} {...(runningOrder ? { write: runningOrder.write } : {})} />
            <FolioSelectedPanel
              row={selectedRow}
              headingCount={selectedHeadingCount}
              roleControl={selectedRow && <><PartRoleControl title={selectedRow.title} role={selectedRow.sectionPage && !isFrontMatterRole(selectedRow.role) ? 'section-page' : selectedRow.role} onChoose={(role) => void chooseRole(selectedRow.index ?? 0, role)} lockedReason={selectedRow.manifestTitlePage ? TITLE_PAGE_SET_IN_MANIFEST : undefined} />{roleUndo && <button type="button" onClick={() => void undoRole()}>Undo role change for {roleUndo.title}</button>}</>}
              headingControl={selectedRow && selectedRow.written && <PartHeadingControl part={selectedRow} onChoose={(path, mode) => void chooseHeadingMode(path, mode)} {...(titleActions ? { onFixTitle: (target: TitleFixTarget, direction: TitleFixDirection) => void fixTitle(target, direction) } : {})} />}
            />
            <FolioFrontMatterSlot
              rows={frontRows}
              selected={selected}
              offers={frontOffers}
              busy={busy}
              menuOpen={chooseFrontOpen}
              onMenuOpen={setChooseFrontOpen}
              onSelect={setSelected}
              onChoose={(offer) => { setSelectedUnlisted(offer.index); void adoptUnlisted(offer.index, true) }}
              onTakeOut={(index) => void removeAt(index)}
            />
          </aside>
        </div>
      </div></div>}

      {!plan && noFolio && <PlanEmptyState kind="absent" onStart={() => { if (!busy) void startPlan() }} />}
      {!plan && readFailure !== null && <p className="unlisted-note" data-plan-read-failed="true">{readFailure}</p>}
      {plan && rows.length === 0 && plan.unlisted.length === 0 && !composer && <PlanEmptyState kind="empty" onStart={() => beginAdd(0)} />}
      {plan && rows.length === 0 && composer && <div className="plan-first-composer">{composerNode}</div>}

      <div className="plan-foot">
        {composer ? <><span className="kb"><kbd>⏎</kbd> record the part</span><span className="kb"><kbd>⇧⏎</kbd> create the file now</span><span className="kb"><kbd>esc</kbd> cancel</span></>
          : <><span className="kb"><kbd>N</kbd> add a part</span><span className="kb"><kbd>⏎</kbd> {selected !== null && rows[selected]?.written ? 'open' : 'start writing'}</span><span className="kb"><kbd>⌥↑↓</kbd> reorder</span>{plan && <><span className="kb"><kbd>R</kbd> role</span><span className="kb"><kbd>D</kbd> details</span><span className="kb"><kbd>⌘⌫</kbd> take out</span><span className="kb"><kbd>?</kbd> every key</span></>}</>}
        <span className="right">{plan ? `Folio outline lives in ${plan.indexPath.split('/').at(-1)}` : 'No Folio outline yet'}</span>
      </div>

      {addAllOpen && runningOrder && <PlanAddAllSheet folderName={dir.split('/').at(-1) || 'this folder'} candidates={addAllRows} busy={busy} onAdd={(chosen) => void commitAddAll(chosen)} onClose={closeAddAll} />}

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
