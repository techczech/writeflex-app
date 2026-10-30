/**
 * Accept all from one source (claude-code, codex, an outside agent): which of the ledger's Changes that
 * is, and in what order they are accepted. Pure. The accepting itself is done one Change at a time by the
 * same Accept a single click runs (agent.ts `acceptOutsideFromSource` → `resolveChange`), so nothing is
 * written that a sequence of single clicks would not write, and each accept is in history as one.
 *
 * ORDER, per document: from the end of the document backwards. A Change is placed by its text (and the
 * words around it, and its recorded span), so a Change accepted further down never moves the text or the
 * span of one above it; a metadata change sits in the frontmatter at the top and goes last of the
 * placeable ones. A Change over the whole document, which places only in exactly the text it was made
 * over, goes first: after any other accept it could not be placed.
 */
import type { Change } from '../engine'
import { isWholeDocumentChange, undecided } from './changes'
import { frontmatterEditOf, placeInFrontmatter } from './frontmatter-change'
import { outsideSourceOf } from './outside-change-fields'
import type { OutsideBulkAccept, OutsideSource } from '../shared/outside-source'
import { placeRecordedReplacement } from './recorded-placement'

/** What Accept all did (shared/outside-source.ts). */
export type BulkAcceptOutcome = OutsideBulkAccept

export const MOVE_LEFT_REASON = 'A move is accepted from its own card.'

/** The undecided Changes of `source`, in ledger order. A reader's items are never accepted in bulk. */
export function bulkAcceptTargets(changes: readonly Change[], source: OutsideSource): Change[] {
  if (source === 'reader') return []
  return changes.filter((change) => undecided(change) && outsideSourceOf(change) === source)
}

/** Where `change` stands in `content`, for ordering: higher goes first. */
export function placeOf(content: string, change: Change): number {
  const metadata = frontmatterEditOf(change)
  if (metadata) {
    const at = placeInFrontmatter(content, change.path, metadata)
    return 'reason' in at ? -1 : at.from
  }
  if (isWholeDocumentChange(change)) return Number.MAX_SAFE_INTEGER
  if (change.editClass === 'insert') {
    const after = change.insertAfter ?? ''
    if (after === '') return content.length
    const at = content.indexOf(after)
    return at === -1 ? -1 : at + after.length
  }
  const at = placeRecordedReplacement(content, change)
  return 'reason' in at ? -1 : at.from
}

/** One document's Changes in the order they are accepted (ties keep ledger order). */
export function acceptOrder(content: string, changes: readonly Change[]): Change[] {
  return changes
    .map((change, index) => ({ change, index, at: placeOf(content, change) }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map((entry) => entry.change)
}

/** The targets grouped by document, documents in path order. */
export function byDocument(changes: readonly Change[]): Array<[string, Change[]]> {
  const groups = new Map<string, Change[]>()
  for (const change of changes) groups.set(change.path, [...(groups.get(change.path) ?? []), change])
  return [...groups].sort(([a], [b]) => a.localeCompare(b))
}
