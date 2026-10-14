import { useCallback, useEffect, useState } from 'react'
import type { MarkdownFile } from '../../../preload'

export type UseWorkspace = {
  /** `undefined` while the first `workspace:get` is in flight; `null` once fetched with no workspace
   *  bound; a string once a Workspace is open. Consumers must distinguish loading from empty so a
   *  workspace-bound boot never paints the start screen before the fetch resolves. */
  root: string | null | undefined
  files: MarkdownFile[]
  folders: string[]
  assetBaseUrl: string | null
  refresh: () => Promise<void>
}

/**
 * Workspace view over the preload bridge. The initial `workspace:get` pull also flushes any
 * queued file-open focus in main (see ipc.ts) — later tasks subscribe to `onFocusFile` before
 * calling refresh.
 */
export function useWorkspace(): UseWorkspace {
  // Start with `root: undefined` (loading) so the very first render is a neutral frame, not the
  // start screen — the fetch below resolves it to a string (workspace) or null (genuinely none).
  const [state, setState] = useState<{ root: string | null | undefined; files: MarkdownFile[]; folders: string[]; assetBaseUrl: string | null }>({
    root: undefined,
    files: [],
    folders: [],
    assetBaseUrl: null,
  })
  const refresh = useCallback(async () => {
    setState(await window.writeflex.getWorkspace())
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { root: state.root, files: state.files, folders: state.folders, assetBaseUrl: state.assetBaseUrl, refresh }
}
