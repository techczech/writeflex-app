/**
 * Accept all / Decline all from one source, across the collection (claude-code, codex, an outside agent):
 * which sources have changes waiting, the words of the confirm sheet, and the words of what it did. Pure.
 * The sheet decides nothing itself; App runs Decline all through `rejectOutsideChanges({ source })` and
 * Accept all through `acceptOutsideChanges` (main, each by the single Accept) plus the window's own accept
 * route for documents it has open.
 *
 * A reader's items are never in it: a reader sees each outcome on the reader page and is named one by one
 * in the margin's own Decline all.
 */
import type { Change, OutsideBulkAccept, OutsideSource } from '../../../preload'
import { OUTSIDE_SOURCE_LABELS } from '../../../shared/outside-source'

export type OutsideSourceRow = {
  source: OutsideSource
  label: string
  /** Pending and held. */
  undecided: number
  held: number
  moves: number
  documents: number
  /** The documents its waiting changes are in. */
  paths: string[]
}

const waiting = (change: Change): boolean => change.status === 'pending' || change.status === 'held'

/** One row per outside source (never readers) with changes waiting, most first. */
export function outsideSourceRows(changes: readonly Change[]): OutsideSourceRow[] {
  const rows = new Map<OutsideSource, OutsideSourceRow>()
  for (const change of changes) {
    const source = change.outsideSource
    if (!source || source === 'reader' || !waiting(change) || change.snapshotId) continue
    const row = rows.get(source) ?? { source, label: OUTSIDE_SOURCE_LABELS[source], undecided: 0, held: 0, moves: 0, documents: 0, paths: [] }
    row.undecided += 1
    if (change.status === 'held') row.held += 1
    if (change.editClass === 'move') row.moves += 1
    if (!row.paths.includes(change.path)) row.paths.push(change.path)
    row.documents = row.paths.length
    rows.set(source, row)
  }
  return [...rows.values()].sort((a, b) => b.undecided - a.undecided || a.label.localeCompare(b.label))
}

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`

export type SourceBulkAction = 'accept' | 'decline'

export type SourceBulkQuestion = {
  /** "Accept all 23 from Claude Code?" */
  title: string
  /** Scope: how many, in how many documents, across the collection; held ones named. */
  detail: string
  /** What happens to them, and what is left. */
  reassurance: string
  /** The number on the confirm button. */
  count: number
}

/** The words of the confirm sheet. `open`: how many of the row's documents are open in this window. */
export function sourceBulkQuestion(row: OutsideSourceRow, action: SourceBulkAction, open = 0): SourceBulkQuestion {
  const count = action === 'accept' ? row.undecided - row.moves : row.undecided
  const held = row.held === 0 ? '' : row.held === 1 ? ', including one you held' : `, including ${row.held.toLocaleString('en-GB')} you held`
  const detail = `Across this collection: ${plural(count, 'change', 'changes')} from ${row.label} in ${plural(row.documents, 'document', 'documents')}${held}.`
  if (action === 'decline') {
    return {
      title: `Decline all ${count.toLocaleString('en-GB')} from ${row.label}?`,
      detail,
      // Declining writes nothing, so "all" is all: moves included (Accept all leaves them, below).
      reassurance: [
        count === 1 ? 'The text stays as it is. It can be reopened from Settled today.' : 'The text stays as it is. Each one can be reopened from Settled today.',
        ...(row.moves > 0 ? [`${row.moves === 1 ? 'The move' : `The ${plural(row.moves, 'move', 'moves')}`} among them ${row.moves === 1 ? 'is' : 'are'} declined too.`] : []),
      ].join(' '),
      count,
    }
  }
  const parts = ['Each is accepted as if you clicked Accept on it, from the end of each document up, and can be undone the same way.']
  parts.push('Any that cannot be placed now are left waiting.')
  if (row.moves > 0) parts.push(`Moves are not included: ${plural(row.moves, 'move is', 'moves are')} left for you to accept from ${row.moves === 1 ? 'its card' : 'their cards'}.`)
  if (open > 0) parts.push(`${plural(open, 'document is', 'documents are')} open in this window and ${open === 1 ? 'is' : 'are'} saved first.`)
  return { title: `Accept all ${count.toLocaleString('en-GB')} from ${row.label}?`, detail, reassurance: parts.join(' '), count }
}

export type SourceBulkResult = {
  title: string
  /** One line per change left waiting or closed, with its document: at most `MAX_RESULT_LINES`, then "and N more". */
  lines: string[]
}

export const MAX_RESULT_LINES = 6
const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** What Decline all did. */
export function declineResult(label: string, rejected: number): SourceBulkResult {
  return { title: rejected === 0 ? `Nothing from ${label} was waiting.` : `Declined ${plural(rejected, 'change', 'changes')} from ${label}.`, lines: [] }
}

/** What Accept all did: main's outcome plus the window's own accepts in open documents (`openAccepted`, `openLeft`). */
export function acceptResult(label: string, outcome: Pick<OutsideBulkAccept, 'accepted' | 'files' | 'left' | 'closed'>, openAccepted = 0, openLeft: OutsideBulkAccept['left'] = [], openFiles: string[] = []): SourceBulkResult {
  const accepted = outcome.accepted + openAccepted
  const files = new Set([...outcome.files, ...openFiles]).size
  const left = [...outcome.left, ...openLeft]
  const head = accepted === 0 ? `Nothing from ${label} was accepted.` : `Accepted ${plural(accepted, 'change', 'changes')} from ${label} in ${plural(files, 'document', 'documents')}.`
  const tail = [
    left.length > 0 ? `${plural(left.length, 'is', 'are')} left waiting.` : '',
    outcome.closed.length > 0 ? `${plural(outcome.closed.length, 'was', 'were')} closed: another change to the same words was accepted first.` : '',
  ].filter(Boolean).join(' ')
  const lines = [
    ...left.map((item) => `${fileName(item.path)}: ${item.reason}`),
    ...outcome.closed.map((item) => `${fileName(item.path)}: closed, another change to the same words was accepted first.`),
  ]
  const shown = lines.slice(0, MAX_RESULT_LINES)
  if (lines.length > MAX_RESULT_LINES) shown.push(`and ${(lines.length - MAX_RESULT_LINES).toLocaleString('en-GB')} more`)
  return { title: tail ? `${head} ${tail}` : head, lines: shown }
}
