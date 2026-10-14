import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MarkdownFile } from '../../../preload'
import { isBoardTabId, ownFolderGroup, type TabGroupOf } from './tab-state'

/**
 * The path→group resolver the strip is derived from. Main resolves each open tab's group (nearest
 * Folio → nearest Index Note folder → own folder) over `tabs:groups`. Until a newly opened tab's
 * answer arrives it borrows what is already known — a sibling's group (a group depends only on the
 * folder), else the nearest known Folio/Index Note group above it, else its own folder — so opening a
 * file inside the project on the strip does not flash the strip to a one-tab group for a frame.
 * Re-resolves when the tab set, the file list (a cover created or removed) or a Collection (a
 * manifest written) changes. Holds no durable state.
 */
export function useTabGroups(root: string | null | undefined, tabs: readonly string[], files: readonly MarkdownFile[], boardDir = ''): TabGroupOf {
  const [resolved, setResolved] = useState<{ root: string | null; groups: Readonly<Record<string, string>> }>({ root: null, groups: {} })
  const [collectionTick, setCollectionTick] = useState(0)
  const request = useRef(0)
  // The Board tab joins its Collection folder's group, asked for as a folder path (`dir/`).
  const boardKey = boardDir !== '' && tabs.some(isBoardTabId) ? `${boardDir}/` : null
  const tabKey = [...tabs.filter((path) => !isBoardTabId(path)), ...(boardKey ? [boardKey] : [])].join('\n')

  useEffect(() => window.writeflex.onCollectionChanged?.(() => setCollectionTick((tick) => tick + 1)), [])

  useEffect(() => {
    if (typeof root !== 'string' || tabKey === '' || typeof window.writeflex.resolveTabGroups !== 'function') return
    const id = ++request.current
    window.writeflex.resolveTabGroups(tabKey.split('\n')).then(
      (groups) => { if (id === request.current) setResolved({ root, groups }) },
      () => {}, // no workspace bound yet, or a transient read failure: own-folder fallback stands
    )
  }, [root, tabKey, files, collectionTick])

  const groups = resolved.root === root ? resolved.groups : null
  const known = useMemo(() => {
    const byFolder = new Map<string, string>()
    const enclosing = new Set<string>() // groups that came from a Folio or Index Note above a tab
    for (const [path, group] of Object.entries(groups ?? {})) {
      const own = ownFolderGroup(path)
      byFolder.set(own, group)
      if (group !== own) enclosing.add(group)
    }
    return { byFolder, enclosing }
  }, [groups])
  return useCallback((path: string) => {
    const board = isBoardTabId(path)
    const answer = groups?.[board ? `${boardDir}/` : path]
    if (answer !== undefined) return answer
    const own = board ? boardDir : ownFolderGroup(path)
    const sibling = known.byFolder.get(own)
    if (sibling !== undefined) return sibling
    for (let dir = own; ; dir = ownFolderGroup(dir)) {
      if (known.enclosing.has(dir)) return dir
      if (dir === '') return own
    }
  }, [boardDir, groups, known])
}
