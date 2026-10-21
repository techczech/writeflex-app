import { useEffect, useRef, useState } from 'react'
import type { ChecklistProgress, MarkdownFile } from '../../../preload'
import { changedEntryPaths } from '../../../shared/listing-patch'

/** A checklist note's progress by path: the Files tree's and Quick Open's "done / total" chip. */
export type ChecklistProgressMap = ReadonlyMap<string, Pick<ChecklistProgress, 'done' | 'total'>>

export const NO_CHECKLIST_PROGRESS: ChecklistProgressMap = new Map()

/** `progress` with the rows of `asked` replaced by `rows` (an asked path with no row has no chip). */
export function mergeChecklistProgress(progress: ChecklistProgressMap, asked: readonly string[], rows: readonly ChecklistProgress[]): ChecklistProgressMap {
  const next = new Map(progress)
  for (const path of asked) next.delete(path)
  for (const { path, done, total } of rows) next.set(path, { done, total })
  return next
}

/**
 * The checklist notes' progress (docs/design/2026-09-27-checkbox-lists, frame 8), re-asked whenever
 * the workspace listing changes — which every save, agent write and on-disk change already does
 * (collection:changed → useWorkspace), so a tick shows in the chip after its save. Main answers from
 * its search content cache, so a repeat ask reads only the files that changed. When the listing
 * changed only by patched entries (an own save in place, shared/listing-patch.ts), only those paths
 * are asked about, so main does not walk the tree; a re-list, or a change while an ask is still
 * pending, asks about everything as before.
 */
export function useChecklistProgress(files: readonly MarkdownFile[]): ChecklistProgressMap {
  const [progress, setProgress] = useState<ChecklistProgressMap>(NO_CHECKLIST_PROGRESS)
  const lastFiles = useRef<readonly MarkdownFile[] | null>(null)
  const pending = useRef(0)
  useEffect(() => {
    let current = true
    const before = lastFiles.current
    lastFiles.current = files
    const paths = before && pending.current === 0 ? changedEntryPaths(before, files) : null
    const ask = window.writeflex.getChecklistProgress?.(paths ? { paths } : undefined)
    if (!ask) return
    pending.current += 1
    ask.then((rows) => {
      if (!current) return
      setProgress((shown) => (paths ? mergeChecklistProgress(shown, paths, rows) : new Map(rows.map(({ path, done, total }) => [path, { done, total }]))))
    }).catch(() => { /* a workspace closing mid-ask: keep the last chips */ })
      .finally(() => { pending.current -= 1 })
    return () => { current = false }
  }, [files])
  return progress
}
