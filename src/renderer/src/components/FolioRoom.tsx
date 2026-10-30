import { visibleSectionRange } from '../../../shared/folio-sections'
import { samePlanCard } from '../../../shared/folio-running-order'
import { AMBIGUOUS_DRAG_MESSAGE, OUTLINE_DRAG_CHANGED_MESSAGE } from './folio-outline-drag'
import { roomPartRenderKey } from '../../../shared/folio-room'
import { confirmRoomOrder } from '../plan/folio-room-store'
import { useFolioHeadingNavigation } from './useFolioHeadingNavigation'
import { FolioRoomMap } from './FolioRoomMap'
import { archiveLinkMarkdown } from '../editor/archive-insert'
import { registerEvidenceAttachmentTarget, evidenceFromDrag, isEvidenceDrag } from '../folio-evidence-transfer'
import type { EvidenceTransfer } from '../../../shared/folio-evidence-transfer'
import { FolioEvidenceView, noEvidence } from './FolioRoomEvidence'
import { quotedCitation, citationChip } from '../editor/citation'
import type { RoomEvidenceRow } from '../../../shared/folio-evidence'
import { FolioRoomFlags, useRoomFlags, type RoomEditorRef, type ShownFlag } from './FolioRoomFlags'
import { findFlags } from '../../../shared/markdown/flags'
import { clearFlagAtCursor } from '../editor/flag-actions'
import { livePreviewBlocks, setOpenLivePreviewBlock } from '../editor/live-preview'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Columns2, Columns3, Flag, FolderOpen, LayoutGrid, Library, Lightbulb, ListTree, Network, FileText } from 'lucide-react'
import type { FolioRoomModel, RoomPart, RoomState, RoomView } from '../../../preload'
import {
  DEFAULT_ROOM_STATE, PRIORITY_LABELS, ROOM_AVAILABLE_VIEWS, ROOM_VIEWS, ROOM_VIEW_LABELS, metaLine, neighbourPart, shownSelection, stageClass, textBeside, wordsText,
} from '../../../shared/folio-room'
import { FolioRoomInspector, type RoomAuthor } from './FolioRoomInspector'
import type { RoomAuthoringRequest } from '../../../shared/folio-room-authoring'
import { registryCommand } from '../commands/registry'
import type { OverrideMap } from '../commands/chords'
import { PLAN_COMMAND_EVENT, planCommandIsShortcut, type PlanCommandName } from '../plan/plan-commands'
import { planCommandForEvent } from '../plan/plan-shortcuts'
import type { FolioRunningOrder } from '../app/folio-running-order'
import { roomOrderLine } from '../../../shared/folio-room-order'
import { useExportOrderCheck } from './ExportOrderNotice'
import { FolioRoomOutline } from './FolioRoomOutline'
import { FolioRoomText } from './FolioRoomText'
import { NewCard, RoomOrderBanner, RoomOrderSource, RoomLeftOut, chordOf, roomMoveChord, usePartDrag, type PartDrag } from './FolioRoomOrder'
import { announceUndoToast, onOtherUndoToast, refreshRoom, subscribeRoom, type RoomAnswer } from '../plan/folio-room-store'
import type { RoomAuthoringResult } from '../../../shared/folio-room-authoring'
import { columnOrder } from './board-view-state'
import { FolioOpenButton } from './FolioOpenButton'
import { pressedInSidebar, removeKeyApplies, roomKeysIgnored } from './folio-room-keys'
import { WORKSPACE_TAB_CHORDS } from '../../../shared/folio-room'
import { groupByStatus, laneOrder, neighbourLaneStatus, workspaceOpenParts, LANE_MOVE_CHORDS, OPEN_SELECTED_CHORD } from '../../../shared/folio-surface'
import { FolioBinderText } from './FolioBinderText'
import { useFolioPlanTools } from './FolioPlanTools'
import { activateSidebar, dispatchSidebar, releaseSidebar, useSidebarSlot, useSidebarState } from '../plan/folio-sidebar'

/**
 * The Folio room (ADR-0048): a Folio opens as one room. Middle pane with the view switch (Cards, Outline and Text; Map,
 * Flags and Evidence are present but disabled until their tickets), Split (the selected card's text beside the cards), and the room's own inspector column
 * beside the Panels pane (D-UI-1). Opening and reading write nothing (I-4). The room's own writes (ticket 11) are the
 * running order's: a card or Outline row dragged, ⌥↑↓, New card, and the export-order banner's repair; each is one
 * request through the app's running-order hook, which keeps the Undo step, and main decides (folio-room-writes.ts).
 * The last view and the selected part are kept in app state under the Folio's key (I-8), and the selection is the
 * part's Plan key, re-resolved after every read (interaction 3).
 */

/**
 * The Folio commands the workspace runs itself. There is no Folio page to hand the others to (ADR-0049): add-all and sort
 * show the Outline tab, whose toolbar holds them; details, role and the agent-instruction commands open the inspector.
 */
export const ROOM_OWN_COMMANDS: ReadonlySet<PlanCommandName> = new Set<PlanCommandName>(['move-up', 'move-down', 'add', 'remove', 'add-all', 'sort', 'details', 'role', 'open-part', 'agents-both', 'agents-agents', 'agents-claude', 'adopt', 'adopt-front-matter', 'front-matter-choose', 'not-in-outline-toggle', 'title-heading-to-title', 'title-title-to-heading', 'titles-heading-to-title', 'titles-title-to-heading'])

/** A part's identity for the screen: its Plan key as one string. */
const EMPTY_ROOM_PARTS: RoomPart[] = []
const partKey = (part: Pick<RoomPart, 'key'>): string => `${part.key.title}\u0000${part.key.path ?? ''}`

/** The removal toast (drawing 4A): its sentence, its Undo token, and the parts it hid before main answered. */
type RemovalToast = { message: string; token: string | null; keys: string[] }

/** Whether keyboard focus is in a place that types (a field or the editor): the room's move keys leave it alone. */
function focusTypes(): boolean {
  const active = document.activeElement
  return active instanceof HTMLElement && (active.closest('input, textarea, select, [contenteditable="true"], .cm-editor') !== null)
}

export const ROOM_VIEW_EVENT = 'writeflex:folio-room-view'
/** A view, status lanes, Split, or a heading navigation target in the open workspace. */
export type RoomViewCommand = RoomView | 'split' | 'status-lanes' | { path: string }

const VIEW_ICONS: Record<RoomView, typeof LayoutGrid> = { cards: LayoutGrid, outline: ListTree, map: Network, flags: Flag, text: FileText, evidence: Library, files: FolderOpen }

/** The chord a view's command (or `split`) answers to, as the registry holds it; undefined for one with no command yet. */
function viewChord(view: RoomViewCommand): string | undefined {
  try {
    const keys = registryCommand(`folio.room.${view}`).keys
    return Array.isArray(keys) ? keys[0] : keys
  } catch {
    return undefined
  }
}

export type FolioRoomProps = {
  dir: string
  editor?: RoomEditorRef
  /** Open a part's file in the editor. */
  onOpenPiece: (path: string) => void
  onOpenFolio?: (path: string) => void
  /** The existing cross-file heading navigator, hosted in Outline. */
  headingOutline?: ReactNode
  /** The Files tab's content: the Collection view of the Folio's folder, embedded (CollectionView builds it, only while Files shows). */
  files?: () => ReactNode
  /** The Board for this Folio, drawn inside the Cards tab (the Board's capabilities stay reachable until the folders tree arrives). */
  board?: (folio: { dir: string; name: string; onLeave: () => void; onOutline: () => void }) => ReactNode
  /** Whether the Board is showing inside Cards (the app enables the Board's palette commands then). */
  onBoardShown?: (shown: boolean) => void
  /** The tab on screen, for the wrapper (the Files tab reads the folder again when it is shown). */
  onViewChange?: (view: RoomView) => void
  /** The app's status line. */
  onStatus?: (message: string) => void
  /** Kept up to date with the shown selected part's Plan key, for a Folio command handed to the page. */
  selectionRef?: { current: { title: string; path: string | null } | null }
  /** The buttons the page header shares (the Collection menu), drawn at the right of the crumb. */
  headerActions?: React.ReactNode
  /** The app shows this file in its own editor, over the room's text pane (null: none wanted). */
  onShowText?: (path: string | null) => void
  /** The file the app's editor holds now. */
  textLoaded?: string | null
  /** The app's running-order hook: the room's order writes go through it (one Undo step, the flash). Absent: the room does not reorder. */
  runningOrder?: Pick<FolioRunningOrder, 'moveInRoom' | 'reorderInRoom' | 'addRoomCard' | 'write' | 'undo' | 'canUndo' | 'sortPlan' | 'addToPlan' | 'removeToBin'>
  /** The user's chord overrides, for N (New card) as the Folio page reads it. */
  shortcutOverrides?: OverrideMap
}

function StageChip({ status, written }: { status: string; written: boolean }): JSX.Element {
  const cls = status.startsWith('Missing') || status === 'Ambiguous link' ? 'missing' : written || status === 'idea' ? stageClass(status) : 'idea'
  return <span className={`fr-stage ${cls}`}><span className="sd" />{status.toLowerCase() === 'unsorted' ? 'Unsorted' : status}</span>
}

function Card({ part, selected, focusable, onSelect, onOpen, compact, drag, onEvidenceDrop, onEvidenceOver }: { onEvidenceDrop?: (event: React.DragEvent) => boolean; onEvidenceOver?: (event: React.DragEvent) => boolean; part: RoomPart; selected: boolean; focusable: boolean; onSelect: (event: React.MouseEvent) => void; onOpen: () => void; compact?: boolean; drag: PartDrag }): JSX.Element {
  const moveChord = roomMoveChord()
  const dragProps = drag.props(part.index)
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={focusable ? 0 : -1}
      data-part-index={part.index}
      data-written={part.written}
      className={`fr-card${part.written ? '' : ' unw'}${part.titleClash ? ' clash' : ''}${part.label ? ` fr-lbl-${part.label.colour}` : ''}${drag.dragged === part.index ? ' dragging' : ''}${drag.over === part.index && drag.dragged !== part.index ? ' drop' : ''}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
      {...dragProps}
      onDragOver={event => { if (!onEvidenceOver?.(event)) dragProps.onDragOver?.(event) }}
      onDrop={event => { if (!onEvidenceDrop?.(event)) dragProps.onDrop?.(event) }}
    >
      <div className="fr-strip" />
      <div className="fr-ct"><span className="n">{part.index + 1}</span>{!part.written && !part.resolution && <Lightbulb className="icon idea" aria-hidden="true" />}<span>{part.title}</span></div>
      <div className={`fr-cs${part.synopsis ? '' : ' none'}`}>{part.synopsis ?? ''}</div>
      {part.titleClash && <div className="fr-clash" role="note">{part.titleClash}</div>}
      {part.tags.length > 0 && <div className="fr-tags" data-testid="card-tags">{part.tags.map((tag) => <span key={tag} className="fr-tag">#{tag}</span>)}</div>}
      <div className="fr-cf"><StageChip status={part.status} written={part.written} /><span className="g" /><span className="w">{wordsText(part)}</span></div>
      {!compact && <div className="fr-kbh"><span><kbd>↵</kbd> text beside</span>{moveChord && <span><kbd>{moveChord}</kbd> move</span>}</div>}
    </div>
  )
}


const NO_TEXT = (): void => undefined
const NO_STATUS = (): void => undefined

export function FolioRoom({ dir, onOpenPiece, onOpenFolio, files, board, onBoardShown, headingOutline = null, onViewChange, onStatus = NO_STATUS, selectionRef, headerActions, onShowText = NO_TEXT, textLoaded = null, editor, runningOrder, shortcutOverrides = {} }: FolioRoomProps): JSX.Element {
  const holdOrder = useRef(false)
  const outlinePress = useRef(false)
  const heldAnswer = useRef<RoomAnswer | null>(null)
  const readHeldAnswer = (): RoomAnswer | null => heldAnswer.current
  const [model, setModel] = useState<FolioRoomModel | null | undefined>(undefined)
  // The Board shown inside Cards; and whether the inspector has been shown (it then stays mounted while hidden, so no draft is lost).
  const [boardShown, setBoardShown] = useState(false)
  const [inspectorMounted, setInspectorMounted] = useState(false)
  const [state, setState] = useState<RoomState | null>(null)
  const [error, setError] = useState(false)
  const [pendingCitation, setPendingCitation] = useState<{ path: string; text: string } | null>(null)
  const evidenceSession = useMemo(() => crypto.randomUUID(), [dir, model?.stateKey])
  const flags = useRoomFlags(model, editor)
  const [pendingFlag, setPendingFlag] = useState<{ part: RoomPart; flag: ShownFlag; clear?: boolean } | null>(null)
  const stateRef = useRef<RoomState | null>(null)
  const loadedDir = useRef<string | null>(null)
  const roomLoad = useRef<object | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [composing, setComposing] = useState(false)
  const [busy, setBusy] = useState(false)
  const authorTail = useRef<Promise<void>>(Promise.resolve())
  const [editMessage, setEditMessage] = useState('')
  const [undoToken, setUndoToken] = useState<string | null>(null)
  const [multi, setMulti] = useState<ReadonlySet<number>>(new Set())
  const anchor = useRef<number | null>(null)
  const multiBasis = useRef('')
  // After a move or a New card the selected part keeps keyboard focus once the room has read the change.
  const focusAfterRead = useRef(false)
  // Parts removed on screen before main answered (spec folio-workspace I-7: the card goes at once); a refusal shows them again.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [toast, setToast] = useState<RemovalToast | null>(null)
  const removing = useRef(false)
  // The room's own writes that have finished, and how many had when the model on screen arrived: a removal asked
  // from a model older than the room's last write reads the room again before it writes (its cards would be stale).
  const ownWrites = useRef(0)
  const ownWritesAtModel = useRef(0)

  // One shared read of the room (folio-room-store.ts): the room, the binder and the wrapper take the same answer.
  const reload = useCallback((): void => { refreshRoom(dir) }, [dir])

  useEffect(() => {
    holdOrder.current = false; heldAnswer.current = null; outlinePress.current = false
    loadedDir.current = dir
    roomLoad.current = {}
    setModel(undefined)
    setBusy(false)
    setState(null)
    setMulti(new Set())
    setUndoToken(null)
    setEditMessage('')
    setHidden(new Set())
    setToast(null)
    activateSidebar(dir)
    setBoardShown(false); setInspectorMounted(false)
    setLooseOpen(false); setLooseSelected(null)
    stateRef.current = null
    void window.writeflex.folioRoom.getState(dir).then((stored) => {
      if (loadedDir.current !== dir) return
      stateRef.current = stored
      setState(stored)
    }).catch(() => { stateRef.current = DEFAULT_ROOM_STATE; setState(DEFAULT_ROOM_STATE) })
    const unsubscribe = subscribeRoom(dir, (answer) => {
      if (loadedDir.current !== dir) return
      if (holdOrder.current) { heldAnswer.current = answer; return }
      if ('error' in answer) { setError(true); return }
      ownWritesAtModel.current = ownWrites.current
      setModel(answer.model)
      setError(false)
    })
    return () => { loadedDir.current = null; roomLoad.current = null; pendingViewPath.current = null; unsubscribe(); releaseSidebar(dir) }
  }, [dir])

  // A part hidden by a removal is shown by the model no longer once main has written: it leaves the hidden set then.
  useEffect(() => {
    if (!model || hidden.size === 0) return
    const present = new Set(model.parts.map(partKey))
    if ([...hidden].some((key) => !present.has(key))) setHidden((previous) => new Set([...previous].filter((key) => present.has(key))))
  }, [model, hidden])

  const update = useCallback((patch: Partial<RoomState>): void => {
    if (patch.split === true) setBoardShown(false)
    const next = { ...(stateRef.current ?? DEFAULT_ROOM_STATE), ...patch }
    stateRef.current = next
    setState(next)
    void window.writeflex.folioRoom.setState(dir, patch).catch(() => undefined)
  }, [dir])

  const insertEvidence = (part: RoomPart, row: RoomEvidenceRow, quote?: string): void => {
    if (!part.written || !part.key.path) return
    let link = row.target
    if (row.path) {
      const from = part.key.path.split('/').slice(0, -1), to = row.path.split('/')
      while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift() }
      link = [...from.map(() => '..'), ...to].join('/')
    }
    const citation = { authorYear: row.citationLabel ?? row.title.replace(/^⟨|⟩$/g, ''), link }
    setPendingCitation({ path: part.key.path, text: row.kind === 'archive' ? archiveLinkMarkdown({ title: row.title, link: row.target, publicUrl: null }) : quote ? quotedCitation(quote, citation) : citationChip(citation) })
    update({ selected: part.key, ...(stateRef.current?.view === 'text' ? {} : { view: 'cards' as const, split: true }) })
  }
  useEffect(() => {
    if (!pendingCitation || textLoaded !== pendingCitation.path || editor?.current?.path() !== pendingCitation.path) return
    const handle = editor.current
    if (handle.view()?.state.readOnly) { setEditMessage('This part is read-only. The citation was not inserted.'); setPendingCitation(null); return }
    handle.insertText(pendingCitation.text, { block: true }); handle.view()?.focus(); setPendingCitation(null)
  }, [pendingCitation, textLoaded, editor])

  const author: RoomAuthor = useCallback((request: RoomAuthoringRequest): Promise<boolean> => {
    const queued = authorTail.current.then(async () => {
    if (!runningOrder) return false
    const asked = dir
    setBusy(true)
    try {
      const roomRequest = request.op === 'evidence' || request.op === 'attachEvidence' || (request.op === 'undo' && request.token.startsWith('ev:')) ? { ...request, session: evidenceSession } : request
      const written = await runningOrder.write(dir, () => window.writeflex.folioRoom.author(dir, roomRequest))
      const answer = written.ok ? written.value : { ok: false as const, message: written.message }
      if (answer.ok) ownWrites.current += 1
      if (loadedDir.current !== asked) return answer.ok
      setEditMessage(answer.message)
      if (answer.ok) { setUndoToken(answer.token); if (request.op === 'remove') setMulti(new Set()) }
      reload()
      return answer.ok
    } catch (error) {
      if (loadedDir.current === asked) setEditMessage(error instanceof Error ? error.message : 'The Folio could not be saved.')
      return false
    } finally { if (loadedDir.current === asked) setBusy(false) }
    })
    authorTail.current = queued.then(() => undefined, () => undefined)
    return queued
  }, [dir, runningOrder, reload, evidenceSession])

  const jumpToFlag = (part: RoomPart, flag: ShownFlag): void => {
    update({ selected: part.key, view: 'text', split: false })
    setPendingFlag({ part, flag })
  }
  useEffect(() => {
    if (!pendingFlag || textLoaded !== pendingFlag.part.key.path || editor?.current?.path() !== textLoaded) return
    const view = editor.current.view()
    if (!view) return
    const expected = pendingFlag.flag
    const found = findFlags(view.state.doc.toString()).find(flag => flag.from === expected.from && flag.words === expected.words && flag.kind === expected.kind)
    if (found) {
      const block = found.inTable ? livePreviewBlocks(view.state).find(block => block.from <= found.from && block.to >= found.to) : null
      view.dispatch({ selection: { anchor: found.wordsFrom, head: found.wordsTo }, ...(block ? { effects: setOpenLivePreviewBlock.of(block) } : {}), scrollIntoView: true })
      if (pendingFlag.clear) { clearFlagAtCursor(view); setEditMessage('Cleared the flag; its words are kept. Use Undo in the text to restore it.') }
      view.focus()
    } else setEditMessage('That flag changed. Select it again from the refreshed list.')
    setPendingFlag(null)
  }, [pendingFlag, textLoaded, editor])
  const clearFlag = (part: RoomPart, flag: ShownFlag): void => {
    const current = editor?.current
    const view = current?.path() === part.key.path ? current.view() : null
    if (view) {
      const found = findFlags(view.state.doc.toString()).find(item => item.from === flag.from && item.words === flag.words && item.kind === flag.kind)
      if (!found) { setEditMessage('That flag changed. Select it again from the refreshed list.'); return }
      view.dispatch({ selection: { anchor: found.wordsFrom, head: found.wordsTo } })
      clearFlagAtCursor(view)
      setEditMessage('Cleared the flag; its words are kept. Use Undo in the text to restore it.')
    } else if (flag.live) { update({ selected: part.key, view: 'text', split: false }); setPendingFlag({part,flag,clear:true}) }
    else void author({ op: 'clearFlag', index: part.index, expected: part.card, from: flag.from, fingerprint: flag.fingerprint })
  }

  const parts = model?.parts ?? EMPTY_ROOM_PARTS
  const pendingViewPath = useRef<string | null>(null)
  const roomLoading = model === undefined || state === null
  // Front matter is not drawn as a card, so the selection lives among the cards: a selection that names front matter (or nothing) shows the first card.
  // A part being removed is not drawn either (optimistic, I-7).
  const cards = useMemo(() => parts.filter((part) => !part.frontMatter && !hidden.has(partKey(part))), [parts, hidden])
  const selectionBasis = JSON.stringify(parts.map(part => part.card))
  useEffect(() => { setMulti(new Set()); anchor.current = null; multiBasis.current = '' }, [selectionBasis])
  const chosen = model && state ? shownSelection(parts, state.selected) : null
  const shown = chosen === null ? null : parts[chosen]?.frontMatter && !state?.selected ? cards[0]?.index ?? chosen : chosen
  const selectedPart = shown === null ? null : parts[shown] ?? null
  const navigateHeading = useFolioHeadingNavigation(dir, textLoaded, editor, selectedPart?.key.path ?? null, state?.view === 'text')
  const selectedPartRef = useRef<RoomPart | null>(null)
  selectedPartRef.current = selectedPart
  const [looseOpen, setLooseOpen] = useState(false)
  const [looseSelected, setLooseSelected] = useState<string | null>(null)
  const statusDragSource = useRef<RoomPart | null>(null)
  const runOwnRef = useRef<(command: PlanCommandName) => void>(() => undefined)
  const attachSource = useCallback(async (part: RoomPart, source: EvidenceTransfer): Promise<boolean> => {
    if (!model) return false
    if (source.kind === 'file' && model.dir && !source.path.startsWith(model.dir + '/')) {
      const sourcePath = source.path
      const candidate = model.evidence?.candidates.find(candidate => candidate.path === sourcePath && candidate.kind === 'note')
      if (!candidate) { setEditMessage('Choose a source inside this Folio, or attach a workspace note.'); return false }
      source = { kind: 'note', title: candidate.title }
    }
    return author({ op: 'attachEvidence', part: part.title, source, session: evidenceSession, stateKey: model.stateKey })
  }, [model, author, evidenceSession])
  useEffect(() => {
    if (!model || !selectedPart) return
    return registerEvidenceAttachmentTarget({ owner: model.stateKey, part: selectedPart.title, attach: source => attachSource(selectedPart, source) })
  }, [model, selectedPart, attachSource])
  const evidenceOver = (event: React.DragEvent): boolean => {
    if (!isEvidenceDrag(event.dataTransfer)) return false
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; return true
  }
  const evidenceDrop = (event: React.DragEvent, part: RoomPart): boolean => {
    if (!model || !isEvidenceDrag(event.dataTransfer)) return false
    event.preventDefault(); event.stopPropagation()
    const source = evidenceFromDrag(event.dataTransfer, model)
    if (source) void attachSource(part, source)
    else setEditMessage('That drop did not contain a source WriteFlex could attach.')
    return true
  }

  // What the Folio commands act on if one is run from here: the shown selection.
  if (selectionRef) selectionRef.current = selectedPart?.key ?? null

  const selectIndex = useCallback((index: number): void => {
    const part = cards[index]
    if (!part) return
    update({ selected: part.key })
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-part-index="${part.index}"]`)?.focus())
  }, [cards, update])

  const setView = useCallback((view: RoomView): void => {
    if (ROOM_AVAILABLE_VIEWS.includes(view)) { setBoardShown(false); if(view==='map')setMulti(new Set()); update({ view, ...(view === 'cards' ? { cardsByStatus: false } : {}) }) }
  }, [update])

  // Split is the Cards view with the selected card's text beside it. From another view it goes to Cards with the text beside; in Cards it toggles.
  const toggleSplit = useCallback((): void => {
    const current = stateRef.current ?? DEFAULT_ROOM_STATE
    update(current.view === 'cards' ? { split: !current.split } : { view: 'cards', split: true })
  }, [update])

  const openRoomPath = useCallback((path: string): void => {
    if (roomLoading) { pendingViewPath.current = path; return }
    if (!parts.some(part => part.key.path === path)) { onOpenPiece(path); return }
    update({ view: 'text', split: false, selected: { title: '', path } })
  }, [roomLoading, parts, onOpenPiece, update])
  useEffect(() => {
    const onView = (event: Event): void => {
      const command = (event as CustomEvent<RoomViewCommand>).detail
      if (typeof command === 'object') openRoomPath(command.path)
      else if (command === 'split') toggleSplit()
      else if (command === 'status-lanes') { setBoardShown(false); update({ view: 'cards', split: false, cardsByStatus: true }) }
      else setView(command)
    }
    window.addEventListener(ROOM_VIEW_EVENT, onView)
    return () => window.removeEventListener(ROOM_VIEW_EVENT, onView)
  }, [setView, toggleSplit, update, openRoomPath])
  useEffect(() => {
    if (roomLoading || pendingViewPath.current === null) return
    const path = pendingViewPath.current
    pendingViewPath.current = null
    openRoomPath(path)
  }, [roomLoading, openRoomPath])

  const columns = (): number => {
    const cards = [...(gridRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
    if (cards.length === 0) return 1
    const top = cards[0].offsetTop
    return Math.max(1, cards.filter((card) => card.offsetTop === top).length)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], .cm-editor'))) return
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && lanes && selectedPart) { event.preventDefault(); moveLane(event.key === 'ArrowRight' ? 1 : -1); return }
    if (event.metaKey || event.ctrlKey || event.altKey || cards.length === 0) return
    const at = Math.max(0, cards.findIndex((part) => part.index === shown))
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? columns() : event.key === 'ArrowUp' ? -columns() : 0
    const choose = (target: number): void => {
      if (event.shiftKey) {
        multiBasis.current = selectionBasis
        const first = anchor.current ?? shown ?? cards[at].index
        anchor.current = first
        const last = cards[target].index
        setMulti(new Set(cards.filter(part => part.index >= Math.min(first, last) && part.index <= Math.max(first, last)).map(part => part.index)))
      } else if (!multi.size) anchor.current = cards[target].index
      selectIndex(target)
    }
    if (event.key === ' ') {
      event.preventDefault(); multiBasis.current = selectionBasis
      const index = cards[at].index
      setMulti(previous => { const next = new Set(previous); if (next.has(index)) next.delete(index); else next.add(index); return next })
      anchor.current ??= index
      return
    }
    if (step !== 0) { event.preventDefault(); choose(Math.min(cards.length - 1, Math.max(0, at + step))); return }
    if (event.key === 'Home') { event.preventDefault(); choose(0) }
    else if (event.key === 'End') { event.preventDefault(); choose(cards.length - 1) }
    else if (event.key === 'Enter' && !event.shiftKey && selectedPart) { event.preventDefault(); if (view === 'outline') update({ view: 'text' }); else update({ split: true }) }
    else if (event.key === 'Escape' && beside) { event.preventDefault(); event.stopPropagation(); update({ split: false }) }
  }

  const view = state?.view ?? 'outline'
  const beside = state ? textBeside(state.view, state.split) : false
  const byStatus = state?.cardsByStatus === true
  const statusBoardOn = view === 'cards' && byStatus && !beside && !boardShown
  const boardOn = boardShown && board !== undefined && view === 'cards' && !beside
  // Group by status draws every status as a lane, in the order the Board saved for this folder (empty lanes take drops).
  const lanes = byStatus && !beside && !boardOn ? groupByStatus(cards, laneOrder(columnOrder(dir))) : null
  useEffect(() => { onBoardShown?.(boardOn); return () => onBoardShown?.(false) }, [boardOn, onBoardShown])
  /** ⌥← / ⌥→: the selected card to the lane on its left or right (the Board's keyboard lane move). */
  const moveLane = (step: 1 | -1): void => {
    if (!lanes || !selectedPart) return
    const target = neighbourLaneStatus(lanes, selectedPart.status, step)
    if (target === null) return
    void author({ op: 'status', index: selectedPart.index, expected: selectedPart.card, status: target }).then((ok) => { if (ok) focusAfterRead.current = true })
  }
  const before = neighbourPart(cards, shown, -1)
  const after = neighbourPart(cards, shown, 1)
  const selectPart = (part: RoomPart, event?: Pick<React.MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>, visible?: readonly number[]): void => {
    setEditMessage('')
    setLooseSelected(null)
    dispatchSidebar('select-part')
    multiBasis.current = selectionBasis
    if (visible && event?.shiftKey && anchor.current === null) anchor.current = shown ?? part.index
    if (event?.shiftKey && anchor.current !== null) {
      const lo = Math.min(anchor.current, part.index), hi = Math.max(anchor.current, part.index)
      setMulti(new Set(visible ? visibleSectionRange(visible, lo, hi) : cards.filter(item => item.index >= lo && item.index <= hi).map(item => item.index)))
    } else if (event?.metaKey || event?.ctrlKey) {
      setMulti(previous => { const next = new Set(previous.size ? previous : shown === null ? [] : [shown]); if (next.has(part.index)) next.delete(part.index); else next.add(part.index); return next })
      anchor.current = part.index
    } else { setMulti(new Set()); anchor.current = part.index }
    update({ selected: part.key })
  }

  /** A part opened from the workspace (a double click, Enter, a second click in the binder, the Map): its text, in the Text tab. A planned part has no file: it is only selected. */
  const openPart = (part: RoomPart): void => {
    if (!part.written || !part.key.path) { selectPart(part); return }
    setMulti(new Set()); anchor.current = part.index
    dispatchSidebar('select-part')
    update({ selected: part.key, view: 'text', split: false })
  }
  /** A file opened by path (the Map, Evidence): a part opens in the Text tab, any other file in the editor as before. */
  const openPath = (path: string): void => {
    const part = parts.find((candidate) => candidate.key.path === path)
    if (part) openPart(part); else onOpenPiece(path)
  }

  // ---- The running order's writes (ticket 11) ----
  const canWrite = runningOrder !== undefined && model !== null && model !== undefined && !model.startAPlan
  // New card also works in a "Start a plan" room (its first card writes the Running order heading): the palette's
  // "Add a Folio outline part" and N open its field there too (review T-2).
  const canAdd = runningOrder !== undefined && model !== null && model !== undefined
  const startAPlan = model?.startAPlan === true
  const keys = useMemo(() => parts.map((part) => part.key), [parts])
  /** Move the part at running-order index `from` to `to` (both among the cards: front matter never moves here). */
  const move = useCallback(async (from: number, to: number, sourceKey?: string): Promise<void> => {
    const askedRoom = roomLoad.current
    const current = (): boolean => askedRoom !== null && roomLoad.current === askedRoom && loadedDir.current === dir
    if (!current()) return
    if (sourceKey === undefined && outlinePress.current) return
    if (!runningOrder || !model || busy || from === to) return
    const part = parts[from]
    if (!part || !parts[to] || part.frontMatter || parts[to].frontMatter) return
    if (sourceKey !== undefined && JSON.stringify(part.card) !== sourceKey) {
      setEditMessage(OUTLINE_DRAG_CHANGED_MESSAGE)
      return
    }
    if (sourceKey !== undefined && parts.filter(other => samePlanCard(other.card, part.card)).length > 1) {
      setEditMessage(AMBIGUOUS_DRAG_MESSAGE)
      return
    }
    holdOrder.current = true; heldAnswer.current = null
    const reordered = [...parts]
    reordered.splice(to, 0, reordered.splice(from, 1)[0])
    setModel({ ...model, parts: reordered.map((item, index) => ({ ...item, index })) })
    setBusy(true)
    try {
      const left = await runningOrder.moveInRoom(dir, keys, from, to)
      if (!current()) return
      if (left) {
        confirmRoomOrder(dir, left); update({ selected: part.key }); focusAfterRead.current = true
        const answer = readHeldAnswer()
        if (answer && 'model' in answer) { ownWritesAtModel.current = ownWrites.current; setModel(answer.model) }
      } else { setModel(model); reload() }
    } catch (error) {
      if (!current()) return
      setModel(model); reload(); setEditMessage(error instanceof Error ? error.message : 'The part could not be moved.')
    } finally {
      if (current()) {
        holdOrder.current = false; heldAnswer.current = null
        setBusy(false)
      }
    }
  }, [busy, dir, keys, model, parts, runningOrder, update])
  const drag = usePartDrag(canWrite && !busy && view !== 'text' && view !== 'map', (from, to) => { void move(from, to) })
  const renderedRoom = roomLoad.current
  const outlineDragActive = (active: boolean): void => {
    if (loadedDir.current !== dir || roomLoad.current !== renderedRoom) return
    outlinePress.current = active
    if (active) { holdOrder.current = true; heldAnswer.current = null; return }
    holdOrder.current = false
    const answer = readHeldAnswer(); heldAnswer.current = null
    if (answer && 'model' in answer) { ownWritesAtModel.current = ownWrites.current; setModel(answer.model) }
    else if (answer) setError(true)
  }
  const refuseOutlineDrag = (message: string): void => {
    if (loadedDir.current === dir && roomLoad.current === renderedRoom) setEditMessage(message)
  }
  const moveSelected = useCallback((step: 1 | -1): void => {
    if (outlinePress.current) return
    if (shown === null) return
    const at = cards.findIndex((part) => part.index === shown)
    const target = cards[at + step]
    if (at < 0 || !target) return
    void move(shown, target.index)
  }, [cards, move, shown])
  const addCard = useCallback(async (title: string): Promise<boolean> => {
    if (!runningOrder) return false
    setBusy(true)
    try {
      const left = await runningOrder.addRoomCard(dir, keys, title)
      if (!left) return false
      const added = left.find((part) => part.path === null && part.title === title.trim())
      if (added) { update({ selected: added }); focusAfterRead.current = true }
      return true
    } finally {
      setBusy(false)
    }
  }, [dir, keys, runningOrder, update])
  const openComposer = useCallback((): void => {
    if (!canAdd) return
    if (view !== 'cards' && view !== 'outline') update({ view: 'cards' })
    setComposing(true)
  }, [canAdd, update, view])

  /**
   * Remove the parts at `indices` from the Folio (spec folio-workspace § 1): at once, no question asked. The cards go
   * from the screen now; main moves written parts' files into the Folio bin and answers with the toast's sentence and
   * its Undo; a refusal shows the cards again with main's sentence. One removal at a time: another Delete pressed before
   * the room has read the first one's result does nothing.
   */
  const removeParts = useCallback((indices: number[]): void => {
    if (!model || !runningOrder || removing.current || hidden.size > 0) return
    const chosen = [...new Set(indices)].map((index) => model.parts[index]).filter((part): part is RoomPart => Boolean(part))
    if (chosen.length === 0) return
    const keys = chosen.map(partKey)
    const gone = new Set(keys)
    const at = cards.findIndex((part) => gone.has(partKey(part)))
    const last = cards.reduce((found, part, index) => (gone.has(partKey(part)) ? index : found), -1)
    const next = cards.slice(last + 1).find((part) => !gone.has(partKey(part))) ?? [...cards.slice(0, Math.max(0, at))].reverse().find((part) => !gone.has(partKey(part))) ?? null
    const seen = model
    const asked = dir
    removing.current = true
    setHidden(new Set(keys))
    setMulti(new Set())
    setToast(null)
    setEditMessage('')
    if (next) {
      update({ selected: next.key })
      requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-part-index="${next.index}"]`)?.focus())
    }
    const queued = authorTail.current.then(async () => {
      let answer: RoomAuthoringResult
      try {
        // A write of the room's own (a synopsis just entered) finished after the model this removal was chosen from:
        // read the room again and find the chosen parts by title and path, so main's stale-card check sees this
        // room's cards. Parts that are gone leave the removal to main's refusal.
        const current = ownWrites.current !== ownWritesAtModel.current ? (await window.writeflex.folioRoom.read(dir)) ?? seen : seen
        const at = new Map(current.parts.map((part) => [partKey(part), part.index]))
        const indices = keys.map((key) => at.get(key) ?? -1)
        const expected = current.parts.map((part) => part.card)
        const written = indices.includes(-1)
          ? { ok: true as const, value: { ok: false as const, message: 'The Folio outline changed. Select the parts again; nothing was removed.' } }
          : await runningOrder.write(dir, () => window.writeflex.folioRoom.author(dir, { op: 'remove', indices, expected }))
        answer = written.ok ? written.value : { ok: false, message: written.message }
        if (answer.ok) ownWrites.current += 1
      } catch (error) {
        answer = { ok: false, message: error instanceof Error ? error.message : 'The Folio could not be saved.' }
      }
      removing.current = false
      if (loadedDir.current !== asked) return
      if (answer.ok) {
        setToast({ message: answer.message, token: answer.token, keys })
        if (answer.token) announceUndoToast(asked, 'room')
      }
      else {
        // Refused: nothing was written. The cards come back, the selection with them.
        setHidden(new Set())
        update({ selected: chosen[0].key })
        setEditMessage(answer.message)
      }
      reload()
    })
    authorTail.current = queued.then(() => undefined, () => undefined)
  }, [model, runningOrder, hidden, cards, dir, update, reload])

  const removeSelected = useCallback((): void => {
    if (!model) return
    const indices = multi.size ? [...multi] : selectedPart ? [selectedPart.index] : []
    if (indices.length) removeParts(indices)
  }, [model, multi, selectedPart, removeParts])

  /** A Folio command the workspace runs (the palette, a chord, or a key on the room). */
  const runOwn = (command: PlanCommandName): void => {
    if (view === 'map' && (command === 'move-up' || command === 'move-down' || command === 'remove')) { setEditMessage('Use Cards or Outline to change the running order, or Use this order for the map path.'); return }
    if (command === 'add') openComposer()
    else if (command === 'remove') removeSelected()
    else if (command === 'move-up' || command === 'move-down') { if (view !== 'text') moveSelected(command === 'move-up' ? -1 : 1) }
    else if (command === 'not-in-outline-toggle') { dispatchSidebar('show-binder'); setLooseOpen(open => !open) }
    else if (command === 'open-part') { if (looseSelected) onOpenPiece(looseSelected); else if (selectedPart?.written) openPart(selectedPart); else if (selectedPart) tools.runCommand(command, selectedPart.key, null) }
    else {
      if (command === 'add-all' || command === 'sort' || command.startsWith('titles-')) update({ view: 'outline' })
      tools.runCommand(command, selectedPart?.key ?? null, looseSelected)
    }
  }
  runOwnRef.current = runOwn

  /** The toast's Undo and ⌘Z: the last removal, exactly, or main's refusal (nothing written). */
  const undoRemoval = useCallback((): void => {
    const held = toast
    if (!held?.token) return
    setToast(null)
    setHidden(new Set())
    void author({ op: 'undo', token: held.token })
  }, [toast, author])
  // The binder's Restore toast is newer: this one closes (one Undo toast at a time).
  useEffect(() => onOtherUndoToast(dir, 'room', () => setToast(null)), [dir])
  useEffect(() => {
    if (!toast?.token) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z' || focusTypes()) return
      event.preventDefault()
      undoRemoval()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toast, undoRemoval])

  // ⌥↑ / ⌥↓ (plan.moveUp / plan.moveDown) and N (plan.addPart) reach the room as Folio commands; it runs them itself.
  useEffect(() => {
    const onCommand = (event: Event): void => {
      const command = (event as CustomEvent<PlanCommandName>).detail
      // From the palette or the app's chord table; never while typing in the text the room shows (Text, or Split). The
      // palette hands focus back to the editor before it runs a command, so focus in an editor the room is not showing
      // (the file open behind the room) does not stop it (review T-2).
      const textShown = !startAPlan && (view === 'text' || beside)
      if (!ROOM_OWN_COMMANDS.has(command) || (planCommandIsShortcut(event) && textShown && !command.startsWith('title') && document.activeElement?.closest('.cm-editor'))) return
      runOwnRef.current(command)
    }
    window.addEventListener(PLAN_COMMAND_EVENT, onCommand)
    return () => window.removeEventListener(PLAN_COMMAND_EVENT, onCommand)
  }, [view, beside, startAPlan])

  useEffect(() => {
    if (!focusAfterRead.current || shown === null) return
    focusAfterRead.current = false
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-part-index="${shown}"]`)?.focus())
  }, [model, shown])

  // The export-order banner: read with the room and again after every read of it (a read writes nothing, I-4).
  const hasWritten = parts.some((part) => part.written)
  const order = useExportOrderCheck(model ? dir : null, model, (check) => roomOrderLine(check, hasWritten))

  /**
   * N, ⌥↑ and ⌥↓ on the room, read as the Folio page reads them (its own keydown, `planCommandForEvent`): while the
   * Collection overlay is up the app's chord table passes only the room's view chords, so these reach the room here.
   * A key the app's table already ran (default prevented) is not run twice; the field and the editor keep their keys.
   */
  const onRoomKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Esc leaves Split from the text beside the cards too (the editor's own Esc, which prevents default, is left alone).
    if (event.key === 'Escape' && beside && !event.defaultPrevented && event.target instanceof HTMLElement && event.target.closest('.cm-editor')) {
      event.preventDefault(); update({ split: false }); return
    }
    if (event.defaultPrevented || focusTypes()) return
    const target = event.target instanceof HTMLElement ? event.target : null
    // The Board shown in Cards has its own keys; the room's act on its own lists and chords.
    if (target?.closest('.fr-boardhost')) return
    // Selection keys leave a key pressed on a sidebar control (the binder's and the inspector's portals bubble through here) alone.
    const mine = !roomKeysIgnored(target)
    // ⌘↵ (Open Folio, at its first part) and ⇧⌘↵ (Open at…) belong to the Open Folio button; ⇧↵ opens the selected part's text.
    if (mine && event.key === 'Enter' && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); if (selectedPart) openPart(selectedPart); return }
    if (mine && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'a' && (view === 'cards' || view === 'outline')) {
      event.preventDefault(); multiBasis.current = selectionBasis; setMulti(new Set(cards.map(part => part.index))); return
    }
    if (mine && event.key === 'Escape' && multi.size) { event.preventDefault(); setMulti(new Set()); return }
    // Delete or Backspace on the chosen part(s) in Cards or Outline: removed at once, with Undo (drawing 4A). ⌘⌫ is the
    // Folio command below (plan.removePart).
    if ((event.key === 'Backspace' || event.key === 'Delete') && !event.metaKey && !event.ctrlKey && !event.altKey && (view === 'cards' || view === 'outline') && !startAPlan) {
      // Only with focus on the cards or Outline list: a button in the binder or inspector is not the part list.
      if (removeKeyApplies(target)) { event.preventDefault(); removeSelected() }
      return
    }
    const command = planCommandForEvent(event, shortcutOverrides)
    if (command === null || !ROOM_OWN_COMMANDS.has(command)) return
    event.preventDefault()
    runOwn(command)
  }
  const sidebar = useSidebarState(dir)
  const textSlot = useSidebarSlot(dir, 'text')
  const inspectorSlot = useSidebarSlot(dir, 'inspector')
  // The inspector stays mounted once it has been shown: closing it hides it, so a field's unsaved draft is never discarded.
  if (sidebar.mode === 'inspector' && !inspectorMounted) setInspectorMounted(true)
  const tools = useFolioPlanTools({ dir, active: view === 'outline' || sidebar.mode === 'inspector' || looseOpen, model, ...(runningOrder ? { runningOrder } : {}), onStatus, onOpenPiece, onSelectPart: index => { const part = parts[index]; if (part) selectPart(part) }, onLeave: () => {
    update({ view: 'outline' }); dispatchSidebar('select-part')
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus())
  } })
  useEffect(() => { if (state) onViewChange?.(state.view) }, [state?.view, onViewChange])
  const openParts = useMemo(() => workspaceOpenParts(parts), [parts])
  const frontMatter = useMemo(() => [
    ...parts.filter((part) => part.frontMatter).map((part) => ({ path: part.key.path, title: part.title })),
    ...(model?.frontMatterFiles ?? []).map((file) => ({ path: file.path, title: file.title })),
  ], [parts, model])

  if (model === undefined || state === null) return <div className="fr-room" aria-busy={error ? undefined : true} data-testid="folio-room">{error && <div className="fr-empty"><b>This Folio could not be read.</b>Close and reopen the folder, then try again.</div>}</div>
  if (model === null) return <div className="fr-room" data-testid="folio-room"><div className="fr-empty"><b>This folder is not a Folio.</b>The room opens on a Folio.</div></div>

  return (
    <div className="fr-room" tabIndex={-1} data-testid="folio-room" data-view={view} onKeyDown={onRoomKeyDown}>
      <div className="fr-mid">
        <div className="fr-head">
          <div className="fr-crumb"><Library className="icon" aria-hidden="true" /><b>{model.name}</b><span className="fr-kind">Folio</span><span className="g" />
            {openParts.length > 0 && <span className="fr-open" data-testid="room-open-folio"><FolioOpenButton returnPath={selectedPart?.key.path ?? null} parts={openParts} onOpen={onOpenFolio ?? onOpenPiece} /></span>}
            {headerActions}</div>
          <div className="fr-titlerow"><h1>{model.title}</h1><span className="fr-info" data-testid="room-meta">{metaLine(model.meta)}{[...flags.values()].flat().length ? ` · ${[...flags.values()].flat().length} flags` : ''}{model.enrichment ? (model.enrichment === 'pending' ? ' · sources loading…' : ' · sources could not be loaded') : model.evidence && (model.evidence.state === 'unreadable' ? ' · evidence file cannot be read' : ` · ${model.parts.filter(part => !part.frontMatter && noEvidence(model, part)).length} with no evidence`)}</span></div>
          <div className="fr-viewrow">
            <div className="seg-view fr-views" role="tablist" aria-label="Views of this Folio">
              {ROOM_VIEWS.map((name) => {
                const Icon = VIEW_ICONS[name]
                const available = ROOM_AVAILABLE_VIEWS.includes(name)
                const chord = available ? viewChord(name) ?? WORKSPACE_TAB_CHORDS[name] : undefined
                return (
                  <button key={name} type="button" role="tab" aria-selected={view === name && !statusBoardOn} aria-pressed={view === name && !statusBoardOn} disabled={!available} title={available ? undefined : 'Arrives in a later release'} data-view={name} onClick={() => { setBoardShown(false); setView(name) }}>
                    <Icon aria-hidden="true" /> {ROOM_VIEW_LABELS[name]}{chord && <kbd className="fr-k">{chord}</kbd>}
                  </button>
                )
              })}
              <button type="button" role="tab" data-view="board" aria-selected={statusBoardOn} aria-pressed={statusBoardOn} onClick={() => { setBoardShown(false); update({ view: 'cards', split: false, cardsByStatus: true }) }}><Columns3 aria-hidden="true" /> Board</button>
            </div>
            {view === 'cards' && !beside && board && <button type="button" className={`fr-tb${boardOn ? ' on' : ''}`} aria-pressed={boardOn} data-testid="cards-board-toggle" title="Sources, offcuts and column order" onClick={() => setBoardShown(!boardShown)}><Columns3 aria-hidden="true" />Sources and offcuts</button>}
            <button type="button" className="fr-tb" data-testid="folio-details-toggle" aria-pressed={sidebar.mode === 'inspector'} onClick={() => dispatchSidebar('toggle-inspector')}>Details</button>
            {view === 'cards' && !beside && !boardOn && <button type="button" className={`fr-tb${byStatus ? ' on' : ''}`} aria-pressed={byStatus} data-testid="group-by-status" title="Group the cards in the Board’s status lanes" onClick={() => update({ cardsByStatus: !byStatus })}>Group by status</button>}
            <button type="button" className={`fr-tb${beside ? ' on' : ''}`} aria-pressed={beside} title="Text beside the cards" data-split onClick={toggleSplit}><Columns2 aria-hidden="true" />Split{viewChord('split') && <kbd className="fr-k">{viewChord('split')}</kbd>}</button>
            <span className="g" />
          </div>
        </div>
        <div className={`fr-body${view === 'text' || beside ? ' fixed' : ''}`}>
          {!model.startAPlan && view !== 'text' && !beside && <RoomOrderBanner state={order} />}
          <RoomLeftOut entries={model.leftOut ?? []} />
          {editMessage && <div className="fr-edit-message" role="status" data-testid="room-edit-message">{editMessage} {undoToken && <button type="button" disabled={busy} onClick={() => void author({ op: 'undo', token: undoToken })}>Undo</button>}</div>}
          {multi.size > 0 && <div className="fr-selection-bar"><b>{multi.size} parts selected</b><button type="button" disabled={busy} onClick={removeSelected}>Remove from Folio</button><button type="button" onClick={() => setMulti(new Set())}>Clear</button></div>}
          {model.startAPlan ? (
            <div className="fr-empty" data-testid="room-start-plan"><b>Start a plan</b>This Folio’s Index Note has no running order yet. Add a “## Running order” list of parts to it and they appear here as cards.
              {canAdd && composing && <NewCard open parts={keys} folio={model.newCardFolio} busy={busy} onOpen={openComposer} onClose={() => setComposing(false)} onAdd={addCard} />}</div>
          ) : (view === 'map' || view === 'evidence') && model.enrichment ? (
            <div className="fr-empty" role="status">{model.enrichment === 'pending' ? 'Loading sources…' : 'Sources could not be loaded.'}</div>
          ) : view === 'map' ? (
            <FolioRoomMap model={model} state={state} update={update} flags={flags} author={author} onOpen={openPath} onSelect={selectPart} runningOrder={runningOrder} />
          ) : view === 'flags' ? (
            <FolioRoomFlags model={model} flags={flags} filter={state.flagsFilter ?? 'all'} onFilter={flagsFilter => update({ flagsFilter })} onJump={jumpToFlag} onClear={clearFlag} busy={busy} />
          ) : view === 'evidence' ? (
            <FolioEvidenceView model={model} author={author} busy={busy} gaps={state.evidenceGaps??false} onGaps={evidenceGaps=>update({evidenceGaps})} onSelect={selectPart} onEvidenceDrop={evidenceDrop} onEvidenceOver={evidenceOver} />
          ) : view === 'files' ? (
            <div className="fr-files" data-testid="room-files">{files?.() ?? <div className="fr-empty"><b>Files</b>The Folio’s folder is listed here.</div>}</div>
          ) : view === 'text' ? (
            <FolioRoomText part={selectedPart} prev={before} next={after} onSelect={selectPart} onShowText={onShowText} textLoaded={textLoaded} />
          ) : (
            <>
              {frontMatter.length > 0 && !beside && (
                <div className="fr-front" data-testid="room-front-matter"><span className="lbl">Front matter</span>
                  {frontMatter.map((file) => <button key={file.path ?? file.title} type="button" onClick={event => {
                    const part = parts.find(part => part.frontMatter && (part.key.path === file.path || (!file.path && part.title === file.title)))
                    if (part) selectPart(part, event); else if (file.path) onOpenPiece(file.path)
                  }} onDoubleClick={() => file.path && onOpenPiece(file.path)}>{file.title}</button>)}
                </div>
              )}
              {view === 'outline' && <div className="fr-otools" data-testid="outline-tools">{tools.toolbar}</div>}
              {view === 'outline' ? (
                <FolioRoomOutline onMove={move} onDragActive={outlineDragActive} onDragRefuse={refuseOutlineDrag} titleWidth={state.outlineTitleWidth} onTitleWidth={width => { update({ outlineTitleWidth: width ?? undefined }); if (width === null) void window.writeflex.folioRoom.setState(dir, { outlineTitleWidth: null } as unknown as Partial<RoomState>) }} expanded={state.outlineExpanded} onExpanded={outlineExpanded => update({ outlineExpanded })} onHeading={target => { const part = parts.find(part => part.key.path === target.path); if (part) { openPart(part); navigateHeading(target) } }} parts={cards} shown={shown} listRef={gridRef} onSelect={selectPart} onKeyDown={onKeyDown} drag={drag} model={model} author={author} busy={busy} multi={multi} flags={flags}
                  newCard={canWrite ? <NewCard row open={composing} parts={keys} folio={model.newCardFolio} busy={busy} onOpen={openComposer} onClose={() => setComposing(false)} onAdd={addCard} /> : null} />
              ) : boardOn ? (
                <div className="fr-boardhost" data-testid="cards-board">{board!({ dir, name: model.name, onLeave: () => setBoardShown(false), onOutline: () => { setBoardShown(false); update({ view: 'outline' }) } })}</div>
              ) : (
                <div className={beside ? 'fr-split' : 'fr-plain'}>
                  <div className={beside ? 'fr-cards fr-scol' : byStatus ? 'fr-cards fr-bystatus' : 'fr-cards'} role="listbox" aria-label="Parts, in running order" aria-multiselectable="true" ref={gridRef} onKeyDown={onKeyDown}>
                    {(lanes ?? [{ status: '', parts: cards }]).map((lane) => {
                      const drawn = lane.parts.map((part) => (
                        <Card key={roomPartRenderKey(part, parts)} part={part} selected={multi.size ? multi.has(part.index) : shown === part.index} focusable={shown === part.index} compact={beside} drag={byStatus && !beside ? { ...drag, props: index => ({ ...drag.props(index), onDragStart: event => { statusDragSource.current = parts[index] ?? null; drag.props(index).onDragStart(event) }, onDragEnd: () => { statusDragSource.current = null; drag.props(index).onDragEnd() }, onDragOver: () => undefined, onDrop: () => undefined }) } : drag} onEvidenceDrop={event => evidenceDrop(event, part)} onEvidenceOver={evidenceOver}
                          onSelect={(event) => selectPart(part, event)} onOpen={() => openPart(part)} />
                      ))
                      return lanes
                        ? <section key={lane.status} className="fr-lane" data-lane={lane.status.toLowerCase()}
                          onDragOver={event => { if (drag.dragged !== null && event.dataTransfer.types.includes('application/x-writeflex-room-part')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }}
                          onDrop={event => {
                            if (drag.dragged === null || !event.dataTransfer.types.includes('application/x-writeflex-room-part')) return
                            event.preventDefault(); event.stopPropagation()
                            const part = statusDragSource.current
                            statusDragSource.current = null
                            drag.props(drag.dragged).onDragEnd()
                            if (part && part.status.toLowerCase() !== lane.status.toLowerCase()) void author({ op: 'status', index: part.index, expected: part.card, status: lane.status })
                          }}><h3>{lane.status}<small>{lane.parts.length}</small></h3><div className="fr-lane-cards">{drawn}</div></section>
                        : drawn
                    })}
                    {!beside && canWrite && <NewCard open={composing} parts={keys} folio={model.newCardFolio} busy={busy} onOpen={openComposer} onClose={() => setComposing(false)} onAdd={addCard} />}
                  </div>
                  {beside && <FolioRoomText part={selectedPart} prev={before} next={after} onSelect={selectPart} onShowText={onShowText} textLoaded={textLoaded} />}
                </div>
              )}
            </>
          )}
        </div>
        <div className="fr-foot">
          {view === 'map' ? <span><kbd>←↑↓→</kbd> move cards · arrows on <kbd>↘</kbd> resize</span> : view === 'text' ? <span><kbd>‹</kbd><kbd>›</kbd> previous and next part</span> : view === 'outline' ? <span><kbd>↵</kbd> open the text</span> : <span><kbd>↵</kbd> text beside</span>}
          {beside && <span><kbd>Esc</kbd> back to cards</span>}
          {(view === 'cards' || view === 'outline') && <span><kbd>{view === 'outline' ? '↑↓' : '←↑↓→'}</kbd> choose · <kbd>⇧</kbd> extend · <kbd>Space</kbd> select</span>}
          {lanes && selectedPart && <span data-testid="room-lane-hint"><kbd>{LANE_MOVE_CHORDS.left}</kbd><kbd>{LANE_MOVE_CHORDS.right}</kbd> move to the lane beside</span>}
          {(view === 'cards' || view === 'outline') && selectedPart && <span><kbd>{OPEN_SELECTED_CHORD}</kbd> open the text</span>}
          {(view === 'cards' || view === 'outline') && canWrite && roomMoveChord() && <span data-testid="room-move-hint"><kbd>{roomMoveChord()}</kbd> move (rewrites the running order)</span>}
          {(view === 'cards' || view === 'outline') && canWrite && chordOf('plan.addPart') && <span><kbd>{chordOf('plan.addPart')}</kbd> new card</span>}
          <RoomOrderSource indexNote={model.newCardFolio.indexNote ?? null} /></div>
      </div>
      {toast && (
        <div className="fr-toast" role="status" data-testid="room-toast" ref={element => {
          // The editor sits above the collection overlay; the toast needs the top layer so Undo stays clickable in Split.
          if (element && !element.matches(':popover-open')) { element.setAttribute('popover', 'manual'); element.showPopover() }
        }}>
          <span>{toast.message}</span>
          {toast.token && <button type="button" className="fr-toast-undo" aria-label="Undo" title="Undo (⌘Z)" onClick={undoRemoval}>Undo <kbd aria-hidden="true">⌘Z</kbd></button>}
          <button type="button" className="fr-toast-close" aria-label="Dismiss" onClick={() => setToast(null)}>×</button>
        </div>
      )}
      {textSlot && createPortal(
        <FolioBinderText showParts={false} model={model} shown={shown} titleRow={sidebar.titleRow} hidden={hidden} canAdopt={runningOrder !== undefined}
          onTitle={() => dispatchSidebar('select-title-row')} onPart={(part) => { setLooseSelected(null); selectPart(part) }} onOpenPart={openPart} onAdopt={tools.adopt} unlistedPlan={tools.unlisted} onHeadingMode={tools.chooseHeading} onOpenFile={onOpenPiece} loose={looseOpen} onLoose={setLooseOpen} onLooseSelect={setLooseSelected} />, textSlot)}
      {inspectorSlot && (inspectorMounted || sidebar.mode === 'inspector') && createPortal(
        sidebar.titleRow
          ? <aside className="fr-insp" aria-label="Inspector" data-subject="folio"><div className="fr-ih"><span className="lbl">Folio</span></div><div className="fr-iscroll">{tools.folioInspector}</div></aside>
          : <FolioRoomInspector onRemove={(part) => removeParts([part.index])} part={selectedPart} model={model} author={author} busy={busy || !runningOrder} flags={selectedPart ? flags.get(selectedPart.index) ?? [] : []} onFlag={flag => selectedPart && jumpToFlag(selectedPart, flag)} onOpenEvidence={onOpenPiece} onInsertEvidence={insertEvidence} onEvidenceDrop={evidenceDrop} onEvidenceOver={evidenceOver} extras={selectedPart ? tools.partExtras(selectedPart.index) : null} />, inspectorSlot)}
      {tools.overlays}
    </div>
  )
}
