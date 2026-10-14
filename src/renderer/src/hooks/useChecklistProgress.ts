import { useEffect, useState } from 'react'
import type { ChecklistProgress, MarkdownFile } from '../../../preload'

/** A checklist note's progress by path: the Files tree's and Quick Open's "done / total" chip. */
export type ChecklistProgressMap = ReadonlyMap<string, Pick<ChecklistProgress, 'done' | 'total'>>

export const NO_CHECKLIST_PROGRESS: ChecklistProgressMap = new Map()

/**
 * The checklist notes' progress (docs/design/2026-09-27-checkbox-lists, frame 8), re-asked whenever
 * the workspace listing is re-pulled — which every save, agent write and on-disk change already does
 * (collection:changed → useWorkspace.refresh), so a tick shows in the chip after its save. Main
 * answers from its search content cache, so a repeat ask reads only the files that changed.
 */
export function useChecklistProgress(files: readonly MarkdownFile[]): ChecklistProgressMap {
  const [progress, setProgress] = useState<ChecklistProgressMap>(NO_CHECKLIST_PROGRESS)
  useEffect(() => {
    let current = true
    const ask = window.writeflex.getChecklistProgress?.()
    if (!ask) return
    ask.then((rows) => {
      if (current) setProgress(new Map(rows.map(({ path, done, total }) => [path, { done, total }])))
    }).catch(() => { /* a workspace closing mid-ask: keep the last chips */ })
    return () => { current = false }
  }, [files])
  return progress
}
