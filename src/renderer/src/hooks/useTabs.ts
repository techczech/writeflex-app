import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MarkdownFile } from '../../../preload'
import {
  activateTab,
  BOARD_TAB_ID,
  closeTab,
  isWidgetWorkbenchTabId,
  workbenchDocumentOf,
  cycleTab,
  emptyTabState,
  openTab,
  type OpenTabGroup,
  parseTabState,
  pinTab,
  reconcileTabs,
  reorderPinnedTab,
  replaceActiveTab,
  serializeTabState,
  tabStorageKey,
  tabStripView,
  type TabState,
} from './tab-state'
import { useTabGroups } from './useTabGroups'

export type UseTabs = {
  tabs: string[]
  active: string | null
  pinned: string[]
  recent: string[]
  /** What the top strip holds: pins, then the active file's group (tabStripView). */
  strip: string[]
  /** Open tabs → By folder: the strip group first, then the rest by last activity (pins excluded). */
  groups: OpenTabGroup[]
  open: (path: string) => void
  replaceActive: (path: string) => void
  renamed: (from: string, to: string) => void
  close: (path: string) => void
  activate: (path: string) => void
  cycle: (dir: 1 | -1) => void
  pin: (path: string, pinned: boolean) => void
  reorderPin: (path: string, before: string | null) => void
}

/**
 * React wrapper over the pure tab-state logic (tab-state.ts). Persists {tabs, active} per workspace
 * root in localStorage and reconciles saved paths against disk. The first bound window can
 * check just those paths while the Collection's full listing is still being built.
 *
 * `root`/`files` are ARGUMENTS, fed from App's single `useWorkspace` — never a private instance.
 * A private instance pulls `workspace:get` once on mount and never again, so a window that binds
 * its Workspace after mount (start screen → Open dialog / Open Recent refreshes only App's
 * instance) would leave this hook rootless forever: no hydration, and the pre-hydration guard
 * below would swallow every open() (fix wave 1). One workspace source, one truth.
 */
export function useTabs(root: string | null | undefined, files: MarkdownFile[], listingReady: boolean, canRestoreTabsEarly: boolean, boardDir = '', keepTab: (path: string) => boolean = () => false, onRestored?: (path: string) => void): UseTabs {
  // A tab whose file left the tree is kept while `keepTab` says so (its buffer holds unsaved text that the
  // writer has to resolve: review round 1, Sol S6). Read when the file list changes.
  const restoredRef = useRef(onRestored)
  restoredRef.current = onRestored
  const keepTabRef = useRef(keepTab)
  keepTabRef.current = keepTab
  const [state, setState] = useState<TabState>(emptyTabState)
  // The root whose persisted tab state has been hydrated into `state`. Hydration keys on root
  // transitions: null/undefined → string on bind, and string → different string re-hydrates from
  // the new root's storage key (with file-list reconciliation) so stale tabs never carry across.
  const loadedRoot = useRef<string | null>(null)
  // open() can't read the `root` prop (stable callback, stale closure), so mirror it in a ref.
  const rootRef = useRef(root)
  rootRef.current = root
  // The hydration setState below and this render's persist effect commit together; without this
  // guard the persist effect would write the still-empty pre-hydration state back over storage.
  const skipPersist = useRef(false)
  // A file-open focus or a held chord can arrive before hydration. Fold the last requested
  // path into the state for this root so restoring the saved tabs cannot wipe out the request.
  const pendingOpen = useRef<string | null>(null)
  // The strip follows the open file: groups are derived in main from each tab's path and never
  // stored, so the persisted TabState is exactly what it was before direction D.
  const groupOf = useTabGroups(root, state.tabs, files, boardDir)
  const groupOfRef = useRef(groupOf)
  groupOfRef.current = groupOf
  const view = useMemo(() => tabStripView(state, groupOf), [state, groupOf])

  useEffect(() => {
    if (typeof root !== 'string') return
    if (loadedRoot.current === root) {
      if (listingReady) {
        // Same workspace, file list changed (create/delete/rename) — prune any now-stale tabs.
        const known = files.map(file => file.path)
        setState((prev) => reconcileTabs(prev, [...known, ...prev.tabs.filter(tab => keepTabRef.current(tab))]))
      }
      return
    }

    const saved = parseTabState(localStorage.getItem(tabStorageKey(root)))
    const hydrate = (known: Set<string>, inEffect: boolean): void => {
      loadedRoot.current = root
      skipPersist.current = inEffect
      const hydrated = reconcileTabs(saved, known)
      const queued = pendingOpen.current
      pendingOpen.current = null
      if (queued !== null && (known.has(queued) || queued === BOARD_TAB_ID
        || (isWidgetWorkbenchTabId(queued) && known.has(workbenchDocumentOf(queued))))) {
        setState(openTab(hydrated, queued))
      } else {
        setState(hydrated)
        if (hydrated.active) restoredRef.current?.(hydrated.active)
      }
    }
    if (listingReady) {
      hydrate(new Set(files.map(file => file.path)), true)
      return
    }
    if (!canRestoreTabsEarly) return

    let live = true
    const documentPath = (path: string): string => isWidgetWorkbenchTabId(path) ? workbenchDocumentOf(path) : path
    const restore = async (): Promise<void> => {
      const paths = new Set(saved.tabs.filter(path => path !== BOARD_TAB_ID).map(documentPath))
      const queued = pendingOpen.current
      if (queued !== null && queued !== BOARD_TAB_ID) paths.add(documentPath(queued))
      const known = new Set(paths.size ? await window.writeflex.checkStartupTabs(root, [...paths]) : [])
      // A focus arriving during the checks is still entitled to open. If it wasn't checked, the
      // full listing will validate it and finish hydration.
      const latest = pendingOpen.current
      if (!live || (latest !== null && latest !== BOARD_TAB_ID && !paths.has(documentPath(latest)))) return
      hydrate(known, paths.size === 0)
    }
    void restore().catch(() => { /* Fall back to hydration from the full listing. */ })
    return () => { live = false }
  }, [root, files, listingReady, canRestoreTabsEarly])

  useEffect(() => {
    if (typeof root !== 'string' || loadedRoot.current !== root) return
    if (skipPersist.current) {
      skipPersist.current = false
      return
    }
    localStorage.setItem(tabStorageKey(root), serializeTabState(state))
  }, [root, state])

  const open = useCallback((path: string) => {
    if (typeof rootRef.current !== 'string' || loadedRoot.current !== rootRef.current) {
      pendingOpen.current = path // pre-hydration (see above): applied when this root hydrates
      return
    }
    setState((s) => openTab(s, path))
  }, [])
  const replaceActive = useCallback((path: string) => setState((s) => replaceActiveTab(s, path)), [])
  const renamed = useCallback((from: string, to: string) => setState((state) => {
    const move = (path: string) => path === from ? to : path
    const paths = (items: string[]) => [...new Set(items.map(move))]
    return { tabs: paths(state.tabs), active: state.active && move(state.active), pinned: paths(state.pinned), recent: paths(state.recent) }
  }), [])
  // ⌘W focuses a neighbour ON THE STRIP; an emptied group hands the strip to the most recent other one.
  const close = useCallback((path: string) => setState((s) => closeTab(s, path, groupOfRef.current)), [])
  const activate = useCallback((path: string) => setState((s) => activateTab(s, path)), [])
  // ⌃⇥ / ⇧⌘] cycle only the tabs on the strip.
  const cycle = useCallback((dir: 1 | -1) => setState((s) => cycleTab(s, dir, tabStripView(s, groupOfRef.current).strip)), [])
  const pin = useCallback((path: string, pinned: boolean) => setState((s) => pinTab(s, path, pinned)), [])
  const reorderPin = useCallback((path: string, before: string | null) => setState((s) => reorderPinnedTab(s, path, before)), [])

  return { tabs: state.tabs, active: state.active, pinned: state.pinned, recent: state.recent, strip: view.strip, groups: view.groups, open, replaceActive, renamed, close, activate, cycle, pin, reorderPin }
}
