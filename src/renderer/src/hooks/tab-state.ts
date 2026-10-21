/**
 * Pure tab-state logic — no React, no DOM — so it can be unit-tested directly under bun
 * (tests/main/tab-state.test.ts) while `useTabs` stays a thin wrapper. The renderer persists one
 * TabState per workspace root and reconciles it against the live file list on load.
 */

export type TabState = { tabs: string[]; active: string | null; pinned: string[]; recent: string[] }

export const emptyTabState: TabState = { tabs: [], active: null, pinned: [], recent: [] }

function touchRecent(recent: string[], path: string): string[] {
  return [path, ...recent.filter((candidate) => candidate !== path)]
}

/** Reserved non-file tab. A URI scheme cannot collide with a workspace-relative file path. */
export const BOARD_TAB_ID = 'writeflex://board'

export function isBoardTabId(id: string | null): boolean {
  return id === BOARD_TAB_ID
}

/**
 * The Source and preview tab of a record browser (ticket 04b): one per document, named by the document it
 * belongs to, so it sits in that document's group on the strip. Never persisted: what it holds (a half-made
 * widget) is not restored by a relaunch.
 */
export const WIDGET_WORKBENCH_PREFIX = 'writeflex://widget-workbench/'
export const widgetWorkbenchTabId = (documentPath: string): string => `${WIDGET_WORKBENCH_PREFIX}${documentPath}`
export function isWidgetWorkbenchTabId(id: string | null): boolean {
  return id !== null && id.startsWith(WIDGET_WORKBENCH_PREFIX)
}
/** The document a workbench tab belongs to. */
export const workbenchDocumentOf = (id: string): string => id.slice(WIDGET_WORKBENCH_PREFIX.length)
/** A tab that is not a file: the Board or a widget workbench. File-owned code never sees these. */
export const isSurfaceTabId = (id: string | null): boolean => isBoardTabId(id) || isWidgetWorkbenchTabId(id)

/** localStorage key — one entry per workspace root so windows on different folders don't collide. */
export function tabStorageKey(root: string): string {
  return `writeflex:tabs:${root}`
}

/** Open (or focus) a path: append if new, then make it active. Idempotent on an already-open path. */
export function openTab(state: TabState, path: string): TabState {
  const tabs = state.tabs.includes(path) ? state.tabs : [...state.tabs, path]
  return { ...state, tabs, active: path, recent: touchRecent(state.recent, path) }
}

/** Replace the active browse slot with another document instead of growing the open-tab set. */
export function replaceActiveTab(state: TabState, path: string): TabState {
  if (state.active === null || state.active && state.pinned.includes(state.active)) return openTab(state, path)
  if (state.active === path) return state
  const activeIndex = state.tabs.indexOf(state.active)
  if (activeIndex === -1) return openTab(state, path)
  if (state.tabs.includes(path)) {
    return { ...state, tabs: state.tabs.filter((tab) => tab !== state.active), active: path, recent: touchRecent(state.recent.filter((tab) => tab !== state.active), path) }
  }
  const tabs = [...state.tabs]
  tabs[activeIndex] = path
  return { ...state, tabs, active: path, recent: touchRecent(state.recent.filter((tab) => tab !== state.active), path) }
}

/**
 * Close a path. If it was the active tab, focus its right neighbour (falling back to the left) as
 * editors conventionally do; closing the final tab leaves `active` null. A no-op for unknown paths.
 *
 * With a group resolver the neighbour is taken ON THE STRIP (the active file's group), so closing a
 * tab never silently swaps the strip to another group. When that closes the group's last tab, focus
 * passes to the most recently active remaining tab, whose group then takes the strip.
 */
export function closeTab(state: TabState, path: string, groupOf?: TabGroupOf): TabState {
  const idx = state.tabs.indexOf(path)
  if (idx === -1 || state.pinned.includes(path)) return state
  const tabs = state.tabs.filter((t) => t !== path)
  const recent = state.recent.filter((t) => t !== path)
  if (state.active !== path) return { ...state, tabs, recent }
  if (!groupOf) return { ...state, tabs, recent, active: tabs[idx] ?? tabs[idx - 1] ?? null }
  const onStrip = tabStripView(state, groupOf).strip.filter((candidate) => !state.pinned.includes(candidate))
  const at = onStrip.indexOf(path)
  const sibling = at === -1 ? undefined : onStrip[at + 1] ?? onStrip[at - 1]
  const next = sibling ?? recent.find((candidate) => !state.pinned.includes(candidate)) ?? recent[0] ?? tabs[0] ?? null
  return { ...state, tabs, recent, active: next }
}

export type CloseTabIntent = { kind: 'tab'; path: string } | { kind: 'window' }

/** macOS ⌘W closes the active document first; only an already-empty workspace closes its window. */
export function closeTabIntent(state: TabState): CloseTabIntent {
  return state.active ? { kind: 'tab', path: state.active } : { kind: 'window' }
}

/** Make an already-open path active; a no-op for paths that aren't open or already active. */
export function activateTab(state: TabState, path: string): TabState {
  if (state.active === path || !state.tabs.includes(path)) return state
  return { ...state, active: path, recent: touchRecent(state.recent, path) }
}

/**
 * Move focus to the next (dir 1) or previous (dir -1) tab, wrapping around the ends. `order` is the
 * ring to cycle — the strip's tabs (tabStripView().strip) in the app; every open tab by default.
 */
export function cycleTab(state: TabState, dir: 1 | -1, order: readonly string[] = state.tabs): TabState {
  const ring = order === state.tabs ? state.tabs : order.filter((path) => state.tabs.includes(path))
  if (ring.length === 0) return state
  const current = state.active ? ring.indexOf(state.active) : -1
  const from = current === -1 ? 0 : current
  const next = (from + dir + ring.length) % ring.length
  const active = ring[next]
  return { ...state, active, recent: touchRecent(state.recent, active) }
}

/** Pin state is durable tab state. Pins are statements, cap at four, and cannot reference closed tabs. */
export function pinTab(state: TabState, path: string, pinned: boolean): TabState {
  if (!state.tabs.includes(path)) return state
  if (pinned) {
    if (state.pinned.includes(path) || state.pinned.length >= 4) return state
    return { ...state, pinned: [...state.pinned, path] }
  }
  if (!state.pinned.includes(path)) return state
  return { ...state, pinned: state.pinned.filter((candidate) => candidate !== path) }
}

/** Reorder a pin inside the pinned zone (drag left/right). */
export function reorderPinnedTab(state: TabState, path: string, before: string | null): TabState {
  if (!state.pinned.includes(path)) return state
  const without = state.pinned.filter((candidate) => candidate !== path)
  const index = before === null ? without.length : without.indexOf(before)
  if (index === -1) return state
  const pinned = [...without.slice(0, index), path, ...without.slice(index)]
  return pinned.every((candidate, position) => candidate === state.pinned[position]) ? state : { ...state, pinned }
}

/**
 * A tab's group key: a workspace-relative folder ('' = the workspace root), or BOARD_TAB_ID for the
 * Board. Resolved in main (tab-groups.ts): nearest Folio, else nearest Index Note folder, else the
 * file's own folder. Derived, never stored in TabState.
 */
export type TabGroupOf = (path: string) => string

/** One folder group in the Open tabs list: its unpinned open tabs in open order. */
export type OpenTabGroup = { key: string; tabs: string[]; onStrip: boolean }

export type TabStripView = {
  /** The group on the strip — the active tab's, or when a pin is active the most recently active
   *  unpinned tab's (activating a pin never swaps the strip). Null when only pins are open. */
  group: string | null
  /** What the strip holds: pins in pin order, then the strip group's unpinned tabs in open order. */
  strip: string[]
  /** Open tabs → By folder: the strip group first, then every other group by last activity. */
  groups: OpenTabGroup[]
}

/**
 * The strip follows the open file (direction D). Pure: tab state plus a path→group resolver in, the
 * strip's ordered tabs and the Open-tabs grouping out. No tab is closed or reordered by a swap.
 */
export function tabStripView(state: TabState, groupOf: TabGroupOf): TabStripView {
  const open = new Set(state.tabs)
  const pinned = state.pinned.filter((path) => open.has(path))
  const pinnedSet = new Set(pinned)
  const unpinned = state.tabs.filter((path) => !pinnedSet.has(path))
  const unpinnedSet = new Set(unpinned)
  const keyOf = new Map(unpinned.map((path) => [path, groupOf(path)]))
  const byGroup = new Map<string, string[]>()
  for (const path of unpinned) {
    const key = keyOf.get(path) as string
    const members = byGroup.get(key)
    if (members) members.push(path)
    else byGroup.set(key, [path])
  }
  const order: string[] = []
  const seen = new Set<string>()
  const activity = state.active && unpinnedSet.has(state.active) ? [state.active, ...state.recent, ...unpinned] : [...state.recent, ...unpinned]
  for (const path of activity) {
    if (!unpinnedSet.has(path)) continue
    const key = keyOf.get(path) as string
    if (seen.has(key)) continue
    seen.add(key)
    order.push(key)
  }
  const group = order[0] ?? null
  const groups = order.map((key) => ({ key, tabs: byGroup.get(key) as string[], onStrip: key === group }))
  return { group, strip: [...pinned, ...(group === null ? [] : byGroup.get(group) as string[])], groups }
}

/** The own-folder fallback group of a path — used until main has resolved it. */
export function ownFolderGroup(path: string): string {
  if (isBoardTabId(path)) return BOARD_TAB_ID
  if (isWidgetWorkbenchTabId(path)) return ownFolderGroup(workbenchDocumentOf(path))
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/**
 * Heading labels for group keys: the folder name, or `parent / name` when the name alone is shared
 * by another listed group. '' is the workspace root; the Board sentinel reads "Board".
 */
export function tabGroupLabels(keys: readonly string[], rootName: string): Map<string, string> {
  const nameOf = (key: string): string => key === '' ? rootName : key.slice(key.lastIndexOf('/') + 1)
  const counts = new Map<string, number>()
  for (const key of keys) if (!isBoardTabId(key)) counts.set(nameOf(key), (counts.get(nameOf(key)) ?? 0) + 1)
  const labels = new Map<string, string>()
  for (const key of keys) {
    if (isBoardTabId(key)) {
      labels.set(key, 'Board')
      continue
    }
    const name = nameOf(key)
    const parts = key.split('/')
    labels.set(key, (counts.get(name) ?? 0) > 1 && parts.length > 1 ? `${parts[parts.length - 2]} / ${name}` : name)
  }
  return labels
}

export type TabStripFill = { visible: string[]; overflow: string[] }

/** Fill pinned → active → recents without ever shrinking a tab. The overflow control reserves space. */
export function tabStripFill(state: TabState, widths: ReadonlyMap<string, number>, available: number, overflowWidth: number): TabStripFill {
  const ordered = [...state.pinned]
  if (state.active && !ordered.includes(state.active)) ordered.push(state.active)
  for (const path of state.recent) if (state.tabs.includes(path) && !ordered.includes(path)) ordered.push(path)
  for (const path of state.tabs) if (!ordered.includes(path)) ordered.push(path)

  const visible: string[] = []
  let used = 0
  for (const path of ordered) {
    const width = widths.get(path) ?? 190
    const remainderAfter = ordered.length - (visible.length + 1)
    const reserve = remainderAfter > 0 ? overflowWidth : 0
    const gap = visible.length > 0 ? 2 : 0
    if (used + gap + width + reserve > available && !state.pinned.includes(path) && path !== state.active) break
    visible.push(path)
    used += gap + width
  }
  return { visible, overflow: ordered.filter((path) => !visible.includes(path)) }
}

/** Same ids in the same order. An equal re-measure of the strip must not schedule a render. */
export function sameTabList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, index) => path === b[index])
}

/**
 * Drop tabs whose file no longer exists in the workspace (renamed/deleted since last run) and
 * repair `active` if it pointed at a dropped tab. Returns the same reference when nothing is stale.
 */
export function reconcileTabs(state: TabState, knownPaths: Iterable<string>): TabState {
  const known = knownPaths instanceof Set ? new Set(knownPaths) : new Set(knownPaths)
  known.add(BOARD_TAB_ID)
  // A workbench tab stays while its document does (it is not a file, so the file list never names it).
  const tabs = state.tabs.filter((t) => known.has(t) || (isWidgetWorkbenchTabId(t) && known.has(workbenchDocumentOf(t))))
  const pinned = state.pinned.filter((t) => tabs.includes(t)).slice(0, 4)
  const recent = state.recent.filter((t) => tabs.includes(t))
  const activeOk = state.active === null || known.has(state.active) || (state.active !== null && isWidgetWorkbenchTabId(state.active) && known.has(workbenchDocumentOf(state.active)))
  if (tabs.length === state.tabs.length && pinned.length === state.pinned.length && recent.length === state.recent.length && activeOk) return state
  return { tabs, pinned, recent, active: activeOk ? state.active : tabs[0] ?? null }
}

/** Parse a persisted blob defensively; anything malformed collapses to the empty state. */
export function parseTabState(raw: string | null): TabState {
  if (!raw) return emptyTabState
  try {
    const value = JSON.parse(raw) as { tabs?: unknown; active?: unknown; pinned?: unknown; recent?: unknown }
    if (Array.isArray(value.tabs) && value.tabs.every((t) => typeof t === 'string')) {
      const tabs = (value.tabs as string[]).filter((t) => !isWidgetWorkbenchTabId(t))
      const active = typeof value.active === 'string' && tabs.includes(value.active) ? value.active : tabs[0] ?? null
      const pinned = Array.isArray(value.pinned) ? value.pinned.filter((t): t is string => typeof t === 'string' && tabs.includes(t)).slice(0, 4) : []
      const parsedRecent = Array.isArray(value.recent) ? value.recent.filter((t): t is string => typeof t === 'string' && tabs.includes(t)) : []
      const recent = [...parsedRecent, ...tabs.toReversed().filter((t) => !parsedRecent.includes(t))]
      return { tabs, active, pinned, recent }
    }
  } catch {
    // malformed JSON — fall through to the empty state
  }
  return emptyTabState
}

/** Serialize for localStorage. */
export function serializeTabState(state: TabState): string {
  return JSON.stringify(state)
}
