import { useCallback, useEffect, useRef, useState } from 'react'
import type { MarkdownFile } from '../../../preload'
import { patchedListing } from '../../../shared/listing-patch'

export type UseWorkspace = {
  /** `undefined` while the first `workspace:get` is in flight; `null` once fetched with no workspace
   *  bound; a string once a Workspace is open. Consumers must distinguish loading from empty so a
   *  workspace-bound boot never paints the start screen before the fetch resolves. */
  root: string | null | undefined
  files: MarkdownFile[]
  folders: string[]
  assetBaseUrl: string | null
  refresh: () => Promise<void>
  /**
   * Answer a `collection:changed` push: an own save in place patches that one listing entry
   * (shared/listing-patch.ts); anything else — a patch that does not fit the listing, or one arriving
   * while a re-list is in flight (whose answer may predate the save) — re-lists through `refresh`.
   */
  applyCollectionChange: (change: unknown) => void
}

type WorkspaceView = { root: string | null | undefined; files: MarkdownFile[]; folders: string[]; assetBaseUrl: string | null }

/**
 * Workspace view over the preload bridge. The initial `workspace:get` pull also flushes any
 * queued file-open focus in main (see ipc.ts) — later tasks subscribe to `onFocusFile` before
 * calling refresh.
 */
export function useWorkspace(): UseWorkspace {
  // Start with `root: undefined` (loading) so the very first render is a neutral frame, not the
  // start screen — the fetch below resolves it to a string (workspace) or null (genuinely none).
  const [state, setState] = useState<WorkspaceView>({
    root: undefined,
    files: [],
    folders: [],
    assetBaseUrl: null,
  })
  const filesRef = useRef(state.files)
  filesRef.current = state.files
  const refreshesInFlight = useRef(0)
  const refresh = useCallback(async () => {
    refreshesInFlight.current += 1
    try {
      setState(await window.writeflex.getWorkspace())
    } finally {
      refreshesInFlight.current -= 1
    }
  }, [])
  const applyCollectionChange = useCallback((change: unknown) => {
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
    void refresh()
  }, [refresh])
  return { root: state.root, files: state.files, folders: state.folders, assetBaseUrl: state.assetBaseUrl, refresh, applyCollectionChange }
}
