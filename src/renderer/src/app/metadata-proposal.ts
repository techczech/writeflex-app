/**
 * A waiting edit that changes only the document's metadata, as the review shows it (pure). Any waiting edit
 * whose place in the document lies inside the frontmatter block is one: a request from outside filed as
 * frontmatter lines (main frontmatter-change.ts), an older whole-document one that main reads as those lines,
 * or the in-app agent's own edit of a metadata line. Its card says the keys and values that change rather
 * than the raw lines, and the metadata panel marks those fields as proposed by its source.
 */
import { frontmatterBlock } from '../../../shared/markdown/frontmatter'
import { frontmatterFieldChanges, type FrontmatterFieldChange } from '../../../shared/markdown/frontmatter-proposal'
import type { DiffSegment } from './margin-card'

/** The fields an edit at `range` (replacing it with `newText`) changes, or null when the range is not inside the frontmatter. */
export function metadataFieldsOf(document: string, range: { from: number; to: number }, newText: string): FrontmatterFieldChange[] | null {
  const block = frontmatterBlock(document)
  if (!block || range.from < 0 || range.to > block.end || range.from > range.to) return null
  const after = document.slice(0, range.from) + newText + document.slice(range.to)
  return frontmatterFieldChanges(document, after)
}

/** The card's words for a metadata change: "status: ~~draft~~ final · audience: teachers (new)". Null: show the lines as they are. */
export function metadataSegments(fields: readonly FrontmatterFieldChange[]): DiffSegment[] | null {
  if (fields.length === 0) return null
  const segments: DiffSegment[] = [{ kind: 'text', text: 'Metadata · ' }]
  fields.forEach((field, index) => {
    if (index > 0) segments.push({ kind: 'text', text: ' · ' })
    segments.push({ kind: 'text', text: `${field.key}: ` })
    if (field.before !== null && field.before !== '') segments.push({ kind: 'del', text: field.before })
    if (field.before !== null && field.before !== '' && field.after !== null && field.after !== '') segments.push({ kind: 'text', text: ' ' })
    if (field.after !== null && field.after !== '') segments.push({ kind: 'ins', text: field.after })
    if (field.before === null) segments.push({ kind: 'text', text: ' (new)' })
    if (field.after === null) segments.push({ kind: 'text', text: ' (removed)' })
  })
  return segments
}

/** One field the metadata panel marks: what it was, what is proposed, and by whom. */
export type MetadataProposal = { id: string; key: string; before: string | null; after: string | null; by: string }

/** The proposals of the waiting edits shown as cards (`cards`), for the metadata panel. */
export function metadataProposalsOf(document: string, cards: ReadonlyArray<{ id: string; kind: string; status: string; anchor: { from: number; to: number } | null; change: { newText: string; provenance: string }; source: { type: string; label: string } }>): MetadataProposal[] {
  const proposals: MetadataProposal[] = []
  for (const card of cards) {
    if (card.kind !== 'edit' || (card.status !== 'pending' && card.status !== 'held') || !card.anchor || card.source.type === 'you') continue
    const fields = metadataFieldsOf(document, card.anchor, card.change.newText)
    for (const field of fields ?? []) proposals.push({ id: card.id, key: field.key, before: field.before, after: field.after, by: card.source.label })
  }
  return proposals
}
