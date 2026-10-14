import { useEffect, useState } from 'react'
import type { MarkdownFile, SourceFile } from '../../../preload'

/**
 * The window's Sources view over the preload bridge (Task 21, PRD S30): reference material under
 * research/, surfaced beside Scratchpad. Lists on the workspace bind and re-lists whenever the workspace
 * file list is re-pulled (`files` reference changes on every refresh — an agent create, a save, or a
 * scraps mutation), so a new research/ file surfaces on the same beat the tree refreshes. Returns []
 * with no workspace bound, so the pane keeps its designed empty state.
 */
export function useSources(root: string | null | undefined, files: MarkdownFile[]): SourceFile[] {
  const [sources, setSources] = useState<SourceFile[]>([])

  useEffect(() => {
    if (!root) {
      setSources([])
      return
    }
    let cancelled = false
    void window.writeflex
      .listSources()
      .then((next) => {
        if (!cancelled) setSources(next)
      })
      .catch(() => {
        /* no workspace bound yet — the pane keeps its designed empty state */
      })
    return () => {
      cancelled = true
    }
    // `files` is the refresh signal: its reference changes each time the tree is re-pulled.
  }, [root, files])

  return sources
}
