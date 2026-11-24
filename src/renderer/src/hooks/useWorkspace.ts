import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import type { MarkdownFile, WorkspaceContext } from '../../../preload'
import { patchedListing } from '../../../shared/listing-patch'

export type UseWorkspace = {
  /** `undefined` while the workspace context is in flight; `null` once fetched with no workspace
   *  bound; a string once a Workspace is open. Consumers must distinguish loading from empty so a
   *  workspace-bound boot never paints the start screen before the fetch resolves. */
  root: string | null | undefined
  files: MarkdownFile[]
  folders: string[]
  assetBaseUrl: string | null
  listingReady: boolean
  canRestoreTabsEarly: boolean
  refresh: () => Promise<void>
  /**
   * Answer a `collection:changed` push. Coalesce changes until the first listing is displayed.
   * After that, patch an own save in place when possible and re-list for other changes.
   */
  applyCollectionChange: (change: unknown) => void
}

type WorkspaceView = Omit<WorkspaceContext, 'root'> & {
  root: string | null | undefined
  files: MarkdownFile[]
  folders: string[]
  listingReady: boolean
}

/** The window publishes its root before walking the tree. The full listing can render in the
 * background while tab restoration and input use the same workspace. */
export function useWorkspace(): UseWorkspace {
  // Start with `root: undefined` (loading) so the very first render is a neutral frame, not the
  // start screen — the fetch below resolves it to a string (workspace) or null (genuinely none).
  const [state, setState] = useState<WorkspaceView>({
    root: undefined,
    files: [],
    folders: [],
    assetBaseUrl: null,
    canRestoreTabsEarly: false,
    listingReady: false,
  })
  const filesRef = useRef(state.files)
  filesRef.current = state.files
  const refreshesInFlight = useRef(0)
  const revision = useRef(0)
  const initialListing = useRef<{ changed: boolean } | null>(null)
  const refresh = useCallback(async (startup?: { changed: boolean }) => {
    // An explicit refresh can follow a user action that changed the root or needs a fresh listing.
    if (!startup) initialListing.current = null
    const request = ++revision.current
    refreshesInFlight.current += 1
    try {
      const view = await window.writeflex.getWorkspace()
      const publish = () => setState((current) => request === revision.current
        ? { ...view, listingReady: true, canRestoreTabsEarly: false }
        : current)
      if (startup) startTransition(publish)
      else publish()
    } catch (error) {
      if (initialListing.current === startup) initialListing.current = null
      throw error
    } finally {
      refreshesInFlight.current -= 1
    }
  }, [])
  const applyCollectionChange = useCallback((change: unknown) => {
    if (initialListing.current) {
      initialListing.current.changed = true
      return
    }
    if (refreshesInFlight.current > 0 || !patchedListing(filesRef.current, change)) {
      void refresh()
      return
    }
    // Patched against the listing React holds when the update runs. If a re-list landed in between and
    // no longer holds the path, that re-list already is the truth: keep it.
    setState((current) => {
      const next = patchedListing(current.files, change)
      return next ? { ...current, files: next } : current
    })
  }, [refresh])
  useEffect(() => {
    let live = true
    const request = ++revision.current
    void window.writeflex.getWorkspaceContext().then((context) => {
      if (!live || request !== revision.current) return
      setState((current) => ({ ...current, ...context, listingReady: context.root === null }))
      if (context.root !== null) {
        const startup = { changed: false }
        initialListing.current = startup
        void refresh(startup)
      }
    }).catch(() => { if (live && request === revision.current) void refresh() })
    return () => { live = false }
  }, [refresh])
  useEffect(() => {
    const startup = initialListing.current
    if (!state.listingReady || !startup) return
    // Wait for the transition to commit. Starting the follow-up earlier would invalidate its result.
    initialListing.current = null
    if (startup.changed) void refresh()
  }, [state.listingReady, refresh])
  return { ...state, refresh, applyCollectionChange }
}
