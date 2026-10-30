import { EVIDENCE_DRAG_MIME, type EvidenceTransfer } from '../../../shared/folio-evidence-transfer'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react'
import {
  createViewStatePersistence,
  ReaderEmbed,
  type ReaderAnnotation,
  type ReaderHostChord,
  type ReaderHostWindow,
  type ReaderLiveness,
  type ReaderSelectionAnnotation,
  type ViewStatePersistence,
} from '@readflex/reader-embed'
import type {
  HighlightRow,
  ReadingBookmarkRow,
  ReadingRoomDocument,
  ReadingRoomState,
  ReadingRoomWriteResult,
  RecentDocumentRow,
  RefusedHighlight,
  ShelfRow,
} from '../../../preload'
import { ReadingRoomShelf } from './ReadingRoomShelf'
import { ReadingRoomHighlights } from './ReadingRoomHighlights'
import { ReadingRoomRefused } from './ReadingRoomRefused'
import { ReadingRoomNotice } from './ReadingRoomNotice'
import { ReadingRoomRail, type ReadingRoomRailView } from './ReadingRoomRail'
import { normaliseReaderText } from '../editor/citation'
import {
  READING_ROOM_AREA_MIME,
  readingRoomAreaTransferForAnnotation,
} from '../editor/reading-room-area-drop'
import {
  beginReadingRoomResize,
  ceilingForReadingRoom,
  clampReadingRoomWidth,
  MIN_ROOM_WIDTH,
  readingRoomWidthForKey,
  type ReadingRoomResizeSession,
  type ReadingRoomSide,
} from '../reading-room-resize'
import {
  completeAreaCapture,
  initialReadingRoomMarkState,
  leaveReadingRoomMarkMode,
  markStatus,
  readingRoomTool,
  selectAreaMode,
  selectHighlightColour,
  selectHighlightMode,
  type ReadingHighlightColour,
  type ReadingRoomMarkState,
} from '../reading-room-marks'
import { restoreReadingBookmark } from '../reading-room-bookmarks'
import { createHeldMarks } from '../reading-room-held-marks'

export type ReadingRoomProps = {
  onClose: () => void
  onError: (message: string) => void
  /** A modified chord the reader forwarded out of its own document (ReadFlex ADR-0028), for App's
   *  chord table to run. The payload is a plain keystroke description — the Room, and WriteFlex
   *  behind it, learn nothing about the reader's iframes. */
  onHostChord: (chord: ReaderHostChord) => void
  /** Bumped by the `Reading Room: Highlights view` command; each bump raises the harvest. */
  highlightsRequest: number
  /** The set of highlights Zotero has not taken may have changed, so the one quiet indicator can
   *  refresh. Nothing else reacts to it — the mark itself must look identical whether or not it has
   *  synced (ADR-0029). Called on a queue, on opening a document, and on raising the harvest, so the
   *  count cannot sit stale just because the change came from somewhere other than this window. */
  onOutboxChanged: () => void
  /**
   * What Zotero said about a write the Room just attempted — its own saves, and the drains it fires on
   * opening. **ADR-0036: this used to be thrown away**, which is why a write refused because Zotero was
   * open was completely silent. App keeps the last word, so the refusal reaches both the notice below
   * the locator and the sync button in the status bar.
   */
  onWriteResult: (result: ReadingRoomWriteResult) => void
  /** An explicit sync requested from the Room's notice. Never throttled or coalesced away. */
  onSyncHighlights: () => void
  /** A bounded background sync used when the Room or one of its documents opens. */
  onSyncHighlightsAutomatically: () => void
  /**
   * The refusal sentence to show while something is still owed to Zotero, or null when nothing is —
   * *"Zotero is not open. Your highlights are saved here and are sent when Zotero is open."*, in the main process's own
   * words rather than any the renderer invents. Shown as a quiet notice, never a modal: highlighting is
   * a flow, and interrupting it to explain a delay would be worse than the silence it replaces.
   */
  outboxRefusal: string | null
  /** Which refusal `outboxRefusal` is: a wait (Zotero closed or busy), a missing plugin, or a failure. */
  outboxRefusalCode: string | null
  /** Highlights, edits and deletions still owed to Zotero — the notice's count. */
  outboxWaiting: number
  /** Text just copied or dragged OUT of the reader, so a paste into the draft can arrive as a quote
   *  with its reference. Null clears it. */
  onReaderSelection: (selection: ReaderSelection | null) => void
  /** Bumped by `Insert reference…`; raises the Shelf as a reference PICKER rather than an opener. */
  citeRequest: number
  /** Called with the item the writer chose while citing. The Room does not know what a citation looks
   *  like — App owns the Markdown — so this just reports the choice. */
  onCite: (row: ShelfRow) => void
  /**
   * The draft the Room is beside — the absolute path of the active Markdown file, or null when none
   * is on screen. **Which paper is open is scoped to this** (ReadFlex ADR-0032): changing it swaps the
   * reading, and a draft with no remembered paper shows the Shelf rather than the last draft's paper.
   */
  draftPath: string | null
  /** Bumped by the `Search the Shelf` command; each bump raises the Shelf and takes the keyboard. */
  shelfRequest: number
  /** The Shelf command's EFFECTIVE chord, or '' when the writer unassigned it (the T6 honesty rule). */
  shelfShortcut: string
  side: ReadingRoomSide
}

/** What the reader handed out on a copy or a drag: the words, and where they came from. */
export type ReaderSelection = {
  annotation: ReaderSelectionAnnotation | null
  attachmentKey: string
  text: string
  pageLabel: string | null
  pageIndex: number | null
  authorYear: string
  libraryId: number
  pageLink: string
  shortTitle: string
  /** Paint the retained outbox annotation in the reader that supplied this selection (ADR-0029). */
  paint: (annotation: ReaderAnnotation) => void
}

/** Which view the Room is in. The Shelf is the entry state (ADR-0027). */
type RoomView = ReadingRoomRailView

type FrameSlot = { html: string; token: number } | null
type PendingLoad = {
  citationBaseLink: string
  document: ReadingRoomDocument
  index: number
  token: number
  viewState: Record<string, unknown> | null
}

function readingRoomError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ReadingRoom({
  citeRequest,
  draftPath,
  highlightsRequest,
  onCite,
  onClose,
  onOutboxChanged,
  onReaderSelection,
  onError,
  onHostChord,
  onSyncHighlights,
  onSyncHighlightsAutomatically,
  onWriteResult,
  outboxRefusal,
  outboxRefusalCode,
  outboxWaiting,
  shelfRequest,
  shelfShortcut,
  side,
}: ReadingRoomProps): JSX.Element {
  const frameRefs = useRef<Array<HTMLIFrameElement | null>>([null, null])
  const embeds = useRef<Array<ReaderEmbed | null>>([null, null])
  const persistence = useRef<Array<ViewStatePersistence | null>>([null, null])
  const pending = useRef<PendingLoad | null>(null)
  const activeIndexRef = useRef(-1)
  const mounted = useRef(true)
  const [frames, setFrames] = useState<[FrameSlot, FrameSlot]>([null, null])
  const [activeIndex, setActiveIndex] = useState(-1)
  const [document, setDocument] = useState<ReadingRoomDocument | null>(null)
  const [evidenceBase, setEvidenceBase] = useState('')
  const [roomWidth, setRoomWidth] = useState(448)
  const roomWidthRef = useRef(448)
  const dockRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)
  const activeResizeRef = useRef<ReadingRoomResizeSession | null>(null)
  const updateRoomWidth = useCallback((width: number): void => {
    roomWidthRef.current = width
    setRoomWidth(width)
  }, [])
  /** The width the Room and the draft share, read off the live layout. Null when the draft is not on
   *  screen to be measured, which sends the clamp to the window instead. */
  const measureSpan = useCallback((): number | null => {
    const dock = dockRef.current
    const room = dock?.querySelector('.reading-room')
    const editor = dock?.parentElement?.querySelector('.editor-wrap')
    if (!room || !editor) return null
    const span = room.getBoundingClientRect().width + editor.getBoundingClientRect().width
    return span > 0 ? span : null
  }, [])
  /** The widest the Room may be right now — measured from the live window, announced on the splitter. */
  const [ceiling, setCeiling] = useState(() => ceilingForReadingRoom(null))
  const [liveness, setLiveness] = useState<ReaderLiveness | null>(null)
  // The Shelf is the entry state, so the Room opens on it and only leaves once a document is live.
  const [roomView, setRoomView] = useState<RoomView>('shelf')
  const [markState, setMarkState] = useState<ReadingRoomMarkState>(initialReadingRoomMarkState)
  const markStateRef = useRef(markState)
  const [colourPopoverOpen, setColourPopoverOpen] = useState(false)
  const [bookmarkIndexOpen, setBookmarkIndexOpen] = useState(false)
  const [bookmarks, setBookmarks] = useState<ReadingBookmarkRow[]>([])
  const [shelfFocus, setShelfFocus] = useState(0)
  const [citing, setCiting] = useState(false)
  const [highlightsFocus, setHighlightsFocus] = useState(0)
  /** A jump asked for while the reader was not yet live; replayed once it is. */
  const pendingJump = useRef<Pick<HighlightRow, 'position'> | null>(null)
  /** The live document, readable from a settled promise. A draft switch has to know what is on screen
   *  to avoid reloading a paper two drafts share, and state read in a `.then` would be the old one. */
  const documentRef = useRef<ReadingRoomDocument | null>(null)
  /** Which draft-state request is current, so a slower earlier reply cannot win. */
  const draftRequest = useRef(0)
  useEffect(() => {
    markStateRef.current = markState
  }, [markState])
  useEffect(() => {
    documentRef.current = document
  }, [document])

  /**
   * Hand Zotero whatever is still owed to it (ADR-0036, decision 2). Before this, a write refused
   * because Zotero was open waited for the NEXT highlight to trigger a drain — so a mark could sit
   * indefinitely and then arrive at an arbitrary moment. Called on opening the Room and on opening a
   * document: both are cheap, and both are moments the reader is already waiting.
   */
  // Opening the Room is the first of the two moments.
  useEffect(onSyncHighlightsAutomatically, [onSyncHighlightsAutomatically])

  /**
   * Put the Room back on the Shelf with no document. Reached when the draft in hand remembers no
   * paper, so the previous draft's reader is torn down rather than left showing someone else's
   * reading, and when a remembered file has gone from disk.
   */
  const closeDocument = useCallback((width: number): void => {
    updateRoomWidth(clampReadingRoomWidth(width, measureSpan()))
    pending.current = null
    for (const writer of persistence.current) writer?.cancel()
    persistence.current = [null, null]
    embeds.current = [null, null]
    activeIndexRef.current = -1
    documentRef.current = null
    pendingJump.current = null
    setActiveIndex(-1)
    setDocument(null)
    setLiveness(null)
    setBookmarks([])
    setBookmarkIndexOpen(false)
    setColourPopoverOpen(false)
    setFrames([null, null])
    setRoomView('shelf')
  }, [measureSpan, updateRoomWidth])

  const readLiveness = useCallback(async (
    embed: ReaderEmbed,
    index: number,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!mounted.current || activeIndexRef.current !== index) return
      try {
        const next = embed.getLiveness()
        setLiveness(next)
        if (next.canvas) return
      } catch {
        // The active view promise has settled; its page canvas may still be taking its first paint.
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }, [])

  const beginDocument = useCallback((state: ReadingRoomState): void => {
    updateRoomWidth(clampReadingRoomWidth(state.roomWidth, measureSpan()))
    if (!state.document) {
      if (activeIndexRef.current < 0) setDocument(null)
      return
    }
    // A document — restored on launch or just chosen on the Shelf — puts the Room in document view.
    setRoomView('document')
    if (activeIndexRef.current < 0) setDocument(state.document)
    const index = activeIndexRef.current === 0 ? 1 : 0
    const token = Date.now() + Math.random()
    pending.current = {
      citationBaseLink: state.citationBaseLink,
      document: state.document,
      index,
      token,
      viewState: state.viewState,
    }
    setFrames((current) => {
      const next: [FrameSlot, FrameSlot] = [...current]
      next[index] = { html: state.readerHtml, token }
      return next
    })
  }, [measureSpan, updateRoomWidth])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      activeResizeRef.current?.dispose()
      for (const writer of persistence.current) writer?.cancel()
    }
  }, [])

  /**
   * The paper for the draft in hand. This runs on mount AND on every draft switch, because they are
   * the same question asked twice: "what was I reading beside this piece of writing?" A draft with no
   * remembered paper tears the reader down and shows the Shelf — degrading to nothing is honest,
   * degrading to another draft's reading is the bug ReadFlex ADR-0032 fixes.
   */
  useEffect(() => {
    // Switching drafts faster than the replies arrive must not land an earlier draft's paper.
    const token = (draftRequest.current += 1)
    void window.writeflex.readingRoom
      .getState(draftPath)
      .then((state) => {
        if (!mounted.current || draftRequest.current !== token) return
        if (!state.document) {
          closeDocument(state.roomWidth)
          return
        }
        const showing = documentRef.current
        if (
          showing
          && showing.libraryId === state.document.libraryId
          && showing.attachmentKey === state.document.attachmentKey
        ) {
          // Two drafts can share a paper; reloading the same one would throw away the live view.
          updateRoomWidth(clampReadingRoomWidth(state.roomWidth, measureSpan()))
          return
        }
        beginDocument(state)
      })
      .catch((error: unknown) => {
        if (draftRequest.current !== token) return
        onError(readingRoomError(error))
      })
  }, [beginDocument, closeDocument, draftPath, measureSpan, onError, updateRoomWidth])

  useEffect(() => {
    if (shelfRequest === 0) return
    setCiting(false)
    setRoomView('shelf')
    setShelfFocus((token) => token + 1)
  }, [shelfRequest])

  useEffect(() => {
    if (citeRequest === 0) return
    setCiting(true)
    setRoomView('shelf')
    setShelfFocus((token) => token + 1)
  }, [citeRequest])

  useEffect(() => {
    if (highlightsRequest === 0) return
    setRoomView('highlights')
    setHighlightsFocus((token) => token + 1)
    onOutboxChanged()
  }, [highlightsRequest, onOutboxChanged])

  /** Go to a mark. Navigating by RAW POSITION deliberately, not by annotation key: the reader is opened
   *  without annotations loaded (writing them back is T5's outbox, not this parcel), so an annotation-key
   *  target would have nothing to resolve against, while a position needs nothing preloaded. */
  const jumpToHighlight = useCallback((row: Pick<HighlightRow, 'position'>): void => {
    setRoomView('document')
    const embed = embeds.current[activeIndexRef.current]
    if (!embed) {
      // The reader is still initialising, or its document was never opened in this session.
      pendingJump.current = row
      return
    }
    pendingJump.current = null
    void embed.navigateTo({ position: row.position }).catch((error: unknown) => {
      onError(readingRoomError(error))
    })
  }, [onError])

  const activateMarkState = useCallback((next: ReadingRoomMarkState): void => {
    const embed = embeds.current[activeIndexRef.current]
    if (!embed) return
    try {
      embed.setTool(readingRoomTool(next))
      markStateRef.current = next
      setMarkState(next)
      if (next.mode !== 'highlight') setColourPopoverOpen(false)
    } catch (error) {
      onError(readingRoomError(error))
    }
  }, [onError])

  const chooseHighlightColour = useCallback((colour: ReadingHighlightColour): void => {
    activateMarkState(selectHighlightColour(markStateRef.current, colour))
    setColourPopoverOpen(false)
  }, [activateMarkState])

  const dropBookmark = useCallback((): void => {
    const embed = embeds.current[activeIndexRef.current]
    const viewState = embed?.saveViewState()
    if (!embed || !viewState) {
      onError('The current reading position is not ready to bookmark yet.')
      return
    }
    const label = liveness?.page ? `p. ${liveness.page}` : 'Current reading position'
    void window.writeflex.readingRoom
      .addBookmark({ label, position: viewState })
      .then((bookmark) => {
        setBookmarks((current) => current.some((row) => row.id === bookmark.id)
          ? current
          : [...current, bookmark])
        setBookmarkIndexOpen(true)
      })
      .catch((error: unknown) => onError(readingRoomError(error)))
  }, [liveness?.page, onError])

  const goToBookmark = useCallback((bookmark: ReadingBookmarkRow): void => {
    const embed = embeds.current[activeIndexRef.current]
    if (!embed) return
    setRoomView('document')
    void restoreReadingBookmark(embed, bookmark.position)
      .catch((error: unknown) => onError(readingRoomError(error)))
  }, [onError])

  const openFromShelf = useCallback((row: ShelfRow, attachmentKey: string): void => {
    void window.writeflex.readingRoom
      .openShelfItem({ attachmentKey, draftPath, itemKey: row.itemKey, libraryId: row.libraryId })
      .then(beginDocument)
      .catch((error: unknown) => onError(readingRoomError(error)))
  }, [beginDocument, draftPath, onError])

  /** Open something from Recents. It travels as KEYS through the same handler the Shelf uses, which
   *  is why a paper reindexed or renamed in Zotero since still resolves. */
  const openRecent = useCallback((recent: RecentDocumentRow): void => {
    void window.writeflex.readingRoom
      .openShelfItem({
        attachmentKey: recent.attachmentKey,
        draftPath,
        itemKey: recent.itemKey,
        libraryId: recent.libraryId,
      })
      .then(beginDocument)
      .catch((error: unknown) => onError(readingRoomError(error)))
  }, [beginDocument, draftPath, onError])

  /** Go to a highlight Zotero would not take. It may belong to a paper other than the one on screen,
   *  in which case that paper is opened through the Shelf's own handler and the jump is replayed once
   *  its reader is live. */
  const openRefused = useCallback((item: RefusedHighlight): void => {
    if (!item.open) return
    const target = item.position ? { position: item.position } : null
    const shown = documentRef.current
    if (
      shown
      && shown.libraryId === item.open.libraryId
      && shown.attachmentKey === item.open.attachmentKey
    ) {
      if (target) jumpToHighlight(target)
      else setRoomView('document')
      return
    }
    void window.writeflex.readingRoom
      .openShelfItem({ ...item.open, draftPath })
      .then((state) => {
        pendingJump.current = state.document ? target : null
        beginDocument(state)
      })
      .catch((error: unknown) => onError(readingRoomError(error)))
  }, [beginDocument, draftPath, jumpToHighlight, onError])

  useEffect(() => {
    for (const frame of frameRefs.current) {
      if (frame?.contentDocument) {
        frame.contentDocument.documentElement.dataset.roomSide = side
      }
    }
  }, [side])

  const frameLoaded = useCallback(async (index: number, token: number): Promise<void> => {
    const load = pending.current
    const frame = frameRefs.current[index]
    if (!load || load.index !== index || load.token !== token || !frame?.contentWindow) return
    frame.contentDocument?.documentElement.setAttribute('data-room-side', side)
    const hostWindow = frame.contentWindow as unknown as ReaderHostWindow
    // The host document load can complete before its defer script publishes createReader.
    // Keep the replacement off-screen while that real readiness seam catches up.
    for (let attempt = 0; attempt < 100 && !hostWindow.createReader; attempt += 1) {
      if (!mounted.current || pending.current?.token !== token) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const writer = createViewStatePersistence(async (viewState) => {
      await window.writeflex.readingRoom.saveViewState({
        attachmentKey: load.document.attachmentKey,
        libraryId: load.document.libraryId,
        viewState,
      })
    })
    // What THIS reader shows for each mark: the before-state its edits and deletions carry (ADR-0031).
    // A list refresh never changes it; only what this reader was given and what it did itself.
    const held = createHeldMarks()
    const embed = new ReaderEmbed({
      readFile: (path) => window.writeflex.readingRoom.readDocument(path),
      hostCallbacks: {
        onError: (error) => onError(error.message),
        // Copy or drag out of the reader passes through here (the same callback serves both), which is
        // how a pasted quote can arrive in the draft already carrying its reference.
        // Copy AND drag out of the reader both arrive here, which is why one mechanism serves both:
        // whichever way the words leave the page, the draft can receive them with their reference.
        onSetDataTransferAnnotations: (dataTransfer, items, _fromText) => {
          const rawArea = items.length === 1 ? items[0] as { id?: unknown; type?: unknown } : null
          if (rawArea?.type === 'image') {
            const transfer = dataTransfer as { setData?: (type: string, value: string) => void }
            const annotation = typeof rawArea.id === 'string' ? embed.annotationForKey(rawArea.id) : null
            const payload = annotation
              ? readingRoomAreaTransferForAnnotation(annotation, load.document, load.citationBaseLink)
              : null
            if (!payload || typeof transfer.setData !== 'function') {
              onReaderSelection(null)
              onError('The Area capture could not be prepared for dragging.')
              return
            }
            // The nested reader already owns text/plain for drops outside WriteFlex. Add only the
            // private typed payload; replacing its text would break ordinary inter-application drag.
            transfer.setData(READING_ROOM_AREA_MIME, JSON.stringify(payload))
            onReaderSelection(null)
            return
          }
          const transfer = dataTransfer as { setData?: (type: string, value: string) => void }
          const itemTarget = load.citationBaseLink.replace('zotero://open-pdf/', 'zotero://select/').replace(/\/items\/[^/?]+(?:\?.*)?$/, `/items/${load.document.itemKey}`)
          const candidate = typeof rawArea?.id === 'string' && /^[A-Z\d]{8}$/.test(rawArea.id) ? rawArea.id : null
          const source: EvidenceTransfer = { kind: 'zotero', itemTarget, label: load.document.authorYear, pending: true,
            ...(candidate ? { annotation: { target: `${load.citationBaseLink}?annotation=${candidate}`, label: load.document.authorYear } } : {}) }
          transfer.setData?.(EVIDENCE_DRAG_MIME, JSON.stringify(source))
          let selection: ReaderSelectionAnnotation | null = null
          try {
            selection = embed.getSelectionAnnotation()
          } catch (error) {
            onError(readingRoomError(error))
          }
          const first = items[0] as {
            pageLabel?: unknown
            position?: unknown
            text?: unknown
          } | undefined
          const text = typeof first?.text === 'string' ? first.text : ''
          if (!text.trim()) {
            onReaderSelection(null)
            return
          }
          const selectionAgrees = !!selection
            && typeof selection.text === 'string'
            && normaliseReaderText(selection.text) === normaliseReaderText(text)
          const matchedSelection = selectionAgrees ? selection : null
          const position = matchedSelection
            ? matchedSelection.position
            : JSON.stringify(first?.position ?? {})
          let pageIndex: number | null = null
          try {
            const parsed = JSON.parse(position) as { pageIndex?: unknown }
            if (typeof parsed.pageIndex === 'number') pageIndex = parsed.pageIndex
          } catch {
            pageIndex = null
          }
          const oneBasedPage = pageIndex === null ? null : Math.max(1, Math.round(pageIndex) + 1)
          const pageLink = oneBasedPage === null
            ? load.citationBaseLink
            : `${load.citationBaseLink}?page=${oneBasedPage}`
          onReaderSelection({
            annotation: matchedSelection,
            attachmentKey: load.document.attachmentKey,
            authorYear: load.document.authorYear,
            libraryId: load.document.libraryId,
            pageLink,
            pageIndex,
            pageLabel: matchedSelection
              ? matchedSelection.pageLabel
              : typeof first?.pageLabel === 'string' ? first.pageLabel : null,
            paint: (annotation) => {
              held.hold(annotation)
              embed.upsertAnnotations([annotation])
            },
            shortTitle: load.document.shortTitle,
            text,
          })
        },
      },
    })
    if (load.viewState) embed.restoreViewState(load.viewState)
    embed.attachWindow(hostWindow)
    // Application chords pressed while the reader has focus arrive here as a seam event instead of
    // dying inside the reader (ReadFlex ADR-0028); the seam re-attaches per window, so this
    // subscription is per embed like the view-state one below.
    embed.on('host-chord', (chord) => onHostChord(chord))
    embed.on('mark-mode-cancelled', () => {
      const next = leaveReadingRoomMarkMode(markStateRef.current)
      embed.setTool(readingRoomTool(next))
      markStateRef.current = next
      setMarkState(next)
      setColourPopoverOpen(false)
    })
    // A highlight made in the reader is queued for Zotero, and the reader is told "saved" only once
    // that queue write has returned — the embed awaits these listeners, so returning the promise IS the
    // durability contract (ADR-0014, consequence 1). Nothing waits on the network.
    //
    // The RESULT is read, not discarded (ADR-0036): it carries `notWritten` — the sentence for a person
    // when Zotero would not take the write — and throwing it away is what made a refused write silent.
    embed.on('annotation-created', (annotation) => {
      if (annotation.type === 'image') {
        const next = completeAreaCapture(markStateRef.current)
        markStateRef.current = next
        setMarkState(next)
        setColourPopoverOpen(false)
      }
      held.created(annotation)
      return window.writeflex.readingRoom
        .saveAnnotations({ annotations: [annotation], operation: 'create', readerSession: held.session })
        .then((result) => { onWriteResult(result) })
        .catch((error: unknown) => onError(readingRoomError(error)))
    })
    embed.on('annotation-updated', (annotation) =>
      window.writeflex.readingRoom
        .saveAnnotations({ annotations: [annotation], before: [held.edit(annotation)], operation: 'update', readerSession: held.session })
        .then((result) => { onWriteResult(result) })
        .catch((error: unknown) => onError(readingRoomError(error))))
    // A deletion takes the same path as an edit: queued (or cancelling a mark Zotero never got), drawn
    // as gone, and written into Zotero when it is closed.
    embed.on('annotation-deleted', (annotation) =>
      window.writeflex.readingRoom
        .saveAnnotations({ annotations: [annotation], before: [held.remove(annotation)], operation: 'delete', readerSession: held.session })
        .then((result) => { onWriteResult(result) })
        .catch((error: unknown) => onError(readingRoomError(error))))
    embed.on('view-state-changed', (viewState) => {
      writer.schedule(viewState)
      window.setTimeout(() => {
        if (activeIndexRef.current === index) {
          try {
            setLiveness(embed.getLiveness())
          } catch {
            // The next settled view-state event will refresh the locator.
          }
        }
      }, 0)
    })
    embeds.current[index] = embed
    persistence.current[index] = writer

    // Your highlights must be ON THE PAGE, not only in the list — the locked mockup paints them, and a
    // reader that shows a clean page cannot tell you what you already marked. Read-only: the reader emits
    // create/update events but persists nothing, so nothing here writes to Zotero.
    const painted = await window.writeflex.readingRoom
      .readHighlights()
      .then((result) => (result.error ? [] : result.forReader))
      .catch(() => [])
    held.load(painted)
    onOutboxChanged()
    if (!mounted.current || pending.current?.token !== token) return

    void embed
      .openDocument({
        annotations: painted,
        kind: load.document.kind,
        path: load.document.path,
      })
      .then(() => {
        if (!mounted.current || pending.current?.token !== token) return
        embed.setTool(readingRoomTool(markStateRef.current))
        const previous = activeIndexRef.current
        pending.current = null
        activeIndexRef.current = index
        setActiveIndex(index)
        setDocument(load.document)
        setEvidenceBase(load.citationBaseLink)
        void window.writeflex.readingRoom
          .listBookmarks()
          .then((rows) => {
            if (mounted.current && activeIndexRef.current === index) setBookmarks(rows)
          })
          .catch((error: unknown) => onError(readingRoomError(error)))
        // The second of the two moments Zotero is asked to take what is waiting (ADR-0036).
        onSyncHighlightsAutomatically()
        void readLiveness(embed, index)
        const queued = pendingJump.current
        if (queued) {
          pendingJump.current = null
          void embed.navigateTo({ position: queued.position }).catch((error: unknown) => {
            onError(readingRoomError(error))
          })
        }
        if (previous >= 0 && previous !== index) {
          window.requestAnimationFrame(() => {
            persistence.current[previous]?.cancel()
            persistence.current[previous] = null
            embeds.current[previous] = null
            setFrames((current) => {
              const next: [FrameSlot, FrameSlot] = [...current]
              next[previous] = null
              return next
            })
          })
        }
      })
      .catch((error: unknown) => {
        if (!mounted.current || pending.current?.token !== token) return
        pending.current = null
        persistence.current[index]?.cancel()
        persistence.current[index] = null
        embeds.current[index] = null
        setFrames((current) => {
          const next: [FrameSlot, FrameSlot] = [...current]
          next[index] = null
          return next
        })
        const message = readingRoomError(error)
        onError(message)
      })
  }, [
    onError,
    onHostChord,
    onOutboxChanged,
    onReaderSelection,
    onSyncHighlightsAutomatically,
    onWriteResult,
    readLiveness,
    side,
  ])

  const movePage = useCallback((direction: -1 | 1): void => {
    const embed = embeds.current[activeIndexRef.current]
    const page = liveness?.page
    const pageCount = liveness?.pageCount
    if (!embed || !page) return
    const target = Math.max(1, Math.min(pageCount ?? Number.POSITIVE_INFINITY, page + direction))
    if (target === page) return
    void embed.navigateTo({ page: target }).then(() => {
      window.setTimeout(() => {
        try {
          setLiveness(embed.getLiveness())
        } catch {
          // A later view-state callback will refresh the locator.
        }
      }, 50)
    }).catch((error: unknown) => onError(readingRoomError(error)))
  }, [liveness, onError])

  useEffect(() => {
    const refresh = (): void => {
      if (draggingRef.current) return
      const span = measureSpan()
      setCeiling(ceilingForReadingRoom(span))
      // A window that has become too small to honour the stored width gives the draft its minimum
      // back rather than letting the Room hide it (ADR-0033).
      updateRoomWidth(clampReadingRoomWidth(roomWidthRef.current, span))
    }
    refresh()
    window.addEventListener('resize', refresh)
    return () => window.removeEventListener('resize', refresh)
  }, [measureSpan, updateRoomWidth])

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    activeResizeRef.current?.dispose()
    const span = measureSpan()
    const startWidth = clampReadingRoomWidth(roomWidthRef.current, span)
    setCeiling(ceilingForReadingRoom(span))
    updateRoomWidth(startWidth)
    activeResizeRef.current = beginReadingRoomResize(
      event.nativeEvent,
      event.currentTarget,
      {
        side,
        span,
        startWidth,
        onWidth: updateRoomWidth,
        onFinish: (dragWidth) => {
          const finalSpan = measureSpan()
          const width = clampReadingRoomWidth(dragWidth, finalSpan)
          setCeiling(ceilingForReadingRoom(finalSpan))
          updateRoomWidth(width)
          void window.writeflex.readingRoom.saveWidth(width).catch((error: unknown) => {
            onError(readingRoomError(error))
          })
        },
        onResizingChange: (resizing) => {
          draggingRef.current = resizing
          const dock = dockRef.current
          if (dock) {
            if (resizing) dock.dataset.resizing = 'true'
            else delete dock.dataset.resizing
          }
          if (!resizing) activeResizeRef.current = null
        },
      },
    )
  }, [measureSpan, onError, side, updateRoomWidth])

  const resizeWithKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const span = measureSpan()
    const width = readingRoomWidthForKey(
      roomWidthRef.current,
      event.key,
      event.shiftKey,
      side,
      span,
    )
    setCeiling(ceilingForReadingRoom(span))
    updateRoomWidth(width)
    void window.writeflex.readingRoom.saveWidth(width).catch((error: unknown) => {
      onError(readingRoomError(error))
    })
  }, [measureSpan, onError, side, updateRoomWidth])

  const rail = (
    <ReadingRoomRail
      bookmarkIndexOpen={bookmarkIndexOpen}
      bookmarks={bookmarks}
      colourPopoverOpen={colourPopoverOpen}
      documentOpen={!!document}
      markState={markState}
      onClose={onClose}
      onDropBookmark={dropBookmark}
      onGoToBookmark={goToBookmark}
      onSelectArea={() => activateMarkState(selectAreaMode(markStateRef.current))}
      onSelectColour={chooseHighlightColour}
      onSelectHighlight={() => activateMarkState(selectHighlightMode(markStateRef.current))}
      onSelectView={(view) => {
        setRoomView(view)
        if (view === 'highlights') setHighlightsFocus((token) => token + 1)
        if (view === 'shelf') setShelfFocus((token) => token + 1)
      }}
      onToggleBookmarkIndex={() => setBookmarkIndexOpen((open) => !open)}
      onToggleColourPopover={() => {
        if (markStateRef.current.mode !== 'highlight') {
          activateMarkState(selectHighlightMode(markStateRef.current))
        }
        setColourPopoverOpen((open) => !open)
      }}
      pageCount={liveness?.pageCount ?? null}
      shelfShortcut={shelfShortcut}
      view={roomView}
    />
  )

  const activeMarkStatus = document ? markStatus(markState) : null

  return (
    <div className={`reading-room-dock side-${side}`} ref={dockRef}>
      <section
        className={`reading-room side-${side}`}
        aria-label="Reading Room"
        style={{ width: roomWidth }}
        data-reader-live={liveness?.canvas ? 'true' : 'false'}
        data-reader-canvas-width={liveness?.canvas?.width}
        data-reader-canvas-height={liveness?.canvas?.height}
        data-mark-mode={markState.mode ?? 'off'}
        data-highlight-colour={markState.colour}
        onKeyDownCapture={(event) => {
          if (event.key !== 'Escape' || markStateRef.current.mode === null) return
          activateMarkState(leaveReadingRoomMarkMode(markStateRef.current))
          setColourPopoverOpen(false)
        }}
      >
        {side === 'left' && rail}
        <div className="reading-room-paper">
          <header className="reading-room-locator">
            <span className="reading-room-author">{document?.authorYear ?? ''}</span>
            <span className="reading-room-title">{document?.shortTitle ?? 'Reading Room'}</span>
            <span className="reading-room-page">
              {liveness?.page
                ? `p. ${liveness.page}${liveness.pageCount ? ` of ${liveness.pageCount}` : ''}`
                : ''}
            </span>
            <button
              type="button"
              aria-label="Previous page"
              title="Previous page"
              disabled={!liveness?.page || liveness.page <= 1}
              onClick={() => movePage(-1)}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Next page"
              title="Next page"
              disabled={!liveness?.page || (!!liveness.pageCount && liveness.page >= liveness.pageCount)}
              onClick={() => movePage(1)}
            >
              <ChevronRight aria-hidden="true" />
            </button>
            <button
              type="button"
              className="reading-room-close"
              aria-label="Close Reading Room"
              title="Close Reading Room (⌃⌘R)"
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </button>
          </header>
          {activeMarkStatus && (
            <div className="reading-room-mark-status" role="status">
              {activeMarkStatus}
              <kbd>Esc</kbd>
            </div>
          )}
          {/* A refused write, said out loud at the moment it is refused (ADR-0036). Deliberately NOT a
              modal and with nothing to dismiss — highlighting is a flow, and stopping it to explain a
              delay would be worse than the silence this replaces. It leads with where the mark IS,
              because the one thing it must never imply is that the highlight was lost: it is queued and
              painted, which ADR-0029 guarantees. It goes away when Zotero has taken the marks. The lead
              is reason-agnostic — a refusal can also be schema drift or a missing library — and the
              sentence that follows is the main process's own, never one the renderer invents. */}
          <ReadingRoomNotice
            waiting={outboxWaiting}
            refusal={outboxRefusal}
            refusalCode={outboxRefusalCode}
            onSync={onSyncHighlights}
            onShowPlugin={() => { void window.writeflex.readingRoom.showZoteroPlugin() }}
          />
          {roomView === 'shelf' && (
            <ReadingRoomShelf
              focusToken={shelfFocus}
              onCite={citing ? (row) => { setCiting(false); onCite(row) } : null}
              onDismiss={document ? () => setRoomView('document') : null}
              onError={onError}
              onOpen={openFromShelf}
              onOpenRecent={openRecent}
            />
          )}
          {roomView === 'highlights' && (
            <ReadingRoomHighlights
              authorYear={document?.authorYear ?? ''}
              evidenceSource={document && evidenceBase ? { label: document.authorYear, itemTarget: evidenceBase.replace('zotero://open-pdf/', 'zotero://select/').replace(/\/items\/[^/?]+(?:\?.*)?$/, `/items/${document.itemKey}`), baseLink: evidenceBase } : undefined}
              banner={(
                <ReadingRoomRefused
                  focusToken={highlightsFocus}
                  onError={onError}
                  onOpen={openRefused}
                  onOutboxChanged={onOutboxChanged}
                  onWriteResult={onWriteResult}
                />
              )}
              focusToken={highlightsFocus}
              onDismiss={document ? () => setRoomView('document') : null}
              onError={onError}
              onJump={jumpToHighlight}
            />
          )}
          {/* Kept mounted across views: the reader iframes hold the live document, and unmounting
              them to show the Shelf would tear down the view and lose the reading position. */}
          <div className={`reading-room-document${roomView === 'document' ? '' : ' hidden'}`}>
            {frames.map((frame, index) => frame && (
              <iframe
                key={frame.token}
                ref={(element) => { frameRefs.current[index] = element }}
                className={index === activeIndex ? 'active' : 'replacement'}
                srcDoc={frame.html}
                sandbox="allow-scripts allow-same-origin"
                title={index === activeIndex ? 'Reading Room document' : 'Reading Room replacement document'}
                onLoad={() => { void frameLoaded(index, frame.token) }}
              />
            ))}
            {!document && roomView === 'document' && <div className="reading-room-empty">No document open</div>}
          </div>
        </div>
        {side === 'right' && rail}
      </section>
      <div
        className="reading-room-resize"
        role="separator"
        aria-label="Resize Reading Room"
        aria-orientation="vertical"
        aria-valuemin={MIN_ROOM_WIDTH}
        aria-valuemax={ceiling}
        aria-valuenow={roomWidth}
        tabIndex={0}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={startResize}
      />
    </div>
  )
}
