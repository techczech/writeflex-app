import type { ReaderAnnotation, ReaderHostChord, ReaderSelectionAnnotation } from '@readflex/reader-embed'
import type { ReadingRoomDocument, ReadingRoomWriteResult, ShelfRow } from '../../../preload'
import type { ReadingRoomSide } from '../reading-room-resize'
import type { ReadingRoomRailView } from './ReadingRoomRail'

export type ReadingRoomProps = {
  onClose: () => void
  registerLifetime: (dispose: (() => Promise<void>) | null) => void
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
export type RoomView = ReadingRoomRailView

export type FrameSlot = { src: string; token: number } | null
export type PendingLoad = {
  citationBaseLink: string
  document: ReadingRoomDocument
  index: number
  token: number
  viewState: Record<string, unknown> | null
}

