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
  close: (path: string) => void
  activate: (path: string) => void
  cycle: (dir: 1 | -1) => void
  pin: (path: string, pinned: boolean) => void
  reorderPin: (path: string, before: string | null) => void
}

/**
 * React wrapper over the pure tab-state logic (tab-state.ts). Persists {tabs, active} per workspace
 * root in localStorage and, on first resolve of a workspace root, reconciles the persisted set
 * against the live file list so tabs for files deleted/renamed since last run drop out.
 *
 * `root`/`files` are ARGUMENTS, fed from App's single `useWorkspace` — never a private instance.
 * A private instance pulls `workspace:get` once on mount and never again, so a window that binds
 * its Workspace after mount (start screen → Open dialog / Open Recent refreshes only App's
 * instance) would leave this hook rootless forever: no hydration, and the pre-hydration guard
 * below would swallow every open() (fix wave 1). One workspace source, one truth.
 */
export function useTabs(root: string | null | undefined, files: MarkdownFile[], boardDir = '', keepTab: (path: string) => boolean = () => false): UseTabs {
  // A tab whose file left the tree is kept while `keepTab` says so (its buffer holds unsaved text that the
  // writer has to resolve: review round 1, Sol S6). Read when the file list changes.
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
  // An open() can arrive BEFORE hydration: a file-open focus (workspace:focus-file) is flushed by
  // main during the first workspace:get pull, ahead of the reply that resolves root/files (Task 6,
  // T2 seam) — and a post-mount bind has the same shape (root not yet a string, or hydration for
  // the current root not yet applied). Opening into the pre-hydration state would be wiped by
  // hydration's replacing setState, so open() stashes the path and the hydration for the CURRENT
  // root folds it into the reconciled state instead.
  const pendingOpen = useRef<string | null>(null)
  // The strip follows the open file: groups are derived in main from each tab's path and never
  // stored, so the persisted TabState is exactly what it was before direction D.
  const groupOf = useTabGroups(root, state.tabs, files, boardDir)
  const groupOfRef = useRef(groupOf)
  groupOfRef.current = groupOf
  const view = useMemo(() => tabStripView(state, groupOf), [state, groupOf])

  useEffect(() => {
    if (typeof root !== 'string') return
    const known = files.map((f) => f.path)
    if (loadedRoot.current !== root) {
      loadedRoot.current = root
      skipPersist.current = true
      const hydrated = reconcileTabs(parseTabState(localStorage.getItem(tabStorageKey(root))), known)
      const queued = pendingOpen.current
      pendingOpen.current = null
      // Same containment contract as reconcileTabs (which also admits BOARD_TAB_ID): never open a path
      // the file list doesn't hold — but the Board sentinel is a valid non-file tab, so a pre-hydration
      // ⇧⌘B (queued before this root loaded) must replay, not be silently dropped.
      const openable = queued !== null && (known.includes(queued) || queued === BOARD_TAB_ID || (isWidgetWorkbenchTabId(queued) && known.includes(workbenchDocumentOf(queued))))
      setState(openable ? openTab(hydrated, queued as string) : hydrated)
    } else {
      // Same workspace, file list changed (create/delete/rename) — prune any now-stale tabs.
      setState((prev) => reconcileTabs(prev, [...known, ...prev.tabs.filter((tab) => keepTabRef.current(tab))]))
    }
  }, [root, files])

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
  // ⌘W focuses a neighbour ON THE STRIP; an emptied group hands the strip to the most recent other one.
  const close = useCallback((path: string) => setState((s) => closeTab(s, path, groupOfRef.current)), [])
  const activate = useCallback((path: string) => setState((s) => activateTab(s, path)), [])
  // ⌃⇥ / ⇧⌘] cycle only the tabs on the strip.
  const cycle = useCallback((dir: 1 | -1) => setState((s) => cycleTab(s, dir, tabStripView(s, groupOfRef.current).strip)), [])
  const pin = useCallback((path: string, pinned: boolean) => setState((s) => pinTab(s, path, pinned)), [])
  const reorderPin = useCallback((path: string, before: string | null) => setState((s) => reorderPinnedTab(s, path, before)), [])

  return { tabs: state.tabs, active: state.active, pinned: state.pinned, recent: state.recent, strip: view.strip, groups: view.groups, open, replaceActive, close, activate, cycle, pin, reorderPin }
}
