/**
 * Changes to a document's metadata (changes.ts `FrontmatterChange`). ONE judgement, asked by Accept
 * (agent.ts `resolveChange`), by Accept all (outside-bulk-accept.ts) and by the check before a sweep
 * (outside-change.ts `unplaceableIn`).
 *
 * Two kinds of record are such a change:
 *  - one filed with `frontmatter: true` (the inbox validator files every metadata request so, when only
 *    the frontmatter changes): its `oldText` / `newText` are the WHOLE old and new frontmatter blocks;
 *  - one filed before that over the WHOLE document (`whole: true`) whose old and new text differ only in
 *    the frontmatter: the two blocks are cut from its two texts. Its stored form is never rewritten.
 * The rule (shared/markdown/frontmatter-proposal.ts): placeable only while the document's frontmatter block
 * is byte-identical to the old block; Accept then replaces exactly that block with the new one. The body
 * never matters (an edit to the writing never blocks it) and is never touched. Any change to the block
 * since it was proposed, and it is not placed: it waits, with that reason. No line or key matching.
 * (A `fieldAfter` field in records filed by 0.27.0-alpha.28 is read and ignored.)
 */
import type { Change } from '../engine'
import { frontmatterBlockEdit, placeFrontmatterBlock, type FrontmatterPlaceEdit } from '../shared/markdown/frontmatter-proposal'
import { isFrontmatterChange, isWholeDocumentChange } from './changes'
import type { Placement, Unplaced } from './recorded-placement'

export type FrontmatterEdit = FrontmatterPlaceEdit

/** The old and new frontmatter blocks of `change`, or null when it is not a change to the metadata only. */
export function frontmatterEditOf(change: Pick<Change, 'oldText' | 'newText'> & { frontmatter?: unknown; whole?: unknown }): FrontmatterEdit | null {
  if (isFrontmatterChange(change as Change)) return { oldText: change.oldText, newText: change.newText }
  if (!isWholeDocumentChange(change as Change)) return null
  const edit = frontmatterBlockEdit(change.oldText, change.newText)
  return edit ? { oldText: edit.oldText, newText: edit.newText } : null
}

/** The words for a metadata change that is not placed: Accept all reports it so. */
export const METADATA_CHANGED = (path: string): string => `Metadata changed since proposed (${path}).`

/** Where `edit` goes in `content`: the whole frontmatter block, only while it is exactly as proposed. */
export function placeInFrontmatter(content: string, path: string, edit: FrontmatterEdit): Placement | Unplaced {
  const placed = placeFrontmatterBlock(content, edit)
  if (!('miss' in placed)) return placed
  return placed.miss === 'no-block'
    ? { reason: `${path} has no frontmatter now, so this change to its metadata has no place to go.`, code: 'target-gone' }
    : { reason: METADATA_CHANGED(path), code: 'target-gone' }
}

/** `content` with `edit` placed in its frontmatter, or why it cannot be. */
export function applyFrontmatterEdit(content: string, path: string, edit: FrontmatterEdit): string | Unplaced {
  const at = placeInFrontmatter(content, path, edit)
  return 'reason' in at ? at : content.slice(0, at.from) + edit.newText + content.slice(at.to)
}

/**
 * The record as the WINDOW reads it (`changes:list`): a waiting whole-document record that changes only
 * the frontmatter is shown as its two frontmatter blocks, so its card reads as metadata and the body
 * carries no mark. The ledger keeps the record as it was filed; Accept places it by the same blocks.
 */
export function asFrontmatterForWindow<C extends Change>(change: C): C {
  if (isFrontmatterChange(change) || !isWholeDocumentChange(change)) return change
  const edit = frontmatterBlockEdit(change.oldText, change.newText)
  if (!edit) return change
  const { whole: _whole, ...rest } = change as C & { whole?: true }
  return { ...rest, oldText: edit.oldText, newText: edit.newText, anchor: { from: edit.from, to: edit.to }, frontmatter: true } as unknown as C
}
