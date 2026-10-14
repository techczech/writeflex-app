import { useCallback, useEffect, useRef, useState } from 'react'
import type { FolderFocus } from '../../../preload'

export type UseFolderFocus = {
  /** The folder focused in this window, with its kind; null = the whole archive. */
  focus: FolderFocus | null
  /** Focus a workspace-relative folder, or clear with null. Main validates and persists. */
  setFocus: (path: string | null) => void
}

/**
 * Folder focus over the preload bridge (ticket 03). Main owns the value — it lives on the window's
 * state and is persisted on the root's recents entry, so it survives a relaunch — and this hook only
 * mirrors it. It loads when a root resolves, and re-asks main when the focused folder drops out of
 * the folder list (deleted or renamed) or a Collection changes (a manifest or cover can change the
 * kind); main clears a focus whose folder has gone.
 */
export function useFolderFocus(root: string | null | undefined, folders: readonly string[]): UseFolderFocus {
  const [state, setState] = useState<{ root: string | null; focus: FolderFocus | null }>({ root: null, focus: null })
  const request = useRef(0)
  const focus = state.root === root ? state.focus : null

  const load = useCallback((forRoot: string) => {
    const id = ++request.current
    window.writeflex.getFolderFocus().then(
      (next) => { if (id === request.current) setState({ root: forRoot, focus: next }) },
      () => {},
    )
  }, [])

  useEffect(() => {
    if (typeof root !== 'string') return
    load(root)
  }, [root, load])

  const focusPath = focus?.path ?? null
  const missing = focusPath !== null && !folders.includes(focusPath)
  useEffect(() => {
    if (typeof root === 'string' && missing) load(root)
  }, [root, missing, load])

  useEffect(() => {
    if (typeof root !== 'string' || focusPath === null) return
    return window.writeflex.onCollectionChanged?.(() => load(root))
  }, [root, focusPath, load])

  const setFocus = useCallback((path: string | null) => {
    if (typeof root !== 'string') return
    const id = ++request.current
    // Clearing is applied at once, so a reveal in the same gesture finds its row in the whole tree;
    // a new focus waits for main, which validates it and says what kind of folder it is.
    if (path === null) setState({ root, focus: null })
    window.writeflex.setFolderFocus(path).then(
      (next) => { if (id === request.current) setState({ root, focus: next }) },
      () => {},
    )
  }, [root])

  return { focus, setFocus }
}
