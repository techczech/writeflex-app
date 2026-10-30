/**
 * A proposed change to a document's METADATA, told apart from a change to its writing. Pure; main (the
 * inbox validator, accept, the ledger as the window reads it) and the renderer (the margin card, the
 * metadata panel) ask the same questions here, so they never disagree.
 *
 * One rule, kept simple on purpose (review 2026-10-27: line and key matching wrote into the wrong field):
 *  - `frontmatterBlockEdit(before, after)`: when `after` differs from `before` ONLY inside the frontmatter
 *    block (the body byte-for-byte the same, the BOM the same), the change is the WHOLE old block (from the
 *    start of the text to the end of the closing fence line) and the whole new block. Null otherwise.
 *  - `placeFrontmatterBlock(content, edit)`: placeable only while the document's frontmatter block is
 *    byte-identical to the old block; it then replaces exactly that block. Any difference, however small,
 *    and it is not placed: it waits. The body never matters and is never touched.
 *  - `frontmatterFieldChanges(before, after)`: for DISPLAY only, the keys whose value differs, as one line
 *    of text each ("status: draft → final"). Lines the flat reader cannot read are not listed.
 */
import { parseFrontmatterEntries } from '../object-markup'
import { frontmatterBlock } from './frontmatter'
import { layoutOf } from './frontmatter-edit'

export type FrontmatterBlockEdit = { from: number; to: number; oldText: string; newText: string }

export function frontmatterBlockEdit(before: string, after: string): FrontmatterBlockEdit | null {
  if (before === after) return null
  if (before.startsWith('\uFEFF') !== after.startsWith('\uFEFF')) return null
  const old = frontmatterBlock(before)
  const next = frontmatterBlock(after)
  if (!old || !next) return null
  if (before.slice(old.end) !== after.slice(next.end)) return null
  return { from: 0, to: old.end, oldText: before.slice(0, old.end), newText: after.slice(0, next.end) }
}

export type FrontmatterPlaceEdit = { oldText: string; newText: string }
export type FrontmatterPlaced = { from: number; to: number } | { miss: 'no-block' | 'changed' }

/** Where `edit` goes in `content`: over the whole frontmatter block, only while it is exactly the old block. */
export function placeFrontmatterBlock(content: string, edit: FrontmatterPlaceEdit): FrontmatterPlaced {
  const block = frontmatterBlock(content)
  if (!block) return { miss: 'no-block' }
  if (content.slice(0, block.end) !== edit.oldText) return { miss: 'changed' }
  return { from: 0, to: block.end }
}

export type FrontmatterFieldChange = { key: string; before: string | null; after: string | null }

const FIELD_CHARS = 400

/** The flat keys of a document's frontmatter, each as one line of text (a list as its items joined by ", "). */
function fieldsOf(text: string): Map<string, string> {
  const fields = new Map<string, string>()
  const layout = layoutOf(text)
  if (!layout) return fields
  const inner = text.slice(layout.openEnd, layout.closeStart).replace(/\r\n/g, '\n').replace(/\n$/, '')
  for (const entry of parseFrontmatterEntries(inner)) {
    if (entry.kind === 'raw') continue
    const value = entry.kind === 'scalar' ? entry.value : entry.values.join(', ')
    fields.set(entry.key, value.length > FIELD_CHARS ? `${value.slice(0, FIELD_CHARS)}…` : value)
  }
  return fields
}

export function frontmatterFieldChanges(before: string, after: string): FrontmatterFieldChange[] {
  const old = fieldsOf(before)
  const next = fieldsOf(after)
  const changes: FrontmatterFieldChange[] = []
  for (const [key, value] of next) {
    const was = old.get(key)
    if (was !== value) changes.push({ key, before: was ?? null, after: value })
  }
  for (const [key, value] of old) if (!next.has(key)) changes.push({ key, before: value, after: null })
  return changes
}

/** "status: draft → final", "audience: teachers (new)", "tags (removed)"; one per changed key. */
export function fieldChangeLine(change: FrontmatterFieldChange): string {
  if (change.before === null) return `${change.key}: ${change.after ?? ''} (new)`
  if (change.after === null) return `${change.key} (removed)`
  return `${change.key}: ${change.before} → ${change.after}`
}
