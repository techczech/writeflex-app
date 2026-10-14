import type { CSSProperties } from 'react'
import {
  BookmarkPlus,
  BookMarked,
  BookOpen,
  ChevronDown,
  Highlighter,
  ScanLine,
  Search,
  X,
} from 'lucide-react'
import type { ReadingBookmarkRow } from '../../../preload'
import {
  READING_HIGHLIGHT_COLOURS,
  type ReadingHighlightColour,
  type ReadingRoomMarkState,
} from '../reading-room-marks'
import { readingBookmarkColour } from '../reading-room-bookmarks'

export type ReadingRoomRailView = 'document' | 'highlights' | 'shelf'

export type ReadingRoomRailProps = {
  bookmarkIndexOpen: boolean
  bookmarks: ReadingBookmarkRow[]
  colourPopoverOpen: boolean
  documentOpen: boolean
  markState: ReadingRoomMarkState
  onClose: () => void
  onDropBookmark: () => void
  onGoToBookmark: (bookmark: ReadingBookmarkRow) => void
  onSelectArea: () => void
  onSelectColour: (colour: ReadingHighlightColour) => void
  onSelectHighlight: () => void
  onSelectView: (view: ReadingRoomRailView) => void
  onToggleBookmarkIndex: () => void
  onToggleColourPopover: () => void
  pageCount: number | null
  shelfShortcut: string
  view: ReadingRoomRailView
}

function bookmarkTop(bookmark: ReadingBookmarkRow, index: number, count: number | null): string {
  const pageIndex = bookmark.position.pageIndex
  if (typeof pageIndex === 'number' && Number.isFinite(pageIndex) && count && count > 1) {
    return `${Math.min(96, Math.max(2, (pageIndex / (count - 1)) * 94 + 2))}%`
  }
  return `${Math.min(94, 8 + index * 12)}%`
}

export function ReadingRoomRail({
  bookmarkIndexOpen,
  bookmarks,
  colourPopoverOpen,
  documentOpen,
  markState,
  onClose,
  onDropBookmark,
  onGoToBookmark,
  onSelectArea,
  onSelectColour,
  onSelectHighlight,
  onSelectView,
  onToggleBookmarkIndex,
  onToggleColourPopover,
  pageCount,
  shelfShortcut,
  view,
}: ReadingRoomRailProps): JSX.Element {
  const colour = READING_HIGHLIGHT_COLOURS[markState.colour]
  const colourStyle = { '--reading-highlight-colour': colour.value } as CSSProperties

  return (
    <nav
      className="reading-room-rail"
      aria-label="Reading Room tools"
      data-highlight-colour={markState.colour}
      style={colourStyle}
    >
      <div className="reading-room-rail-group browse" aria-label="Browse and navigate">
        <span className="reading-room-rail-label">Browse</span>
        <button
          type="button"
          className={view === 'document' ? 'on' : ''}
          aria-current={view === 'document' ? 'page' : undefined}
          aria-label="Document view"
          title={documentOpen ? 'Document view' : 'Document view — open something from the Shelf first'}
          disabled={!documentOpen}
          onClick={() => onSelectView('document')}
        >
          <BookOpen aria-hidden="true" />
        </button>
        <button
          type="button"
          className={view === 'highlights' ? 'on' : ''}
          aria-current={view === 'highlights' ? 'page' : undefined}
          aria-label="Highlights view"
          title={documentOpen ? 'Highlights view' : 'Highlights view — open something from the Shelf first'}
          disabled={!documentOpen}
          onClick={() => onSelectView('highlights')}
        >
          <Highlighter aria-hidden="true" />
        </button>
        <button
          type="button"
          className={view === 'shelf' ? 'on' : ''}
          aria-current={view === 'shelf' ? 'page' : undefined}
          aria-label="Search the Shelf"
          title={shelfShortcut ? `Search the Shelf (${shelfShortcut})` : 'Search the Shelf'}
          onClick={() => onSelectView('shelf')}
        >
          <Search aria-hidden="true" />
        </button>
        <button
          type="button"
          className={bookmarkIndexOpen ? 'on' : ''}
          aria-label="Go to Reading Bookmark"
          aria-expanded={bookmarkIndexOpen}
          title={bookmarks.length ? 'Go to Reading Bookmark' : 'Go to Reading Bookmark — none saved yet'}
          disabled={!bookmarks.length}
          onClick={onToggleBookmarkIndex}
        >
          <BookMarked aria-hidden="true" />
        </button>
      </div>

      <div className="reading-room-rail-group mark" aria-label="Mark the current page">
        <span className="reading-room-rail-label">Mark</span>
        <button
          type="button"
          className={`reading-room-mode-button highlight${markState.mode === 'highlight' ? ' on' : ''}`}
          aria-label={`Highlight text with ${colour.label}`}
          aria-pressed={markState.mode === 'highlight'}
          title={`Highlight text with ${colour.label}`}
          disabled={!documentOpen}
          onClick={onSelectHighlight}
        >
          <Highlighter aria-hidden="true" />
          <i className="reading-room-mode-colour" aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`reading-room-mode-button area${markState.mode === 'area' ? ' on' : ''}`}
          aria-label="Capture chart or table"
          aria-pressed={markState.mode === 'area'}
          title="Capture chart or table"
          disabled={!documentOpen}
          onClick={onSelectArea}
        >
          <ScanLine aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Drop Reading Bookmark"
          title="Drop Reading Bookmark"
          disabled={!documentOpen}
          onClick={onDropBookmark}
        >
          <BookmarkPlus aria-hidden="true" />
        </button>
        <button
          type="button"
          className="reading-room-colour-button"
          aria-label={`Highlight colour: ${colour.label}`}
          aria-expanded={colourPopoverOpen}
          title={`Highlight colour: ${colour.label}`}
          disabled={!documentOpen}
          onClick={onToggleColourPopover}
        >
          <i className="reading-room-current-colour" aria-hidden="true" />
          <ChevronDown aria-hidden="true" />
        </button>
      </div>

      {colourPopoverOpen && (
        <div className="reading-room-colour-popover" role="dialog" aria-label="Highlight colour">
          <header>Highlight colour <strong>{colour.label}</strong></header>
          <div className="reading-room-colour-options">
            {(Object.keys(READING_HIGHLIGHT_COLOURS) as ReadingHighlightColour[]).map((key) => (
              <button
                key={key}
                type="button"
                className={key === markState.colour ? 'selected' : ''}
                aria-label={`Use ${READING_HIGHLIGHT_COLOURS[key].label.toLocaleLowerCase('en')} highlight`}
                aria-pressed={key === markState.colour}
                style={{ background: READING_HIGHLIGHT_COLOURS[key].value }}
                onClick={() => onSelectColour(key)}
              />
            ))}
          </div>
          <p>The choice stays selected until you change it.</p>
        </div>
      )}

      {bookmarkIndexOpen && (
        <div className="reading-room-bookmark-index" aria-label="Reading Bookmark thumb index">
          {bookmarks.map((bookmark, index) => (
            <button
              key={bookmark.id}
              type="button"
              className="reading-room-bookmark-thumb"
              aria-label={`Go to ${bookmark.label}`}
              title={bookmark.label}
              style={{
                background: readingBookmarkColour(index),
                top: bookmarkTop(bookmark, index, pageCount),
              }}
              onClick={() => onGoToBookmark(bookmark)}
            >
              <span>{bookmark.label}</span>
            </button>
          ))}
        </div>
      )}

      <span className="reading-room-rail-gap" />
      <button type="button" aria-label="Close Reading Room" title="Close Reading Room" onClick={onClose}>
        <X aria-hidden="true" />
      </button>
    </nav>
  )
}
