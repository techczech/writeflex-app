import { useCallback, useEffect, useRef, useState } from 'react'
import type { Scrap } from '../../../preload'

export type UseScraps = {
  /** Every scrap across the workspace's SCRAPS.md files, in file then document order. */
  scraps: Scrap[]
  /** Cut text into the origin document's scraps file (⌘⇧X routes here with the active file). */
  add: (origin: string, text: string) => Promise<Scrap | null>
  toggleDone: (id: string) => void
  setColour: (id: string, colour: string | null) => void
  /** Remove a scrap; returns it so a drag-into-document can insert the text it carried. */
  remove: (id: string) => Promise<Scrap | null>
}

/**
 * The window's Scratchpad view over the preload bridge (Task 20, ADR-0008). Lists on the first workspace
 * bind and re-lists on every `scraps:changed` push — so a mutation from this window (or, later, the
 * agent) re-renders the pane. Mutations write through main and let the push drive the refresh, which
 * keeps the pane and the editor's expansion map reading one source of truth. `onChanged` lets App
 * refresh the file tree in the same beat (scraps/ appears on the first cut).
 */
export function useScraps(root: string | null | undefined, onChanged?: () => void): UseScraps {
  const [scraps, setScraps] = useState<Scrap[]>([])
  const rootRef = useRef(root)
  rootRef.current = root
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  const reload = useCallback(() => {
    if (!rootRef.current) return
    void window.writeflex
      .listScraps()
      .then(setScraps)
      .catch(() => {
        /* no workspace bound yet — the pane keeps its designed empty state */
      })
  }, [])

  useEffect(() => {
    if (!root) {
      setScraps([])
      return
    }
    reload()
  }, [root, reload])

  // A mutation landed (this window's write, or the agent's in Task 24): re-list and let App refresh
  // the file tree so scraps/ surfaces the moment the first cutting is stored.
  useEffect(
    () =>
      window.writeflex.onScrapsChanged(() => {
        reload()
        onChangedRef.current?.()
      }),
    [reload],
  )

  const add = useCallback(async (origin: string, text: string) => {
    try {
      return await window.writeflex.addScrap(origin, text)
    } catch {
      return null
    }
  }, [])
  const toggleDone = useCallback((id: string) => {
    void window.writeflex.toggleScrapDone(id).catch(() => {})
  }, [])
  const setColour = useCallback((id: string, colour: string | null) => {
    void window.writeflex.setScrapColour(id, colour).catch(() => {})
  }, [])
  const remove = useCallback(async (id: string) => {
    try {
      return await window.writeflex.removeScrap(id)
    } catch {
      return null
    }
  }, [])

  return { scraps, add, toggleDone, setColour, remove }
}
