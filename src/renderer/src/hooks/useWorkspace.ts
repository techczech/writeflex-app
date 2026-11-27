import { startTransition, useCallback, useEffect, useReducer, useRef } from 'react'
import type { MarkdownFile } from '../../../preload'
import { patchedListing } from '../../../shared/listing-patch'

export type UseWorkspace = {
  /** `undefined` until we know the workspace, `null` for an accepted unbound window, or a root. */
  root: string | null | undefined
  files: MarkdownFile[]
  folders: string[]
  assetBaseUrl: string | null
  /** The window has accepted a listing (including an empty one) or is confirmed unbound. */
  listingReady: boolean
  /** The latest read failed. A previously accepted listing is still usable. */
  listingFailed: boolean
  canRestoreTabsEarly: boolean
  refresh: () => Promise<void>
  refreshInBackground: () => void
  retryListing: () => void
  /**
   * Answer a `collection:changed` push. Coalesce changes until the first listing is displayed.
   * After that, patch an own save in place when possible and re-list for other changes.
   */
  applyCollectionChange: (change: unknown) => void
}

type WorkspaceView = Pick<UseWorkspace, 'root' | 'files' | 'folders' | 'assetBaseUrl' | 'listingReady' | 'listingFailed' | 'canRestoreTabsEarly'>
type WorkspaceUpdate = (current: WorkspaceView) => WorkspaceView

/** The window publishes its root before walking the tree. The full listing can render in the
 * background while tab restoration and input use the same workspace. */
export function useWorkspace(): UseWorkspace {
  const [state, dispatch] = useReducer((current: WorkspaceView, update: WorkspaceUpdate) => update(current), {
    root: undefined,
    files: [],
    folders: [],
    assetBaseUrl: null,
    canRestoreTabsEarly: false,
    listingReady: false,
    listingFailed: false,
  } satisfies WorkspaceView)
  const filesRef = useRef(state.files)
  filesRef.current = state.files
  const mounted = useRef(false)
  const revision = useRef(0)
  const refreshesInFlight = useRef(0)
  const initialListing = useRef<{ changed: boolean } | null>(null)

  const publish = useCallback((request: number, update: WorkspaceUpdate) => {
    if (!mounted.current || request !== revision.current) return
    // The reducer checks again when React renders a queued transition.
    dispatch(current => request === revision.current ? update(current) : current)
  }, [])

  const readListing = useCallback(async (request: number, defer: boolean) => {
    if (!mounted.current || request !== revision.current) return
    refreshesInFlight.current += 1
    try {
      const view = await window.writeflex.getWorkspace()
      const accept = () => publish(request, () => ({
        ...view, listingReady: true, listingFailed: false, canRestoreTabsEarly: false,
      }))
      if (defer) startTransition(accept)
      else accept()
    } catch (error) {
      if (request === revision.current) initialListing.current = null
      publish(request, current => ({
        ...current,
        // A launch from the start screen may have bound a root before its listing failed.
        ...(current.root === null ? { root: undefined, listingReady: false } : {}),
        listingFailed: true,
      }))
      throw error
    } finally {
      refreshesInFlight.current -= 1
    }
  }, [publish])

  const refresh = useCallback(() => readListing(++revision.current, false), [readListing])
  const refreshInBackground = useCallback(() => { void refresh().catch(() => {}) }, [refresh])
  const retryListing = useCallback(() => {
    const request = ++revision.current
    const first = !state.listingReady
    if (first) initialListing.current = { changed: false }
    publish(request, current => ({ ...current, listingFailed: false }))
    void readListing(request, first).catch(() => {})
  }, [publish, readListing, state.listingReady])

  const applyCollectionChange = useCallback((change: unknown) => {
    if (!mounted.current) return
    if (initialListing.current) {
      initialListing.current.changed = true
      return
    }
    if (refreshesInFlight.current > 0 || !patchedListing(filesRef.current, change)) {
      refreshInBackground()
      return
    }
    // Patch the listing React holds when this runs. An accepted re-list may have removed the path.
    dispatch((current) => {
      const next = patchedListing(current.files, change)
      return next ? { ...current, files: next } : current
    })
  }, [refreshInBackground])

  useEffect(() => {
    mounted.current = true
    const request = ++revision.current
    const readStartup = async (): Promise<void> => {
      // A full listing can recover the root if the lightweight context read failed.
      const context = await window.writeflex.getWorkspaceContext().catch(() => null)
      if (request !== revision.current) return
      if (context) {
        publish(request, current => ({
          ...current, ...context, listingReady: context.root === null, listingFailed: false,
        }))
        if (context.root === null) return
      }
      initialListing.current = { changed: false }
      await readListing(request, context !== null)
    }
    void readStartup().catch(() => {})
    return () => {
      mounted.current = false
      revision.current += 1
      initialListing.current = null
    }
  }, [publish, readListing])

  useEffect(() => {
    const startup = initialListing.current
    if (!state.listingReady || !startup) return
    // Wait for the transition to commit. Starting the follow-up earlier would invalidate its result.
    initialListing.current = null
    if (startup.changed) refreshInBackground()
  }, [state.listingReady, refreshInBackground])

  return { ...state, refresh, refreshInBackground, retryListing, applyCollectionChange }
}
