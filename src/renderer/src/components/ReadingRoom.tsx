import { flushSync } from 'react-dom'
import { bindReaderEvents } from '../reading-room-events'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react'
import {
  createViewStatePersistence,
  type ReaderAnnotation,
  type ReaderHostChord,
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
import { ReadingRoomClient } from '../reading-room-client'
import { ReaderDisposals } from '../reading-room-disposals'
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

import type { ReadingRoomProps, ReaderSelection, RoomView, FrameSlot, PendingLoad } from './ReadingRoom.types'
export type { ReadingRoomProps, ReaderSelection } from './ReadingRoom.types'

function readingRoomError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ReadingRoom({
  citeRequest,
  draftPath,
  highlightsRequest,
  onCite,
  onClose,
  registerLifetime,
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
  const embeds = useRef<Array<ReadingRoomClient | null>>([null, null])
  const disposals = useRef(new ReaderDisposals())
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
    const closing = [...embeds.current]
    for (const [index, embed] of closing.entries()) if (embed) void disposals.current.dispose(embed).then(() => {
      if (embeds.current[index] === embed) { embeds.current[index] = null; persistence.current[index] = null }
      setFrames(current => current.map((slot, i) => i === index && slot?.src === embed.src ? null : slot) as [FrameSlot, FrameSlot])
    }).catch(error => onError(readingRoomError(error)))
    activeIndexRef.current = -1
    documentRef.current = null
    pendingJump.current = null
    setActiveIndex(-1)
    setDocument(null)
    setLiveness(null)
    setBookmarks([])
    setBookmarkIndexOpen(false)
    setColourPopoverOpen(false)
    setRoomView('shelf')
  }, [measureSpan, updateRoomWidth])

  const readLiveness = useCallback(async (
    embed: ReadingRoomClient,
    index: number,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!mounted.current || activeIndexRef.current !== index) return
      try {
        const next = await embed.getLiveness()
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
    void (async () => {
      const closing = embeds.current[index]
      if (closing) await disposals.current.dispose(closing)
      if (!mounted.current || pending.current?.token !== token) return
      const lease = await window.writeflex.readingRoom.createReaderLease({ selection: state.selection, slot: index as 0 | 1 })
      if (!mounted.current || pending.current?.token !== token) { await window.writeflex.readingRoom.releaseReaderLease(lease.id); return }
      const client = new ReadingRoomClient(lease, () => frameRefs.current[index], () => {
        flushSync(() => setFrames(current => current.map((slot, i) => i === index && slot?.src === client.src ? null : slot) as [FrameSlot, FrameSlot]))
      })
      embeds.current[index] = client
      setFrames((current) => {
        const next: [FrameSlot, FrameSlot] = [...current]
        next[index] = { src: client.src, token }
        return next
      })
    })().catch(error => onError(readingRoomError(error)))
  }, [measureSpan, onError, updateRoomWidth])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      activeResizeRef.current?.dispose()
      void disposals.current.close(embeds.current).catch(error => onError(readingRoomError(error)))
    }
  }, [onError])

  useEffect(() => {
    registerLifetime(async () => {
      pending.current = null
      await disposals.current.close(embeds.current)
    })
    return () => registerLifetime(null)
  }, [registerLifetime])

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
      void embed.setTool(readingRoomTool(next)).catch(error => onError(readingRoomError(error)))
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
    void (async () => {
    const embed = embeds.current[activeIndexRef.current]
    const viewState = await embed?.saveViewState()
    if (!embed || !viewState) {
      onError('The current reading position is not ready to bookmark yet.')
      return
    }
    const label = liveness?.page ? `p. ${liveness.page}` : 'Current reading position'
    void window.writeflex.readingRoom
      .addBookmark({ lease: embed.lease.id, label, position: viewState })
      .then((bookmark) => {
        setBookmarks((current) => current.some((row) => row.id === bookmark.id)
          ? current
          : [...current, bookmark])
        setBookmarkIndexOpen(true)
      })
      .catch((error: unknown) => onError(readingRoomError(error)))
    })().catch(error => onError(readingRoomError(error)))
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
    for (const client of embeds.current) void client?.request('side', side).catch(error => onError(readingRoomError(error)))
  }, [side, onError])

  const frameLoaded = useCallback(async (index: number, token: number): Promise<void> => {
    const load = pending.current
    const embed = embeds.current[index]
    if (!load || load.index !== index || load.token !== token || !embed) return
    await embed.ready
    if (!mounted.current || pending.current?.token !== token) { await disposals.current.dispose(embed); return }
    const writer = createViewStatePersistence(async (viewState) => {
      const saved = await window.writeflex.readingRoom.saveViewState({
        lease: embed.lease.id,
        attachmentKey: load.document.attachmentKey,
        libraryId: load.document.libraryId,
        viewState,
      })
      if (!saved) throw new Error('The reader view state was not saved.')
    })
    const held = bindReaderEvents({ embed, writer, document: load.document, index, markStateRef, activeIndexRef, setMarkState, setColourPopoverOpen, setLiveness, onError, onReaderSelection, onHostChord, onWriteResult })
    embeds.current[index] = embed
    persistence.current[index] = writer

    // Your highlights must be ON THE PAGE, not only in the list — the locked mockup paints them, and a
    // reader that shows a clean page cannot tell you what you already marked. Read-only: the reader emits
    // create/update events but persists nothing, so nothing here writes to Zotero.
    const painted = await window.writeflex.readingRoom
      .readHighlights(embed.lease.id)
      .then((result) => (result.error ? [] : result.forReader))
      .catch(() => [])
    held.load(painted)
    onOutboxChanged()
    if (!mounted.current || pending.current?.token !== token) { await disposals.current.dispose(embed); return }

    const bytes = await window.writeflex.readingRoom.readDocument({ lease: embed.lease.id })
    if (!mounted.current || pending.current?.token !== token) { await disposals.current.dispose(embed); return }
    void embed
      .openDocument({
        bytes, side, viewState: load.viewState, citationBaseLink: load.citationBaseLink,
        document: { attachmentKey: load.document.attachmentKey, authorYear: load.document.authorYear,
          itemKey: load.document.itemKey, libraryId: load.document.libraryId, shortTitle: load.document.shortTitle },
        annotations: painted,
        kind: load.document.kind,
      })
      .then(() => {
        if (!mounted.current || pending.current?.token !== token) { void disposals.current.dispose(embed).catch(error => onError(readingRoomError(error))); return }
        void embed.setTool(readingRoomTool(markStateRef.current)).catch(error => onError(readingRoomError(error)))
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
            const closing = embeds.current[previous]
            if (!closing) return
            void disposals.current.dispose(closing).then(() => {
              if (embeds.current[previous] === closing) { embeds.current[previous] = null; persistence.current[previous] = null }
              setFrames((current) => {
                const next: [FrameSlot, FrameSlot] = [...current]
                if (next[previous]?.src === closing.src) next[previous] = null
                return next
              })
            }).catch(error => onError(readingRoomError(error)))
          })
        }
      })
      .catch((error: unknown) => {
        if (!mounted.current || pending.current?.token !== token) return
        pending.current = null
        void disposals.current.dispose(embed).then(() => {
          if (embeds.current[index] === embed) { embeds.current[index] = null; persistence.current[index] = null }
          setFrames((current) => {
            const next: [FrameSlot, FrameSlot] = [...current]
            if (next[index]?.src === embed.src) next[index] = null
            return next
          })
        }).catch(error => onError(readingRoomError(error)))
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
          void embed.getLiveness().then(setLiveness).catch(error => onError(readingRoomError(error)))
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
                src={frame.src}
                sandbox="allow-scripts allow-same-origin"
                title={index === activeIndex ? 'Reading Room document' : 'Reading Room replacement document'}
                onLoad={() => {
                  const failing = embeds.current[index]
                  void frameLoaded(index, frame.token).catch(async error => {
                    if (!failing) return
                    const current = (): boolean => mounted.current && embeds.current[index] === failing && pending.current?.token === frame.token
                    if (current()) onError(readingRoomError(error))
                    try { await disposals.current.dispose(failing) }
                    catch (failure) { onError(readingRoomError(failure)); return }
                    if (!current()) return
                    pending.current = null
                    persistence.current[index] = null
                    embeds.current[index] = null
                  })
                }}
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
