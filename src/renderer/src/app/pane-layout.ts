import { useCallback, useRef, useState } from 'react'
import { DOCK_WIDTH } from '../../../shared/scratchpad-layout'

export type LeftPaneTab = 'files' | 'outline' | 'search' | 'sync'

/**
 * Read a left-pane tab from anywhere it might have been stored. The open-tabs list left the sidebar
 * (ticket 14: it is a popover off the toolbar now), so a layout saved with `'open'` opens on Files,
 * as does anything unrecognised.
 */
export function normaliseLeftPaneTab(value: unknown): LeftPaneTab {
  return value === 'outline' || value === 'search' || value === 'files' || value === 'sync' ? value : 'files'
}
export type RightPaneTab = 'guide' | 'agent' | 'scratchpad' | 'versions' | 'research'

/**
 * The tabs that are always there, in the one order they ever appear (house rule R6, owner decision D1,
 * 2026-11-07): Versions (the default), Agent, Research. The Scratchpad joins only while it is docked
 * there and the Guide only while it is open; neither changes the order of these three.
 */
export const RIGHT_PANE_TABS: readonly RightPaneTab[] = ['versions', 'agent', 'research']

/** The tabs in the row now: the three standing ones, then the Scratchpad while docked, then the Guide while open. */
export const rightPaneTabsFor = (guideOpen: boolean, scratchpadDocked = false): readonly RightPaneTab[] => [
  ...RIGHT_PANE_TABS,
  ...(scratchpadDocked ? (['scratchpad'] as const) : []),
  ...(guideOpen ? (['guide'] as const) : []),
]

/**
 * The tab the right sidebar shows: the one the person chose, else Versions. A chosen Guide that is not open
 * (its tab was closed) or a chosen Scratchpad that is no longer docked falls back to Versions.
 */
export function resolveRightPaneTab(chosen: RightPaneTab | null, guideOpen: boolean, scratchpadDocked = true, fallback: RightPaneTab = 'versions'): RightPaneTab {
  if (chosen !== null && (chosen !== 'guide' || guideOpen) && (chosen !== 'scratchpad' || scratchpadDocked)) return chosen
  return fallback
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

/** R3: the editor keeps at least this share of the window; chrome gives way to protect it. */
export const EDITOR_MIN_SHARE = 0.55
/** R3: the width the left sidebar narrows to before it closes. */
export const LEFT_NARROW_WIDTH = 220

/** The most sidebar width (both together) that still leaves the editor 55%, in whole pixels. */
function chromeRoom(viewportWidth: number): number {
  let room = Math.ceil(viewportWidth * (1 - EDITOR_MIN_SHARE))
  while (room > 0 && (viewportWidth - room) / viewportWidth < EDITOR_MIN_SHARE) room--
  return room
}

/**
 * The widest the docked Scratchpad shows (R3, R7): the text keeps 55% of the window, and where both sidebars can be open the left
 * is left its narrowed 220 px, so docking never closes the left sidebar. The person may still drag wider, which closes it.
 */
export function scratchpadDockCap(viewportWidth: number, leftOpen: boolean): number {
  const leftKept = leftOpen && viewportWidth >= SIDEBARS_TAKE_TURNS_BELOW ? LEFT_NARROW_WIDTH : 0
  return Math.max(0, Math.min(viewportWidth * 0.6, chromeRoom(viewportWidth) - leftKept))
}

export type SidebarFit = { leftWidth: number; closeLeft: boolean; closeRight: boolean }

/**
 * The collapse order for a window too small for both sidebars (house rule R3, after chord labels hide and
 * title-bar labels become icons): with both open, the left narrows to 220 px first; if the editor still has less
 * than 55% of the width, one sidebar closes, the right first, and the left then keeps its own width if that fits
 * (Sol S5). A sidebar the person has just OPENED is never taken away again: when they opened the right, the left
 * closes instead. With one sidebar open, the left only narrows; nothing closes what the person chose to show.
 */
export function fitSidebars(input: { viewportWidth: number; leftWidth: number; rightWidth: number; leftOpen: boolean; rightOpen: boolean; lastOpened: 'left' | 'right' | null }): SidebarFit {
  const { viewportWidth: vw, leftWidth, rightWidth, leftOpen, rightOpen, lastOpened } = input
  const left = leftOpen ? leftWidth : 0
  const right = rightOpen ? rightWidth : 0
  const fits = (l: number, r: number): boolean => (vw - l - r) / vw >= EDITOR_MIN_SHARE
  if (vw <= 0 || fits(left, right)) return { leftWidth, closeLeft: false, closeRight: false }
  // The left gives up only what the editor needs, down to 220 px at most, so it keeps as much of its width as fits.
  const room = chromeRoom(vw) - (rightOpen ? rightWidth : 0)
  const narrow = Math.min(leftWidth, Math.max(LEFT_NARROW_WIDTH, room))
  if (leftOpen && rightOpen) {
    if (fits(narrow, rightWidth)) return { leftWidth: narrow, closeLeft: false, closeRight: false }
    if (lastOpened === 'right') return { leftWidth, closeLeft: true, closeRight: false }
    return { leftWidth: fits(leftWidth, 0) ? leftWidth : narrow, closeLeft: false, closeRight: true }
  }
  return { leftWidth: leftOpen ? narrow : leftWidth, closeLeft: false, closeRight: false }
}

/**
 * The sidebar the person last chose while the two took turns (Sol S4), kept across restarts. Only the person's
 * choice is stored; the automatic close of the other sidebar is not, so it is lent again at start.
 */
export type SidebarTurn = 'left' | 'right'
const SIDEBAR_TURN_KEY = 'wf:sidebarTurn'
export function readSidebarTurn(): SidebarTurn | null {
  try {
    const stored = localStorage.getItem(SIDEBAR_TURN_KEY)
    return stored === 'left' || stored === 'right' ? stored : null
  } catch {
    return null
  }
}
export function writeSidebarTurn(turn: SidebarTurn): void {
  try { localStorage.setItem(SIDEBAR_TURN_KEY, turn) } catch { /* the choice still holds for the session */ }
}
/**
 * The right sidebar's remembered state (house rule R6): it is closed when WriteFlex first opens, and after that the
 * person's own choice holds. Stored only when the person opens or closes it (the automatic close of the take-turns and
 * fit rules is a loan and is not stored). One key for the installation: the window's vault is not known when the page
 * starts, and the choice has to be read before the first paint.
 */
export type RightSidebarChoice = 'open' | 'closed'
const RIGHT_SIDEBAR_KEY = 'wf:rightSidebar'
export function readRightSidebarChoice(): RightSidebarChoice | null {
  try {
    const stored = localStorage.getItem(RIGHT_SIDEBAR_KEY)
    return stored === 'open' || stored === 'closed' ? stored : null
  } catch {
    return null
  }
}
export function writeRightSidebarChoice(choice: RightSidebarChoice): void {
  try { localStorage.setItem(RIGHT_SIDEBAR_KEY, choice) } catch { /* the choice still holds for the session */ }
}

/**
 * The sidebars at start: in a narrow window the chosen one is open and the other is lent (widening gives it back).
 * `rightChoice` is the person's remembered choice for the right sidebar (null = never chosen, so closed); left out,
 * the earlier behaviour (right open when it fits) applies.
 */
export function initialSidebars(narrow: boolean, turn: SidebarTurn | null, rightChoice?: RightSidebarChoice | null): { leftCollapsed: boolean; rightCollapsed: boolean; autoLeft: boolean; autoRight: boolean } {
  if (rightChoice !== undefined) {
    const wantsRight = rightChoice === 'open'
    if (!narrow) return { leftCollapsed: false, rightCollapsed: !wantsRight, autoLeft: false, autoRight: false }
    // The person's explicit right-sidebar choice wins over the older take-turns preference: the remembered turn applies only
    // when the right sidebar is wanted open (Sol S1).
    if (turn === 'right' && wantsRight) return { leftCollapsed: true, rightCollapsed: false, autoLeft: true, autoRight: false }
    // The right sidebar is lent only if the person had it open: a sidebar nobody opened has nothing to give back on widening.
    return { leftCollapsed: false, rightCollapsed: true, autoLeft: false, autoRight: wantsRight }
  }
  if (!narrow) return { leftCollapsed: false, rightCollapsed: false, autoLeft: false, autoRight: false }
  return turn === 'right'
    ? { leftCollapsed: true, rightCollapsed: false, autoLeft: true, autoRight: false }
    : { leftCollapsed: false, rightCollapsed: true, autoLeft: false, autoRight: true }
}

/** House rule R3 (TalkWeaver R17): below this window width the two sidebars take turns. */
export const SIDEBARS_TAKE_TURNS_BELOW = 1260

export type TurnsInput = { narrow: boolean; leftCollapsed: boolean; rightCollapsed: boolean; seenLeftCollapsed: boolean; seenRightCollapsed: boolean; autoLeft: boolean; autoRight: boolean }
export type TurnsResult = { closeLeft: boolean; closeRight: boolean; openLeft: boolean; openRight: boolean; autoLeft: boolean; autoRight: boolean }

/**
 * Sidebars take turns at narrow widths. Explicitly opening one closes the other, and the one closed this way is remembered
 * (`auto*`): it is a loan, not the person's choice, so widening the window gives it back. Opening an auto-closed sidebar by hand
 * clears the loan. Only width decides `narrow`, so a height-only resize never reverses anything.
 */
export function takeTurns(input: TurnsInput): TurnsResult {
  const { narrow, leftCollapsed, rightCollapsed } = input
  let autoLeft = input.autoLeft, autoRight = input.autoRight
  if (autoLeft && input.seenLeftCollapsed && !leftCollapsed) autoLeft = false
  if (autoRight && input.seenRightCollapsed && !rightCollapsed) autoRight = false
  const none = { closeLeft: false, closeRight: false, openLeft: false, openRight: false }
  if (!narrow) return { ...none, openLeft: autoLeft && leftCollapsed, openRight: autoRight && rightCollapsed, autoLeft: false, autoRight: false }
  if (leftCollapsed || rightCollapsed) return { ...none, autoLeft, autoRight }
  const openedRight = input.seenRightCollapsed && !rightCollapsed
  const openedLeft = input.seenLeftCollapsed && !leftCollapsed
  if (openedRight) return { ...none, closeLeft: true, autoLeft: true, autoRight }
  if (openedLeft) return { ...none, closeRight: true, autoRight: true, autoLeft }
  return { ...none, closeRight: true, autoRight: true, autoLeft }
}

export type SidebarPlanInput = {
  viewportWidth: number; leftWidth: number; rightWidth: number
  leftCollapsed: boolean; rightCollapsed: boolean; seenLeftCollapsed: boolean; seenRightCollapsed: boolean
  autoLeft: boolean; autoRight: boolean
}
export type SidebarPlan = TurnsResult & { seenLeftCollapsed: boolean; seenRightCollapsed: boolean; remember: SidebarTurn | null }

/**
 * One pass of the sidebar rules after a resize or an open or close (App runs it in an effect): sidebars take turns
 * below 1260 px; above, the fit planner closes one when narrowing the left is not enough (Sol S5). A sidebar the app
 * closed, for either reason, is a loan (`auto*`) and comes back on widening, once both fit; one the person closed is
 * not. `remember` is the person's choice while the two take turns, kept for the next start (Sol S4).
 */
export function planSidebars(input: SidebarPlanInput): SidebarPlan {
  const { viewportWidth, leftWidth, rightWidth, leftCollapsed, rightCollapsed, seenLeftCollapsed, seenRightCollapsed } = input
  const narrow = viewportWidth < SIDEBARS_TAKE_TURNS_BELOW
  const openedLeft = seenLeftCollapsed && !leftCollapsed
  const openedRight = seenRightCollapsed && !rightCollapsed
  const remember: SidebarTurn | null = narrow && openedRight ? 'right' : narrow && openedLeft ? 'left' : null
  let { closeLeft, closeRight, openLeft, openRight, autoLeft, autoRight } = takeTurns({ narrow, leftCollapsed, rightCollapsed, seenLeftCollapsed, seenRightCollapsed, autoLeft: input.autoLeft, autoRight: input.autoRight })
  if (!narrow) {
    const fit = (lastOpened: 'left' | 'right' | null) => fitSidebars({ viewportWidth, leftWidth, rightWidth, leftOpen: true, rightOpen: true, lastOpened })
    // A lent sidebar comes back only when both then fit; otherwise it stays lent for a wider window.
    if ((openLeft || openRight) && (!leftCollapsed || openLeft) && (!rightCollapsed || openRight) && fit(null).closeRight) {
      if (openRight) { openRight = false; autoRight = true }
      else if (openLeft && !rightCollapsed) { openLeft = false; autoLeft = true }
    }
    // Both open and the editor short of 55% even with the left narrowed: one closes, and is lent.
    if (!leftCollapsed && !rightCollapsed) {
      const planned = fit(openedRight ? 'right' : openedLeft ? 'left' : null)
      if (planned.closeLeft) { closeLeft = true; autoLeft = true }
      if (planned.closeRight) { closeRight = true; autoRight = true }
    }
  }
  return {
    closeLeft, closeRight, openLeft, openRight, autoLeft, autoRight, remember,
    seenLeftCollapsed: (leftCollapsed || closeLeft) && !openLeft,
    seenRightCollapsed: (rightCollapsed || closeRight) && !openRight,
  }
}

/** Drag-resize bounds for the left/right chrome panes — narrow enough to reclaim space, never so wide it
 *  starves the editor, never so narrow its tabs are unusable. */
const PANE_MIN = 200
const PANE_MAX = 560

/**
 * R3 applied to a drag: a sidebar can be dragged only as wide as leaves the editor 55% beside the other sidebar as
 * shown, so the fit planner never has to undo the drag (snap the left back to 220 px, or close the right mid-drag).
 */
export function paneDragBounds(input: { viewportWidth: number; otherShownWidth: number }): { min: number; max: number } {
  const room = chromeRoom(input.viewportWidth) - input.otherShownWidth
  return { min: PANE_MIN, max: Math.max(PANE_MIN, Math.min(PANE_MAX, room)) }
}

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
  /** The Scratchpad is actually docked, rather than floating or collapsed. */
  scratchpadDocked?: boolean
  viewportWidth?: number
  /** The tab shown until the person picks one (Versions, house rule R6). A test run that keeps the earlier shell passes Agent. */
  defaultRightTab?: RightPaneTab
  /** Which sidebars start closed (read once, at mount): the take-turns choice kept from the last run. */
  initialCollapsed?: { left: boolean; right: boolean }
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
  const rightTab = resolveRightPaneTab(chosenRightTab, deps.guideShown === true, deps.scratchpadDocked === true, deps.defaultRightTab)
  const [leftPaneCollapsed, setLeftPaneCollapsed] = useState(deps.initialCollapsed?.left === true)
  const [rightPaneCollapsed, setRightPaneCollapsed] = useState(deps.initialCollapsed?.right === true)
  const [leftPaneWidth, setLeftPaneWidth] = useState<number>(() => readPaneWidth('wf:leftPaneWidth', 268))
  const [ordinaryRightPaneWidth, setRightPaneWidth] = useState<number>(() => readPaneWidth('wf:rightPaneWidth', 340))
  const [scratchpadPaneWidth, setScratchpadPaneWidth] = useState<number>(() => readPaneWidth('wf:scratchpadPaneWidth', DOCK_WIDTH))
  const scratchpadDocked = rightTab === 'scratchpad' && deps.scratchpadDocked === true
  // The viewport limits the displayed dock, never the person's saved requested width.
  const rightPaneWidth = scratchpadDocked
    ? Math.min(scratchpadPaneWidth, scratchpadDockCap(deps.viewportWidth ?? window.innerWidth, !leftPaneCollapsed))
    : ordinaryRightPaneWidth

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
      // Capture the destination at pointer-down; switching tabs mid-drag must not redirect it.
      const resizingScratchpad = side === 'right' && scratchpadDocked
      const set = side === 'left' ? setLeftPaneWidth : resizingScratchpad ? setScratchpadPaneWidth : setRightPaneWidth
      const key = side === 'left' ? 'wf:leftPaneWidth' : resizingScratchpad ? 'wf:scratchpadPaneWidth' : 'wf:rightPaneWidth'
      // Start from the widths as shown (the left may be narrowed below its saved width), and stop where the editor
      // would drop below 55%, so the drag follows the pointer and nothing snaps back or closes.
      const viewportWidth = depsRef.current.viewportWidth ?? window.innerWidth
      const shownLeft = leftPaneCollapsed ? 0 : fitSidebars({ viewportWidth, leftWidth: leftPaneWidth, rightWidth: rightPaneWidth, leftOpen: true, rightOpen: !rightPaneCollapsed, lastOpened: null }).leftWidth
      const shownRight = rightPaneCollapsed ? 0 : rightPaneWidth
      // Widening the right first narrows the left (to 220 px at most, R3 order); widening the left never shrinks the right.
      const bounds = paneDragBounds({ viewportWidth, otherShownWidth: side === 'left' ? shownRight : Math.min(shownLeft, LEFT_NARROW_WIDTH) })
      const startW = side === 'left' ? shownLeft : rightPaneWidth
      const sign = side === 'left' ? 1 : -1
      let latest = resizingScratchpad ? scratchpadPaneWidth : startW
      const move = (ev: PointerEvent): void => {
        latest = Math.max(bounds.min, Math.min(bounds.max, startW + sign * (ev.clientX - startX)))
        set(latest)
      }
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        document.body.style.cursor = ''
        try {
          localStorage.setItem(key, String(Math.round(latest)))
        } catch {
          /* localStorage may be unavailable; the live width still applies for the session. */
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      document.body.style.cursor = 'col-resize'
    },
    [leftPaneWidth, rightPaneWidth, leftPaneCollapsed, rightPaneCollapsed, scratchpadDocked, scratchpadPaneWidth],
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
