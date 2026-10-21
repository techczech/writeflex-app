/**
 * Where a recorded replacement goes in a document: ONE judgement, asked by Accept (agent.ts
 * `resolveChange`, which then writes there) and by the sweep after another Accept (outside-change.ts
 * `unplaceableIn`, which closes what can no longer be placed). Both ask this, so the sweep never closes
 * a Change that Accept would have placed (ticket 14).
 *
 * The recorded `oldText` is often shorter than what was reviewed: the store shortens a replacement to
 * the changed words (proposed-replacement.ts), so `reading ` may stand twice where "Most reading lists"
 * stood once, and a pure addition has no old text at all. The words the shortening trimmed are kept on
 * the record (`anchorContext`, changes.ts) and are the first test of the place.
 */
import type { Change } from '../engine'
import { anchorContextOf, type AnchorContext, type ClosedCode } from './changes'

export type Placement = { from: number; to: number }
export type Unplaced = { reason: string; code: ClosedCode }

const GONE = (path: string): string => `oldText was not found in ${path}; ask the agent to redo the edit.`
const REPEATED = (path: string): string => `oldText is not unique in ${path}; ask the agent to redo the edit with more context.`
const PLACE_GONE = (path: string): string => `The words around this change are no longer in ${path} as they were, so it has no place to go; ask the agent to redo the edit.`
/** A legacy addition (no old text, no words around it kept, a bare point): nothing is known about its place. */
const PLACE_UNKNOWN = (path: string): string => `This addition was recorded by an older WriteFlex that kept no words around its place, so it cannot be placed safely in ${path}; decline it, or ask the agent to redo the edit.`
const PLACE_REPEATED = (path: string): string => `The words around this change now stand more than once in ${path}, so it has no one place to go; ask the agent to redo the edit.`

/** How often `text` stands in `content`, overlapping occurrences counted (`aa` stands twice in `aaa`); stops at 2. */
function standsTimes(content: string, text: string): 0 | 1 | 2 {
  const first = content.indexOf(text)
  if (first === -1) return 0
  return content.indexOf(text, first + 1) === -1 ? 1 : 2
}

/**
 * The one place for a recorded replacement in `content`, or why there is none. In order:
 *  1. with `anchorContext` on record: the recorded text with the trimmed words either side, where that
 *     stands exactly once;
 *  2. the recorded span (`anchor`), where it still holds exactly the recorded text (for an addition, a
 *     zero-width point) and, with `anchorContext` on record, the trimmed words stand either side of it;
 *  3. with NO `anchorContext` on record (a reader's edit, a record from before it was kept): the
 *     recorded text, where it stands exactly once.
 * The recorded text alone never places a record that has its context: standing once elsewhere (the title,
 * after the writer made the edit by hand) is not the place it was made.
 * Unplaceable: `target-gone` or `target-repeated`. Only a record with no text, no context and no span to
 * place it by is `other` (it was never placeable).
 */
export function placeRecordedReplacement(content: string, change: Pick<Change, 'oldText' | 'path' | 'anchor'> & AnchorContext): Placement | Unplaced {
  const { oldText, path, anchor } = change
  const context = anchorContextOf(change)
  if (oldText === '' && !context && !(anchor && anchor.from === anchor.to)) {
    return { reason: `oldText must not be empty; ask the agent to redo the edit for ${path}.`, code: 'other' }
  }
  if (context) {
    const full = `${context.before}${oldText}${context.after}`
    const at = content.indexOf(full)
    if (at !== -1 && standsTimes(content, full) === 1) {
      const from = at + context.before.length
      return { from, to: from + oldText.length }
    }
  }
  if (anchor && Number.isSafeInteger(anchor.from) && anchor.from >= 0 && anchor.to === anchor.from + oldText.length && anchor.to <= content.length
    && content.slice(anchor.from, anchor.to) === oldText) {
    const framed = !context || (
      anchor.from >= context.before.length
      && content.slice(anchor.from - context.before.length, anchor.from) === context.before
      && content.slice(anchor.to, anchor.to + context.after.length) === context.after
    )
    // A bare zero-width point with nothing around it on record says nothing about the place: not enough.
    if (framed && (oldText !== '' || context)) return { from: anchor.from, to: anchor.to }
  }
  if (context) {
    const times = standsTimes(content, `${context.before}${oldText}${context.after}`)
    return times === 0 ? { reason: PLACE_GONE(path), code: 'target-gone' } : { reason: PLACE_REPEATED(path), code: 'target-repeated' }
  }
  if (oldText === '') return { reason: PLACE_UNKNOWN(path), code: 'target-gone' }
  const times = standsTimes(content, oldText)
  if (times === 1) {
    const from = content.indexOf(oldText)
    return { from, to: from + oldText.length }
  }
  return times === 0 ? { reason: GONE(path), code: 'target-gone' } : { reason: REPEATED(path), code: 'target-repeated' }
}
