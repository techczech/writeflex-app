import type { RoomEditorRef } from './FolioRoomFlags'
import { BackControl, useEscapeBack } from './BackControl'
import type { CollectionBatchResult } from '../app/collection-bulk'
import { CollectionActionSheet, NO_MOVE_DESTINATION, type CollectionSheet } from './CollectionActionSheet'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BookMarked, BookOpenText, ChevronUp, Columns3, FilePlus2, FileText, Folder, FolderOpen, Library, List, Sparkles, Tag, ArrowRight, X } from 'lucide-react'
import type { Collection, CollectionRow, CollectionSubfolder } from '../../../preload'
import { effectiveSheetChords, type OverrideMap } from '../commands/chords'
import { PLAN_COMMAND_EVENT, type PlanCommandName } from '../plan/plan-commands'
import { FolioManifestWarning } from './PlanView'
import { FolioRoom, ROOM_VIEW_EVENT } from './FolioRoom'
import { useCollectionFolioEligibility } from './collection-folio-eligibility'
import type { RoomView } from '../../../preload'
import { subscribeRoom } from '../plan/folio-room-store'
import { announceRoom } from '../plan/room-on-screen'
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

type CollectionListing =
  | { dir: string; status: 'loading' | 'failed' }
  | { dir: string; status: 'ready' | 'refreshing'; data: Collection }

type SortKey = DashSortKey
type SortState = DashSort
type DashItem = { sub: CollectionSubfolder; row?: undefined } | { row: CollectionRow; sub?: undefined }

export type CollectionViewProps = {
  /** R10: the way back to the document the writer came from; absent when no document is open. */
  onBack?: () => void
  /** The collection folder, workspace-relative ('' = the workspace root). */
  dir: string
  onRunCommand?: (id: string) => void
  onExport?: (source: { dir: string; folio: boolean }) => void
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
  onReturnToFolio?: (dir: string) => void
  onFolderPieceSelected: (selection: { dir: string; folderPath: string; mode: 'one' | 'many' } | null) => void
  shortcutOverrides?: OverrideMap
  /** The Versions tab's Save Folio version… button: the same way in as File ▸ Save Folio Version… (ticket 04's guarded sheet). */
  onSaveFolioVersion?: (suggestedName?: string) => void
  /** Whether a part has typed text not yet saved (Compare's take, ticket 09). */
  partIsUnsaved?: (path: string) => boolean
  /** Ticket 17: accepts or declines a suggestion through the document owner's route, for the three texts of the decide step. */
  resolveSuggestion?: (change: { id: string; path: string }, action: 'accept' | 'reject') => Promise<{ applied: boolean; message?: string }>
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
  /** The Folio room's text pane wants this file shown in the app's editor (null: none wanted). App owns the editor. */
  onShowRoomText?: (path: string | null) => void
  /** The file the app's editor holds now, for the room's text pane. */
  roomTextLoaded?: string | null
  headingOutline?: ReactNode
  roomEditor?: RoomEditorRef
  /** The Board for this Folio, drawn inside the workspace's Cards tab (the app owns the Board's wiring). */
  renderBoard?: (folio: { dir: string; name: string; onLeave: () => void; onOutline: () => void }) => ReactNode
  /** Whether the Board is showing inside the workspace, so the app enables the Board's palette commands. */
  onBoardShown?: (shown: boolean) => void
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
export function CollectionView({ onBack, dir, onOpenPiece, onNewPiece, onStatus, onOpenBoard, onOpenFolder, onReturnToFolio, onFolderPieceSelected, shortcutOverrides = {}, openPlanRequested = false, onStartFolio, onHelpWithReport, onMakeVault, rootIsVault = false, runningOrder, onOpenFolio, onRunCommand, onExport, onRename, onBulkAction, canAddToFolio = false, onShowRoomText, roomTextLoaded, roomEditor, headingOutline, renderBoard, onBoardShown, onSaveFolioVersion, partIsUnsaved, resolveSuggestion }: CollectionViewProps): JSX.Element {
  const pageRef = useRef<HTMLDivElement>(null)
  useEscapeBack(onBack)
  // The vault's root page is titled with the vault's name, not its folder's, and is not "a Collection" (house rule R4).
  const [vaultName, setVaultName] = useState<string | null>(null)
  useEffect(() => {
    if (dir !== '' || !rootIsVault) { setVaultName(null); return }
    let live = true
    void window.writeflex.vault.get().then((vault) => { if (live) setVaultName(vault?.settings.name ?? null) }, () => undefined)
    const off = window.writeflex.vault.onChanged((event) => { if (live) setVaultName(event.vault?.settings.name ?? null) })
    return () => { live = false; off() }
  }, [dir, rootIsVault])
  const [filters, setFilters] = useState(EMPTY_COLLECTION_FILTERS)
  const [group, setGroup] = useState<CollectionGroup>('none')
  const [menuOpen, setMenuOpen] = useState(false)
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
  const [listing, setListing] = useState<CollectionListing>({ dir, status: 'loading' })
  const currentListing = listing.dir === dir ? listing : null
  const listReady = currentListing?.status === 'ready'
  const data = currentListing && 'data' in currentListing ? currentListing.data : null
  const mountedListing = useRef<{ dir: string; latest: number } | null>(null)
  const {
    read: readFolioEligibility, isCurrent: eligibilityIsCurrent, surface, folio, folioParent, isFolio,
    manifestUnreadable, repairNeeded, planError, planCommandError, canMakeFolio, canStartOutline,
  } = useCollectionFolioEligibility(dir, openPlanRequested)
  // A Folio opens as the workspace (ADR-0049). The tab on screen is the workspace's own.
  const [roomView, setRoomView] = useState<RoomView | null>(null)
  // null = the folder's NATURAL order: a Folio's manifest compile-order, else newest-first (mockup
  // default). A concrete SortState means the writer clicked a column and took over the ordering.
  const [sort, setSort] = useState<SortState | null>(null)

  useLayoutEffect(() => {
    mountedListing.current = { dir, latest: 0 }
    return () => { mountedListing.current = null }
  }, [dir])
  const loadListing = useCallback(() => {
    const mounted = mountedListing.current
    if (mounted?.dir !== dir) return
    const request = ++mounted.latest
    const isCurrent = () => mountedListing.current === mounted && mounted.latest === request
    // Keep the same folder's rows mounted so a refresh cannot blur the writer's focused row.
    setListing(previous => previous.dir === dir && 'data' in previous
      ? { ...previous, status: 'refreshing' }
      : { dir, status: 'loading' })
    void window.writeflex.listCollection(dir, { includeSearchText: true }).then((result) => {
      if (isCurrent()) setListing({ dir, status: 'ready', data: result })
    }, () => {
      if (!isCurrent()) return
      setListing({ dir, status: 'failed' })
      setSheet(null)
    })
  }, [dir])

  const reload = useCallback(() => {
    loadListing()
    readFolioEligibility()
  }, [loadListing, readFolioEligibility])
  useEffect(() => { reload() }, [reload])
  // The room owns refreshes while it is on screen. The wrapper reads again when the room
  // is unavailable, when it leaves, or while its embedded Files tab is showing.
  const roomOnScreenRef = useRef(false)
  const roomOpensRef = useRef(false)
  useEffect(() => window.writeflex.onCollectionChanged(() => {
    if (roomOnScreenRef.current) return
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
  const roomOpens = surface === 'workspace'
  // The Files tab lists the folder, so it reads it (and every change to it) like the list does; the other tabs take the room's one read.
  roomOnScreenRef.current = roomOpens && roomView !== 'files'
  roomOpensRef.current = roomOpens
  useEffect(() => { if (roomOpens && roomView === 'files') reload() }, [roomOpens, roomView, reload])
  const previousRoomDir = useRef<string | null>(null)
  useEffect(() => {
    if (!roomOpens) {
      // Back from the room: what changed while it was the reader is read now.
      if (previousRoomDir.current === dir) reload()
      previousRoomDir.current = null
      return
    }
    previousRoomDir.current = dir
    return subscribeRoom(dir, (answer) => { if ('error' in answer || answer.model === null) reload() })
  }, [roomOpens, dir, reload])
  useEffect(() => {
    // Only a room announces itself (and its leaving), to the sidebar's binder.
    if (!roomOpens) return
    announceRoom(dir)
    return () => announceRoom(null)
  }, [roomOpens, dir])
  const startOutline = useCallback(() => {
    if (canStartOutline && eligibilityIsCurrent()) onStartFolio?.(dir)
  }, [canStartOutline, eligibilityIsCurrent, onStartFolio, dir])
  useLayoutEffect(() => {
    const onPlanCommand = (event: Event): void => {
      if (!eligibilityIsCurrent() || roomOpens) return
      if (planCommandError) { onStatus(planCommandError); return }
      // In an undeclared Collection, "Add a part" starts a Folio.
      if ((event as CustomEvent<PlanCommandName>).detail === 'add') startOutline()
    }
    window.addEventListener(PLAN_COMMAND_EVENT, onPlanCommand)
    return () => window.removeEventListener(PLAN_COMMAND_EVENT, onPlanCommand)
  }, [eligibilityIsCurrent, roomOpens, planCommandError, onStatus, startOutline])

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
  useEffect(() => { setFilters(EMPTY_COLLECTION_FILTERS); setSelection(new Set()); setGroup('none'); setSort(null); setMenuOpen(false); setSheet(null); setRoomView(null) }, [dir])
  useEffect(() => {
    if (data) setSelection(previous => new Set([...previous].filter(path => visiblePaths.has(path))))
  }, [data, visiblePaths])
  const runPageCommand = useCallback((command: CollectionPageCommand) => {
    if (command === 'menu') { setMenuOpen(value => !value); return }
    if (busy && (command === 'rename' || command in COLLECTION_BULK_COMMANDS)) return
    sheetOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setMenuOpen(false)
    if (command === 'make-folio') {
      if (!eligibilityIsCurrent()) return
      if (!canMakeFolio && !repairNeeded) { onStatus('This folder is already inside a Folio.'); return }
      if (manifestUnreadable) onStatus('The Folio manifest could not be read. Fix or move it before making a Folio.')
      else if (!folio) makeFolio()
      return
    }
    if (command === 'index') {
      if (!listReady) return
      if (data?.cover) onOpenPiece(data.cover.path)
      else createIndex()
      return
    }
    if (command === 'clear') { setFilters(EMPTY_COLLECTION_FILTERS); return }
    if (command === 'clear-selection') { setSelection(new Set()); return }
    if (command === 'select-all') { setSelection(new Set(hits.map(hit => hit.row.path))); return }
    if (command === 'bulk-folio' && !canAddToFolio) { onStatus('Add pieces from the Folio’s own collection folder.'); return }
    if (command === 'rename' || command in COLLECTION_BULK_COMMANDS) {
      if (!data || !listReady) return
      if (command.startsWith('bulk-') && selectedPaths.length === 0) { onStatus('Select pieces first.'); return }
      if (command === 'bulk-move' && sortedRows.some(row => row.folderPath && selectedPaths.includes(row.path))) { onStatus('Move folder pieces from Files so all their documents move together.'); return }
      if (command === 'bulk-move') setMoveFolders([])
      setSheet(command === 'rename' ? 'rename' : COLLECTION_BULK_COMMANDS[command as keyof typeof COLLECTION_BULK_COMMANDS]); setSheetValue(command === 'rename' ? data.name : command === 'bulk-move' ? NO_MOVE_DESTINATION : ''); setSheetError(''); return
    }
    // The folder's controls live in the Files tab of a Folio's workspace.
    if (roomOpensRef.current) window.dispatchEvent(new CustomEvent(ROOM_VIEW_EVENT, { detail: 'files' }))
    // Palette dismissal restores its prior focus; focus this view after that restoration.
    requestAnimationFrame(() => {
      const control = pageRef.current?.querySelector<HTMLElement>(`[data-collection-control="${command}"]`)
      if (control?.tagName === 'DETAILS') { (control as HTMLDetailsElement).open = true; control.querySelector<HTMLElement>('input, button')?.focus() }
      else control?.focus()
    })
  }, [folio, manifestUnreadable, makeFolio, data, listReady, onOpenPiece, createIndex, hits, selectedPaths, sortedRows, onStatus, busy, canAddToFolio, canMakeFolio, repairNeeded, eligibilityIsCurrent])
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
    pageRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [menuOpen])
  const submitSheet = async () => {
    if (batchRunning.current || busy || !listReady || !sheet || (sheet !== 'rename' && !selectedPaths.length)) return
    if (sheet === 'move' ? !moveFolders.includes(sheetValue) : sheet !== 'folio' && !sheetValue.trim()) return
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
  const sheetNode = listReady && data && sheet && <CollectionActionSheet
    sheet={sheet}
    value={sheetValue}
    folders={moveFolders}
    folioName={data.name}
    busy={busy}
    error={sheetError}
    returnFocusTo={sheetOpener.current}
    fallbackFocus={() => pageRef.current?.querySelector<HTMLElement>('.cv-menu-trigger') ?? null}
    onChange={setSheetValue}
    onClose={() => { if (!batchRunning.current) setSheet(null) }}
    onSubmit={() => { void submitSheet() }}
  />
  const collectionMenu = <CollectionMenu listReady={listReady} canCreateFolio={canMakeFolio} hasCover={Boolean(data?.cover)} folio={isFolio} open={menuOpen} onToggle={() => runPageCommand('menu')} onCommand={runPageCommand} onTurnBack={() => { setMenuOpen(false); onRunCommand?.('folio.turnBack') }} onAssemble={() => { setMenuOpen(false); onHelpWithReport?.(dir) }} onExport={() => { setMenuOpen(false); onExport?.({ dir, folio: isFolio || manifestUnreadable }) }} />
  const createButtons = <><button className="ghost primary" onClick={() => onNewPiece(dir)}><FilePlus2 className="icon sm" />New piece<kbd aria-hidden="true">{effectiveSheetChords(registryCommand('sheet.Files.2'), shortcutOverrides).join(' / ')}</kbd></button>{canStartOutline && onStartFolio && <button className="ghost" onClick={startOutline}><BookOpenText className="icon sm" />Start a Folio outline</button>}</>

  if (surface === 'loading') {
    return <div className="cv-scroll"><div className="cv-empty" role="status">Loading files…</div></div>
  }

  const bareCount = sortedRows.filter((r) => r.bare).length
  const totalWords = sortedRows.reduce((sum, r) => sum + r.words, 0)
  const folderPieces = sortedRows.filter((row) => row.folderPath).length
  const subfolders = data?.subfolders ?? []
  const folderName = vaultName ?? data?.name ?? (dir.split('/').at(-1) || 'Workspace folder')
  const firstBare = sortedRows.find((r) => r.bare) // follow the visible order, not disk order
  const columns: Array<{ key: SortKey; label: string }> = [
    { key: 'title', label: 'Title' },
    { key: 'status', label: 'Status' },
    { key: 'purpose', label: 'Purpose' },
    { key: 'words', label: 'Words' },
    { key: 'date', label: 'Modified' },
  ]

  // The list is the Collection view of the folder. A Folio shows it as the workspace's Files tab (`embedded`: the
  // workspace has the header, the menu and the action sheet); any other folder shows it as its own page.
  const openAncestor = (path: string) => {
    if (path === folioParent) (onReturnToFolio ?? onOpenFolder)?.(path)
    else onOpenFolder?.(path)
  }
  const renderList = (embedded: boolean): JSX.Element => (
    <div className="cv-scroll cv-option-a" ref={embedded ? undefined : pageRef}>{!embedded && sheetNode}
    <div className="cv">
      {!embedded && folioParent !== undefined && folioParent !== null && folioParent !== dir && <nav className="cv-folio-navigation" aria-label="Folio folders">
        <button className="ghost" onClick={() => openAncestor(dir.split('/').slice(0, -1).join('/'))}>↑ Up a level</button>
        <button className="ghost" onClick={() => openAncestor(folioParent)}>Return to the Folio</button>
        <span aria-hidden="true">/</span>
        <button className="ghost" onClick={() => openAncestor(folioParent)}>{folioParent.split('/').at(-1) || 'Folio'}</button>
        {(folioParent === '' ? dir : dir.slice(folioParent.length + 1)).split('/').map((name, at, parts) => {
          const path = [folioParent, ...parts.slice(0, at + 1)].filter(Boolean).join('/')
          return <span key={path}><span aria-hidden="true"> / </span><button className="ghost" aria-current={path === dir ? 'page' : undefined} onClick={() => openAncestor(path)}>{name}</button></span>
        })}
      </nav>}
      {!embedded && onBack && <div className="cv-back"><BackControl onBack={onBack} /></div>}
      {!embedded && <div className="cv-head">
        <FolderOpen className="icon" style={{ width: 22, height: 22 }} />
        <h1>{folderName}</h1>
        {(vaultName === null || manifestUnreadable || folio) && <span className="cv-badge">{manifestUnreadable ? 'Folio manifest unreadable' : folio ? 'Folio' : 'Collection'}</span>}
        {collectionMenu}
      </div>}

      {data?.cover?.text && <p className="cv-cover">{data.cover.text}</p>}

      {data && <div className="cv-src">
        <BookOpenText className="icon sm" />
        {data.cover ? (
          <>
            Cover from&nbsp;<strong>{data.cover.source}</strong>
            <button className="ghost" onClick={() => onOpenPiece(data.cover!.path)}>Edit</button>
          </>
        ) : (
          <>
            No cover note yet
            <button className="ghost" disabled={!listReady} onClick={createIndex}>Create index note</button>
          </>
        )}
        <span>·</span><span>{sortedRows.length} {sortedRows.length === 1 ? 'piece' : 'pieces'} · {totalWords.toLocaleString('en-GB')} words</span>
      </div>}

      {manifestUnreadable && <FolioManifestWarning />}
      {planError && <div className="cv-warn" role="alert" data-plan-read-failed="true">{planError}</div>}
      <FolioAgentInstructions dir={dir} onOpenPiece={onOpenPiece} onStatus={onStatus} />

      {repairNeeded && <div role="status" className="cv-actions"><span>Turn back was unfinished. Your saved running order is still here.</span><button className="ghost" onClick={() => onRunCommand?.('folio.turnBack')}>Finish Turn back</button><button className="ghost" onClick={() => runPageCommand('make-folio')}>Make Folio again</button></div>}
      <div className="cv-actions">{createButtons}
        <div className="seg-view" aria-label="Collection projection"><button aria-pressed="true"><List className="icon sm" />List</button>{!roomOpens && <button onClick={onOpenBoard}><Columns3 className="icon sm" />Board</button>}</div>
        {dir === '' && !rootIsVault && onMakeVault && <button className="ghost" onClick={onMakeVault}>Make this folder a vault…</button>}
      </div>
      <CollectionFilterBar filters={filters} onChange={setFilters} facets={data ? facets : null} group={group} onGroup={setGroup} sort={`${shownSort.key}:${shownSort.dir}`} onSort={value => { const [key, direction] = value.split(':'); setSort({ key: key as SortKey, dir: direction as 'asc' | 'desc' }) }} />

      {data && <>
      <div className="cv-table" role="table" aria-label={`Pieces in ${data.name}`}>
        <div className="cv-tr cv-th" role="row">
          <input type="checkbox" aria-label="Select all matching pieces" checked={hits.length > 0 && selectedPaths.length === hits.length} onChange={() => runPageCommand(selectedPaths.length === hits.length ? 'clear-selection' : 'select-all')} />
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
        {hits.length === 0 && (activeFilters || subfolders.length === 0) ? (
          <div className="cv-empty">{data.rows.length > 0 || subfolders.length > 0 ? 'No pieces match. Clear the search or filters to show more.' : 'No pieces in this folder yet.'}</div>
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

      {activeFilters && <p className="cv-match-count" role="status">{hits.length} of {sortedRows.length} {sortedRows.length === 1 ? 'piece' : 'pieces'} {hits.length === 1 ? 'matches' : 'match'}. {filters.query && 'Text matches show the sentence they were found in.'}<button onClick={() => runPageCommand('clear')}>Clear filters</button></p>}
      {listReady && selectedPaths.length > 0 && <div className="cv-bulk" role="toolbar" aria-label="Selected pieces"><strong>{selectedPaths.length} selected</strong><button onClick={() => runPageCommand('bulk-status')}>Set status</button><button onClick={() => runPageCommand('bulk-move')}><ArrowRight className="icon sm" />Move to…</button>{canAddToFolio && <button onClick={() => runPageCommand('bulk-folio')}><BookOpenText className="icon sm" />Add to Folio…</button>}<button onClick={() => runPageCommand('bulk-tag')}><Tag className="icon sm" />Tag…</button><button onClick={() => runPageCommand('clear-selection')}>Clear <X className="icon sm" /></button></div>}
      <p className="cv-foot">
        {collectionFooterText({ pieces: sortedRows.length, folderPieces, subfolders: subfolders.length, words: totalWords })}
        {bareCount > 0 && firstBare && ` · ${firstBare.name} carries no frontmatter — bare files are welcome here.`}
      </p>
      </>}
      {currentListing?.status === 'failed' ? (
        <div className="cv-empty cv-list-problem" role="alert">
          <span>Could not list files in {dir || folderName}.</span>
          <button type="button" className="ghost" onClick={loadListing}>Try again</button>
        </div>
      ) : !listReady && <div className="cv-empty" role="status">Loading files…</div>}
    </div>
    </div>
  )
  if (roomOpens) return (
    <div ref={pageRef} className="cv-folio-page">{sheetNode}<FolioRoom onOpenFolio={onOpenFolio} headingOutline={headingOutline} editor={roomEditor} dir={dir} onOpenPiece={onOpenPiece} onStatus={onStatus} onViewChange={setRoomView} files={() => renderList(true)} {...(renderBoard ? { board: renderBoard } : {})} {...(onBoardShown ? { onBoardShown } : {})} headerActions={collectionMenu} {...(onShowRoomText ? { onShowText: onShowRoomText } : {})} textLoaded={roomTextLoaded ?? null} {...(runningOrder ? { runningOrder } : {})} shortcutOverrides={shortcutOverrides} {...(onSaveFolioVersion ? { onSaveFolioVersion } : {})} {...(partIsUnsaved ? { partIsUnsaved } : {})} {...(resolveSuggestion ? { resolveSuggestion } : {})} /></div>
  )
  return renderList(false)
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
