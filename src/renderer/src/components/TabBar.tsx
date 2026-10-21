import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { AppWindow, ArrowLeft, ArrowRight, Columns3, Ellipsis, FileText, FolderTree, ListTree, Pin, Plus, Search, SlidersHorizontal, X } from 'lucide-react'
import { isBoardTabId, isSurfaceTabId, isWidgetWorkbenchTabId, ownFolderGroup, sameTabList, tabGroupLabels, tabStripFill, tabStripView, type OpenTabGroup } from '../hooks/tab-state'

export type TabOrientation = 'horizontal' | 'sidebar'

export type OpenTabsSort = 'folder' | 'changed' | 'opened' | 'name'

const SORT_LABELS: ReadonlyArray<readonly [OpenTabsSort, string]> = [
  ['folder', 'By folder'],
  ['changed', 'Recently changed'],
  ['opened', 'Recently opened'],
  ['name', 'Name'],
]

/** Compact elapsed time used by the locked Tabs-sidebar mockup: 2m, 1h, 3h, yest. */
export function formatSidebarTabTime(timestamp: number, now = Date.now()): string {
  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours}h`
  if (elapsedHours < 48) return 'yest'
  return `${Math.floor(elapsedHours / 24)}d`
}

export function measurementOverflowLabel(tabCount: number): string {
  return `+${tabCount}`
}

export type TabBarProps = {
  tabs: string[]
  active: string | null
  pinned?: string[]
  recent?: string[]
  /** Paths with unsaved changes; the editor supplies real values from Task 6, empty until then. */
  dirtyPaths: Set<string>
  /** Open paths waiting for a changed/removed-on-disk decision. */
  diskNoticePaths?: Set<string>
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onNew: () => void
  onPin?: (path: string, pinned: boolean) => void
  /** The tab menu's Reveal in Files: show the tab's file in the Files sidebar. */
  onReveal?: (path: string) => void
  onReorderPin?: (path: string, before: string | null) => void
  onOpenTabs?: () => void
  visibleInStrip?: string[]
  parentByPath?: Readonly<Record<string, string>>
  onTrailBack?: () => void
  onTrailForward?: () => void
  canTrailBack?: boolean
  canTrailForward?: boolean
  onStripVisibleChange?: (paths: string[]) => void
  modifiedAt?: Readonly<Record<string, number>>
  /** Horizontal renders the toolbar strip; sidebar renders the grouped Tabs section. */
  orientation?: TabOrientation
  /** Sidebar only: bump to focus its filter when the Tabs command is invoked. */
  focusTick?: number
  /** Label for the reserved Board tab; its id deliberately carries no collection path. */
  boardName?: string | null
  /** Sidebar By folder: the strip group first, then the rest by last activity (useTabs().groups).
   *  Absent → derived from each tab's own folder. */
  groups?: OpenTabGroup[]
  /** Heading for the workspace-root group. */
  rootName?: string | null
  /** Sidebar only: the initial sort. By folder is the default. */
  initialSort?: OpenTabsSort
}

/** Basename for the tab label — derived from the path so a tab never needs the file list to render. */
function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? path : path.slice(cut + 1)
}

/**
 * Document tabs in the horizontal shelf or the grouped sidebar Tabs section. The horizontal strip
 * measures natural widths and spills whole tabs; pinned state and recency come from durable tab state.
 */
export function TabBar({
  tabs,
  active,
  pinned = [],
  recent = [],
  dirtyPaths,
  diskNoticePaths = new Set(),
  onActivate,
  onClose,
  onNew,
  onPin,
  onReveal,
  onReorderPin,
  onOpenTabs,
  visibleInStrip = tabs,
  parentByPath = {},
  onTrailBack,
  onTrailForward,
  canTrailBack = false,
  canTrailForward = false,
  onStripVisibleChange,
  modifiedAt = {},
  orientation = 'horizontal',
  focusTick = 0,
  boardName,
  groups,
  rootName,
  initialSort = 'folder',
}: TabBarProps): JSX.Element {
  // Filter is only used in the sidebar instance, but the hook must run unconditionally.
  const [filter, setFilter] = useState('')
  const filterRef = useRef<HTMLInputElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const pinMenuRef = useRef<HTMLDivElement | null>(null)
  const [stripVisible, setStripVisible] = useState<string[]>(tabs)
  const [pinMenu, setPinMenu] = useState<{ path: string; x: number; y: number } | null>(null)
  const [sort, setSort] = useState<OpenTabsSort>(initialSort)
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [treeView, setTreeView] = useState(true)

  useLayoutEffect(() => {
    if (orientation !== 'horizontal' || !measureRef.current) return
    const strip = measureRef.current.closest<HTMLElement>('.tabstrip')
    if (!strip) return
    const measure = (): void => {
      const widths = new Map<string, number>()
      for (const node of measureRef.current?.querySelectorAll<HTMLElement>('[data-measure-path]') ?? []) {
        const path = node.dataset.measurePath
        if (path) widths.set(path, node.getBoundingClientRect().width)
      }
      const moreWidth = measureRef.current?.querySelector<HTMLElement>('.tab-more')?.getBoundingClientRect().width ?? 46
      const newWidth = measureRef.current?.querySelector<HTMLElement>('.newtab')?.getBoundingClientRect().width ?? 30
      const pinDivider = pinned.length > 0 && pinned.length < tabs.length ? 13 : 0
      const fill = tabStripFill({ tabs, active, pinned, recent }, widths, strip.clientWidth - newWidth - pinDivider - 4, moreWidth)
      // Skip an equal result: React replays a pending lower-priority updater on every urgent render,
      // which hands this effect fresh `tabs`/`recent` arrays with the same content each time. An
      // unconditional set here re-renders synchronously and the replay starts again (React error #185).
      setStripVisible((current) => (sameTabList(current, fill.visible) ? current : fill.visible))
      onStripVisibleChange?.(fill.visible)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [active, onStripVisibleChange, orientation, pinned, recent, tabs])

  useEffect(() => {
    if (orientation === 'sidebar' && focusTick > 0) filterRef.current?.focus()
  }, [focusTick, orientation])

  useEffect(() => {
    if (!pinMenu) return
    const dismissOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setPinMenu(null)
    }
    const dismissOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !pinMenuRef.current?.contains(event.target)) setPinMenu(null)
    }
    window.addEventListener('keydown', dismissOnEscape, true)
    document.addEventListener('pointerdown', dismissOutside, true)
    return () => {
      window.removeEventListener('keydown', dismissOnEscape, true)
      document.removeEventListener('pointerdown', dismissOutside, true)
    }
  }, [pinMenu])

  // The keyboard lands on the menu's first item, so ↑/↓ and ↵ work the moment it opens.
  useEffect(() => {
    if (pinMenu) pinMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [pinMenu])

  // Direction D frame D3: the same four items on a strip tab and on an Open-tabs row. Each runs the
  // command it names (⌥⌘P pin, activate, Files reveal, ⌘W close) — the menu adds no behaviour of its own.
  const pinMenuElement = pinMenu && (() => {
    const path = pinMenu.path
    const run = (action: () => void) => (): void => {
      setPinMenu(null)
      action()
    }
    const moveFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      const items = [...(pinMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
      const at = items.indexOf(document.activeElement as HTMLButtonElement)
      const step = event.key === 'ArrowDown' ? 1 : -1
      items[(at + step + items.length) % items.length]?.focus()
    }
    return (
      <div ref={pinMenuRef} className="tab-pin-menu" role="menu" aria-label="Tab" style={{ left: pinMenu.x, top: pinMenu.y }} onKeyDown={moveFocus}
        // The pointer moves the one highlight, so the menu never shows two lit rows.
        onMouseOver={(event) => (event.target as HTMLElement).closest<HTMLButtonElement>('[role="menuitem"]')?.focus()}>
        <button role="menuitem" className="tab-menu-pin" onClick={run(() => onPin?.(path, !pinned.includes(path)))}>
          <Pin className="icon sm" /><span>{pinned.includes(path) ? 'Unpin from strip' : 'Pin to strip'}</span><kbd>⌥⌘P</kbd>
        </button>
        <button role="menuitem" className="tab-menu-open" onClick={run(() => onActivate(path))}>
          <FileText className="icon sm" /><span>Open</span>
        </button>
        {onReveal && !isSurfaceTabId(path) && (
          <button role="menuitem" className="tab-menu-reveal" onClick={run(() => onReveal(path))}>
            <FolderTree className="icon sm" /><span>Reveal in Files</span>
          </button>
        )}
        <button role="menuitem" className="tab-menu-close" onClick={run(() => onClose(path))}>
          <X className="icon sm" /><span>Close tab</span><kbd>⌘W</kbd>
        </button>
      </div>
    )
  })()

  const tabButton = (path: string, className: string): JSX.Element => {
    const selected = path === active
    const board = isBoardTabId(path)
    const workbench = isWidgetWorkbenchTabId(path)
    const name = board ? `Board — ${boardName ?? 'Collection'}` : workbench ? 'Widget workbench' : basename(path)
    const dirty = dirtyPaths.has(path)
    const diskNotice = diskNoticePaths.has(path)
    const isPinned = pinned.includes(path)
    const close = (e: MouseEvent): void => {
      e.stopPropagation() // don't also activate the tab we're closing
      onClose(path)
    }
    return (
      <button
        key={path}
        className={`${className}${isPinned ? ' pinned' : ''}${dirty ? ' dirty' : ''}${diskNotice ? ' disk-notice' : ''}`}
        role="tab"
        aria-selected={selected}
        title={board || workbench ? name : path}
        draggable={orientation === 'horizontal'}
        onDragStart={(event) => event.dataTransfer.setData('text/writeflex-tab', path)}
        onDragOver={(event) => { if (orientation === 'horizontal') event.preventDefault() }}
        onDrop={(event) => {
          const dragged = event.dataTransfer.getData('text/writeflex-tab')
          if (!dragged || !onPin) return
          event.preventDefault()
          if (isPinned) {
            onPin(dragged, true)
            onReorderPin?.(dragged, path)
          } else if (pinned.includes(dragged)) onPin(dragged, false)
        }}
        onClick={(event) => {
          if (event.altKey && onPin) onPin(path, !isPinned)
          else onActivate(path)
        }}
        onContextMenu={(event) => {
          if (!onPin) return
          event.preventDefault()
          setPinMenu({ path, x: event.clientX, y: event.clientY })
        }}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault() // middle-click closes without opening/navigating
            onClose(path)
          }
        }}
      >
        {isPinned ? <Pin className="icon sm" /> : board ? <Columns3 className="icon sm" /> : workbench ? <AppWindow className="icon sm" /> : <FileText className="icon sm" />}
        <span className="name">{name}</span>
        {dirty && <span className="dirty-dot" aria-hidden="true" />}
        {diskNotice && <span className="disk-notice-dot" aria-hidden="true" />}
        {orientation === 'sidebar' && modifiedAt[path] && <span className="tab-time">{formatSidebarTabTime(modifiedAt[path])}</span>}
        {orientation === 'horizontal' && !isPinned && (
          <span className="close" role="button" aria-label={`Close ${name}`} title="Close tab (⌘W)" onClick={close}>
            <X className="icon sm" />
          </span>
        )}
      </button>
    )
  }

  if (orientation === 'sidebar') {
    const needle = filter.trim().toLowerCase()
    const shown = needle ? tabs.filter((path) => basename(path).toLowerCase().includes(needle)) : tabs
    const shownSet = new Set(shown)
    const bySort = (a: string, b: string): number => {
      if (sort === 'name') return basename(a).localeCompare(basename(b))
      if (sort === 'opened') return recent.indexOf(a) - recent.indexOf(b)
      return (modifiedAt[b] ?? 0) - (modifiedAt[a] ?? 0)
    }
    const visibleSet = new Set(visibleInStrip)
    const pinnedGroup = pinned.filter((path) => shownSet.has(path))
    const recentGroup = visibleInStrip.filter((path) => !pinned.includes(path) && shownSet.has(path)).sort(bySort)
    const spillGroup = shown.filter((path) => !visibleSet.has(path)).sort(bySort)
    // By folder: the groups replace Recent and "Not in the strip" — the strip group heads the list.
    const folderGroups = sort === 'folder'
      ? (groups ?? tabStripView({ tabs, active, pinned, recent }, ownFolderGroup).groups)
      : []
    const folderLabels = tabGroupLabels(folderGroups.map((group) => group.key), rootName ?? 'Workspace')
    const renderTree = (paths: string[], spill = false): JSX.Element[] => {
      const pathSet = new Set(paths)
      const children = new Map<string, string[]>()
      for (const path of paths) {
        const parent = treeView ? parentByPath[path] : undefined
        if (parent && pathSet.has(parent)) children.set(parent, [...(children.get(parent) ?? []), path])
      }
      const roots = paths.filter((path) => !pathSet.has(parentByPath[path] ?? ''))
      const out: JSX.Element[] = []
      const walk = (path: string, depth: number): void => {
        out.push(tabButton(path, `tab open-tab-row${spill ? ' spill' : ''}${depth > 0 ? ' nested' : ''}`))
        for (const child of children.get(path) ?? []) walk(child, depth + 1)
      }
      for (const root of roots) walk(root, 0)
      return out
    }
    const sortLabel = SORT_LABELS.find(([value]) => value === sort)?.[1] ?? 'By folder'
    const onFilterKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
      // Esc clears the filter and stays in the input — it must NOT bubble out and close a pane/overlay.
      if (e.key === 'Escape' && filter !== '') {
        e.preventDefault()
        e.stopPropagation()
        setFilter('')
      }
    }
    return (
      <div className="open-tabs-section" onKeyDown={(event) => {
        // ↑/↓ walk the filter and the rows (↵ on a row activates it); menus inside the list keep their own arrows.
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        const target = event.target as HTMLElement
        if (target.closest('.tab-pin-menu, .open-sort-menu')) return
        const stops = [...event.currentTarget.querySelectorAll<HTMLElement>('input[aria-label="Filter open tabs"], .open-tabs-list .tab')]
        const at = stops.indexOf(target)
        if (at === -1) return
        event.preventDefault()
        stops[Math.max(0, Math.min(stops.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
      }}>
        <div className="open-tabs-summary">
          <span>Open tabs</span><span className="open-tabs-count">{tabs.length}</span><span className="open-tabs-head-spacer" />
          <button className="open-head-button" disabled={!canTrailBack} title="Back along link trail (⌃⌘←)" aria-label="Back along link trail" onClick={onTrailBack}><ArrowLeft className="icon sm" /></button>
          <button className="open-head-button" disabled={!canTrailForward} title="Forward along link trail (⌃⌘→)" aria-label="Forward along link trail" onClick={onTrailForward}><ArrowRight className="icon sm" /></button>
        </div>
        <div className="open-tabs-filter">
          <div className="facet-search">
            <Search className="icon sm" aria-hidden="true" />
            <input
              ref={filterRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={onFilterKeyDown}
              placeholder="Filter"
              aria-label="Filter open tabs"
            />
          </div>
          <button className="open-sort" aria-expanded={sortMenuOpen} aria-label={`Sort tabs: ${sortLabel}`} onClick={() => setSortMenuOpen((open) => !open)}>
            <SlidersHorizontal className="icon sm" />{sortLabel}
          </button>
          {sortMenuOpen && (
            <div className="open-sort-menu" role="menu">
              {SORT_LABELS.map(([value, label]) => (
                <button key={value} role="menuitemradio" aria-checked={sort === value} onClick={() => { setSort(value); setSortMenuOpen(false) }}>{label}</button>
              ))}
              <button role="menuitemcheckbox" aria-checked={treeView} onClick={() => setTreeView((value) => !value)}><ListTree className="icon sm" />Tree view</button>
            </div>
          )}
        </div>
        <div className="open-tabs-list" role="tablist" aria-label="Open tabs">
          {pinnedGroup.length > 0 && <div className="open-tabs-group"><Pin className="icon sm" />Pinned</div>}
          {renderTree(pinnedGroup)}
          {sort === 'folder' ? folderGroups.map((group) => {
            const rows = group.tabs.filter((path) => shownSet.has(path))
            if (rows.length === 0) return null
            return (
              <Fragment key={`group:${group.key}`}>
                <div className={`open-tabs-group folder-group${group.onStrip ? ' on-strip' : ''}`} data-group={group.key}>
                  <span className="group-name">{folderLabels.get(group.key)}</span>
                  {group.onStrip && <span className="on-strip-label">on the strip</span>}
                </div>
                {renderTree(rows)}
              </Fragment>
            )
          }) : (
            <>
              {recentGroup.length > 0 && <div className="open-tabs-group">Recent</div>}
              {renderTree(recentGroup)}
              {spillGroup.length > 0 && <div className="open-tabs-group spill-label">Not in the strip · {spillGroup.length}</div>}
              {renderTree(spillGroup, true)}
            </>
          )}
          {shown.length === 0 && (
            <p className="open-tabs-empty">{tabs.length === 0 ? 'No open tabs' : 'No tabs match'}</p>
          )}
        </div>
        {pinMenuElement}
      </div>
    )
  }

  return (
    <>
      <div className="tab-measure" ref={measureRef} aria-hidden="true">
        {tabs.map((path) => {
          const name = isBoardTabId(path) ? `Board — ${boardName ?? 'Collection'}` : isWidgetWorkbenchTabId(path) ? 'Widget workbench' : basename(path)
          const isPinned = pinned.includes(path)
          return <span key={path} className={`tab${isPinned ? ' pinned' : ''}`} data-measure-path={path}>{isPinned ? <Pin className="icon sm" /> : <FileText className="icon sm" />}<span className="name">{name}</span>{!isPinned && <span className="close"><X className="icon sm" /></span>}</span>
        })}
        <span className="tab-more"><Ellipsis className="icon sm" /><span className="n">{measurementOverflowLabel(tabs.length)}</span></span>
        <span className="tbtn newtab"><Plus className="icon" /></span>
      </div>
      {/* Recency decides WHICH tabs are visible (tabStripFill), but they RENDER in stable order — pinned
          in pin order, the rest in open order — so activating a tab never makes it jump to the front. */}
      {pinned.filter((path) => stripVisible.includes(path)).map((path) => tabButton(path, 'tab'))}
      {stripVisible.some((path) => pinned.includes(path)) && stripVisible.some((path) => !pinned.includes(path)) && (
        <span className="pinsep" aria-hidden="true" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
          const dragged = event.dataTransfer.getData('text/writeflex-tab')
          if (dragged) onPin?.(dragged, true)
        }} />
      )}
      {tabs.filter((path) => stripVisible.includes(path) && !pinned.includes(path)).map((path) => tabButton(path, 'tab'))}
      {tabs.length > stripVisible.length && (
        <button className="tab-more" aria-label="More open tabs" title="More open tabs (⌘2)" onClick={onOpenTabs}>
          <Ellipsis className="icon sm" /><span className="n">+{tabs.length - stripVisible.length}</span><span className="chord" aria-hidden="true">⌘2</span>
        </button>
      )}
      <button className="tbtn newtab" title="New tab (⌘N)" aria-label="New file" onClick={onNew}>
        <Plus className="icon" />
        <span className="chord" aria-hidden="true">⌘N</span>
      </button>
      {pinMenuElement}
    </>
  )
}
