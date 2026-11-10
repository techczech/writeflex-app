import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BookOpen, Check, ChevronDown, CloudOff, Code2, Command, Compass, Eye, PanelsTopLeft, Glasses, Highlighter, Link, ListOrdered, PanelLeft, PanelRight, PanelTop, Search, TriangleAlert, X } from 'lucide-react'
import { missingPartsLabel, type ShareMark } from '../../../shared/sharing-links'
import type { EditorViewMode } from '../editor/view-mode'
import { SearchField } from './SearchField'
import type { WriterReviewMode } from '../editor/writer-review'

export type ToolbarProps = {
  sidebarShortcut?: string
  panelsShortcut?: string
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
  /** Vault protection status in the approved title-bar position. */
  syncStatus?: ReactNode
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
  sidebarShortcut = '⌘[',
  panelsShortcut = '⌘]',
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
  syncStatus,
}: ToolbarProps): JSX.Element {
  // One on/off mode (house rule R18): on is the stored value 'reviewing', off is 'drafting'. Only the labels changed.
  const tracking = writerMode === 'reviewing'
  const modeLabel = 'Track my changes'
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
    setHighlighted(0)
    requestAnimationFrame(() => menuRef.current?.focus())
    const outside = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node) && !modeButtonRef.current?.contains(event.target as Node)) onModeDrawerOpenChange(false)
    }
    window.addEventListener('pointerdown', outside, true)
    return () => window.removeEventListener('pointerdown', outside, true)
  }, [modeDrawerOpen, onModeDrawerOpenChange, writerMode])

  const pick = (index: number): void => {
    if (index < 1) onSelectWriterMode(tracking ? 'drafting' : 'reviewing')
    else onSelectViewMode((['clean', 'markup', 'raw'] as const)[index - 1])
    onModeDrawerOpenChange(false)
  }

  return (
    <div className="toolbar">
      <div className="traffic-spacer" aria-hidden="true" />
      <button
        className="tbtn"
        aria-pressed={sidebarOpen}
        title={`Toggle sidebar (${sidebarShortcut})`}
        aria-label="Toggle sidebar"
        onClick={onToggleSidebar}
      >
        <PanelLeft className="icon" />
      </button>
      <button
        className="tbtn"
        aria-pressed={readingRoomOpen}
        title={`${readingRoomOpen ? 'Close' : 'Open'} Reading Room (${readingRoomShortcut})`}
        aria-label={`${readingRoomOpen ? 'Close' : 'Open'} Reading Room`}
        onClick={onToggleReadingRoom}
      >
        <BookOpen className="icon" />
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
            <PanelsTopLeft className="icon" />
          </button>
          {tabsListOpen && tabsPopover && <div className="tabs-popover" role="dialog" aria-label="Open tabs">{tabsPopover}</div>}
        </span>
      )}
      <div className="tabstrip" role="tablist" aria-label="Open tabs">{children}</div>
      {syncStatus}
      {folioName && onOpenFolioPlan && (
        <button type="button" className="planbtn" aria-label={`Manage Folio ${folioName}`} title={`Manage Folio ${folioName}`} onClick={onOpenFolioPlan}>
          <ListOrdered className="icon sm" /><span className="pb-plan">Manage Folio</span><span className="pb-name">{folioName}</span>
        </button>
      )}

      <span className="tbsep" aria-hidden="true" />
        <button ref={modeButtonRef} className={`modebtn${writerMode === 'reviewing' ? ' reviewing' : ''}`} title={`${modeLabel}: ${tracking ? 'on' : 'off'} (⌥⌘M)`} aria-label={`${modeLabel}: ${tracking ? 'on' : 'off'}`} aria-haspopup="menu" aria-expanded={modeDrawerOpen} onClick={() => onModeDrawerOpenChange(!modeDrawerOpen)}>
          <Glasses className="icon sm" /><span className="mn">{modeLabel}</span><ChevronDown className="icon cv" />
        </button>
        {modeDrawerOpen && (
          <div className="modemenu" role="menu" aria-label="Writing and showing modes" ref={menuRef} tabIndex={-1} onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); onModeDrawerOpenChange(false) }
            else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setHighlighted((current) => (current + (event.key === 'ArrowDown' ? 1 : 3)) % 4) }
            else if (event.key === 'Enter') { event.preventDefault(); pick(highlighted) }
          }}>
            <div className="mm-h"><span>Writing</span><span className="ln" /><kbd>⌥⌘M</kbd></div>
            <button type="button" role="menuitemcheckbox" aria-checked={tracking} title="Shows this session’s changes, old struck and new highlighted." className={`mm-i${tracking ? ' on' : ''}${highlighted === 0 ? ' hi' : ''}`} onMouseEnter={() => setHighlighted(0)} onClick={() => pick(0)}>
              <Check className="tick" /><Glasses className="icon sm" /><span className="mt"><b>{modeLabel}</b></span>
            </button>
            <hr />
            <div className="mm-h"><span>Showing</span><span className="ln" /><kbd>⌥⌘R</kbd></div>
            {([
              ['Clean', Eye, 'clean'],
              ['Markup', Highlighter, 'markup'],
              ['Raw', Code2, 'raw'],
            ] as const).map(([label, Icon, mode], offset) => {
              const index = offset + 1
              return <button type="button" role="menuitemradio" aria-checked={viewMode === mode} className={`mm-i${viewMode === mode ? ' on' : ''}${highlighted === index ? ' hi' : ''}`} onMouseEnter={() => setHighlighted(index)} onClick={() => pick(index)} key={label}><Check className="tick" /><Icon className="icon sm" /><span className="mt">{label}</span></button>
            })}
          </div>
        )}
      <span className="tbsep" aria-hidden="true" />

      <div className="tb-right">
        {boardFilter ? (
          <SearchField
            wrapClassName="board-filter"
            value={boardFilter.value}
            onValueChange={(value) => boardFilter.onChange(value)}
            onKeyDown={(event) => { if (event.key === 'Escape') boardFilter.onChange('') }}
            placeholder="Filter cards"
            aria-label="Filter cards"
            role="searchbox"
            clearLabel="Clear card filter"
          />
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
          </button>
        )}
        <button className="tbtn" title="Command palette (⇧⌘P)" aria-label="Command palette" onClick={onOpenPalette}>
          <Command className="icon" />
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
        </button>
        <button
          className="tbtn"
          aria-pressed={panelsOpen}
          title={`Toggle right sidebar (${panelsShortcut})`}
          aria-label="Toggle panels"
          onClick={onTogglePanels}
        >
          <PanelRight className="icon" />
        </button>
      </div>
    </div>
  )
}
