import type { ChecklistProgressMap } from '../hooks/useChecklistProgress'

/**
 * The progress chip where a checklist note is listed (docs/design/2026-09-27-checkbox-lists,
 * hifi-direction-1 frame 8): "done / total" in the Files tree and Quick Open, green once every box
 * is ticked. A note that is not a checklist note has no entry in the map, so it shows nothing.
 */
export function ChecklistProgressChip({ path, progress }: { path: string; progress: ChecklistProgressMap }): JSX.Element | null {
  const entry = progress.get(path)
  if (!entry || entry.total === 0) return null
  const finished = entry.done === entry.total
  return (
    <span
      className={`checklist-chip${finished ? ' done' : ''}`}
      aria-label={finished ? `All ${entry.total} ticked` : `${entry.done} of ${entry.total} ticked`}
    >{entry.done} / {entry.total}</span>
  )
}
