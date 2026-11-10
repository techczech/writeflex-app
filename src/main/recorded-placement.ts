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
 *
 * A SUGGESTION STAGED FROM A CO-AUTHOR'S REVISION (`folioRevision`, Folio versions ticket 15) is placed by a
 * stricter rule, `placeStagedChange` below: only as a WHOLE PARAGRAPH, with the paragraphs around it as they
 * were. The text standing once somewhere else is never its place (a paragraph the writer rewrote and pasted
 * elsewhere as a quotation must not be the one Accept rewrites). Every other kind of proposal keeps the rule
 * above, including the fallback to the recorded text standing once: that is how a reader's edit and a record
 * from before the words around a change were kept are placed, and it is not wrong for them.
 */
import type { Change } from '../engine'
import { anchorContextOf, type AnchorContext, type ClosedCode } from './changes'
import { markdownBlocks } from './markdown-blocks'
import { folioRevisionOf } from '../shared/folio-version-stage'

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
  if (folioRevisionOf(change) !== null) return placeStagedChange(content, change)
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

// ---- A suggestion staged from a co-author's revision -------------------------------------------

/** How many characters of the text either side of a staged suggestion are kept on its record to find its place again. */
export const STAGED_CONTEXT_CHARS = 300

const STAGED_MOVED = (path: string): string => `The paragraph this suggestion changes is not in ${path} exactly as it was when the revision came in (it has been edited, moved or copied since), so it was not applied and nothing was changed. It stays in the margin: decline it, or make the change by hand.`
const STAGED_REPEATED = (path: string): string => `The paragraph this suggestion changes, with the paragraphs around it, now stands more than once in ${path}, so it has no one place to go and nothing was changed. It stays in the margin: decline it, or make the change by hand.`

/**
 * Whether `content[from, to)` is whole paragraphs: it starts where a paragraph starts (the start of the text or just after a blank line) and
 * ends where one ends (at the end of the text or before a blank line), trailing blank lines of its own aside. A paragraph standing inside a
 * longer one, or on one line of a quotation, is not.
 */
export function isWholeParagraphSpan(content: string, from: number, to: number): boolean {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to > content.length || from >= to) return false
  if (/\s/.test(content[from]!)) return false
  if (from > 0 && !/\n[ \t]*\r?\n$/.test(content.slice(0, from))) return false
  const rest = content.slice(from + content.slice(from, to).replace(/\s+$/, '').length)
  return /^[ \t]*\r?\n[ \t]*\r?\n/.test(rest) || /^\s*$/.test(rest)
}

/** The text kept around a staged suggestion, or nothing when there is none worth keeping. Blank space alone says nothing about a place. */
export function stagedContextAround(content: string, from: number, to: number, sides: { before: boolean } = { before: true }): { before: string; after: string } | undefined {
  const before = sides.before ? content.slice(Math.max(0, from - STAGED_CONTEXT_CHARS), from) : ''
  const after = content.slice(to, to + STAGED_CONTEXT_CHARS)
  const kept = { before: before.trim() === '' ? '' : before, after: after.trim() === '' ? '' : after }
  return kept.before === '' && kept.after === '' ? undefined : kept
}

/**
 * The one place for a staged replacement or removal, or why there is none: the recorded paragraph(s) as WHOLE paragraphs, with the text
 * recorded around them either side, standing exactly once; or, failing that, at the very span recorded, holding exactly the recorded text,
 * framed by the same recorded text, as whole paragraphs. Never "the text stands once somewhere else".
 */
function placeStagedChange(content: string, change: Pick<Change, 'oldText' | 'path' | 'anchor'> & AnchorContext): Placement | Unplaced {
  const { oldText, path, anchor } = change
  if (oldText === '') return { reason: STAGED_MOVED(path), code: 'target-gone' }
  const context = anchorContextOf(change)
  let times: 0 | 1 | 2 = 0
  if (context) {
    const full = `${context.before}${oldText}${context.after}`
    times = standsTimes(content, full)
    if (times === 1) {
      const from = content.indexOf(full) + context.before.length
      if (isWholeParagraphSpan(content, from, from + oldText.length)) return { from, to: from + oldText.length }
    }
  }
  if (anchor && Number.isSafeInteger(anchor.from) && anchor.from >= 0 && anchor.to === anchor.from + oldText.length && anchor.to <= content.length
    && content.slice(anchor.from, anchor.to) === oldText && isWholeParagraphSpan(content, anchor.from, anchor.to)) {
    const framed = !context || (
      anchor.from >= context.before.length
      && content.slice(anchor.from - context.before.length, anchor.from) === context.before
      && content.slice(anchor.to, anchor.to + context.after.length) === context.after
    )
    if (framed) return { from: anchor.from, to: anchor.to }
  }
  return times === 2 ? { reason: STAGED_REPEATED(path), code: 'target-repeated' } : { reason: STAGED_MOVED(path), code: 'target-gone' }
}

/**
 * Whether a staged INSERTION's anchor, the whole paragraph it goes after, is still there exactly once with the text recorded after it. Null while
 * it is; otherwise why not. (The insertion itself is then placed by the one insert every proposal has.)
 */
export function stagedInsertUnplaced(content: string, change: { path: string; insertAfter?: string } & AnchorContext): Unplaced | null {
  const after = change.insertAfter ?? ''
  if (after === '') return { reason: STAGED_MOVED(change.path), code: 'target-gone' }
  const context = anchorContextOf(change)
  const found = markdownBlocks(content).filter((block) => block.text === after && (!context || content.slice(block.to, block.to + context.after.length) === context.after))
  if (found.length === 1) return null
  return found.length === 0 ? { reason: STAGED_MOVED(change.path), code: 'target-gone' } : { reason: STAGED_REPEATED(change.path), code: 'target-repeated' }
}
