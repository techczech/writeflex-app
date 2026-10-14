import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { ArrowRight, Bot, Check, Clock3, Columns3, Eye, FilePlus2, Flame, Folder, ListOrdered, ListPlus, ListTree } from 'lucide-react'
import type { BoardStepResult, DrawerScrap, FileReadResult, Offcut, QueryRow } from '../../../preload'
import { REFERENCE_STATUS_ORDER, UNSORTED_STATUS } from '../../../shared/collection-status'
import { projectionQuerySource } from '../../../shared/query-source'
import { humanReadableError } from '../error-text'
import { boardAge, boardOffcuts, boardSources, groupBoardRows, isOffcutKey, isSourceKey, offcutKey, sourceKey, type BoardSource } from './board-projection'
import { BoardCardChips, BoardCardDrawer, BoardCardTasks } from './BoardCardMaterial'
import { BoardActivity, OffcutNamer, OffcutsColumn, OFFCUT_DRAG_MIME, type BoardActivityRow } from './BoardOffcuts'
import { offcutsHidden, setOffcutsHidden, setSourcesCollapsed, sourcesCollapsed } from './board-view-state'
import { SOURCE_DRAG_MIME, SourceCarryHint, SourcesRail } from './BoardSources'
import { BOARD_COMMAND_EVENT, type BoardCommandName } from './board-commands'
import type { QueryInsertionContext } from './Rail'
import { useDragAutoScroll } from './useDragAutoScroll'

export type BoardProps = {
  dir: string
  name: string
  filter: string
  onOpenPiece: (path: string) => void
  onNewPiece: (dir: string) => void
  onStatus: (message: string) => void
  /** List the sources of the selected card's piece (palette command "List this piece's sources"). */
  onListSources?: (path: string, dir: string) => void
  onPieceChanged: (file: FileReadResult) => void
  seenStatuses: Set<string>
  onFolderPieceSelected: (selection: { dir: string; folderPath: string; mode: 'one' } | null) => void
  onQueryContext: (context: QueryInsertionContext) => void
  onInsertQuery: (context: QueryInsertionContext) => void
  onOpenPlan: () => void
}

function includesFilter(row: QueryRow, filter: string): boolean {
  const needle = filter.trim().toLocaleLowerCase()
  return needle === '' || row.title.toLocaleLowerCase().includes(needle) || row.description?.toLocaleLowerCase().includes(needle) === true
}

/** The Board page is a renderer-only projection of collection.query('', …), never a second engine. */
export function Board({ dir, name, filter, onOpenPiece, onNewPiece, onStatus, onListSources, onPieceChanged, seenStatuses, onFolderPieceSelected, onQueryContext, onInsertQuery, onOpenPlan }: BoardProps): JSX.Element {
  const [rows, setRows] = useState<QueryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  // One selection across the Board: a piece by its path, an offcut by its offcutKey, a source by its sourceKey.
  const [selected, setSelected] = useState<string | null>(null)
  const selectedPath = selected !== null && !isOffcutKey(selected) && !isSourceKey(selected) ? selected : null
  const setSelectedPath = setSelected
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [dragOffcut, setDragOffcut] = useState<Offcut | null>(null)
  const [showOffcuts, setShowOffcuts] = useState(() => !offcutsHidden(dir))
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  // The Sources rail (frames 1, 4, 7, 8): shown or collapsed per collection; a source being dragged,
  // the card under it, and a source picked up with the keyboard (⌥←) waiting for a card and ⏎.
  const [sourcesShown, setSourcesShown] = useState(() => !sourcesCollapsed(dir))
  const [dragSource, setDragSource] = useState<BoardSource | null>(null)
  const [overCard, setOverCard] = useState<string | null>(null)
  const [carrying, setCarrying] = useState<BoardSource | null>(null)
  // Offcut to idea, step one (frame 2): the offcut being named, the name, and a refusal to show.
  const [naming, setNaming] = useState<{ offcut: Offcut; name: string; error: string | null } | null>(null)
  const [stepBusy, setStepBusy] = useState(false)
  // The activity row (frame 3): the last Board step and, while it holds one, its Undo.
  const [activity, setActivity] = useState<BoardActivityRow | null>(null)
  const [overStatus, setOverStatus] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  // One card's drawer is open at a time: the listing of what that piece is made of (scraps, sources).
  const [drawerPath, setDrawerPath] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const colsRef = useRef<HTMLDivElement | null>(null)
  useDragAutoScroll(colsRef, dragPath !== null || dragOffcut !== null || dragSource !== null)
  for (const row of rows) {
    const status = row.status?.trim()
    if (status) seenStatuses.add(status)
  }

  const reload = useCallback(async () => {
    try {
      const result = await window.writeflex.collection.query(dir, '')
      if (!result.ok) throw new Error(result.error.humanReadable)
      setRows(result.rows)
      setError(false)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [dir])

  useEffect(() => {
    setLoading(true)
    void reload()
    return window.writeflex.collection.onChanged(() => { void reload() })
  }, [reload])

  useEffect(() => {
    requestAnimationFrame(() => rootRef.current?.focus())
  }, [dir, loading])

  useEffect(() => {
    setShowOffcuts(!offcutsHidden(dir))
    setSourcesShown(!sourcesCollapsed(dir))
    setCarrying(null)
    setNaming(null)
    setActivity(null)
  }, [dir])

  const columns = useMemo(() => groupBoardRows(rows, seenStatuses).map((column) => ({
    ...column,
    rows: column.rows.filter((row) => includesFilter(row, filter)),
  })), [rows, filter, seenStatuses])
  const shownRows = useMemo(() => columns.flatMap((column) => column.rows), [columns])
  const offcuts = useMemo(() => boardOffcuts(rows).filter((offcut) => {
    const needle = filter.trim().toLocaleLowerCase()
    return needle === '' || offcut.text.toLocaleLowerCase().includes(needle) || offcut.originTitle.toLocaleLowerCase().includes(needle)
  }), [rows, filter])
  const sources = useMemo(() => boardSources(rows).filter((source) => {
    const needle = filter.trim().toLocaleLowerCase()
    return needle === '' || source.title.toLocaleLowerCase().includes(needle)
  }), [rows, filter])
  // The Offcuts column stands just before Idea (frame 1), and the Sources rail after the last stage;
  // keyboard columns follow the same order.
  const ideaIndex = columns.findIndex((column) => column.status.toLocaleLowerCase() === 'idea')
  const navColumns = useMemo(() => {
    const keys = columns.map((column) => column.rows.map((row) => row.path))
    if (showOffcuts) keys.splice(ideaIndex < 0 ? 0 : ideaIndex, 0, offcuts.map(offcutKey))
    if (sourcesShown) keys.push(sources.map(sourceKey))
    return keys
  }, [columns, ideaIndex, offcuts, showOffcuts, sources, sourcesShown])
  const selectedOffcut = selected !== null && isOffcutKey(selected) ? offcuts.find((offcut) => offcutKey(offcut) === selected) ?? null : null
  const selectedSource = selected !== null && isSourceKey(selected) ? sources.find((source) => sourceKey(source) === selected) ?? null : null
  const queryContextFor = useCallback((status: string): QueryInsertionContext => ({
    label: status,
    source: projectionQuerySource({ dir, status }),
    ...(filter.trim() ? { notice: 'Current filter not included.' } : {}),
  }), [dir, filter])

  useEffect(() => {
    const selected = selectedPath ? rows.find((row) => row.path === selectedPath) : null
    const status = selected?.status?.trim() || columns.find((column) => column.rows.length > 0)?.status
    if (status) onQueryContext(queryContextFor(status))
  }, [columns, onQueryContext, queryContextFor, rows, selectedPath])

  useEffect(() => {
    if (selected && !navColumns.some((keys) => keys.includes(selected))) setSelected(null)
  }, [navColumns, selected])

  useEffect(() => {
    const row = selectedPath ? rows.find((piece) => piece.path === selectedPath) : undefined
    onFolderPieceSelected(row?.folderPath ? { dir, folderPath: row.folderPath, mode: 'one' } : null)
  }, [dir, onFolderPieceSelected, rows, selectedPath])

  const moveToStatus = useCallback(async (path: string, status: string) => {
    if (moving) return
    const row = rows.find((piece) => piece.path === path)
    if (!row || row.status?.trim().toLocaleLowerCase() === status.toLocaleLowerCase()) return
    setMoving(true)
    setSelectedPath(path)
    try {
      const saved = await window.writeflex.collection.setStatus(dir, path, status)
      onPieceChanged(saved)
      await reload()
    } catch (error: unknown) {
      onStatus(humanReadableError(error, 'Could not move that Piece to the new stage.'))
    } finally {
      setMoving(false)
      setDragPath(null)
      setOverStatus(null)
      requestAnimationFrame(() => rootRef.current?.focus())
    }
  }, [dir, moving, onPieceChanged, onStatus, reload, rows])

  const moveStage = useCallback((direction: 1 | -1) => {
    if (!selectedPath) return
    const row = rows.find((piece) => piece.path === selectedPath)
    const index = columns.findIndex((column) => column.status.toLocaleLowerCase() === row?.status?.trim().toLocaleLowerCase())
    const target = columns[index + direction]?.status
    if (target) void moveToStatus(selectedPath, target)
  }, [columns, moveToStatus, rows, selectedPath])

  const selectVertical = useCallback((direction: 1 | -1) => {
    const flat = navColumns.flat()
    if (!selected) {
      setSelected(flat[direction === 1 ? 0 : flat.length - 1] ?? null)
      return
    }
    const column = navColumns.find((keys) => keys.includes(selected))
    if (!column) return
    const index = column.indexOf(selected)
    const target = column[Math.max(0, Math.min(column.length - 1, index + direction))]
    if (target) setSelected(target)
  }, [navColumns, selected])

  const selectColumn = useCallback((direction: 1 | -1) => {
    if (!selected) {
      setSelected(navColumns.flat()[0] ?? null)
      return
    }
    const currentColumn = navColumns.findIndex((keys) => keys.includes(selected))
    const currentRow = navColumns[currentColumn]?.indexOf(selected) ?? 0
    for (let index = currentColumn + direction; index >= 0 && index < navColumns.length; index += direction) {
      const target = navColumns[index][Math.min(Math.max(currentRow, 0), navColumns[index].length - 1)]
      if (target) {
        setSelected(target)
        return
      }
    }
  }, [navColumns, selected])

  const startNaming = useCallback((offcut: Offcut) => {
    setSelected(offcutKey(offcut))
    setNaming({ offcut, name: offcut.suggestedName, error: null })
  }, [])

  const cancelNaming = useCallback(() => {
    setNaming(null)
    requestAnimationFrame(() => rootRef.current?.focus())
  }, [])

  const afterStep = useCallback(async (result: BoardStepResult) => {
    if (result.ok) {
      setActivity({ text: result.step.activity, stepId: result.step.id, ...(result.step.kind === 'source' ? { tone: 'source' as const } : {}) })
      await reload()
    }
    return result
  }, [reload])

  const makeIdea = useCallback(async () => {
    if (!naming || stepBusy) return
    setStepBusy(true)
    try {
      const result = await afterStep(await window.writeflex.boardMaterial.promoteOffcut({
        dir, scrapsPath: naming.offcut.scrapsPath, scrapId: naming.offcut.id, name: naming.name,
      }))
      if (result.ok) {
        setNaming(null)
        requestAnimationFrame(() => rootRef.current?.focus())
      } else setNaming((current) => current && { ...current, error: result.message })
    } catch (error: unknown) {
      setNaming((current) => current && { ...current, error: humanReadableError(error, 'Could not make the idea.') })
    } finally {
      setStepBusy(false)
    }
  }, [afterStep, dir, naming, stepBusy])

  const appendScrap = useCallback(async (piece: string, scrap: DrawerScrap) => {
    if (stepBusy) return
    setStepBusy(true)
    try {
      const result = await afterStep(await window.writeflex.boardMaterial.appendScrap({ piece, scrapId: scrap.id }))
      if (!result.ok) setActivity({ text: result.message, stepId: null, refused: true })
    } catch (error: unknown) {
      setActivity({ text: humanReadableError(error, 'Could not add the scrap to the piece.'), stepId: null, refused: true })
    } finally {
      setStepBusy(false)
      requestAnimationFrame(() => rootRef.current?.focus())
    }
  }, [afterStep, stepBusy])

  // Attach a source to a piece (frame 4): one line in its sources: list, one undoable step. A source
  // the list already names is refused by main, and the activity row says so.
  const attachSource = useCallback(async (piece: string, source: BoardSource) => {
    setCarrying(null)
    setDragSource(null)
    setOverCard(null)
    if (stepBusy) return
    setStepBusy(true)
    setSelected(piece)
    try {
      const result = await afterStep(await window.writeflex.boardMaterial.attachSource({ dir, piece, source: source.path }))
      if (!result.ok) setActivity({ text: result.message, stepId: null, refused: true })
    } catch (error: unknown) {
      setActivity({ text: humanReadableError(error, 'Could not attach the source.'), stepId: null, refused: true })
    } finally {
      setStepBusy(false)
      requestAnimationFrame(() => rootRef.current?.focus())
    }
  }, [afterStep, dir, stepBusy])

  const undoStep = useCallback(async (id: string | null = activity?.stepId ?? null) => {
    if (!id || stepBusy) return
    setStepBusy(true)
    try {
      const result = await window.writeflex.boardMaterial.undo(id)
      if (result.ok) {
        setActivity(null)
        onStatus(result.paths.length === 1 ? 'Undone: the file is as it was.' : 'Undone: both files are as they were.')
        await reload()
      } else setActivity({ text: result.message, stepId: null, refused: true })
    } catch (error: unknown) {
      setActivity({ text: humanReadableError(error, 'Could not undo that step.'), stepId: null, refused: true })
    } finally {
      setStepBusy(false)
      requestAnimationFrame(() => rootRef.current?.focus())
    }
  }, [activity, onStatus, reload, stepBusy])

  const toggleOffcuts = useCallback(() => {
    setShowOffcuts((shown) => {
      setOffcutsHidden(dir, shown)
      return !shown
    })
    setViewMenuOpen(false)
  }, [dir])

  const toggleSources = useCallback(() => {
    setSourcesShown((shown) => {
      setSourcesCollapsed(dir, shown)
      return !shown
    })
    setCarrying(null)
    setViewMenuOpen(false)
  }, [dir])

  // Palette commands on the Board's selection (board-commands.ts).
  const commandRef = useRef<(command: BoardCommandName) => void>(() => {})
  commandRef.current = (command) => {
    if (command === 'toggle-offcuts') toggleOffcuts()
    else if (command === 'toggle-sources') toggleSources()
    else if (command === 'attach-source') {
      if (carrying && selectedPath) void attachSource(selectedPath, carrying)
      else if (selectedSource) setCarrying(selectedSource)
      else onStatus(sourcesShown ? 'Select a source in the Sources rail first.' : 'Show the Sources rail and select a source first.')
    }
    else if (command === 'list-sources') {
      if (selectedPath && onListSources) onListSources(selectedPath, dir)
      else onStatus('Select a card on the Board first.')
    }
    else if (command === 'undo-step') {
      if (activity?.stepId) void undoStep(activity.stepId)
      else onStatus('There is no offcut, scrap or source step to undo.')
    } else if (command === 'make-idea') {
      if (selectedOffcut) startNaming(selectedOffcut)
      else onStatus('Select an offcut in the Offcuts column first.')
    }
  }
  useEffect(() => {
    const listener = (event: Event) => commandRef.current((event as CustomEvent<BoardCommandName>).detail)
    window.addEventListener(BOARD_COMMAND_EVENT, listener)
    return () => window.removeEventListener(BOARD_COMMAND_EVENT, listener)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return
    // ⌘⇧Z on the Board takes back its last step, as it takes back the agent's turn in the agent panel.
    if (event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey && event.key.toLowerCase() === 'z') {
      if (!activity?.stepId) return
      event.preventDefault()
      void undoStep(activity.stepId)
      return
    }
    // A source picked up with ⌥← waits for a card: ⏎ on a card attaches it, Esc lets it go.
    if (carrying && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setCarrying(null)
      return
    }
    if (carrying && event.key === 'Enter' && selectedPath) {
      event.preventDefault()
      void attachSource(selectedPath, carrying)
      return
    }
    if (selectedSource && event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault()
      setCarrying(selectedSource)
      return
    }
    if (selectedSource && event.key === 'Enter') {
      event.preventDefault()
      onOpenPiece(selectedSource.path)
      return
    }
    if (selectedOffcut && event.altKey && event.key === 'ArrowRight') {
      event.preventDefault()
      startNaming(selectedOffcut)
      return
    }
    if (selectedOffcut && event.key === 'Enter') {
      event.preventDefault()
      onOpenPiece(selectedOffcut.origin)
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      selectVertical(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const direction = event.key === 'ArrowRight' ? 1 : -1
      if (event.altKey) moveStage(direction)
      else selectColumn(direction)
    } else if (event.key === 'Enter' && selectedPath) {
      event.preventDefault()
      onOpenPiece(selectedPath)
    } else if (event.key === ' ' && selectedPath) {
      const row = rows.find((piece) => piece.path === selectedPath)
      if (!row?.drawer) return
      event.preventDefault()
      setDrawerPath((open) => open === selectedPath ? null : selectedPath)
    }
  }

  const startOffcutDrag = (event: DragEvent, offcut: Offcut): void => {
    setSelected(offcutKey(offcut))
    setDragOffcut(offcut)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(OFFCUT_DRAG_MIME, JSON.stringify({ scrapsPath: offcut.scrapsPath, id: offcut.id }))
  }

  const startSourceDrag = (event: DragEvent, source: BoardSource): void => {
    setSelected(sourceKey(source))
    setCarrying(null)
    setDragSource(source)
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(SOURCE_DRAG_MIME, source.path)
  }

  const startDrag = (event: DragEvent, path: string): void => {
    setSelectedPath(path)
    setDragPath(path)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', path)
  }

  if (loading) return <div className="board-wrap board-loading" aria-label="Loading Board" />

  return (
    <div className="board-wrap" ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} aria-label={`Board — ${name}`}>
      <div className="board-head">
        <h1>{name}</h1>
        <span className="bh-count">{shownRows.length} {shownRows.length === 1 ? 'piece' : 'pieces'} · {columns.length} stages{showOffcuts ? ` · ${offcuts.length} ${offcuts.length === 1 ? 'offcut' : 'offcuts'}` : ''} · {sources.length} {sources.length === 1 ? 'source' : 'sources'} · {shownRows.length} shown</span>
        <div className="board-view-menu">
          <button type="button" className="btn" aria-haspopup="menu" aria-expanded={viewMenuOpen} onClick={() => setViewMenuOpen((open) => !open)}><Eye aria-hidden="true" /> View</button>
          {viewMenuOpen && (
            <div className="board-view-pop" role="menu" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setViewMenuOpen(false); rootRef.current?.focus() } }}>
              <button type="button" role="menuitemcheckbox" aria-checked={showOffcuts} autoFocus onClick={toggleOffcuts}>
                <span className="bvp-check">{showOffcuts && <Check aria-hidden="true" />}</span> Offcuts column
              </button>
              <button type="button" role="menuitemcheckbox" aria-checked={sourcesShown} onClick={toggleSources}>
                <span className="bvp-check">{sourcesShown && <Check aria-hidden="true" />}</span> Sources rail
              </button>
            </div>
          )}
        </div>
        <div className="seg-view" aria-label="Collection projection">
          <button type="button" aria-pressed="true"><Columns3 aria-hidden="true" /> Board</button>
          <button type="button" aria-pressed="false" onClick={onOpenPlan}><ListOrdered aria-hidden="true" /> Plan</button>
          <button type="button" disabled title="Outline comes in a later wave"><ListTree aria-hidden="true" /> Outline</button>
        </div>
      </div>
      <div className="board-projnote">
        one query · <span className="pj">rail</span><span className="pj on">board</span><span className="pj">in-doc query</span>
      </div>

      {error ? (
        <div className="board-empty" role="alert">
          <h2>The Board could not load</h2>
          <p>The collection query did not complete. Your files have not been changed.</p>
          <button className="btn" type="button" onClick={() => void reload()}>Try again</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="board-empty">
          <div className="art" aria-hidden="true">{REFERENCE_STATUS_ORDER.slice(0, 4).map((status) => <span className="ph" key={status} />)}</div>
          <h2>No pipeline yet</h2>
          <p>This collection has no pieces yet. Create the first Piece and its frontmatter status will place it on the Board.</p>
          <div className="pattern" aria-label="Reference pipeline">
            {REFERENCE_STATUS_ORDER.map((status, index) => (
              <span key={status} className="pattern-stage">
                <span className={`sbadge ${groupBoardRows([])[index].badgeClass}`}><span className="sdot" />{status}</span>
                {index < REFERENCE_STATUS_ORDER.length - 1 && <ArrowRight className="icon xs arw" aria-hidden="true" />}
              </span>
            ))}
          </div>
          <div className="be-act">
            <button className="btn primary" type="button" onClick={() => onNewPiece(dir)}><FilePlus2 aria-hidden="true" /> Create first Piece</button>
          </div>
          <p className="empty-note">Nothing is written until you choose an action.</p>
        </div>
      ) : (
        <div className="board-body">
        <div className="board-cols" ref={colsRef}>
          {showOffcuts && ideaIndex < 0 && <OffcutsColumn offcuts={offcuts} selectedKey={selected} onSelect={(offcut) => { setSelected(offcutKey(offcut)); rootRef.current?.focus() }} onDragStart={startOffcutDrag} onDragEnd={() => { setDragOffcut(null); setOverStatus(null) }} />}
          {columns.map((column, columnIndex) => {
            const stalled = column.rows.filter((row) => boardAge(row).stalled).length
            const isOver = overStatus === column.status
            const isIdea = columnIndex === ideaIndex
            return (<Fragment key={column.status}>
              {showOffcuts && isIdea && <OffcutsColumn offcuts={offcuts} selectedKey={selected} onSelect={(offcut) => { setSelected(offcutKey(offcut)); rootRef.current?.focus() }} onDragStart={startOffcutDrag} onDragEnd={() => { setDragOffcut(null); setOverStatus(null) }} />}
              <section
                className={`bcol${column.status === UNSORTED_STATUS ? ' unsorted' : ''}${isOver ? ' over armed' : ''}`}
                data-status={column.status}
                onDragOver={(event) => { if (dragPath || (dragOffcut && isIdea)) { event.preventDefault(); setOverStatus(column.status) } }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOverStatus(null) }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragOffcut) {
                    const offcut = dragOffcut
                    setDragOffcut(null)
                    setOverStatus(null)
                    if (isIdea) startNaming(offcut)
                    return
                  }
                  const path = dragPath ?? event.dataTransfer.getData('text/plain')
                  if (path) void moveToStatus(path, column.status)
                }}
              >
                <div className="bcol-head">
                  <span className={`c-dot ${column.badgeClass}`} />
                  <span className={`c-name ${column.badgeClass}`}>{column.status}</span>
                  <button
                    type="button"
                    className="bcol-insert-query"
                    aria-label={`Insert ${column.status} as query`}
                    title="Insert as query"
                    onFocus={() => onQueryContext(queryContextFor(column.status))}
                    onClick={() => onInsertQuery(queryContextFor(column.status))}
                  ><ListPlus aria-hidden="true" /></button>
                  <span className="c-count">{column.rows.length}</span>
                </div>
                <div className="bcol-list">
                  {isIdea && naming && (
                    <OffcutNamer
                      offcut={naming.offcut}
                      name={naming.name}
                      busy={stepBusy}
                      error={naming.error}
                      onChange={(name) => setNaming((current) => current && { ...current, name, error: null })}
                      onSubmit={() => void makeIdea()}
                      onCancel={cancelNaming}
                    />
                  )}
                  {isOver && dragOffcut && isIdea && !naming && (
                    <div className="bcard ghost" aria-hidden="true">
                      <div className="bc-title">{dragOffcut.firstWords}</div>
                      <div className="bc-desc">drop to name it as an idea</div>
                    </div>
                  )}
                  {isOver && dragPath && rows.find((row) => row.path === dragPath)?.status?.trim().toLocaleLowerCase() !== column.status.toLocaleLowerCase() && (
                    <div className="bcard ghost" aria-hidden="true">
                      <div className="bc-title">{rows.find((row) => row.path === dragPath)?.title}</div>
                      <div className="bc-desc">moving here — release ⏎ to stage the status edit</div>
                    </div>
                  )}
                  {column.rows.map((row) => {
                    const age = boardAge(row)
                    const drawerOpen = drawerPath === row.path && row.drawer !== undefined
                    // The source this card would take (frame 4): under a dragged source, or selected while one is carried.
                    const incoming = dragSource && overCard === row.path ? dragSource : carrying && selectedPath === row.path ? carrying : null
                    return (
                      <article
                        key={row.path}
                        className={`bcard${selectedPath === row.path ? ' sel' : ''}${drawerOpen ? ' open' : ''}${incoming ? ' src-target' : ''}${row.agentAuthored ? ' agent-authored' : ''}${row.folderPath ? ' folder-piece' : ''}`}
                        draggable={!moving}
                        tabIndex={-1}
                        data-path={row.path}
                        onClick={() => {
                          setSelectedPath(row.path)
                          onQueryContext(queryContextFor(row.status?.trim() || UNSORTED_STATUS))
                          rootRef.current?.focus()
                        }}
                        onDoubleClick={() => onOpenPiece(row.path)}
                        onDragStart={(event) => startDrag(event, row.path)}
                        onDragEnd={() => { setDragPath(null); setOverStatus(null) }}
                        onDragOver={(event) => {
                          if (!dragSource) return
                          event.preventDefault()
                          event.stopPropagation()
                          event.dataTransfer.dropEffect = 'copy'
                          if (overCard !== row.path) setOverCard(row.path)
                        }}
                        onDragLeave={(event) => {
                          if (dragSource && !event.currentTarget.contains(event.relatedTarget as Node | null)) setOverCard((over) => over === row.path ? null : over)
                        }}
                        onDrop={(event) => {
                          if (!dragSource) return
                          event.preventDefault()
                          event.stopPropagation()
                          void attachSource(row.path, dragSource)
                        }}
                      >
                        <div className="bc-title">{row.title}{row.agentAuthored && <Bot className="agent-mark" aria-label="Agent-authored Piece" />}</div>
                        <div className={`bc-desc${row.description ? '' : ' muted'}`}>{row.folderPath && <Folder className="folder-piece-mark" aria-label="Folder Piece" />}{row.description ?? '— no description yet'}</div>
                        <div className="bc-foot">
                          <span className={`age${row.provenance.date === 'derived' ? ' derived' : ''}`}>{age.label}</span>
                          {age.stalled && <span className="stall"><Clock3 aria-hidden="true" /> stalled</span>}
                          <BoardCardChips row={row} drawerOpen={drawerOpen} onToggleDrawer={() => { setSelectedPath(row.path); setDrawerPath((open) => open === row.path ? null : row.path) }} />
                          <BoardCardTasks row={row} />
                          {incoming && <span className="bc-chip sources incoming">+ {incoming.title}</span>}
                        </div>
                        {drawerOpen && <BoardCardDrawer row={row} busy={stepBusy} onAppend={(scrap) => void appendScrap(row.path, scrap)} />}
                        {carrying
                          ? <div className="kbhint"><kbd>⏎</kbd> attach source · <kbd>Esc</kbd> cancel</div>
                          : <div className="kbhint"><kbd>⏎</kbd> open · <kbd>⌥←→</kbd> move stage{row.drawer && <> · <kbd>Space</kbd> scraps, sources</>}</div>}
                      </article>
                    )
                  })}
                  {stalled > 0 && <div className="stall-cap"><Flame aria-hidden="true" /> {stalled} stalled here over 90 days</div>}
                </div>
              </section>
            </Fragment>)
          })}
        </div>
        <SourcesRail
          sources={sources}
          collapsed={!sourcesShown}
          selectedKey={selected}
          carryingPath={carrying?.path ?? null}
          onToggle={toggleSources}
          onSelect={(source) => { setSelected(sourceKey(source)); rootRef.current?.focus() }}
          onOpen={(source) => onOpenPiece(source.path)}
          onDragStart={startSourceDrag}
          onDragEnd={() => { setDragSource(null); setOverCard(null) }}
        />
        </div>
      )}
      {carrying && <SourceCarryHint source={carrying} />}
      {activity && !carrying && <BoardActivity activity={activity} onUndo={(id) => void undoStep(id)} />}
      {!error && rows.length > 0 && (
        <div className="board-foot">
          <span className="kb"><kbd>←</kbd><kbd>→</kbd> column</span>
          <span className="kb"><kbd>↑</kbd><kbd>↓</kbd> select card</span>
          <span className="kb"><kbd>⌥←→</kbd> move stage</span>
          <span className="kb"><kbd>⏎</kbd> open</span>
          {rows.some((row) => row.drawer) && <span className="kb"><kbd>Space</kbd> scraps and sources</span>}
          {showOffcuts && offcuts.length > 0 && <span className="kb"><kbd>⌥→</kbd> offcut to idea</span>}
          {sourcesShown && sources.length > 0 && <span className="kb"><kbd>⌥←</kbd> attach source</span>}
          {moving && <span className="board-moving" role="status"><Check aria-hidden="true" /> Applying status…</span>}
        </div>
      )}
    </div>
  )
}
