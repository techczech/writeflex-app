import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { BookMarked, BookOpen, ChevronDown, FileText, ListOrdered, ListPlus, Plus } from 'lucide-react'
import { usePieceDrag } from './folio-piece-drag'
import { ORDER_IN_PLAN_LINE, addAllTooltip, addName, addTooltip, gripName, putBackWhy, type FocusedFolioRow } from '../../../shared/folio-running-order'
import type { FolioOutline, FolioOutlineFile } from '../../../preload'
import type { OutlineHeading } from '../editor/outline'
import { alsoLine, filterFolioFile, folderFootLine, folioKeyAction, folioTabStop, limitLevels, openRows, shownHeadings, type FolioKeyRow } from '../../../shared/folio-outline'
import { partTitle, type PartHeadingMode } from '../../../shared/folio-part-title'
import { folioHeadingFlow, type FlowPart } from '../../../shared/folio-heading-flow'
import { TITLE_FIX_LABEL, titleConflictSentence } from '../../../shared/title-conflict'
import { useTitleConflictContext } from '../app/title-conflict-actions'

/** A heading row of the Folio part. The open file's headings carry their editor offset (`from`); the
 *  others, read from disk, their 1-based line. */
type HeadingRow = { level: number; text: string; from?: number; line?: number; /** Nesting depth under the part's row (the heading flow); absent on "Not in the outline" rows. */ depth?: number }

type FolioOutlinePartProps = {
  outline: FolioOutline
  /** The file in the editor, or null. */
  openPath: string | null
  /** The open file's headings from the editor buffer (unsaved ones included). */
  bufferHeadings: readonly OutlineHeading[]
  /** The file those headings were read from. They are used only when it is the open path; otherwise the disk data stands. */
  bufferPath: string | null
  /** The text of that buffer, for the part-title rule (shared/folio-part-title.ts); absent: judged from the headings' levels. */
  bufferText?: string | null
  /** Offset of the heading the cursor is in. */
  activeFrom: number | null
  /** Lower-cased Filter text ('' = none). */
  needle: string
  /** The Levels limit (null = all). */
  levelLimit: number | null
  /** Collapse state per row key: a row absent from the map follows its default (the open file starts expanded). */
  expanded: ReadonlyMap<string, boolean>
  onToggle: (key: string, open: boolean) => void
  onOpenFile: (path: string) => void
  /** Land the caret on a line of another file (opens it first). */
  onJumpToFile: (path: string, line: number) => void
  /** Move the caret to a heading of the open file. */
  onJumpOpen: (from: number) => void
  listRef: RefObject<HTMLDivElement>
  /** Move a piece before another (null = to the end); `expected` is the running order the drag was made against. */
  onMovePiece: (path: string, beforePath: string | null, expected: string[]) => void
  /** Add files to the end of the running order. */
  onAdd: (files: Array<{ path: string; title: string }>) => void
  /** A write is under way: nothing can be dragged or added. */
  busy: boolean
  /** The pieces the last Add added, tinted until the next change. */
  justAdded: readonly string[]
  /** The live-region text. */
  announcement: string
  /** After a change: the row to focus once the Outline shows `order`. */
  touched: { tick: number; path: string; order: string[] } | null
  /** Tells the pane which row has focus, for the action bar's Move up / Move down. */
  onFocusedRow: (row: FocusedFolioRow) => void
  /** Open the Plan of this Folio (the way to change the order of a Folio the Outline cannot change). */
  onOpenPlan: () => void
}

const NO_BUFFER: readonly OutlineHeading[] = []

/** The row keys the Folio part uses, so OutlinePane's Collapse all / Expand all can address every file. */
export const pieceKey = (index: number, path: string): string => `piece:${index}:${path}`
export const alsoKey = (path: string): string => `also:${path}`
// "Not in the outline" is listed on the Folio page only (2026-10-19 redesign, element 5, option A): the sidebar's Outline lists the running order.
export const folioFileKeys = (outline: FolioOutline): string[] => outline.pieces.map((piece, index) => pieceKey(index, piece.path))

/** Headings are indented by their level relative to the file's shallowest shown heading. */
function indentOf(level: number, base: number): number {
  return 30 + Math.min(Math.max(level - base, 0), 4) * 12
}
/** The heading flow's nesting depth (1 = directly under the part's row) as an indent. */
const depthIndent = (depth: number): number => 30 + Math.min(Math.max(depth - 1, 0), 4) * 12
/** The name of a file as the file mark shows it. */
const fileNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/**
 * The Folio part of the Outline: every piece of the Folio in running order, each collapsible to its
 * headings, then "Not in the outline" with the files the running order does not list. Read-only: a click
 * opens a file or goes to a heading; nothing here changes a file. The open piece's headings are the
 * editor's own (so unsaved ones show), every other file's come from disk. The rows are one roving-focus
 * list: ↑ ↓ move, ← → collapse and expand a file, Enter opens.
 */
export function FolioOutlinePart({ outline, openPath, bufferHeadings: rawBufferHeadings, bufferPath, bufferText, activeFrom, needle, levelLimit, expanded, onToggle, onOpenFile, onJumpToFile, onJumpOpen, listRef, onMovePiece, onAdd, busy, justAdded, announcement, touched, onFocusedRow, onOpenPlan }: FolioOutlinePartProps): JSX.Element {
  // A buffer from another file (the snapshot trails a tab switch) is ignored: the open piece then shows its disk headings.
  const fromBuffer = openPath !== null && bufferPath === openPath
  const titleActions = useTitleConflictContext()
  const bufferHeadings: readonly OutlineHeading[] = fromBuffer ? rawBufferHeadings : NO_BUFFER
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const open = useMemo(() => openRows(outline, openPath), [outline, openPath])
  const filtering = needle !== ''
  // A Folio the Outline cannot change exactly: no grip, no drag, no Add, no Add all; one line sends the owner to the Plan.
  const canChange = outline.orderInPlanOnly !== true
  const suppressClick = useRef(false)
  const added = useMemo(() => new Set(justAdded), [justAdded])

  // The open file's title rule from its editor buffer, the same rule main reads from the disk (a `## T` that is the title is `own`).
  const bufferNamed = useMemo(() => (fromBuffer && openPath !== null && typeof bufferText === 'string' ? partTitle(bufferText, openPath) : null), [fromBuffer, openPath, bufferText])
  // Whether a part has its own heading. The open file follows its editor buffer; `heading: none` is the disk's word.
  const modeOf = useCallback((file: FolioOutlineFile): PartHeadingMode => {
    if (file.path === openPath && fromBuffer && file.heading !== 'none') return bufferNamed ? (bufferNamed.mode === 'own' ? 'own' : 'missing') : bufferHeadings[0]?.level === 1 ? 'own' : 'missing'
    return file.heading ?? 'own'
  }, [openPath, fromBuffer, bufferHeadings, bufferNamed])

  // The open file's title follows its buffer by the same rule main reads from the disk (`partTitle`: a first
  // heading that is the title, at any level), as its disk title would after a save.
  const titleOf = useCallback((file: FolioOutlineFile): string => {
    if (file.path !== openPath || !fromBuffer || file.heading === 'none' || file.frontMatter) return file.title
    if (bufferNamed) return bufferNamed.mode === 'own' ? bufferNamed.title : file.title
    return bufferHeadings[0]?.level === 1 && bufferHeadings[0].text ? bufferHeadings[0].text : file.title
  }, [openPath, fromBuffer, bufferHeadings, bufferNamed])

  // The Folio's heading flow (ADR-0046, shared/folio-heading-flow.ts), from every heading before any filter or
  // level limit: the chapter level must not move when the Filter is typed. The open file reads its editor buffer.
  const flow = useMemo(() => folioHeadingFlow<HeadingRow>(outline.pieces.map((file) => ({
    path: file.path,
    title: titleOf(file),
    mode: modeOf(file),
    frontMatter: file.frontMatter === true,
    headings: file.path === openPath && fromBuffer
      ? bufferHeadings.map((heading) => ({ level: heading.level, text: heading.text, from: heading.from }))
      : file.headings.map((heading) => ({ level: heading.level, text: heading.text, line: heading.line })),
  }))), [outline, titleOf, modeOf, openPath, fromBuffer, bufferHeadings])

  const childrenOf = useCallback((file: FolioOutlineFile, flowPart: FlowPart<HeadingRow> | undefined): HeadingRow[] => {
    const mode = modeOf(file)
    const own: HeadingRow[] = flowPart
      ? flowPart.children
      : file.path === openPath && fromBuffer
        ? shownHeadings(bufferHeadings.map((heading) => ({ level: heading.level, text: heading.text, from: heading.from })), mode, titleOf(file))
        : shownHeadings(file.headings.map((heading) => ({ level: heading.level, text: heading.text, line: heading.line })), mode, titleOf(file))
    return limitLevels(own, levelLimit)
  }, [modeOf, titleOf, openPath, fromBuffer, bufferHeadings, levelLimit])

  // Front matter (ADR-0046) is listed first, in its own group, and is not dragged here: a drag moves a contents
  // piece among the contents. The drop names the whole running order as the order the move was made against.
  const contentsPieces = useMemo(() => outline.pieces.filter((file) => file.frontMatter !== true), [outline])
  const contentsNumber = useMemo(() => {
    const numbers = new Map<number, number>()
    let next = 1
    outline.pieces.forEach((file, index) => { if (file.frontMatter !== true) numbers.set(index, next++) })
    return numbers
  }, [outline])
  const { drag, start: startDrag } = usePieceDrag({
    listRef,
    pieces: contentsPieces.map((file) => ({ path: file.path, title: titleOf(file) })),
    enabled: canChange && !filtering && !busy,
    onDrop: (path, beforePath) => onMovePiece(path, beforePath, outline.pieces.map((file) => file.path)),
    suppressClick,
  })

  // Filter against the headings that are displayed: the editor buffer's for the open file.
  const keep = useCallback((file: FolioOutlineFile): boolean => {
    if (!filtering) return true
    const headings = file.path === openPath && fromBuffer ? bufferHeadings.map((heading) => ({ level: heading.level, text: heading.text, line: 0 })) : file.headings
    return filterFolioFile({ ...file, title: titleOf(file), headings, heading: modeOf(file) }, needle).keep
  }, [filtering, needle, titleOf, modeOf, openPath, fromBuffer, bufferHeadings])

  const isOpen = (key: string, isOpenFile: boolean): boolean => filtering || (expanded.get(key) ?? isOpenFile)

  type Entry = { file: FolioOutlineFile; key: string; kind: 'piece' | 'also'; index: number; headings: HeadingRow[]; count: number; isExpanded: boolean; canExpand: boolean; tooLarge: boolean; continues: boolean; depth: number }
  const entryOf = (file: FolioOutlineFile, key: string, kind: 'piece' | 'also', index: number): Entry => {
    const flowPart = kind === 'piece' ? flow.parts[index] : undefined
    const all = childrenOf(file, flowPart)
    const headings = filtering ? all.filter((heading) => heading.text.toLowerCase().includes(needle)) : all
    const isOpenPath = file.path === openPath
    const count = all.length
    const tooLarge = file.tooLarge === true && !isOpenPath
    const continues = flowPart?.role === 'continues'
    return { file, key, kind, index, headings, count, tooLarge, continues, depth: flowPart?.depth ?? 0, canExpand: headings.length > 0 || count > 0 || tooLarge, isExpanded: isOpen(key, isOpenPath) }
  }
  const allPieceEntries = outline.pieces.map((file, index) => ({ file, index })).filter(({ file }) => keep(file)).map(({ file, index }) => entryOf(file, pieceKey(index, file.path), 'piece', index))
  const frontEntries = allPieceEntries.filter((entry) => entry.file.frontMatter === true)
  const pieceEntries = allPieceEntries.filter((entry) => entry.file.frontMatter !== true)
  const alsoEntries: Entry[] = []
  const entries = [...frontEntries, ...pieceEntries, ...alsoEntries]

  // The rows a key press can reach, in order (headings only under an expanded file).
  const rows: FolioKeyRow[] = entries.flatMap((entry) => [
    { key: entry.key, file: true, ...(entry.canExpand ? { expanded: entry.isExpanded } : {}) },
    ...(entry.isExpanded ? (entry.tooLarge ? [`${entry.key}:h0`] : entry.headings.map((_, at) => `${entry.key}:h${at}`)).map((key) => ({ key, file: false, parent: entry.key })) : []),
  ])
  const openKey = open.pieces[0] !== undefined ? pieceKey(open.pieces[0], outline.pieces[open.pieces[0]].path) : open.also !== null ? alsoKey(outline.also[open.also].path) : null
  // The one tab stop: the stored row while it is shown, else the open file's row if shown, else the first shown row.
  const tabStop = folioTabStop(rows.map((row) => row.key), focusKey, openKey)

  const focusedRow = useMemo((): FocusedFolioRow => {
    const piece = outline.pieces.findIndex((file, index) => pieceKey(index, file.path) === focusKey)
    if (piece >= 0) return { path: outline.pieces[piece].path, kind: 'piece' }
    const also = outline.also.find((file) => alsoKey(file.path) === focusKey)
    return also ? { path: also.path, kind: 'also' } : null
  }, [outline, focusKey])
  useEffect(() => { onFocusedRow(focusedRow) }, [focusedRow, onFocusedRow])

  // After a move or an Add the focus goes to the moved piece in its new place, once the list shows the new order.
  const handledTouch = useRef(0)
  useEffect(() => {
    if (!touched || touched.tick === handledTouch.current) return
    const shown = outline.pieces.map((file) => file.path)
    if (shown.length !== touched.order.length || shown.some((path, index) => path !== touched.order[index])) return
    handledTouch.current = touched.tick
    const holder = document.activeElement
    if (holder && holder !== document.body && !listRef.current?.contains(holder) && !holder.closest('.ol-bar')) return
    const index = shown.indexOf(touched.path)
    if (index < 0) return
    const key = pieceKey(index, touched.path)
    setFocusKey(key)
    listRef.current?.querySelector<HTMLElement>(`[data-fokey="${CSS.escape(key)}"]`)?.focus()
  }, [touched, outline, listRef])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-fo-open="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [openPath, outline, listRef])

  const focusRow = (key: string): void => {
    setFocusKey(key)
    listRef.current?.querySelector<HTMLElement>(`[data-fokey="${CSS.escape(key)}"]`)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('button')) return // Add and Add all are ordinary buttons: Enter and Space are theirs
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-fokey]')
    if (!row) return
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); return }
    const action = folioKeyAction(rows, row.dataset.fokey!, event.key, filtering)
    if (!action) return
    event.preventDefault()
    if (action.toggle) onToggle(action.toggle.key, action.toggle.open)
    else if (action.focus) focusRow(action.focus)
  }

  const renderFile = ({ file, key, kind, index, headings, count, isExpanded, canExpand, tooLarge, continues, depth }: Entry): JSX.Element => {
    const isOpenFile = file.path === openPath && (kind === 'also' || open.pieces.includes(index))
    const base = headings.reduce((least, heading) => Math.min(least, heading.level), 6)
    const title = titleOf(file)
    const front = kind === 'piece' && file.frontMatter === true
    const draggable = kind === 'piece' && !front && canChange
    return (
      <div key={key} role="presentation" data-fo-box={kind === 'piece' && !front ? index : undefined} data-fo-front-box={front ? index : undefined}>
        {kind === 'piece' && !front && (
          // Where this file starts in the flow: a dashed line with the file name at its right end (ADR-0046, option A).
          <div className="fo-mark" aria-hidden="true" data-fo-mark={file.path}><span>{fileNameOf(file.path)}</span></div>
        )}
        <div
          className={`fo-row fo-piece${kind === 'also' ? ' fo-out' : ''}${continues ? ' fo-cont' : ''}${isExpanded && canExpand ? '' : ' fo-shut'}${kind === 'piece' && added.has(file.path) ? ' fo-new' : ''}${drag?.path === file.path && kind === 'piece' ? ' fo-drag-src' : ''}`}
          role="treeitem"
          data-fokey={key}
          data-fofile="true"
          data-kind={kind}
          data-fo-front={front ? 'true' : undefined}
          data-fo-path={file.path}
          data-fo-open={isOpenFile ? 'true' : undefined}
          tabIndex={key === tabStop ? 0 : -1}
          aria-level={1}
          aria-expanded={canExpand ? isExpanded : undefined}
          aria-current={isOpenFile ? 'true' : undefined}
          aria-posinset={kind === 'piece' && !front ? contentsNumber.get(index) : undefined}
          aria-setsize={kind === 'piece' && !front ? contentsPieces.length : undefined}
          title={title}
          data-fo-continues={continues ? 'true' : undefined}
          style={continues ? { marginLeft: depth * 12 } : undefined}
          onFocus={(event) => { if (event.target === event.currentTarget) setFocusKey(key) }}
          onPointerDown={draggable ? (event) => startDrag(event, file.path) : undefined}
          onClick={() => { if (suppressClick.current) return; setFocusKey(key); onOpenFile(file.path) }}
        >
          {kind === 'piece'
            ? (!filtering && (draggable ? <span className="fo-grip" aria-hidden="true" title={gripName(title)} /> : <span className="fo-grip fo-grip-none" aria-hidden="true" />))
            : <span className="fo-grip fo-grip-none" aria-hidden="true" />}
          <span
            className="fo-chev-btn"
            aria-hidden="true"
            onClick={(event) => { event.stopPropagation(); if (canExpand && !filtering) onToggle(key, !isExpanded) }}
          >
            {canExpand ? <ChevronDown className="fo-chev" aria-hidden="true" /> : <span className="fo-chev" />}
          </span>
          {front ? <BookOpen className="icon sm fo-fi" aria-hidden="true" /> : kind === 'piece' ? null : <FileText className="icon sm fo-fi" aria-hidden="true" />}
          <span className="fo-t">{kind === 'also' && file.under ? <span className="fo-under" data-fo-under={file.under}>{file.under}/</span> : null}{title}</span>
          {front && <span className="fo-flag fo-front-flag" data-fo-flag="not-in-contents" title="Front matter: exported before the contents page and never listed in it. Change it in the Folio outline.">not in contents</span>}
          {file.titleMismatch === true && <span className="fo-flag" data-fo-flag="title-differs" title={file.titleConflict ? titleConflictSentence(file.titleConflict) : 'This part’s frontmatter title differs from its heading.'}>title differs</span>}
          {kind === 'piece' && !(isExpanded && canExpand) && count > 0 && <span className="fo-c">{count}</span>}
          {kind === 'also' && canChange && file.addable === true && (
            <button
              type="button"
              className="fo-add"
              data-fo-add={file.path}
              title={addTooltip(title)}
              aria-label={addName(title)}
              disabled={busy}
              onClick={(event) => { event.stopPropagation(); onAdd([{ path: file.path, title }]) }}
            >
              <Plus className="icon sm" aria-hidden="true" />Put back
            </button>
          )}
          {kind === 'also' && !(canChange && file.addable === true) && (
            <button
              type="button"
              className="fo-addoff"
              data-fo-putback-off={file.path}
              title={putBackWhy(!canChange)}
              aria-label={`Put ${title} back is not available: ${putBackWhy(!canChange)}`}
              disabled
            >
              <Plus className="icon sm" aria-hidden="true" />Put back<span className="fo-why"> · {putBackWhy(!canChange)}</span>
            </button>
          )}
        </div>
        {kind === 'piece' && file.titleConflict && titleActions && (
          // Title-conflict buttons (2026-10-19): one click makes the title and the heading one. Main writes over the version read.
          // Only on a part of the running order: main writes only a part of the Folio (an "Also in this folder" file keeps its tag).
          <div className="fo-title-fix" role="group" aria-label={titleConflictSentence(file.titleConflict)} data-fo-title-fix={file.path}>
            {(['heading-to-title', 'title-to-heading'] as const).map((direction) => (
              <button
                key={direction}
                type="button"
                className="fo-add"
                data-fo-title-fix-direction={direction}
                disabled={busy}
                onClick={(event) => { event.stopPropagation(); void titleActions.fixPart(outline.dir, { path: file.path, fingerprint: file.titleConflict!.fingerprint }, direction) }}
              >
                {TITLE_FIX_LABEL[direction]}
              </button>
            ))}
          </div>
        )}
        {isExpanded && tooLarge && (
          <div
            className="fo-row fo-hd fo-toolarge"
            role="treeitem"
            data-fokey={`${key}:h0`}
            tabIndex={`${key}:h0` === tabStop ? 0 : -1}
            aria-level={2}
            aria-disabled="true"
          >
            <span>Too large to outline</span>
          </div>
        )}
        {isExpanded && !tooLarge && headings.map((heading, at) => {
          const hKey = `${key}:h${at}`
          const current = file.path === openPath && heading.from !== undefined && heading.from === activeFrom
          return (
            <div
              key={hKey}
              className="fo-row fo-hd"
              role="treeitem"
              data-fokey={hKey}
              data-heading-level={heading.level}
              data-heading-depth={heading.depth}
              data-fopiece={key}
              tabIndex={hKey === tabStop ? 0 : -1}
              aria-level={2}
              aria-current={current ? 'true' : undefined}
              title={heading.text}
              style={{ paddingLeft: heading.depth !== undefined ? depthIndent(heading.depth) : indentOf(heading.level, base) }}
              onClick={() => {
                setFocusKey(hKey)
                if (heading.from !== undefined) onJumpOpen(heading.from)
                else onJumpToFile(file.path, heading.line ?? 1)
              }}
            >
              <span>{heading.text}</span>
            </div>
          )
        })}
      </div>
    )
  }

  const addable = canChange ? outline.also.filter((file) => file.addable === true) : []
  const dropLine = (slot: number): JSX.Element | null => (drag && !drag.inPlace && drag.slot === slot ? <div key={`drop-${slot}`} className="fo-dropline" data-fo-dropline={slot} aria-hidden="true" /> : null)
  const movingTitle = drag ? outline.pieces.find((file) => file.path === drag.path) : undefined
  const hasFront = outline.pieces.some((file) => file.frontMatter === true)

  return (
    <>
      <div
        ref={listRef}
        className={`ol-list fo-scroll${drag ? ' dragging' : ''}`}
        role="tree"
        aria-label="Folio outline"
        onKeyDown={onKeyDown}
      >
        {hasFront && (
          <>
            <div className="fo-sec" id="fo-grp-front" role="presentation" data-fo-front-heading="true">
              <span>Front matter</span>
              <span className="fo-hint">before the contents</span>
            </div>
            <div role="group" aria-labelledby="fo-grp-front" data-fo-front-group="true">
              {frontEntries.length === 0 && <p className="ol-empty">No matches</p>}
              {frontEntries.map(renderFile)}
            </div>
          </>
        )}
        <div className="fo-sec fo-pin" id="fo-grp-run" role="presentation">
          <span>Contents · {flow.chapters} {flow.chapters === 1 ? 'chapter' : 'chapters'}</span>
          {canChange && !filtering && contentsPieces.length > 1 && <span className="fo-hint" data-fo-hint="true">{movingTitle ? `moving ${titleOf(movingTitle)}` : 'drag to reorder'}</span>}
        </div>
        {/* Each group's rows sit in a labelled group; the sticky headings stay direct children of the scroller. */}
        {/* Hidden while a filter is on, like the drag hint and Add all: Tab from the Filter box then lands on a row. */}
        {!canChange && !filtering && (
          <p className="fo-planonly" data-fo-plan-only="true">
            <span>{ORDER_IN_PLAN_LINE}</span>
            <button type="button" className="fo-openplan" data-fo-open-plan="true" title="Open the Folio outline for this Folio" onClick={onOpenPlan}>
              <ListOrdered className="icon sm" aria-hidden="true" />Folio outline
            </button>
          </p>
        )}
        <div role="group" aria-labelledby="fo-grp-run">
          {pieceEntries.length === 0 && <p className="ol-empty">{filtering ? 'No matches' : 'No pieces in the running order'}</p>}
          {pieceEntries.flatMap((entry, at) => [dropLine(at), renderFile(entry)])}
          {dropLine(pieceEntries.length)}
        </div>
        {drag && drag.label && <div className="ol-drag-label" style={{ left: drag.x + 14, top: drag.y + 14 }} aria-hidden="true">{drag.label}</div>}
      </div>
      {/* During a pointer drag nothing is announced; this speaks after a write has succeeded or been refused. */}
      <div className="fo-live" role="status" aria-live="polite" data-fo-live="true">{announcement}</div>
    </>
  )
}

type FolderPartFootProps = {
  /** The open file's folder name; null for a file loose in the collection root. */
  folderName: string | null
  fileName: string
  fileCount: number
  onMakeFolio: () => void
}

/** The foot of the Folder part (the folder is not a Folio): one line and the button that makes it one. */
export function FolderPartFoot({ folderName, fileName, fileCount, onMakeFolio }: FolderPartFootProps): JSX.Element {
  if (folderName === null) {
    return (
      <div className="fo-foot" data-fo-foot="loose">
        <p>{folderFootLine(null, fileCount, fileName)}</p>
      </div>
    )
  }
  return (
    <div className="fo-foot" data-fo-foot="folder">
      <p>{folderFootLine(folderName, fileCount, fileName)}</p>
      <button
        type="button"
        className="fo-big"
        title={`Make ${folderName} a Folio: its Markdown files go into the running order, in file-name order`}
        onClick={onMakeFolio}
      >
        <BookMarked className="icon sm" aria-hidden="true" />Make a Folio of this folder
      </button>
    </div>
  )
}
