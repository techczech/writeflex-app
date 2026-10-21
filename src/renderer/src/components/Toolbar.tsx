import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BookOpen, Check, ChevronDown, CloudOff, Code2, Command, Compass, Eye, Files, Glasses, Highlighter, Link, ListOrdered, PanelLeft, PanelRight, PanelTop, Search, SquarePen, TriangleAlert, X } from 'lucide-react'
import { missingPartsLabel, type ShareMark } from '../../../shared/sharing-links'
import type { EditorViewMode } from '../editor/view-mode'
import type { WriterReviewMode } from '../editor/writer-review'

export type ToolbarProps = {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  panelsOpen: boolean
  onTogglePanels: () => void
  writerMode: WriterReviewMode
  viewMode: EditorViewMode
  modeDrawerOpen: boolean
  onModeDrawerOpenChange: (open: boolean) => void
  onSelectWriterMode: (mode: WriterReviewMode) => void
  onSelectViewMode: (mode: EditorViewMode) => void
  readingRoomOpen: boolean
  readingRoomShortcut: string
  onToggleReadingRoom: () => void
  /** Raise the command palette (⇧⌘P). */
  onOpenPalette: () => void
  /** The Guide button: opens the Guide tab in the right pane, or closes it when it is the tab showing. */
  onToggleGuide?: () => void
  guideOpen?: boolean
  /** Is the action bar shown (ADR-0040)? One GLOBAL app setting, not per window. */
  actionBarVisible: boolean
  /** Show or hide the action bar — the bar's one and only toggle; it carries no fold chevron. */
  onToggleActionBar: () => void
  /** The action-bar toggle's effective chord, or null while the command is keyless. */
  actionBarShortcut?: string | null
  /** The Board owns the toolbar search slot while its non-file tab is active. */
  boardFilter?: { value: string; onChange: (value: string) => void }
  /** The Tabs list button (ticket 14): the last control before the tab strip. Absent = no button. */
  onToggleTabsList?: () => void
  tabsListOpen?: boolean
  tabsShortcut?: string
  /** The open-tabs popover, rendered anchored under the Tabs button while it is open. */
  tabsPopover?: ReactNode
  /** Esc / an outside press closes the popover; focus returns to the Tabs button. */
  onCloseTabsList?: () => void
  /** The Folio the open file belongs to. Present = the "Plan | <Folio name>" button; absent = nothing is rendered. */
  folioName?: string | null
  onOpenFolioPlan?: () => void
  /**
   * The Shared mark (sharing ticket 03, frame `title-bar-marks`): Share, Shared, or Not published, for
   * the open piece. Absent = no piece open, no mark. Opens the Sharing page (⌥⌘S).
   */
  shareMark?: ShareMark | null
  shareOpen?: boolean
  onOpenSharing?: () => void
  /** Tab-strip slot — the horizontal document tabs and new-file button. */
  children?: ReactNode
}

const SHARE_MARK_WORDS: Record<ShareMark['kind'], string> = { share: 'Share', shared: 'Shared', 'not-published': 'Not published' }
/** Frame `folio`: "Shared · 1 part missing". */
const shareMarkWords = (mark: ShareMark): string => (mark.kind === 'shared' && mark.missing ? `Shared · ${missingPartsLabel(mark.missing)}` : SHARE_MARK_WORDS[mark.kind])
const SHARE_MARK_TITLES: Record<ShareMark['kind'], string> = {
  share: 'Not shared. Opens the Sharing page (⌥⌘S)',
  shared: 'Shared and published. Opens the Sharing page (⌥⌘S)',
  'not-published': 'Publishing failed; readers see the last published time. Opens the Sharing page (⌥⌘S)',
}

export function documentIdentityLabel(documentName?: string | null, collectionName?: string | null): string {
  return documentName && collectionName ? `${documentName} — ${collectionName}` : collectionName ?? 'WriteFlex'
}

/**
 * Chrome 0.6 shelf per the locked v3 mockup (ADR-0026). The bar is the traffic-light drag region
 * (app.css); the spacer reserves the native traffic lights' footprint, positioned by
 * windows.ts. Only controls with live handlers render here.
 */
export function Toolbar({
  sidebarOpen,
  onToggleSidebar,
  panelsOpen,
  onTogglePanels,
  writerMode,
  viewMode,
  modeDrawerOpen,
  onModeDrawerOpenChange,
  onSelectWriterMode,
  onSelectViewMode,
  readingRoomOpen,
  readingRoomShortcut,
  onToggleReadingRoom,
  onToggleTabsList,
  tabsListOpen = false,
  tabsShortcut = '⌘2',
  tabsPopover,
  onCloseTabsList,
  onOpenPalette,
  onToggleGuide,
  guideOpen = false,
  actionBarVisible,
  onToggleActionBar,
  actionBarShortcut,
  boardFilter,
  folioName,
  onOpenFolioPlan,
  shareMark,
  shareOpen = false,
  onOpenSharing,
  children,
}: ToolbarProps): JSX.Element {
  const modeLabel = writerMode === 'drafting' ? 'Drafting' : 'Reviewing'
  const menuRef = useRef<HTMLDivElement | null>(null)
  const modeButtonRef = useRef<HTMLButtonElement | null>(null)
  const tabsButtonRef = useRef<HTMLButtonElement | null>(null)
  const tabsAnchorRef = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    if (!tabsListOpen || !onCloseTabsList) return
    const outside = (event: PointerEvent): void => {
      if (!tabsAnchorRef.current?.contains(event.target as Node)) onCloseTabsList()
    }
    // Esc closes and hands focus back to the button (capture: the list's own inputs also hear Esc).
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      // The filter's own Esc (clear the text) and open menus inside the list keep their meaning first.
      if (target?.matches('input') && (target as HTMLInputElement).value !== '') return
      if (target?.closest('.tab-pin-menu, .open-sort-menu')) return
      event.preventDefault()
      event.stopPropagation()
      onCloseTabsList()
      tabsButtonRef.current?.focus()
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', escape, true)
    }
  }, [tabsListOpen, onCloseTabsList])
  const [highlighted, setHighlighted] = useState(0)
  useEffect(() => {
    if (!modeDrawerOpen) return
    setHighlighted(writerMode === 'drafting' ? 0 : 1)
    requestAnimationFrame(() => menuRef.current?.focus())
    const outside = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node) && !modeButtonRef.current?.contains(event.target as Node)) onModeDrawerOpenChange(false)
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  }, [modeDrawerOpen, onModeDrawerOpenChange, writerMode])

  const pick = (index: number): void => {
    if (index < 2) onSelectWriterMode(index === 0 ? 'drafting' : 'reviewing')
    else onSelectViewMode((['clean', 'markup', 'raw'] as const)[index - 2])
    onModeDrawerOpenChange(false)
  }

  return (
    <div className="toolbar">
      <div className="traffic-spacer" aria-hidden="true" />
      <button
        className="tbtn"
        aria-pressed={sidebarOpen}
        title="Toggle sidebar (⌘0)"
        aria-label="Toggle sidebar"
        onClick={onToggleSidebar}
      >
        <PanelLeft className="icon" />
        <span className="chord" aria-hidden="true">⌘0</span>
      </button>
      <button
        className="tbtn"
        aria-pressed={readingRoomOpen}
        title={`${readingRoomOpen ? 'Close' : 'Open'} Reading Room (${readingRoomShortcut})`}
        aria-label={`${readingRoomOpen ? 'Close' : 'Open'} Reading Room`}
        onClick={onToggleReadingRoom}
      >
        <BookOpen className="icon" />
        <span className="chord" aria-hidden="true">{readingRoomShortcut}</span>
      </button>
      {onToggleTabsList && (
        <span className="tabs-list-anchor" ref={tabsAnchorRef}>
          <button
            ref={tabsButtonRef}
            className="tbtn tabs-list-button"
            aria-pressed={tabsListOpen}
            aria-haspopup="dialog"
            aria-expanded={tabsListOpen}
            title={`Tabs (${tabsShortcut})`}
            aria-label="Tabs"
            onClick={onToggleTabsList}
          >
            <Files className="icon" />
            <span className="chord" aria-hidden="true">{tabsShortcut}</span>
          </button>
          {tabsListOpen && tabsPopover && <div className="tabs-popover" role="dialog" aria-label="Open tabs">{tabsPopover}</div>}
        </span>
      )}
      <div className="tabstrip" role="tablist" aria-label="Open tabs">{children}</div>
      {folioName && onOpenFolioPlan && (
        <button type="button" className="planbtn" aria-label={`Open the Folio outline for ${folioName}`} title={`Open the Folio outline for ${folioName}`} onClick={onOpenFolioPlan}>
          <ListOrdered className="icon sm" /><span className="pb-plan">Folio outline</span><span className="pb-name">{folioName}</span>
        </button>
      )}

      <span className="tbsep" aria-hidden="true" />
        <button ref={modeButtonRef} className={`modebtn${writerMode === 'reviewing' ? ' reviewing' : ''}`} title={`Mode — ${modeLabel} (⌥⌘R)`} aria-label={`Mode: ${modeLabel}`} aria-haspopup="menu" aria-expanded={modeDrawerOpen} onClick={() => onModeDrawerOpenChange(!modeDrawerOpen)}>
          <SquarePen className="icon sm" /><span className="mn">{modeLabel}</span><ChevronDown className="icon cv" /><span className="chord" aria-hidden="true">⌥⌘R</span>
        </button>
        {modeDrawerOpen && (
          <div className="modemenu" role="menu" aria-label="Writing and showing modes" ref={menuRef} tabIndex={-1} onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); onModeDrawerOpenChange(false) }
            else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setHighlighted((current) => (current + (event.key === 'ArrowDown' ? 1 : 4)) % 5) }
            else if (event.key === 'Enter') { event.preventDefault(); pick(highlighted) }
          }}>
            <div className="mm-h"><span>Writing</span><span className="ln" /><kbd>⌥⌘M</kbd></div>
            {([
              ['Drafting', 'Text is text. Your edits are recorded quietly.', SquarePen],
              ['Reviewing', 'Reveals this session — old struck, new highlighted.', Glasses],
            ] as const).map(([label, detail, Icon], index) => (
              <button type="button" role="menuitemradio" aria-checked={(writerMode === 'drafting') === (index === 0)} className={`mm-i${(writerMode === 'drafting') === (index === 0) ? ' on' : ''}${highlighted === index ? ' hi' : ''}`} onMouseEnter={() => setHighlighted(index)} onClick={() => pick(index)} key={label}>
                <Check className="tick" /><Icon className="icon sm" /><span className="mt"><b>{label}</b><small>{detail}</small></span>
              </button>
            ))}
            <hr />
            <div className="mm-h"><span>Showing</span><span className="ln" /><kbd>⌥⌘R</kbd></div>
            {([
              ['Clean', Eye, 'clean'],
              ['Markup', Highlighter, 'markup'],
              ['Raw', Code2, 'raw'],
            ] as const).map(([label, Icon, mode], offset) => {
              const index = offset + 2
              return <button type="button" role="menuitemradio" aria-checked={viewMode === mode} className={`mm-i${viewMode === mode ? ' on' : ''}${highlighted === index ? ' hi' : ''}`} onMouseEnter={() => setHighlighted(index)} onClick={() => pick(index)} key={label}><Check className="tick" /><Icon className="icon sm" /><span className="mt">{label}</span></button>
            })}
            <div className="mm-foot"><span className="fk"><kbd>↑↓</kbd>move</span><span className="fk"><kbd>↵</kbd>pick</span><span className="fk"><kbd>Esc</kbd></span></div>
          </div>
        )}
      <span className="tbsep" aria-hidden="true" />

      <div className="tb-right">
        {boardFilter ? (
          <div className="board-filter">
            <Search className="icon sm" aria-hidden="true" />
            <input
              type="search"
              role="searchbox"
              value={boardFilter.value}
              onChange={(event) => boardFilter.onChange(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape') boardFilter.onChange('') }}
              placeholder="Filter cards"
              aria-label="Filter cards"
              spellCheck={false}
            />
            {boardFilter.value && (
              <button type="button" className="board-filter-clear" aria-label="Clear card filter" onClick={() => boardFilter.onChange('')}>
                <X className="icon sm" />
              </button>
            )}
          </div>
        ) : null}
        {shareMark && onOpenSharing && (
          <button
            type="button"
            className={`sharemark ${shareMark.kind}${shareMark.kind === 'shared' && shareMark.missing ? ' missing' : ''}`}
            data-testid="share-mark"
            data-mark={shareMark.kind}
            aria-pressed={shareOpen}
            title={shareMark.kind === 'shared' && shareMark.missing ? `Shared; ${missingPartsLabel(shareMark.missing)}: readers see its title with “not available”. Opens the Sharing page (⌥⌘S)` : SHARE_MARK_TITLES[shareMark.kind]}
            aria-label={`${shareMarkWords(shareMark)}: open the Sharing page`}
            onClick={onOpenSharing}
          >
            {shareMark.kind === 'not-published' ? <CloudOff className="icon sm" aria-hidden="true" /> : shareMark.kind === 'shared' && shareMark.missing ? <TriangleAlert className="icon sm" aria-hidden="true" /> : <Link className="icon sm" aria-hidden="true" />}
            <span className="sm-word">{shareMarkWords(shareMark)}</span>
            <span className="chord" aria-hidden="true">⌥⌘S</span>
          </button>
        )}
        <button className="tbtn" title="Command palette (⇧⌘P)" aria-label="Command palette" onClick={onOpenPalette}>
          <Command className="icon" />
          <span className="chord" aria-hidden="true">⇧⌘P</span>
        </button>
        {onToggleGuide && (
          <button className="tbtn" aria-pressed={guideOpen} title="Guide" aria-label="Guide" data-action="guide" onClick={onToggleGuide}>
            <Compass className="icon" />
          </button>
        )}
        <button
          className="tbtn"
          aria-pressed={actionBarVisible}
          title={`${actionBarVisible ? 'Hide' : 'Show'} the action bar${actionBarShortcut ? ` (${actionBarShortcut})` : ''}`}
          aria-label="Show/Hide the action bar"
          onClick={onToggleActionBar}
        >
          <PanelTop className="icon" />
          {actionBarShortcut && <span className="chord" aria-hidden="true">{actionBarShortcut}</span>}
        </button>
        <button
          className="tbtn"
          aria-pressed={panelsOpen}
          title="Panels — Agent ⌘J · Scratchpad ⇧⌘J · Versions ⌘3"
          aria-label="Toggle panels"
          onClick={onTogglePanels}
        >
          <PanelRight className="icon" />
          <span className="chord" aria-hidden="true">⌘J</span>
        </button>
      </div>
    </div>
  )
}
