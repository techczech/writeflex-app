import { useCallback, useRef, useState } from 'react'

export type LeftPaneTab = 'files' | 'outline' | 'search'

/**
 * Read a left-pane tab from anywhere it might have been stored. The open-tabs list left the sidebar
 * (ticket 14: it is a popover off the toolbar now), so a layout saved with `'open'` opens on Files,
 * as does anything unrecognised.
 */
export function normaliseLeftPaneTab(value: unknown): LeftPaneTab {
  return value === 'outline' || value === 'search' || value === 'files' ? value : 'files'
}
export type RightPaneTab = 'guide' | 'agent' | 'scratchpad' | 'review' | 'agent-notes' | 'versions'

/** The tabs that are always there. The Guide is not one of them: the title bar's Guide button adds it. */
export const RIGHT_PANE_TABS: readonly RightPaneTab[] = ['agent', 'scratchpad', 'review', 'agent-notes', 'versions']

/** The tabs in the row now: the Guide is last, and only while the person has opened it. */
export const rightPaneTabsFor = (guideOpen: boolean): readonly RightPaneTab[] =>
  guideOpen ? [...RIGHT_PANE_TABS, 'guide'] : RIGHT_PANE_TABS

/**
 * The tab the right pane shows: the one the person chose, else the Agent. A chosen Guide that is not
 * open (its tab was closed) falls back to the Agent.
 */
export function resolveRightPaneTab(chosen: RightPaneTab | null, guideOpen: boolean): RightPaneTab {
  if (chosen !== null && (chosen !== 'guide' || guideOpen)) return chosen
  return 'agent'
}

/** Resolve one wrapped move through the tabs that exist for the current app state. */
export function nextRightPaneTab(
  current: RightPaneTab,
  direction: 1 | -1,
  available: readonly RightPaneTab[],
): RightPaneTab {
  if (available.length === 0) return current
  const currentIndex = available.indexOf(current)
  if (currentIndex === -1) return direction === 1 ? available[0] : available[available.length - 1]
  return available[(currentIndex + direction + available.length) % available.length]
}

/** One tab as the fit planner sees it: its id and its natural width at rest (chord hidden). */
export type PaneTabWidth<T extends string> = { id: T; width: number }

/** Which tabs a pane-tab row shows and which go under its trailing "…" menu, both in tab order. */
export type PaneTabFit<T extends string> = { row: T[]; menu: T[] }

/** Sub-pixel slack: measured widths are fractional, and a sum that lands a hair over the row still fits. */
const FIT_EPSILON = 0.01

/**
 * Fit a pane's tabs to its width (ticket 07, option D): the tabs that fit stay in the row, in order,
 * and the rest go under a "…" menu at the row's right end — which exists, and costs its width, only
 * when something is inside it. The ACTIVE tab is never in the menu: when it would be hidden it takes
 * the place of the last tab that fits (more than one, if it is wider), and those move into the menu.
 *
 * `available` is the width the row gives its tabs (the pane's width less the row's padding and the
 * pane's border); `gap` is the row's gap between items, and `more` the "…" control's width. Before
 * anything is measured (`available` ≤ 0) every tab is in the row. A pane too narrow for even the
 * active tab still shows it alone, with everything else in the menu.
 */
export function fitPaneTabs<T extends string>(input: {
  tabs: readonly PaneTabWidth<T>[]
  available: number
  gap: number
  more: number
  active: T
}): PaneTabFit<T> {
  const { tabs, available, gap, more, active } = input
  const span = (list: readonly PaneTabWidth<T>[]): number =>
    list.reduce((sum, tab, index) => sum + tab.width + (index > 0 ? gap : 0), 0)
  const ids = (list: readonly PaneTabWidth<T>[]): T[] => list.map((tab) => tab.id)
  if (available <= 0 || span(tabs) <= available + FIT_EPSILON) return { row: ids(tabs), menu: [] }

  // Something will be hidden, so the "…" and the gap before it are spent first.
  const budget = available - gap - more
  let fit = 0
  while (fit < tabs.length && span(tabs.slice(0, fit + 1)) <= budget + FIT_EPSILON) fit += 1

  const activeIndex = tabs.findIndex((tab) => tab.id === active)
  let row: PaneTabWidth<T>[]
  if (activeIndex === -1 || activeIndex < fit) {
    row = tabs.slice(0, fit)
  } else {
    // Keep as many leading tabs as still fit beside the active one; it goes where they end.
    let keep = fit
    while (keep > 0 && span([...tabs.slice(0, keep), tabs[activeIndex]]) > budget + FIT_EPSILON) keep -= 1
    row = [...tabs.slice(0, keep), tabs[activeIndex]]
  }
  const shown = new Set(ids(row))
  return { row: ids(row), menu: ids(tabs.filter((tab) => !shown.has(tab.id))) }
}

/** The editor's width the Guide protects (mockup-onboarding-hifi-v2, state 34: 900px window, Files pane closed, 340px right pane). */
export const GUIDE_EDITOR_MIN_WIDTH = 560

/**
 * The narrow-window rule (ticket 07): with the Guide open (right pane open on the Guide tab), the Files
 * pane closes when the editor would be narrower than 560px with both panes open. The editor's width is
 * the window less the two panes; the rule only ever closes the Files pane, and does so once per
 * narrowing, so a person who opens it again is not fought.
 */
export const guideNeedsRoom = (input: { viewportWidth: number; leftWidth: number; rightWidth: number }): boolean =>
  input.viewportWidth - input.leftWidth - input.rightWidth < GUIDE_EDITOR_MIN_WIDTH

/** Drag-resize bounds for the left/right chrome panes — narrow enough to reclaim space, never so wide it
 *  starves the editor, never so narrow its tabs are unusable. */
const PANE_MIN = 200
const PANE_MAX = 560
function readPaneWidth(key: string, fallback: number): number {
  const stored = Number(localStorage.getItem(key))
  return Number.isFinite(stored) && stored >= PANE_MIN && stored <= PANE_MAX ? stored : fallback
}

export type PaneLayoutDeps = {
  /** App-domain side effects of opening a tab (mount its panel, arm its focus tick, …). Held in a ref
   *  inside the hook, so the open commands keep stable identities across renders. */
  onLeftTabOpened: (tab: LeftPaneTab) => void
  onRightTabOpened: (tab: RightPaneTab) => void
  /** The person has opened the Guide tab (the title-bar Guide button): it is last in the row. */
  guideShown?: boolean
}

export type PaneLayout = {
  leftTab: LeftPaneTab
  rightTab: RightPaneTab
  leftPaneCollapsed: boolean
  rightPaneCollapsed: boolean
  leftPaneWidth: number
  rightPaneWidth: number
  /** Open commands NEVER close (CH-1): they un-collapse the pane, switch to the tab, and fire the
   *  app-domain side effect. Collapse is only ever ⌘[/⌘] or the chevron. */
  openLeftTab: (tab: LeftPaneTab | 'open') => void
  openRightTab: (tab: RightPaneTab) => void
  cycleRightTab: (direction: 1 | -1, available: readonly RightPaneTab[]) => void
  toggleLeftPane: () => void
  toggleRightPane: () => void
  collapseLeftPane: () => void
  collapseRightPane: () => void
  startPaneResize: (side: 'left' | 'right') => (e: React.PointerEvent) => void
}

/**
 * The tabbed-panes chrome state (CH-1): which tab each pane shows, collapse, and drag-resizable widths
 * (persisted per browser, clamped). Pure UI-layout state — it knows nothing about what the tabs contain;
 * the app supplies that via the onTabOpened callbacks.
 */
export function usePaneLayout(deps: PaneLayoutDeps): PaneLayout {
  const [leftTab, setLeftTab] = useState<LeftPaneTab>(() => normaliseLeftPaneTab('files'))
  const [chosenRightTab, setChosenRightTab] = useState<RightPaneTab | null>(null)
  const rightTab = resolveRightPaneTab(chosenRightTab, deps.guideShown === true)
  const [leftPaneCollapsed, setLeftPaneCollapsed] = useState(false)
  const [rightPaneCollapsed, setRightPaneCollapsed] = useState(false)
  const [leftPaneWidth, setLeftPaneWidth] = useState<number>(() => readPaneWidth('wf:leftPaneWidth', 268))
  const [rightPaneWidth, setRightPaneWidth] = useState<number>(() => readPaneWidth('wf:rightPaneWidth', 340))

  const depsRef = useRef(deps)
  depsRef.current = deps
  const rightTabRef = useRef(rightTab)
  rightTabRef.current = rightTab

  const openLeftTab = useCallback((requested: LeftPaneTab | 'open') => {
    const tab = normaliseLeftPaneTab(requested)
    setLeftPaneCollapsed(false)
    setLeftTab(tab)
    depsRef.current.onLeftTabOpened(tab)
  }, [])
  const openRightTab = useCallback((tab: RightPaneTab) => {
    setRightPaneCollapsed(false)
    rightTabRef.current = tab
    setChosenRightTab(tab)
    depsRef.current.onRightTabOpened(tab)
  }, [])
  const cycleRightTab = useCallback((direction: 1 | -1, available: readonly RightPaneTab[]) => {
    const tab = nextRightPaneTab(rightTabRef.current, direction, available)
    openRightTab(tab)
  }, [openRightTab])
  const toggleLeftPane = useCallback(() => setLeftPaneCollapsed((isCollapsed) => !isCollapsed), [])
  const toggleRightPane = useCallback(() => setRightPaneCollapsed((isCollapsed) => !isCollapsed), [])
  const collapseLeftPane = useCallback(() => setLeftPaneCollapsed(true), [])
  const collapseRightPane = useCallback(() => setRightPaneCollapsed(true), [])

  // Drag a pane's inner-edge splitter to resize it. Dragging the LEFT pane's right edge rightwards widens
  // it; the RIGHT pane's left edge is mirrored. Width is tracked live during the drag and persisted on
  // release. Uses window listeners (not React DnD) so the drag survives the pointer leaving the 6px handle.
  const startPaneResize = useCallback(
    (side: 'left' | 'right') => (e: React.PointerEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const set = side === 'left' ? setLeftPaneWidth : setRightPaneWidth
      const startW = side === 'left' ? leftPaneWidth : rightPaneWidth
      const sign = side === 'left' ? 1 : -1
      let latest = startW
      const move = (ev: PointerEvent): void => {
        latest = Math.max(PANE_MIN, Math.min(PANE_MAX, startW + sign * (ev.clientX - startX)))
        set(latest)
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.style.cursor = ''
        try {
          localStorage.setItem(side === 'left' ? 'wf:leftPaneWidth' : 'wf:rightPaneWidth', String(Math.round(latest)))
        } catch {
          /* localStorage may be unavailable; the live width still applies for the session. */
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      document.body.style.cursor = 'col-resize'
    },
    [leftPaneWidth, rightPaneWidth],
  )

  return {
    leftTab,
    rightTab,
    leftPaneCollapsed,
    rightPaneCollapsed,
    leftPaneWidth,
    rightPaneWidth,
    openLeftTab,
    openRightTab,
    cycleRightTab,
    toggleLeftPane,
    toggleRightPane,
    collapseLeftPane,
    collapseRightPane,
    startPaneResize,
  }
}
