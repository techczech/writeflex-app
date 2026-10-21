/**
 * The ingest of shown-first requests into the review ledger (specification section 4): every request
 * the executor read in one look at the inbox, validated from scratch and added in ONE write of the
 * ledger. Called by request-executor.ts; needs no window.
 *
 * WHAT THE APP DECIDES, AND FROM WHAT:
 *  - whether a request can be a Change at all: `proposeOutsideChange` (outside-change.ts), run here
 *    against the app's document-only view of the Collection as it stands now. Nothing the command
 *    line concluded is carried in the request, so nothing of it can be trusted by mistake;
 *  - the author: from `OUTSIDE_AUTHORS`, keyed on `declaredSource(args.source)`. A request that says
 *    it is the writer, or the in-app agent, or anything not on the list, is "Outside agent". No text
 *    from the request reaches the author;
 *  - the provenance: `agent`, the shared ledger's own value for "not the writer's own text", so the
 *    existing accept path replays the Change and the existing dock shows it. That it came from
 *    outside is recorded beside it (`outsideSource`, `outsideRequest`: outside-change-fields.ts);
 *  - the request's id, kept on each Change, by which the Change store adds a request once however
 *    often it is read (`ChangeStore.addOutside`).
 *
 * A request that fails validation is not dropped and is never acceptable: it becomes ONE record born
 * closed, with the reason, marked `outsideRefused` (the store closes it again if anything tries to
 * reopen, hold or accept it). Its `oldText` and `newText` are empty: what the request asked for is
 * kept, cut to a length, in `outsideIntended`, where no accept path reads.
 *
 * A flood of bad requests cannot grow the ledger without end: it keeps at most 2,000 such records,
 * and past that a refused request is answered (if anything waits for the answer) and cleared with no
 * record.
 *
 * LIMITS. The executor bounds what one look reads (cli/review-format.ts). This bounds what the ledger
 * holds: undecided outside Changes are one pool, capped in number and in bytes of text, with a share
 * per source so that one source cannot take all of it. A request past a cap is `full`: nothing of it
 * is added, and the executor refuses it (naming the count and saying the writer must clear changes in
 * WriteFlex) or, when no command is waiting for an answer, leaves it in the inbox for later. Validation stops building Changes once
 * a pass has produced that many bytes, so a flood of small requests for large whole-document Changes
 * is never held in memory at once.
 */
import type { NewChange } from '../engine'
import { bornClosed, type ChangeStore } from './changes'
import { documentOnlyView } from './document-only-workspace'
import { intendedForRecord, proposeOutsideChange, type OutsideChangeFields } from './outside-change'
import { intendedPathOf } from './outside-change-fields'
import { requestTime, type WriteRequest } from './cli/request-format'
import {
  MAX_CHANGES_PER_REQUEST, MAX_REFUSED_OUTSIDE_RECORDS, MAX_UNDECIDED_PER_SOURCE, MAX_UNDECIDED_OUTSIDE_BYTES, MAX_UNDECIDED_OUTSIDE_CHANGES, OUTSIDE_AUTHORS, REFUSED_PATH_SHOWN_CHARS, bytesOf, declaredSource, type OutsideSource,
} from './cli/review-format'
import type { Workspace } from './workspace'

export type WaitingRequest = { id: string; request: WriteRequest }

export type IngestOutcome =
  /** Pending in the review dock now (`repeat`: it already was, from an earlier look). */
  | { kind: 'filed'; id: string; path: string; source: OutsideSource; changes: Array<{ id: string; summary: string }>; repeat: boolean }
  /** Refused by validation: recorded closed with `reason`, never acceptable. `recorded` is false when
   *  the ledger already keeps as many records of refused requests as it may: then there is no record. */
  | { kind: 'closed'; id: string; path: string; source: OutsideSource; reason: string; repeat: boolean; recorded: boolean }
  /** Not added: the ledger has no room (in all, or for this source). `undecided` and `ofSource` are
   *  what it holds. The executor refuses it if a command is waiting, and otherwise leaves it in the inbox. */
  | { kind: 'full'; id: string; source: OutsideSource; undecided: number; ofSource: number; because: 'all' | 'source' | 'bytes' }

/** A sender's clock may run ahead; a request is never recorded as made later than it was added. */
const madeAt = (id: string, nowMs: number): number => Math.min(requestTime(id) ?? nowMs, nowMs)

/**
 * Validate `requests` (oldest first, as given) and add them to `changes` in one write. Throws only
 * what the Change store throws (the Collection may not be written just now): then nothing was added
 * and every request is still in the inbox.
 */
export async function addOutsideRequests(input: { requests: WaitingRequest[]; workspace: Workspace; changes: ChangeStore; now: () => Date }): Promise<IngestOutcome[]> {
  const { requests, workspace, changes } = input
  const view = documentOnlyView(workspace).workspace
  const nowMs = input.now().getTime()
  const entries: Array<{ requestId: string; changes: NewChange[] }> = []
  const facts = new Map<string, { path: string; source: OutsideSource; reason?: string }>()
  const left = new Set<string>()
  let produced = 0
  for (const { id, request } of requests) {
    if (produced > MAX_UNDECIDED_OUTSIDE_BYTES) { left.add(id); continue }
    const args = request.args as Record<string, unknown>
    const source = declaredSource(args.source)
    const stamp = (index: number, count: number): Pick<NewChange, 'provenance' | 'isCorrection' | 'author' | 'ts'> & OutsideChangeFields => ({
      provenance: 'agent', isCorrection: false, author: { ...OUTSIDE_AUTHORS[source] }, ts: nowMs,
      outsideSource: source, outsideRequest: { id, index, count, at: madeAt(id, nowMs) },
    })
    const proposal = await proposeOutsideChange(view, request.operation, args, workspace)
    if (proposal.ok) {
      const drafts: NewChange[] = proposal.changes.map((draft, index) => ({ ...draft, ...stamp(index + 1, proposal.changes.length) }))
      produced += drafts.reduce((sum, draft) => sum + bytesOf(draft.oldText) + bytesOf(draft.newText), 0)
      entries.push({ requestId: id, changes: drafts })
      facts.set(id, { path: proposal.path, source })
    } else {
      const refused: NewChange & OutsideChangeFields = {
        path: proposal.path === '' ? '(no document named)' : proposal.path.slice(0, REFUSED_PATH_SHOWN_CHARS), editClass: 'content', category: 'other', summary: proposal.summary,
        oldText: '', newText: '', ...stamp(1, 1), outsideRefused: true, outsideIntended: intendedForRecord(proposal.intended),
      }
      entries.push({ requestId: id, changes: [bornClosed(refused, proposal.reason, proposal.code, nowMs)] })
      facts.set(id, { path: proposal.path, source, reason: proposal.reason })
    }
  }
  const results = entries.length === 0 ? [] : await changes.addOutside(entries, { maxUndecided: MAX_UNDECIDED_OUTSIDE_CHANGES, maxUndecidedBytes: MAX_UNDECIDED_OUTSIDE_BYTES, maxRefused: MAX_REFUSED_OUTSIDE_RECORDS, maxPerSource: MAX_UNDECIDED_PER_SOURCE, maxPerRequest: MAX_CHANGES_PER_REQUEST })
  const byRequest = new Map(results.map((result) => [result.requestId, result]))
  return requests.map(({ id }): IngestOutcome => {
    const result = byRequest.get(id)
    const fact = facts.get(id)
    const source = fact?.source ?? 'outside-agent'
    if (left.has(id) || !result || !fact) return { kind: 'full', id, source, undecided: MAX_UNDECIDED_OUTSIDE_CHANGES, ofSource: 0, because: 'bytes' }
    if (result.outcome === 'full') return { kind: 'full', id, source, undecided: result.full?.undecided ?? 0, ofSource: result.full?.ofSource ?? 0, because: result.full?.because ?? 'all' }
    if (result.outcome === 'dropped') return { kind: 'closed', id, path: fact.path, source: fact.source, reason: fact.reason ?? `The request carries more changes than one request may (${MAX_CHANGES_PER_REQUEST}).`, repeat: false, recorded: false }
    const repeat = result.outcome === 'repeat'
    // What the ledger holds decides what is reported, also for a repeat: the record made the first time.
    const closed = result.changes.find((change) => change.status === 'rejected' && (change as { closedReason?: unknown }).closedReason !== undefined && (change as OutsideChangeFields).outsideRefused === true)
    if (closed) return { kind: 'closed', id, path: intendedPathOf(closed), source: fact.source, reason: String((closed as { closedReason?: unknown }).closedReason), repeat, recorded: true }
    return { kind: 'filed', id, path: result.changes[0]?.path ?? fact.path, source: fact.source, changes: result.changes.map((change) => ({ id: change.id, summary: change.summary })), repeat }
  })
}
