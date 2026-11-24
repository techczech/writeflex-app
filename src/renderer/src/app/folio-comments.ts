/**
 * "All comments in this Folio" (Dominik, 10 Nov 2026: "Folio does not feel like a single document - eg no place to
 * see all comments"). Pure: every comment and suggested edit still waiting in the Folio's parts, grouped by part in
 * running order, then the Folio's files not in the outline. The store is the ordinary change ledger and the order is
 * the Folio's outline: nothing new is stored. What counts as waiting is the review margin's own rule: open or held,
 * no quiet copy fixes, and none of the writer's own recorded edits.
 */
import type { Change } from '../../../preload'
import type { FolioOutline } from '../../../shared/folio-outline'
import { marginKind, marginSource } from './margin-model'

export type FolioCommentRow = {
  id: string
  path: string
  kind: 'note' | 'edit'
  /** What the row says it is. */
  label: 'Comment' | 'Suggested edit'
  /** Who left it: the reader's name, else the source (Agent, Claude Code, You…). */
  who: string
  /** The words it was written on; empty for an insertion. */
  quote: string
  /** A comment's text, or a suggested edit's replacement words. */
  text: string
  held: boolean
  ts: number
}

export type FolioCommentGroup = {
  path: string
  title: string
  /** 1-based place in the running order; null for a file not in the outline. */
  position: number | null
  rows: FolioCommentRow[]
}

export type FolioComments = { groups: FolioCommentGroup[]; comments: number; edits: number }

/** Whether a change is still waiting for the writer, by the margin's rule. */
export function waitingInFolio(change: Change): boolean {
  if (change.status !== 'pending' && change.status !== 'held') return false
  if (change.editClass === 'copy') return false
  return !(change.provenance === 'writer' && marginKind(change) === 'edit')
}

function rowOf(change: Change): FolioCommentRow {
  const kind = marginKind(change)
  const reader = change.readerNote ?? null
  const text = kind === 'note' ? (reader?.text ?? change.summary ?? '') : change.newText
  return {
    id: change.id,
    path: change.path,
    kind,
    label: kind === 'note' ? 'Comment' : 'Suggested edit',
    who: reader?.name || marginSource(change).label,
    quote: (reader?.quote || change.oldText || '').trim(),
    text: text.trim(),
    held: change.status === 'held',
    ts: reader?.at ?? change.ts,
  }
}

/** Where a change stands in its part, for the order inside a group: its recorded range, else last (then by time). */
const placeOf = (change: Change): number => change.anchor?.from ?? change.moveTo?.from ?? Number.POSITIVE_INFINITY

export function folioComments(outline: Pick<FolioOutline, 'pieces' | 'also'>, changes: readonly Change[]): FolioComments {
  const byPath = new Map<string, Change[]>()
  for (const change of changes) {
    if (!waitingInFolio(change)) continue
    const list = byPath.get(change.path)
    if (list) list.push(change)
    else byPath.set(change.path, [change])
  }
  const groups: FolioCommentGroup[] = []
  const seen = new Set<string>()
  const add = (path: string, title: string, position: number | null): void => {
    if (seen.has(path)) return
    seen.add(path)
    const list = byPath.get(path)
    if (!list?.length) return
    const rows = [...list].sort((a, b) => placeOf(a) - placeOf(b) || a.ts - b.ts).map(rowOf)
    groups.push({ path, title, position, rows })
  }
  let position = 0
  for (const piece of outline.pieces) {
    if (seen.has(piece.path)) continue
    position += 1
    add(piece.path, piece.title, position)
  }
  for (const file of outline.also) add(file.path, file.title, null)
  const rows = groups.flatMap((group) => group.rows)
  return { groups, comments: rows.filter((row) => row.kind === 'note').length, edits: rows.filter((row) => row.kind === 'edit').length }
}

/** The count line under the pane's title: "3 comments and 2 suggested edits in 4 parts". */
export function folioCommentsCountText(result: FolioComments): string {
  const { comments, edits, groups } = result
  if (comments + edits === 0) return 'Nothing is waiting in this Folio.'
  const parts: string[] = []
  if (comments > 0) parts.push(`${comments} ${comments === 1 ? 'comment' : 'comments'}`)
  if (edits > 0) parts.push(`${edits} suggested ${edits === 1 ? 'edit' : 'edits'}`)
  return `${parts.join(' and ')} in ${groups.length} ${groups.length === 1 ? 'part' : 'parts'}`
}
