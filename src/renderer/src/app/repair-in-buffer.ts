/**
 * Main's link repair (a rename, a move, a folder's rename) writes the documents that link to what moved. The
 * route holds those documents (the owner's `withFlushed`), so their saves wait and the repair reads exactly the
 * version each buffer was saved as. Typing that arrives while the route holds is still in the buffer, based on
 * that version: without this step the repair's write is an outside change under unsaved text, and the writer
 * sees the changed-on-disk banner although nothing was lost (review of PR 255, 20 Nov).
 *
 * So, in the route, the buffer takes the repair's edit as the document's new basis: the repair's change and the
 * typing are combined line by line (shared/three-way-merge.ts). Where they touch the same lines nothing is
 * combined by guess: the buffer is left as it is and the banner asks, as for any outside change.
 */
import { isTextChange } from '../../../shared/line-endings'
import { mergedText, threeWayMerge } from '../../../shared/three-way-merge'

export type RepairInBuffer =
  /** Nothing to take: no buffer, nothing typed over its basis (the watcher's read gives it the repair), or the
   *  repair left the text as it was. */
  | { kind: 'none' }
  /** The typing and the repair touch the same lines: left to the changed-on-disk banner. */
  | { kind: 'conflict' }
  /** The buffer to place: the repair's change with the typing on top, based on `repaired`. */
  | { kind: 'merge'; merged: string }

/** What a buffer based on `baseline`, holding `buffer`, becomes once the repair wrote `repaired` over its basis. */
export function repairInBuffer(baseline: string | undefined, buffer: string | null | undefined, repaired: string): RepairInBuffer {
  if (baseline === undefined || buffer == null) return { kind: 'none' }
  if (!isTextChange(baseline, buffer) || !isTextChange(baseline, repaired)) return { kind: 'none' }
  const merge = threeWayMerge(baseline, buffer, repaired)
  if (merge.conflicts) return { kind: 'conflict' }
  const merged = mergedText(merge, [])
  return merged === null ? { kind: 'conflict' } : { kind: 'merge', merged }
}
