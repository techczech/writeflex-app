import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookMarked, BookOpenText, ChevronUp, Columns3, FilePlus2, FileText, Folder, FolderOpen, Sparkles } from 'lucide-react'
import type { Collection, CollectionRow, Folio, Plan } from '../../../preload'
import { MANIFEST_NAME } from '../../../shared/folio-constants'
import type { OverrideMap } from '../commands/chords'
import { PLAN_COMMAND_EVENT, type PlanCommandName } from '../plan/plan-commands'
import { FolioManifestWarning, PlanView } from './PlanView'

type SortKey = 'title' | 'purpose' | 'status' | 'date'
type SortState = { key: SortKey; dir: 'asc' | 'desc' }

export type CollectionViewProps = {
  /** The collection folder, workspace-relative ('' = the workspace root). */
  dir: string
  /** Open a piece (or the Index Note) in a tab — App exits the collection and shows the editor. */
  onOpenPiece: (path: string) => void
  /** Create a new blank piece in this folder, then open it (App owns create + open + tree refresh). */
  onNewPiece: (dir: string) => void
  /** Inline status flashes (create-index / Make Folio errors). */
  onStatus: (message: string) => void
  onOpenBoard: () => void
  onFolderPieceSelected: (selection: { dir: string; folderPath: string; mode: 'one' | 'many' } | null) => void
  shortcutOverrides?: OverrideMap
  openPlanRequested?: boolean
  onOpenPlan?: () => void
  /** The Plan pane's Help with this report (ticket 10): start the report skill on this folder. */
  onHelpWithReport?: (dir: string) => void
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const KNOWN_STATUS = new Set(['idea', 'draft', 'final'])

/** A short British relative date for the Modified column: today / yesterday / "9 Jun" / "9 Jun 2025". */
function relativeDate(ms: number): string {
  const d = new Date(ms)
  const now = new Date()
  const midnight = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDelta = Math.round((midnight(now) - midnight(d)) / 86_400_000)
  if (dayDelta === 0) return 'today'
  if (dayDelta === 1) return 'yesterday'
  const dm = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === now.getFullYear() ? dm : `${dm} ${d.getFullYear()}`
}

/** The sort value for a column; the title sorts by its displayed filename. */
function sortValue(row: CollectionRow, key: SortKey): string | number | null {
  switch (key) {
    case 'title': return row.title ?? row.name
    case 'purpose': return row.purpose
    case 'status': return row.status
    case 'date': return row.modified
  }
}

/** Compare two rows on a column. Empty cells (bare files / missing metadata) always sort LAST, in
 *  either direction — so a sort surfaces the filled-in pieces without burying the blanks unpredictably. */
function compareRows(a: CollectionRow, b: CollectionRow, sort: SortState): number {
  const av = sortValue(a, sort.key)
  const bv = sortValue(b, sort.key)
  const aEmpty = av === null || av === ''
  const bEmpty = bv === null || bv === ''
  if (aEmpty && bEmpty) return a.name.localeCompare(b.name)
  if (aEmpty) return 1
  if (bEmpty) return -1
  const base = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
  return sort.dir === 'desc' ? -base : base
}

function StatusBadge({ status, derived }: { status: string | null; derived: boolean }): JSX.Element {
  if (!status) return <span className="muted">—</span>
  const cls = KNOWN_STATUS.has(status) ? status : 'other'
  return <span className={`sbadge2 ${cls}${derived ? ' derived' : ''}`}>{status}</span>
}

export function CollectionFolioStatus({
  manifestUnreadable,
  onMakeFolio,
}: {
  manifestUnreadable: boolean
  onMakeFolio: () => void
}): JSX.Element {
  if (manifestUnreadable) return <FolioManifestWarning />
  return <>
    <button className="ghost" onClick={onMakeFolio}><BookMarked className="icon sm" />Make a Folio…</button>
    <span className="hint"><Sparkles className="icon sm" />or ask the agent to assemble one</span>
  </>
}

/**
 * The Collection view (Task 23, mockup v4 / ADR-0009): a folder rendered as its Index-Note cover plus a
 * sortable table of its pieces. Self-fetching (like ScratchpadPane) — it lists on mount, on `dir` change,
 * and whenever a Collection write pushes `collection:changed`. Every row and control is a button, so
 * the whole surface is keyboard-reachable (Enter/Space opens a piece; the header buttons re-sort).
 */
export function CollectionView({ dir, onOpenPiece, onNewPiece, onStatus, onOpenBoard, onFolderPieceSelected, shortcutOverrides = {}, openPlanRequested = false, onOpenPlan, onHelpWithReport }: CollectionViewProps): JSX.Element {
  const [data, setData] = useState<Collection | null>(null)
  const [folio, setFolio] = useState<Folio | null>(null)
  const [manifestUnreadable, setManifestUnreadable] = useState(false)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [planDeclared, setPlanDeclared] = useState(false)
  const [planRequested, setPlanRequested] = useState(false)
  const [startPlanComposer, setStartPlanComposer] = useState(false)
  // null = the folder's NATURAL order: a Folio's manifest compile-order, else newest-first (mockup
  // default). A concrete SortState means the writer clicked a column and took over the ordering.
  const [sort, setSort] = useState<SortState | null>(null)

  const reload = useCallback(() => {
    void window.writeflex.listCollection(dir).then(setData).catch(() => setData({ name: dir, cover: null, rows: [] }))
    void (async () => {
      const manifestPath = [dir, MANIFEST_NAME].filter(Boolean).join('/')
      const [nextFolio, manifestExists] = await Promise.all([
        window.writeflex.readFolio(dir).catch(() => null),
        window.writeflex.readFile(manifestPath).then(() => true).catch(() => false),
      ])
      setFolio(nextFolio)
      setManifestUnreadable(nextFolio === null && manifestExists)
    })()
    void window.writeflex.plan.read(dir).then(async (nextPlan) => {
      setPlan(nextPlan)
      if (!nextPlan) {
        setPlanDeclared(false)
        return
      }
      if (nextPlan.parts.length > 0) {
        setPlanDeclared(true)
        return
      }
      const source = await window.writeflex.readFile(nextPlan.indexPath).catch(() => null)
      setPlanDeclared(source ? /^##\s+Running order\s*$/im.test(source.content) : false)
    }).catch(() => { setPlan(null); setPlanDeclared(false) })
  }, [dir])
  useEffect(() => { reload() }, [reload])
  useEffect(() => window.writeflex.onCollectionChanged(reload), [reload])
  const showPlan = openPlanRequested || planRequested || folio !== null || planDeclared || (plan?.parts.length ?? 0) > 0
  useEffect(() => {
    const onPlanCommand = (event: Event): void => {
      if (showPlan) return
      const command = (event as CustomEvent<PlanCommandName>).detail
      if (command !== 'add') return
      setStartPlanComposer(true)
      setPlanRequested(true)
    }
    window.addEventListener(PLAN_COMMAND_EVENT, onPlanCommand)
    return () => window.removeEventListener(PLAN_COMMAND_EVENT, onPlanCommand)
  }, [showPlan])

  const makeFolio = useCallback(() => {
    void window.writeflex
      .makeFolio(dir)
      .catch((e: Error) => onStatus(e?.message ?? 'Could not make this folder a Folio.'))
  }, [dir, onStatus])

  const sortedRows = useMemo(() => {
    if (!data) return []
    return [...data.rows].sort((a, b) => compareRows(a, b, sort ?? { key: 'date', dir: 'desc' }))
  }, [data, sort])

  const shownSort: SortState = sort ?? { key: 'date', dir: 'desc' }

  const toggleSort = useCallback((key: SortKey) => {
    setSort((prev) => {
      const cur = prev ?? { key: 'date', dir: 'desc' }
      return cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
    })
  }, [])

  const createIndex = useCallback(() => {
    void window.writeflex.createCollectionIndex(dir).catch((e: Error) => onStatus(e?.message ?? 'Could not create the Index Note.'))
  }, [dir, onStatus])

  if (!data) return <div className="cv-scroll" aria-busy="true" />

  if (showPlan) return <PlanView dir={dir} onOpenPiece={onOpenPiece} onStatus={onStatus} onOpenBoard={onOpenBoard} shortcutOverrides={shortcutOverrides} startWithComposer={startPlanComposer} manifestUnreadable={manifestUnreadable} {...(onHelpWithReport ? { onHelpWithReport: () => onHelpWithReport(dir) } : {})} />

  const bareCount = sortedRows.filter((r) => r.bare).length
  const totalWords = sortedRows.reduce((sum, r) => sum + r.words, 0)
  const folderPieces = sortedRows.filter((row) => row.folderPath).length
  const firstBare = sortedRows.find((r) => r.bare) // follow the visible order, not disk order
  const columns: Array<{ key: SortKey; label: string }> = [
    { key: 'title', label: 'Title' },
    { key: 'purpose', label: 'Purpose' },
    { key: 'status', label: 'Status' },
    { key: 'date', label: 'Modified' },
  ]

  return (
    <div className="cv-scroll">
    <div className="cv">
      <div className="cv-head">
        <FolderOpen className="icon" style={{ width: 22, height: 22 }} />
        <h1>{data.name}</h1>
        <span className="cv-badge">{manifestUnreadable ? 'Folio manifest unreadable' : 'Collection'}</span>
      </div>

      {data.cover?.text && <p className="cv-cover">{data.cover.text}</p>}

      <div className="cv-src">
        <BookOpenText className="icon sm" />
        {data.cover ? (
          <>
            Cover from&nbsp;<strong>{data.cover.source}</strong>
            <button className="ghost" onClick={() => onOpenPiece(data.cover!.path)}>Edit</button>
          </>
        ) : (
          <>
            No cover note yet
            <button className="ghost" onClick={createIndex}>Create Index Note</button>
          </>
        )}
      </div>

      <div className="cv-actions">
        <button className="ghost" onClick={() => onNewPiece(dir)}><FilePlus2 className="icon sm" />New piece</button>
        <button className="ghost" onClick={() => onOpenPlan ? onOpenPlan() : setPlanRequested(true)}><BookOpenText className="icon sm" />Start a plan</button>
        <button className="ghost" title="Open Board (⇧⌘B)" onClick={onOpenBoard}><Columns3 className="icon sm" />Board</button>
        <CollectionFolioStatus manifestUnreadable={manifestUnreadable} onMakeFolio={makeFolio} />
      </div>

      <div className="cv-table" role="table" aria-label={`Pieces in ${data.name}`}>
        <div className="cv-tr cv-th" role="row">
          {columns.map((col) => (
            <button
              key={col.key}
              data-sort={col.key}
              data-dir={shownSort?.key === col.key ? shownSort.dir : undefined}
              aria-sort={shownSort?.key === col.key ? (shownSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
              onClick={() => toggleSort(col.key)}
            >
              <span>{col.label}</span>
              <ChevronUp className="icon sort" />
            </button>
          ))}
        </div>
        {sortedRows.length === 0 ? (
          <div className="cv-empty">No pieces in this folder yet.</div>
        ) : (
          sortedRows.map((row) => (
            <button
              key={row.path}
              className={`cv-tr cv-row${row.folderPath ? ' folder-piece' : ''}`}
              title={row.path}
              data-folder-piece-mode={row.folderPieceMode}
              onFocus={() => onFolderPieceSelected(row.folderPath ? { dir, folderPath: row.folderPath, mode: row.folderPieceMode ?? 'one' } : null)}
              onClick={() => {
                if (row.folderPath) onFolderPieceSelected({ dir, folderPath: row.folderPath, mode: row.folderPieceMode ?? 'one' })
                else onOpenPiece(row.path)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || !row.folderPath) return
                event.preventDefault()
                onFolderPieceSelected({ dir, folderPath: row.folderPath, mode: row.folderPieceMode ?? 'one' })
                onOpenPiece(row.path)
              }}
              onDoubleClick={() => { if (row.folderPath) onOpenPiece(row.path) }}
            >
              <span className="cell title">
                {row.folderPath ? <Folder className="icon sm folder-piece-mark" aria-label="Folder Piece" /> : <FileText className="icon sm" />}
                <span>{row.title ?? row.name}</span>
              </span>
              <span className="cell">{row.purpose ? <span className={`pbadge${row.provenance.purpose === 'derived' ? ' derived' : ''}`}>{row.purpose}</span> : <span className="muted">—</span>}</span>
              <span className="cell"><StatusBadge status={row.status} derived={row.provenance.status === 'derived'} /></span>
              <span className="cell muted">{relativeDate(row.modified)}</span>
            </button>
          ))
        )}
      </div>

      <p className="cv-foot">
        {sortedRows.length} {sortedRows.length === 1 ? 'piece' : 'pieces'} · {folderPieces} folder {folderPieces === 1 ? 'piece' : 'pieces'} · {totalWords.toLocaleString('en-GB')} words
        {bareCount > 0 && firstBare && ` · ${firstBare.name} carries no frontmatter — bare files are welcome here.`}
      </p>
    </div>
    </div>
  )
}
