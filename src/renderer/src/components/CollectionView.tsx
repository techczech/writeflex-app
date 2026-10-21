import type { CollectionBatchResult } from '../app/collection-bulk'
import { CollectionActionSheet, NO_MOVE_DESTINATION, type CollectionSheet } from './CollectionActionSheet'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookMarked, BookOpenText, ChevronUp, Columns3, FilePlus2, FileText, Folder, FolderOpen, Library, List, Sparkles, Tag, ArrowRight, X } from 'lucide-react'
import type { Collection, CollectionRow, CollectionSubfolder, Folio, Plan } from '../../../preload'
import { MANIFEST_NAME } from '../../../shared/folio-constants'
import { effectiveSheetChords, type OverrideMap } from '../commands/chords'
import { PLAN_COMMAND_EVENT, type PlanCommandName } from '../plan/plan-commands'
import { FolioManifestWarning, PlanView } from './PlanView'
import { FolioOpenButton, folioOpenParts } from './FolioOpenButton'
import { FolioAgentInstructions } from './FolioAgentInstructions'
import type { FolioRunningOrder } from '../app/folio-running-order'
import { collectionFooterText, subfolderPiecesText } from './collection-footer'
import { orderDashboard, type DashEntry, type DashSort, type DashSortKey } from './collection-order'

import { registryCommand } from '../commands/registry'
import { CollectionMenu } from './CollectionMenu'
import { CollectionFilterBar } from './CollectionFilterBar'
import { COLLECTION_BULK_COMMANDS, COLLECTION_PAGE_EVENT, type CollectionPageCommand } from './collection-page-commands'
import { EMPTY_COLLECTION_FILTERS, filterCollectionRows, prepareCollectionRows, groupCollectionRows, type CollectionGroup } from './collection-view-state'
import { BOARD_STATUS_ORDER } from '../../../shared/collection-status'

type SortKey = DashSortKey
type SortState = DashSort
type DashItem = { sub: CollectionSubfolder; row?: undefined } | { row: CollectionRow; sub?: undefined }

export type CollectionViewProps = {
  /** The collection folder, workspace-relative ('' = the workspace root). */
  dir: string
  onRunCommand?: (id: string) => void
  onRename?: (name: string) => Promise<void>
  canAddToFolio?: boolean
  onBulkAction?: (action: 'status' | 'move' | 'folio' | 'tag', paths: string[], value: string) => Promise<CollectionBatchResult>
  /** Open a piece (or the Index Note) in a tab — App exits the collection and shows the editor. */
  onOpenPiece: (path: string) => void
  /** Create a new blank piece in this folder, then open it (App owns create + open + tree refresh). */
  onNewPiece: (dir: string) => void
  /** Inline status flashes (create-index / Make Folio errors). */
  onStatus: (message: string) => void
  onOpenBoard: () => void
  /** Open a subfolder's own Folder dashboard (App's openCollection; a Folio opens as it does from the sidebar). */
  onOpenFolder?: (dir: string) => void
  onFolderPieceSelected: (selection: { dir: string; folderPath: string; mode: 'one' | 'many' } | null) => void
  shortcutOverrides?: OverrideMap
  openPlanRequested?: boolean
  onStartFolio?: (dir: string) => void
  /** The Plan pane's Help with this report (ticket 10): start the report skill on this folder. */
  onHelpWithReport?: (dir: string) => void
  /** Open the Make-this-folder-a-vault sheet (vaults ticket 03). The button shows on the root's dashboard only, and only when the root is not a vault. */
  onMakeVault?: () => void
  rootIsVault?: boolean
  /** The running-order writer with its one Undo step (App owns it); the Plan's Add all and Sort use it. */
  runningOrder?: FolioRunningOrder
  /** Open Folio on a Folio's page: open this part AND show the sidebar Outline in its Folio part (App owns both). Without it the part just opens. */
  onOpenFolio?: (path: string) => void
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

function StatusBadge({ status, derived }: { status: string | null; derived: boolean }): JSX.Element {
  if (!status) return <span className="muted">—</span>
  const cls = KNOWN_STATUS.has(status) ? status : 'other'
  return <span data-status={status.toLowerCase()} className={`sbadge2 ${cls}${derived ? ' derived' : ''}`}>{(BOARD_STATUS_ORDER as readonly string[]).includes(status) ? status.charAt(0).toUpperCase() + status.slice(1) : status}</span>
}

export function CollectionFolioStatus({
  manifestUnreadable,
  onMakeFolio,
  onMakeVault,
}: {
  manifestUnreadable: boolean
  onMakeFolio: () => void
  /** Given only where a vault can be made: after Make a Folio…, accent outline. */
  onMakeVault?: () => void
}): JSX.Element {
  if (manifestUnreadable) return <FolioManifestWarning />
  return <>
    <button className="ghost" onClick={onMakeFolio}><BookMarked className="icon sm" />Make a Folio…</button>
    {onMakeVault && <button className="ghost accent-outline" data-action="make-vault" onClick={onMakeVault}><Library className="icon sm" />Make this folder a vault…</button>}
    <span className="hint"><Sparkles className="icon sm" />or ask the agent to assemble one</span>
  </>
}

/**
 * The Collection view (Task 23, mockup v4 / ADR-0009): a folder rendered as its Index-Note cover plus a
 * sortable table of its pieces. Self-fetching (like ScratchpadPane) — it lists on mount, on `dir` change,
 * and whenever a Collection write pushes `collection:changed`. Every row and control is a button, so
 * the whole surface is keyboard-reachable (Enter/Space opens a piece; the header buttons re-sort).
 */
export function CollectionView({ dir, onOpenPiece, onNewPiece, onStatus, onOpenBoard, onOpenFolder, onFolderPieceSelected, shortcutOverrides = {}, openPlanRequested = false, onStartFolio, onHelpWithReport, onMakeVault, rootIsVault = false, runningOrder, onOpenFolio, onRunCommand, onRename, onBulkAction, canAddToFolio = false }: CollectionViewProps): JSX.Element {
  const pageRef = useRef<HTMLDivElement>(null)
  const [filters, setFilters] = useState(EMPTY_COLLECTION_FILTERS)
  const [group, setGroup] = useState<CollectionGroup>('none')
  const [menuOpen, setMenuOpen] = useState(false)
  const [listFolio, setListFolio] = useState(false)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [sheet, setSheet] = useState<CollectionSheet | null>(null)
  const [moveFolders, setMoveFolders] = useState<string[]>([])
  const sheetOpener = useRef<HTMLElement | null>(null)
  const batchRunning = useRef(false)
  const reloadPending = useRef(false)
  const [sheetValue, setSheetValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [sheetError, setSheetErrorState] = useState('')
  const sheetErrorRef = useRef('')
  const setSheetError = useCallback((message: string) => {
    sheetErrorRef.current = message
    setSheetErrorState(message)
  }, [])
  const [data, setData] = useState<Collection | null>(null)
  const [folio, setFolio] = useState<Folio | null>(null)
  const [folioPieces, setFolioPieces] = useState<string[] | null>(null)
  const [manifestUnreadable, setManifestUnreadable] = useState(false)
  const [planDeclared, setPlanDeclared] = useState(false)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [planRequested, setPlanRequested] = useState(false)
  const [startPlanComposer, setStartPlanComposer] = useState(false)
  // null = the folder's NATURAL order: a Folio's manifest compile-order, else newest-first (mockup
  // default). A concrete SortState means the writer clicked a column and took over the ordering.
  const [sort, setSort] = useState<SortState | null>(null)

  const reload = useCallback(() => {
    void window.writeflex.listCollection(dir, { includeSearchText: true }).then(setData).catch(() => setData({ name: dir, cover: null, rows: [], subfolders: [] }))
    void (async () => {
      const manifestPath = [dir, MANIFEST_NAME].filter(Boolean).join('/')
      const [nextFolio, manifestExists] = await Promise.all([
        window.writeflex.readFolio(dir).catch(() => null),
        window.writeflex.readFile(manifestPath).then(() => true).catch(() => false),
      ])
      setFolio(nextFolio)
      setManifestUnreadable(nextFolio === null && manifestExists)
    })()
    void window.writeflex.readFolioPieces(dir).then((next) => setFolioPieces(next?.pieces ?? null)).catch(() => setFolioPieces(null))
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
  useEffect(() => window.writeflex.onCollectionChanged(() => {
    if (batchRunning.current) { reloadPending.current = true; return }
    reload()
  }), [reload])
  useEffect(() => {
    if (sheet !== 'move') return
    let cancelled = false
    void window.writeflex.getWorkspace().then(workspace => {
      if (!cancelled) setMoveFolders(['', ...workspace.folders].filter(folder => folder !== dir))
    }).catch(() => { if (!cancelled) setSheetError('Could not list destination folders. Try again.') })
    return () => { cancelled = true }
  }, [sheet, dir])
  const showPlan = !listFolio && (openPlanRequested || planRequested || folio !== null || manifestUnreadable || planDeclared || (plan?.parts.length ?? 0) > 0)
  useEffect(() => {
    const onPlanCommand = (event: Event): void => {
      if (showPlan) return
      const command = (event as CustomEvent<PlanCommandName>).detail
      if (command !== 'add') return
      setListFolio(false)
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

  // Folders (plain subfolders + folder pieces) first, then files; the column sort applies within each group.
  const ordered = useMemo((): DashEntry<DashItem>[] => {
    if (!data) return []
    const entries: DashEntry<DashItem>[] = [
      ...(data.subfolders ?? []).map((sub): DashEntry<DashItem> => ({
        isFolder: true, label: sub.title ?? sub.name, purpose: subfolderPiecesText(sub.pieces), status: sub.status,
        modified: sub.modified > 0 ? sub.modified : null, item: { sub },
      })),
      ...data.rows.map((row): DashEntry<DashItem> => ({
        isFolder: Boolean(row.folderPath), label: row.title ?? row.name, purpose: row.purpose, status: row.status, modified: row.modified, words: row.words, item: { row },
      })),
    ]
    return orderDashboard(entries, sort ?? { key: 'date', dir: 'desc' })
  }, [data, sort])
  const sortedRows = useMemo(() => ordered.flatMap((entry) => (entry.item.row ? [entry.item.row] : [])), [ordered])

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

  const entriesByPath = useMemo(() => new Map(ordered.flatMap(entry => entry.item.row ? [[entry.item.row.path, entry] as const] : [])), [ordered])
  const prepared = useMemo(() => prepareCollectionRows(sortedRows), [sortedRows])
  const hits = useMemo(() => filterCollectionRows(prepared, filters), [prepared, filters])
  const groups = useMemo(() => groupCollectionRows(hits, group), [hits, group])
  const visiblePaths = useMemo(() => new Set(hits.map(hit => hit.row.path)), [hits])
  const selectedPaths = useMemo(() => [...selection].filter(path => visiblePaths.has(path)), [selection, visiblePaths])
  const snippets = useMemo(() => new Map(hits.map(hit => [hit.row.path, hit.snippet])), [hits])
  const facets = useMemo(() => ({ statuses: [...new Set(sortedRows.map(row => row.status || 'Unsorted'))].sort(), purposes: [...new Set(sortedRows.map(row => row.purpose || 'Unspecified'))].sort(), tags: [...new Set(sortedRows.flatMap(row => row.tags ?? []))].sort() }), [sortedRows])
  const activeFilters = filters.query.trim() !== '' || filters.statuses.length > 0 || filters.purposes.length > 0 || filters.tags.length > 0 || filters.modified !== 'any'
  useEffect(() => { setFilters(EMPTY_COLLECTION_FILTERS); setSelection(new Set()); setGroup('none'); setSort(null); setMenuOpen(false); setListFolio(false); setSheet(null) }, [dir])
  useEffect(() => { setSelection(previous => new Set([...previous].filter(path => visiblePaths.has(path)))) }, [visiblePaths])
  const runPageCommand = useCallback((command: CollectionPageCommand) => {
    if (command === 'menu') { setMenuOpen(value => !value); return }
    if (busy && (command === 'rename' || command in COLLECTION_BULK_COMMANDS)) return
    sheetOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setMenuOpen(false)
    if (command === 'make-folio') { if (manifestUnreadable) onStatus('The Folio manifest could not be read. Fix or move it before making a Folio.'); else if (!folio) makeFolio(); return }
    if (command === 'index') { if (data?.cover) onOpenPiece(data.cover.path); else createIndex(); return }
    if (command === 'clear') { setFilters(EMPTY_COLLECTION_FILTERS); return }
    if (command === 'clear-selection') { setSelection(new Set()); return }
    if (command === 'select-all') { setSelection(new Set(hits.map(hit => hit.row.path))); return }
    if (command === 'bulk-folio' && !canAddToFolio) { onStatus('Add documents from the Folio’s own collection folder.'); return }
    if (command === 'rename' || command in COLLECTION_BULK_COMMANDS) {
      if (command.startsWith('bulk-') && selectedPaths.length === 0) { onStatus('Select documents first.'); return }
      if (command === 'bulk-move' && sortedRows.some(row => row.folderPath && selectedPaths.includes(row.path))) { onStatus('Move folder pieces from Files so all their documents move together.'); return }
      if (command === 'bulk-move') setMoveFolders([])
      setSheet(command === 'rename' ? 'rename' : COLLECTION_BULK_COMMANDS[command as keyof typeof COLLECTION_BULK_COMMANDS]); setSheetValue(command === 'rename' ? data?.name ?? '' : command === 'bulk-move' ? NO_MOVE_DESTINATION : ''); setSheetError(''); return
    }
    setListFolio(true)
    // Palette dismissal restores its prior focus; focus this view after that restoration.
    requestAnimationFrame(() => {
      const control = pageRef.current?.querySelector<HTMLElement>(`[data-collection-control="${command}"]`)
      if (control?.tagName === 'DETAILS') { (control as HTMLDetailsElement).open = true; control.querySelector<HTMLElement>('input, button')?.focus() }
      else control?.focus()
    })
  }, [folio, manifestUnreadable, makeFolio, data, onOpenPiece, createIndex, hits, selectedPaths, sortedRows, onStatus, busy, canAddToFolio])
  useEffect(() => {
    const listener = (event: Event) => runPageCommand((event as CustomEvent<CollectionPageCommand>).detail)
    window.addEventListener(COLLECTION_PAGE_EVENT, listener)
    return () => window.removeEventListener(COLLECTION_PAGE_EVENT, listener)
  }, [runPageCommand])
  useEffect(() => {
    if (!menuOpen) return
    const outside = (event: PointerEvent) => { if (!(event.target as Element).closest('.cv-menu-anchor')) setMenuOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); pageRef.current?.querySelector<HTMLButtonElement>('.cv-menu-trigger')?.focus() } }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape)
    pageRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [menuOpen])
  const submitSheet = async () => {
    if (batchRunning.current || busy || !sheet || (sheet === 'move' ? !moveFolders.includes(sheetValue) : sheet !== 'folio' && !sheetValue.trim())) return
    setBusy(true); setSheetError(''); batchRunning.current = true; reloadPending.current = false
    try {
      if (sheet === 'rename') await onRename?.(sheetValue.trim())
      else {
        const result = await onBulkAction?.(sheet, selectedPaths, sheetValue.trim())
        if (!result) return
        setSelection(previous => new Set([...previous].filter(path => !result.succeeded.includes(path))))
        if (result.failed.length) { setSheetError(result.message); return }
      }
      if (!sheetErrorRef.current) setSheet(null)
    } catch (error) { setSheetError(error instanceof Error ? error.message : 'Could not finish. Try again.') }
    finally { batchRunning.current = false; setBusy(false); if (reloadPending.current) { reloadPending.current = false; reload() } }
  }
  const sheetNode = sheet && <CollectionActionSheet
    sheet={sheet}
    value={sheetValue}
    folders={moveFolders}
    folioName={data?.name ?? dir}
    busy={busy}
    error={sheetError}
    returnFocusTo={sheetOpener.current}
    fallbackFocus={() => pageRef.current?.querySelector<HTMLElement>('.cv-menu-trigger') ?? null}
    onChange={setSheetValue}
    onClose={() => { if (!batchRunning.current) setSheet(null) }}
    onSubmit={() => { void submitSheet() }}
  />
  const collectionMenu = <CollectionMenu hasCover={Boolean(data?.cover)} folio={folio !== null} open={menuOpen} onToggle={() => runPageCommand('menu')} onCommand={runPageCommand} onTurnBack={() => { setMenuOpen(false); onRunCommand?.('folio.turnBack') }} onAssemble={() => { setMenuOpen(false); onHelpWithReport?.(dir) }} onExport={() => { setMenuOpen(false); onRunCommand?.('export.document') }} />
  const createButtons = <><button className="ghost primary" onClick={() => onNewPiece(dir)}><FilePlus2 className="icon sm" />New document<kbd aria-hidden="true">{effectiveSheetChords(registryCommand('sheet.Files.2'), shortcutOverrides).join(' / ')}</kbd></button>{!showPlan && folio === null && onStartFolio && <button className="ghost" onClick={() => onStartFolio(dir)}><BookOpenText className="icon sm" />Start a Folio outline</button>}</>

  if (!data) return <div className="cv-scroll" aria-busy="true" />

  if (showPlan) return (
    <div ref={pageRef} className="cv-folio-page">{sheetNode}<PlanView headerActions={collectionMenu} createActions={createButtons} onOpenList={() => setListFolio(true)} openFolio={<FolioOpenButton parts={folioOpenParts(folio, plan, folioPieces)} onOpen={onOpenFolio ?? onOpenPiece} />} dir={dir} onOpenPiece={onOpenPiece} onStatus={onStatus} onOpenBoard={onOpenBoard} shortcutOverrides={shortcutOverrides} startWithComposer={startPlanComposer} manifestUnreadable={manifestUnreadable} {...(runningOrder ? { runningOrder } : {})} {...(onHelpWithReport ? { onHelpWithReport: () => onHelpWithReport(dir) } : {})} /></div>
  )

  const bareCount = sortedRows.filter((r) => r.bare).length
  const totalWords = sortedRows.reduce((sum, r) => sum + r.words, 0)
  const folderPieces = sortedRows.filter((row) => row.folderPath).length
  const subfolders = data.subfolders ?? []
  const firstBare = sortedRows.find((r) => r.bare) // follow the visible order, not disk order
  const columns: Array<{ key: SortKey; label: string }> = [
    { key: 'title', label: 'Title' },
    { key: 'status', label: 'Status' },
    { key: 'purpose', label: 'Purpose' },
    { key: 'words', label: 'Words' },
    { key: 'date', label: 'Modified' },
  ]

  return (
    <div className="cv-scroll cv-option-a" ref={pageRef}>{sheetNode}
    <div className="cv">
      <div className="cv-head">
        <FolderOpen className="icon" style={{ width: 22, height: 22 }} />
        <h1>{data.name}</h1>
        <span className="cv-badge">{manifestUnreadable ? 'Folio manifest unreadable' : folio ? 'Folio' : 'Collection'}</span>
        {collectionMenu}
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
            <button className="ghost" onClick={createIndex}>Create index note</button>
          </>
        )}
        <span>·</span><span>{sortedRows.length} {sortedRows.length === 1 ? 'document' : 'documents'} · {totalWords.toLocaleString('en-GB')} words</span>
      </div>

      {manifestUnreadable && <FolioManifestWarning />}
      <FolioAgentInstructions dir={dir} onOpenPiece={onOpenPiece} onStatus={onStatus} />

      <div className="cv-actions">{createButtons}
        <div className="seg-view" aria-label="Collection projection"><button aria-pressed="true"><List className="icon sm" />List</button><button onClick={onOpenBoard}><Columns3 className="icon sm" />Board</button>{folio && <button onClick={() => setListFolio(false)}><BookOpenText className="icon sm" />Folio outline</button>}</div>
        {dir === '' && !rootIsVault && onMakeVault && <button className="ghost" onClick={onMakeVault}>Make this folder a vault…</button>}
      </div>
      <CollectionFilterBar filters={filters} onChange={setFilters} facets={facets} group={group} onGroup={setGroup} sort={`${shownSort.key}:${shownSort.dir}`} onSort={value => { const [key, direction] = value.split(':'); setSort({ key: key as SortKey, dir: direction as 'asc' | 'desc' }) }} />

      <div className="cv-table" role="table" aria-label={`Pieces in ${data.name}`}>
        <div className="cv-tr cv-th" role="row">
          <input type="checkbox" aria-label="Select all matching documents" checked={hits.length > 0 && selectedPaths.length === hits.length} onChange={() => runPageCommand(selectedPaths.length === hits.length ? 'clear-selection' : 'select-all')} />
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
        {hits.length === 0 && (activeFilters || (data.subfolders ?? []).length === 0) ? (
          <div className="cv-empty">{activeFilters ? 'No documents match. Clear the search or filters to show more.' : 'No pieces in this folder yet.'}</div>
        ) : (
          groups.map(g => <div key={g.label} className="cv-row-group">{g.label && <div className="cv-group-heading">{g.label}<span>{g.rows.length}</span></div>}{[
            ...(!activeFilters && group === 'none' ? ordered.filter(entry => entry.item.sub) : []),
            ...g.rows.map(hit => entriesByPath.get(hit.row.path)!),
          ].map((entry, index, entries) => {
            const groupStart = index > 0 && entries[index - 1].isFolder && !entry.isFolder
            const { sub, row } = entry.item
            if (sub) return (
          <button
          key={`dir:${sub.path}`}
          className={`cv-tr cv-row cv-subfolder${groupStart ? ' group-start' : ''}`}
          title={sub.path}
          data-subfolder={sub.path}
          onFocus={() => onFolderPieceSelected(null)}
          onClick={() => onOpenFolder?.(sub.path)}
        >
          <span />
          <span className="cell title">
            <Folder className="icon sm" aria-label="Folder" />
            <span>{sub.title ?? sub.name}</span>
          </span>
          <span className="cell">{sub.status ? <StatusBadge status={sub.status} derived={false} /> : <span className="muted">—</span>}</span>
          <span className="cell muted">{subfolderPiecesText(sub.pieces)}</span><span className="cell muted">—</span>
          <span className="cell muted">{sub.modified > 0 ? relativeDate(sub.modified) : '—'}</span>
        </button>
            )
            if (!row) return null
            return (
            <div key={row.path} className={`cv-document${selection.has(row.path) ? ' selected' : ''}`}>
            <input type="checkbox" aria-label={`Select ${row.title ?? row.name}`} checked={selection.has(row.path)} onChange={() => setSelection(previous => { const next = new Set(previous); if (next.has(row.path)) next.delete(row.path); else next.add(row.path); return next })} />
            <button
              className={`cv-tr cv-row${row.folderPath ? ' folder-piece' : ''}${groupStart ? ' group-start' : ''}`}
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
                <span>{row.title ?? row.name}<CollectionSnippet text={snippets.get(row.path)} query={filters.query} /></span>
              </span>
              <span className="cell"><StatusBadge status={row.status} derived={row.provenance.status === 'derived'} /></span>
              <span className="cell">{row.purpose ? <span className={`pbadge${row.provenance.purpose === 'derived' ? ' derived' : ''}`}>{row.purpose}</span> : <span className="muted">—</span>}</span>
              <span className="cell cv-words">{row.words.toLocaleString('en-GB')}</span>
              <span className="cell muted">{relativeDate(row.modified)}</span>
            </button></div>
            )
          })}</div>)
        )}
      </div>

      {activeFilters && <p className="cv-match-count" role="status">{hits.length} of {sortedRows.length} {sortedRows.length === 1 ? 'document' : 'documents'} {hits.length === 1 ? 'matches' : 'match'}. {filters.query && 'Text matches show the sentence they were found in.'}<button onClick={() => runPageCommand('clear')}>Clear filters</button></p>}
      {selectedPaths.length > 0 && <div className="cv-bulk" role="toolbar" aria-label="Selected documents"><strong>{selectedPaths.length} selected</strong><button onClick={() => runPageCommand('bulk-status')}>Set status</button><button onClick={() => runPageCommand('bulk-move')}><ArrowRight className="icon sm" />Move to…</button>{canAddToFolio && <button onClick={() => runPageCommand('bulk-folio')}><BookOpenText className="icon sm" />Add to Folio…</button>}<button onClick={() => runPageCommand('bulk-tag')}><Tag className="icon sm" />Tag…</button><button onClick={() => runPageCommand('clear-selection')}>Clear <X className="icon sm" /></button></div>}
      <p className="cv-foot">
        {collectionFooterText({ pieces: sortedRows.length, folderPieces, subfolders: subfolders.length, words: totalWords })}
        {bareCount > 0 && firstBare && ` · ${firstBare.name} carries no frontmatter — bare files are welcome here.`}
      </p>
    </div>
    </div>
  )
}

export function CollectionSnippet({ text, query }: { text?: string | null; query: string }): JSX.Element | null {
  if (!text) return null
  const terms = query.trim().split(/\s+/).filter(Boolean)
  const escaped = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!escaped.length) return <small className="cv-snippet">{text}</small>
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi')
  return <small className="cv-snippet">{text.split(pattern).map((part, index) => (
    index % 2 ? <mark key={index}>{part}</mark> : part
  ))}</small>
}
