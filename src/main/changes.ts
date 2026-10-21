import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import { isHiddenWorkspacePath, type Workspace } from './workspace'
import { minimiseProposedReplacement } from './proposed-replacement'
import {
  createChangeIdFactory,
  matchesScope,
  parseChangeLine,
  serializeChanges,
  type Change,
  type ChangeIdFactory,
  type ChangeScope,
  type ChangeStatus,
  type EditClass,
  type NewChange,
} from '../engine'

export {
  createChangeIdFactory,
  matchesScope,
  parseChangeLine,
  serializeChanges,
  type Change,
  type ChangeIdFactory,
  type ChangeScope,
  type ChangeStatus,
  type EditClass,
  type EditSession,
  type EditSessionStatus,
  type NewChange,
  type Provenance,
} from '../engine'
import { assertCollectionWritable } from './collection-write-gate'
import { isRefusedOutsideChange, outsideRequestOf, outsideSourceOf, readerNoteOf } from './outside-change-fields'
import { closedCodeOf, type ClosedCode } from '../shared/closed-code'
import { NOT_A_DOCUMENT_PATH_LABEL, type OutsideChangeFields, type ReaderHeard, type ReaderReply } from '../shared/outside-source'

export { CLOSED_CODES, closedCodeOf, type ClosedCode } from '../shared/closed-code'

/**
 * "Closed with a reason": the final state of a Change that could not be placed (its target text has
 * gone or repeats, its file has gone) or whose path is not a document the sidebar would show. It is
 * stored as `status: 'rejected'` plus these two fields, not as a fifth status: the shared ledger
 * parser drops a line whose status it does not know, and the store rewrites the journal from what it
 * parsed, so a new status written by this build would be deleted from history by any older build that
 * opened the Collection. `rejected` is already "not pending, not accepted" for every reader; the extra
 * fields pass through the parser untouched. Read them with `closedReasonOf`.
 *
 * `closedCode` says the same thing as `closedReason` from a closed list (shared/closed-code.ts), for
 * the review dock, which shows its own sentence per code. Every place that closes a Change sets it;
 * a record closed before the code existed has none and reads as `other` (`closedCodeOf`).
 */
export type ChangeClosure = { closedReason?: string; closedAt?: number; closedCode?: ClosedCode }

/**
 * The words the shortening to the word (proposed-replacement.ts) trimmed off an agent's replacement,
 * either side of the recorded `oldText` (ticket 14): "Most reading lists" → "Most lists" is recorded as
 * `reading ` → `` with `before: 'Most '`, `after: 'lists'`; a pure addition ("Most lists" → "Most reading
 * lists") as `` → `reading ` with the same two. Kept at ingest so an Accept long after the live proposal
 * has gone finds the one place it was made (recorded-placement.ts). Like `ChangeClosure`, an extra field
 * the ledger parser passes through untouched; absent on records made before it and on records never
 * shortened (a reader's edit is filed already grown to a span that stands once). Read it with `anchorContextOf`.
 */
export type AnchorContext = { anchorContext?: { before: string; after: string } }

/** The words trimmed either side of a record's `oldText`, or null when none are on record. Tolerates any record. */
export function anchorContextOf(change: object): { before: string; after: string } | null {
  const context = (change as AnchorContext).anchorContext as unknown
  if (!context || typeof context !== 'object') return null
  const { before, after } = context as { before?: unknown; after?: unknown }
  if (typeof before !== 'string' || typeof after !== 'string' || (before === '' && after === '')) return null
  return { before, after }
}

/**
 * A Change over the WHOLE document (restore a version, set frontmatter or status, attach a source,
 * from outside: outside-change.ts `wholeDocument`). `oldText` is the document as it stood and
 * `newText` what it would become, so it is placed only while the document is exactly `oldText`:
 * never as a passage found somewhere inside a document that has since grown.
 */
export type WholeDocumentChange = { whole?: true }

/** Whether `change` is over the whole document. Tolerates any record. */
export const isWholeDocumentChange = (change: Change | NewChange): boolean => (change as WholeDocumentChange).whole === true

/** Why this Change was closed without being applied, or null when it was not (a writer's own reject
 *  carries no reason). Tolerates any record: a reason of the wrong type or on a non-rejected Change is
 *  not a closure. */
export function closedReasonOf(change: Change): string | null {
  const reason = (change as Change & ChangeClosure).closedReason
  return change.status === 'rejected' && typeof reason === 'string' && reason !== '' ? reason : null
}

/** `change` moved to `status`. A move to a different status re-decides the Change, so its closure
 *  goes (reopening a closed Change makes it an ordinary pending one); the same status keeps it. */
function withStatus(change: Change, status: ChangeStatus): Change {
  if (status === change.status) return change
  const { closedReason: _reason, closedAt: _at, closedCode: _code, ...rest } = change as Change & ChangeClosure
  return { ...rest, status, ...readerDecided(change, Date.now()) }
}

/**
 * A reader's record keeps when the writer last moved its status (0.24 ticket 08): the outcome's time
 * the reader is told, sent as it is however often it is sent. Nothing on any other record.
 */
function readerDecided(change: Change, at: number): { readerDecidedAt?: number } {
  return readerNoteOf(change) ? { readerDecidedAt: at } : {}
}

/** Why a Change at `path` can never be applied or accepted, or null when the path is a document the
 *  sidebar would show. The one rule is `Workspace.classifyPath` (typed path and real location on disk). */
export function documentPathRefusal(ws: Pick<Workspace, 'classifyPath'>, path: string): string | null {
  const verdict = ws.classifyPath(path)
  if (verdict === 'document') return null
  return verdict === 'hidden'
    ? `${path} is in a folder WriteFlex keeps for itself or hides from the sidebar; a change there is never applied.`
    : `${path} is outside this Collection; a change there is never applied.`
}

function closedWith(change: Change, reason: string, code: ClosedCode): Change {
  // Closed again while already closed: the reader's outcome (could not be applied) was decided then, not now.
  const kept = (change as Change & OutsideChangeFields).readerDecidedAt
  const decided = closedReasonOf(change) !== null && typeof kept === 'number' ? { readerDecidedAt: kept } : readerDecided(change, Date.now())
  const closed: Change & ChangeClosure = { ...change, status: 'rejected', closedReason: reason, closedAt: Date.now(), closedCode: code, ...decided }
  return closed
}

/** A new record that is born closed with `reason`: for a request from outside that failed validation. */
export function bornClosed(input: NewChange, reason: string, code: ClosedCode, at = Date.now()): NewChange {
  const closed: NewChange & ChangeClosure = { ...input, status: 'rejected', closedReason: reason, closedAt: at, closedCode: code }
  return closed
}

/** Why this record can never be anything but closed, whatever its path: it is the record of an
 *  outside request that failed validation (outside-change.ts). Null for every other Change. */
function neverAcceptable(change: Change): string | null {
  if (!isRefusedOutsideChange(change)) return null
  const recorded = (change as Change & ChangeClosure).closedReason
  return typeof recorded === 'string' && recorded !== '' ? recorded : 'The request this came from was refused, so it is never applied.'
}

/** One request's Changes for `ChangeStore.addOutside`, and what became of them. */
export type OutsideBatchEntry = { requestId: string; changes: NewChange[] }
export type OutsideBatchResult = {
  requestId: string
  /** `added` now; `repeat` when the ledger already holds this request's Changes; `full` when the
   *  ledger has no room for it (in all, or for its source); `dropped` for a born-closed record past
   *  the limit on those, and for a request that carries more Changes than one request may. */
  outcome: 'added' | 'repeat' | 'full' | 'dropped'
  changes: Change[]
  /** With `full`: how many undecided outside Changes the ledger holds, in all and from this request's source. */
  full?: { undecided: number; ofSource: number; because: 'all' | 'source' | 'bytes' }
}
export type OutsideLimits = { maxUndecided: number; maxUndecidedBytes: number; maxRefused: number; maxPerSource: number; maxPerRequest: number }

/** Not yet decided: pending or held. */
export const undecided = (change: Change): boolean => change.status === 'pending' || change.status === 'held'
/** The text a record carries, for the size limits: its old and new text, and the words kept around them (`AnchorContext`). */
const textBytes = (change: Pick<Change, 'oldText' | 'newText'>): number => {
  const context = anchorContextOf(change)
  return Buffer.byteLength(change.oldText, 'utf8') + Buffer.byteLength(change.newText, 'utf8')
    + (context ? Buffer.byteLength(context.before, 'utf8') + Buffer.byteLength(context.after, 'utf8') : 0)
}

/**
 * A NEW FILE that accepting a Change also writes (the agent's widgets.create: an HTML file beside the document).
 * It rides on the Change record so the Review pane shows the writer the file's workspace-relative path and its
 * full content, and so the accept can be bound to it: the verb writes only bytes whose SHA-256 is `sha256`.
 */
export type NewFilePart = { path: string; content: string; sha256: string }

/** The new-file part of a Change, only if it is intact: strings, and `content` really hashes to `sha256`. */
export function newFilePartOf(change: Change | undefined): NewFilePart | undefined {
  const part = (change as (Change & { newFile?: unknown }) | undefined)?.newFile as Partial<NewFilePart> | undefined
  if (!part || typeof part.path !== 'string' || typeof part.content !== 'string' || typeof part.sha256 !== 'string') return undefined
  if (createHash('sha256').update(Buffer.from(part.content, 'utf8')).digest('hex') !== part.sha256) return undefined
  return { path: part.path, content: part.content, sha256: part.sha256 }
}

const WIDGETS_CREATE = 'widgets.create'

/** Whether a Change is the agent's widgets.create proposal. The record says so by its verb, not by still having
 *  its file part: a record that lost `newFile` is still a widget proposal and is still never applied as a plain edit. */
export function createsAFile(change: Change | undefined): boolean {
  const record = change as (Change & { capability?: unknown; newFile?: unknown }) | undefined
  return record?.capability === WIDGETS_CREATE || record?.newFile !== undefined
}

/** No Change, from any door, targets a hidden folder: `.writeflex/` (this journal lives there), `.bridle/`, `.git/`... */
export function assertChangeTargetsADocument(path: unknown): void {
  if (isHiddenWorkspacePath(path)) throw new Error('A change can only be recorded for a document in a visible folder of the Workspace.')
}

/**
 * `input` with a path `add` would accept. A record born closed (a refused request) whose typed path
 * fails `assertChangeTargetsADocument` (`.writeflex/changes.jsonl`, `../x.md`, `/abs/x.md`) is stored
 * under a fixed label, the typed text kept in `outsideIntended.path`, where only the dock's "could
 * not be applied" list reads it, as text. Any other record with such a path is refused, as `add` refuses it.
 */
function safeOutsidePath(input: NewChange): NewChange {
  if (!isHiddenWorkspacePath(input.path)) return input
  if ((input.status ?? 'pending') !== 'rejected') assertChangeTargetsADocument(input.path)
  const record = input as NewChange & OutsideChangeFields
  const intended = record.outsideIntended ?? { oldText: '', newText: '', cut: false }
  const typed = typeof input.path === 'string' ? input.path : ''
  return { ...record, path: NOT_A_DOCUMENT_PATH_LABEL, outsideIntended: { ...intended, path: typed } } as NewChange
}

/** Hidden per-workspace store dir (WriteFlex-owned metadata, like `.bridle` is Bridle-owned). */
const STORE_DIR = '.writeflex'
const JOURNAL_REL = `${STORE_DIR}/changes.jsonl`
const defaultIdFactory = createChangeIdFactory({ now: () => Date.now(), random: () => Math.random() })

/**
 * File-native Change store (ADR-0010/0011). One JSONL journal per Workspace at `.writeflex/changes.jsonl`,
 * the source of truth for every ledger surface. All writes go through the Workspace guard and are atomic
 * (temp-file + rename); every operation is SERIALISED through one promise chain (`#run`) so concurrent
 * captures — fire-and-forget writer edits, agent suggestion ingest, accept/reject from the dock — never
 * race and lose a record. A lost change record is lost history, so the same care ScrapStore takes applies.
 */
export class ChangeStore {
  #queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly ws: Workspace,
    private readonly makeId: ChangeIdFactory = defaultIdFactory,
  ) {}

  /** The Collection this ledger belongs to. */
  get root(): string {
    return this.ws.root
  }

  /** The write-side mirror of `parseChangeLine`: never persist a record a later read would reject as
   *  corrupt (and silently drop). A mutation reached through IPC carries only TypeScript's word that its
   *  enums are in-union; a stale or hand-rolled caller passing `status:'done'` or `editClass:'style'`
   *  would otherwise orphan the record on the next list/reopen. Validating here, before any write, means
   *  a bad payload fails loudly instead of eating history — and covers every caller, not just the bridge. */
  #assertWellFormed(change: Change): void {
    if (!parseChangeLine(JSON.stringify(change))) {
      throw new Error('Refusing to persist a malformed change record.')
    }
  }

  /**
   * `change` moved to `status`, under the rule every status door shares: a Change whose path is not
   * a document the sidebar would show can only end rejected. Asked to make it anything else, the
   * store closes it with the path as the reason, whatever its status was. The same holds for the
   * record of an outside request that failed validation: it is closed again with its own reason.
   */
  #moved(change: Change, status: ChangeStatus): Change {
    if (status === 'rejected') return withStatus(change, status)
    // A refused request's record keeps the code it was born with; the path rule has its own.
    const never = neverAcceptable(change)
    if (never) return closedWith(change, never, closedCodeOf(change))
    const refusal = documentPathRefusal(this.ws, change.path)
    return refusal ? closedWith(change, refusal, 'not-a-document') : withStatus(change, status)
  }

  /**
   * A door the WINDOW writes the ledger through (a status set from the review pane, the clearing of
   * what came from outside, a writer's Change refreshed, a class set): one turn of the Collection's
   * write turn (collection-write-turn.ts), so it runs before or after a decision on a Change
   * (`WorkspaceAgent.resolveChange`, which holds the turn from its status read to its status write),
   * never inside one: a reject made while an accept is in flight is applied after it, not overwritten.
   */
  #door<T>(op: () => Promise<T>): Promise<T> {
    return this.ws.exclusiveAll(() => this.#run(op))
  }

  #run<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(() => op())
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Read + parse the journal (skips corrupt lines). Empty when the store has never been written. */
  async #readAll(): Promise<Change[]> {
    const abs = this.ws.absolute(JOURNAL_REL)
    if (!existsSync(abs)) return []
    const raw = await readFile(abs, 'utf8')
    const out: Change[] = []
    for (const line of raw.split('\n')) {
      const change = parseChangeLine(line)
      if (change) out.push(change)
    }
    return out
  }

  /** Atomic journal write: stage to a sibling temp file, then rename over the target (atomic on one
   *  filesystem), so a crash mid-write can never leave a truncated journal.
   *  Why this needs no checked append (checked-store-append.ts): `rename` replaces whatever stands at
   *  the target, a link included, instead of following it, and the staged name is random, so no file
   *  planted at either name is ever written through. */
  async #writeAll(changes: Change[]): Promise<void> {
    assertCollectionWritable(this.ws.root)
    const abs = this.ws.absolute(JOURNAL_REL)
    await mkdir(this.ws.absolute(STORE_DIR), { recursive: true })
    const tmp = `${abs}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, serializeChanges(changes), 'utf8')
    await rename(tmp, abs)
  }

  /** Every change in the store (newest last, as recorded), narrowed by `scope`. */
  async list(scope?: ChangeScope): Promise<Change[]> {
    return this.#run(async () => (await this.#readAll()).filter((c) => matchesScope(c, scope)))
  }

  async get(id: string): Promise<Change | undefined> {
    return this.#run(async () => (await this.#readAll()).find((c) => c.id === id))
  }

  /** Append a new change, assigning a unique id, a timestamp, and a default 'pending' status. A `newFile`
   *  part on the input is dropped: only addWithNewFile attaches one (the renderer's changes:add cannot). */
  async add(input: NewChange): Promise<Change> {
    const { newFile: _dropped, capability: _verb, ...plain } = input as NewChange & { newFile?: unknown; capability?: unknown }
    return this.#add(plain as NewChange)
  }

  /** The agent's proposal that also creates a file: the Change plus the file the writer must be shown. In-process only. */
  async addWithNewFile(input: NewChange, newFile: NewFilePart): Promise<Change> {
    const { newFile: _dropped, capability: _verb, ...plain } = input as NewChange & { newFile?: unknown; capability?: unknown }
    return this.#add({ ...plain, capability: WIDGETS_CREATE, newFile: { path: newFile.path, content: newFile.content, sha256: newFile.sha256 } } as NewChange)
  }

  async #add(input: NewChange): Promise<Change> {
    assertChangeTargetsADocument(input.path)
    return this.#run(async () => {
      const existing = await this.#readAll()
      const taken = new Set(existing.map((c) => c.id))
      const filed: Change = {
        ...input,
        id: this.makeId(taken),
        ts: input.ts ?? Date.now(),
        category: input.category ?? null,
        status: input.status ?? 'pending',
      }
      // A record may be filed pending for any path (accept is where it is judged and closed), but it
      // is never born accepted or held for a path that is not a document.
      const change = filed.status === 'pending' ? filed : this.#moved(filed, filed.status)
      this.#assertWellFormed(change)
      await this.#writeAll([...existing, change])
      return change
    })
  }

  /**
   * Add the Changes of many outside requests in ONE write of the journal (hundreds of requests that
   * waited while the app was closed are one batch, not hundreds of rewrites). Each entry is one
   * request; its Changes carry the request's id (`outsideRequest.id`).
   *  - A request whose id the ledger already carries is a `repeat`: nothing is added, and the Changes
   *    already there are returned. This is what makes "a request read twice is added once" hold
   *    after a crash, whatever else was lost.
   *  - Undecided outside Changes are bounded (`limits`), as ONE pool with a share per source: an
   *    entry that would take the ledger past the count, the bytes of text, or its own source's
   *    share is `full` and nothing of it is written. Each entry is judged by itself, so one source
   *    at its share does not stop another's. An entry with more Changes than one request may carry
   *    is `dropped`. A record born closed is small and is not counted there; the records of refused
   *    requests have their own limit (`maxRefused`), past which such an entry is `dropped`: not
   *    written, so a flood of bad requests cannot grow the ledger without end.
   *  - A record is never born accepted or held for a path that is not a document, as in `add`.
   *  - No record is stored under a path `add` would refuse: a refused request's typed path that is
   *    hidden or outside the Collection is kept as text beside a fixed label (`safeOutsidePath`).
   * Entries are taken in order. One malformed record refuses the whole batch before any write.
   */
  async addOutside(entries: OutsideBatchEntry[], limits: OutsideLimits): Promise<OutsideBatchResult[]> {
    return this.#run(async () => {
      const existing = await this.#readAll()
      const taken = new Set(existing.map((c) => c.id))
      const byRequest = new Map<string, Change[]>()
      let count = 0
      let bytes = 0
      let refused = 0
      const perSource = new Map<string, number>()
      for (const change of existing) {
        const source = outsideSourceOf(change)
        if (source === null) continue
        if (undecided(change)) perSource.set(source, (perSource.get(source) ?? 0) + 1)
        if (isRefusedOutsideChange(change)) refused += 1
        const request = outsideRequestOf(change)?.id
        if (request !== undefined) byRequest.set(request, [...(byRequest.get(request) ?? []), change])
        if (undecided(change)) { count += 1; bytes += textBytes(change) }
      }
      const added: Change[] = []
      const results: OutsideBatchResult[] = []
      for (const entry of entries) {
        const before = byRequest.get(entry.requestId)
        if (before) { results.push({ requestId: entry.requestId, outcome: 'repeat', changes: before }); continue }
        const open = entry.changes.filter((input) => (input.status ?? 'pending') !== 'rejected')
        if (entry.changes.length > limits.maxPerRequest || (open.length === 0 && refused + entry.changes.length > limits.maxRefused)) {
          results.push({ requestId: entry.requestId, outcome: 'dropped', changes: [] })
          continue
        }
        const needs = open.reduce((sum, input) => sum + textBytes(input), 0)
        const source = open.length > 0 ? outsideSourceOf(open[0] as Change) ?? 'outside-agent' : 'outside-agent'
        const ofSource = perSource.get(source) ?? 0
        const because = open.length === 0 ? null
          : count + open.length > limits.maxUndecided ? 'all' as const
          : ofSource + open.length > limits.maxPerSource ? 'source' as const
          : bytes + needs > limits.maxUndecidedBytes ? 'bytes' as const : null
        if (because) {
          results.push({ requestId: entry.requestId, outcome: 'full', changes: [], full: { undecided: count, ofSource, because } })
          continue
        }
        const filed = entry.changes.map((typed) => {
          const input = safeOutsidePath(typed)
          const id = this.makeId(taken)
          taken.add(id)
          const record: Change = { ...input, id, ts: input.ts ?? Date.now(), category: input.category ?? null, status: input.status ?? 'pending' }
          const change = record.status === 'pending' ? record : this.#moved(record, record.status)
          this.#assertWellFormed(change)
          return change
        })
        count += open.length
        bytes += needs
        if (open.length > 0) perSource.set(source, ofSource + open.length)
        if (open.length === 0) refused += filed.length
        byRequest.set(entry.requestId, filed)
        added.push(...filed)
        results.push({ requestId: entry.requestId, outcome: 'added', changes: filed })
      }
      if (added.length > 0) await this.#writeAll([...existing, ...added])
      return results
    })
  }

  /**
   * An undecided outside Change follows a rename the app made: `from` (a document, or a folder and
   * everything under it) is now `to`. One write. Changes of any other kind are left as they are: the
   * in-app agent's carry their path in a live proposal as well. Returns how many moved.
   */
  async followRename(from: string, to: string): Promise<number> {
    if (from === '' || to === '' || from === to) return 0
    return this.#run(async () => {
      const all = await this.#readAll()
      let moved = 0
      const next = all.map((change) => {
        if (!undecided(change) || outsideSourceOf(change) === null) return change
        const path = change.path === from ? to : change.path.startsWith(`${from}/`) ? `${to}${change.path.slice(from.length)}` : null
        if (path === null) return change
        moved += 1
        return { ...change, path }
      })
      if (moved > 0) await this.#writeAll(next)
      return moved
    })
  }

  /**
   * The writer's one action to clear what came from outside: reject every undecided Change of one
   * request, or every undecided Change of one source, in ONE write. A plain reject (no closure
   * reason: the writer decided). Decided Changes and every other Change are left as they are.
   */
  async rejectOutside(which: { requestId: string } | { source: string }): Promise<Change[]> {
    return this.#door(async () => {
      const all = await this.#readAll()
      const rejected: Change[] = []
      const next = all.map((change) => {
        if (!undecided(change) || outsideSourceOf(change) === null) return change
        const matches = 'requestId' in which ? outsideRequestOf(change)?.id === which.requestId : outsideSourceOf(change) === which.source
        if (!matches) return change
        const updated = this.#moved(change, 'rejected')
        this.#assertWellFormed(updated)
        rejected.push(updated)
        return updated
      })
      if (rejected.length > 0) await this.#writeAll(next)
      return rejected
    })
  }

  /** Close several undecided Changes in one write, each with its reason and code (see `close`). Unknown ids and decided Changes are skipped. */
  async closeMany(closures: Array<{ id: string; reason: string; code: ClosedCode }>): Promise<Change[]> {
    const wanted = new Map(closures.filter((closure) => closure.reason.trim() !== '').map((closure) => [closure.id, { reason: closure.reason.trim(), code: closure.code }]))
    if (wanted.size === 0) return []
    return this.#run(async () => {
      const all = await this.#readAll()
      const closed: Change[] = []
      const next = all.map((change) => {
        const closure = wanted.get(change.id)
        if (closure === undefined || !undecided(change)) return change
        const updated = closedWith(change, closure.reason, closure.code)
        this.#assertWellFormed(updated)
        closed.push(updated)
        return updated
      })
      if (closed.length > 0) await this.#writeAll(next)
      return closed
    })
  }

  /** Proposed replacements pass through one store-owned seam before they become ledger records. */
  async addProposedReplacement(input: NewChange): Promise<Change | null> {
    const minimal = minimiseProposedReplacement(input)
    return minimal ? this.add(minimal) : null
  }

  async updateWriterChange(id: string, input: NewChange): Promise<Change> {
    assertChangeTargetsADocument(input.path)
    return this.#door(async () => {
      const all = await this.#readAll()
      const index = all.findIndex((c) => c.id === id)
      if (index === -1) throw new Error(`No change with id ${id}.`)
      const current = all[index]
      if (current.provenance !== 'writer') throw new Error('Only writer changes can be refreshed from live writer marks.')
      if (current.snapshotId) return current
      const updated: Change = {
        ...current,
        path: input.path,
        provenance: 'writer',
        editClass: input.editClass,
        category: input.category ?? null,
        summary: input.summary,
        oldText: input.oldText,
        newText: input.newText,
        anchor: input.anchor,
        isCorrection: input.isCorrection,
      }
      this.#assertWellFormed(updated)
      all[index] = updated
      await this.#writeAll(all)
      return updated
    })
  }

  /**
   * Move a change to a new status. For main-process callers that have done what the status claims:
   * `accepted` here means the caller has placed the text (the agent's accept path). The renderer's
   * status-only door is `setReviewStatus`. Throws if the id is unknown.
   */
  async setStatus(id: string, status: ChangeStatus): Promise<Change> {
    return this.#setStatus(id, status, false)
  }

  /**
   * The status-only door (`changes:set-status`): hold, reject, reopen, and settling the writer's own
   * Change. It is not a way to accept: `accepted` is refused for an agent's or reviewer's Change,
   * whose text only Accept (`WorkspaceAgent.resolveChange`) places. The writer's own Change is the
   * named exception, because its text is already in their document when they settle it.
   */
  async setReviewStatus(id: string, status: ChangeStatus): Promise<Change> {
    return this.ws.exclusiveAll(() => this.#setStatus(id, status, true)) // a door of the window: one turn (see `#door`)
  }

  async #setStatus(id: string, status: ChangeStatus, statusOnly: boolean): Promise<Change> {
    return this.#run(async () => {
      const all = await this.#readAll()
      const index = all.findIndex((c) => c.id === id)
      if (index === -1) throw new Error(`No change with id ${id}.`)
      const updated = this.#moved(all[index], status)
      if (statusOnly && updated.status === 'accepted' && updated.provenance !== 'writer') {
        throw new Error('A change that is not the writer\'s own is accepted only by Accept, which places its text.')
      }
      this.#assertWellFormed(updated)
      all[index] = updated
      await this.#writeAll(all)
      return updated
    })
  }

  /**
   * Close a Change that cannot be applied, recording why in words and as a code from the closed list
   * (see `ChangeClosure`). Final: it leaves the pending and held queues and is never accepted. Only
   * an undecided or already-closed Change can be closed; an accepted one is history and is returned
   * untouched. Throws if the id is unknown or the reason is empty.
   */
  async close(id: string, reason: string, code: ClosedCode = 'other'): Promise<Change> {
    const closedReason = reason.trim()
    if (closedReason === '') throw new Error('A closed change needs a reason.')
    return this.#run(async () => {
      const all = await this.#readAll()
      const index = all.findIndex((c) => c.id === id)
      if (index === -1) throw new Error(`No change with id ${id}.`)
      const current = all[index]
      if (current.status === 'accepted') return current
      const updated = closedWith(current, closedReason, code)
      this.#assertWellFormed(updated)
      all[index] = updated
      await this.#writeAll(all)
      return updated
    })
  }

  /** Re-anchor a still-pending move after another recorded move changes the buffer. This updates only
   *  positional metadata; the reviewed source/destination meaning and status remain unchanged. */
  async rebaseMove(
    id: string,
    moveFrom: { from: number; to: number },
    moveTo: { from: number; to: number },
    anchor: { from: number; to: number },
  ): Promise<Change> {
    return this.#run(async () => {
      const all = await this.#readAll()
      const index = all.findIndex((change) => change.id === id)
      if (index === -1) throw new Error(`No change with id ${id}.`)
      const current = all[index]
      if (current.editClass !== 'move' || current.status !== 'pending') {
        throw new Error('Only pending move changes can be re-anchored.')
      }
      const updated: Change = { ...current, moveFrom, moveTo, anchor }
      this.#assertWellFormed(updated)
      all[index] = updated
      await this.#writeAll(all)
      return updated
    })
  }

  /** Lazily classify a writer edit (ADR-0011 D2). Throws if the id is unknown. */
  async setEditClass(id: string, editClass: EditClass): Promise<Change> {
    return this.#door(async () => {
      const all = await this.#readAll()
      const index = all.findIndex((c) => c.id === id)
      if (index === -1) throw new Error(`No change with id ${id}.`)
      const updated: Change = { ...all[index], editClass }
      this.#assertWellFormed(updated)
      all[index] = updated
      await this.#writeAll(all)
      return updated
    })
  }

  /** Finalise a review run into one version snapshot. The caller passes only explicit resolved statuses:
   *  accepted rows are stamped with the version, rejected rows are marked rejected but not stamped, and
   *  rows with no status stay pending for a future version. Rows already assigned to an earlier version
   *  are left untouched. */
  /**
   * The writer's reply on a reader's note or proposed edit (0.24 ticket 08), added to the record and to
   * nothing else: its status, text and anchor stay as they are, so a reply never decides the note and
   * never writes to a piece. Only a record from a reader takes one, and at most READER_REPLIES_MOST of
   * them. The reply comes checked (sharing-reader-replies.ts `readerReplyFor`); it is checked again
   * for shape here. A door of the window: one turn of the Collection's write turn.
   */
  async addReaderReply(id: string, reply: ReaderReply): Promise<Change> {
    if (!isReaderReply(reply) || reply.sent !== undefined || reply.notSent !== undefined) throw new Error('A reply is plain text of 1 to 1000 characters.')
    return this.#door(async () => {
      const all = await this.#readAll()
      const index = all.findIndex((c) => c.id === id)
      if (index === -1) throw new Error(`No change with id ${id}.`)
      const current = all[index] as Change & OutsideChangeFields
      if (!readerNoteOf(current)) throw new Error('Only a reader\'s note or proposed edit takes a reply.')
      const replies = Array.isArray(current.readerReplies) ? current.readerReplies.filter(keptReply) : []
      if (replies.length >= READER_REPLIES_MOST) throw new Error(`A note takes at most ${READER_REPLIES_MOST} replies.`)
      if (replies.some((r) => r.id === reply.id)) return current
      const updated = { ...current, readerReplies: [...replies, { id: reply.id, text: reply.text, at: reply.at, by: reply.by }] } as Change
      this.#assertWellFormed(updated)
      all[index] = updated
      await this.#writeAll(all)
      return updated
    })
  }

  /**
   * What a link's sharing service answered (0.24 ticket 08), for each reader record:
   *  - it holds the note: the outcome it was sent (`heard`), the replies it holds (`replyIds`, marked
   *    sent) and the replies it refused because the note has its 20 (`fullIds`, marked `notSent: full`);
   *  - it no longer holds the note (`gone`): the record is marked `readerGone` and every reply not sent
   *    `notSent: gone`; `readerHeard` stays as it was, because the service holds no outcome.
   * Both final answers end sending. Changes nothing else; a record that is not a reader's, or is gone
   * from the ledger, is skipped. One write.
   */
  async markReaderHeard(acks: ReaderHeardAck[]): Promise<number> {
    const byId = new Map(acks.map((ack) => [ack.id, ack]))
    if (byId.size === 0) return 0
    return this.#run(async () => {
      const all = await this.#readAll()
      let marked = 0
      const next = all.map((change) => {
        const ack = byId.get(change.id)
        if (!ack || !readerNoteOf(change)) return change
        const updated = heardApplied(change, ack)
        this.#assertWellFormed(updated)
        marked += 1
        return updated
      })
      if (marked > 0) await this.#writeAll(next)
      return marked
    })
  }

  /**
   * Clear handled notes answered (review round 1 of ticket 11, F1): the service no longer holds these
   * notes of the link (it cleared them, or did not know them). Each record of them is marked as
   * `markReaderHeard` marks a note the service no longer holds (`readerGone`, its unsent replies
   * `notSent: gone`); a record already marked is left as it is. The link's closed records are then kept
   * within `closedMost` (`boundReaderClosed`). One write. Returns how many records were marked.
   */
  async markReaderNotesGone(shareId: string, keys: readonly string[], at: number, closedMost: number): Promise<number> {
    const wanted = new Set(keys)
    if (wanted.size === 0) return 0
    return this.#run(async () => {
      const all = await this.#readAll()
      let marked = 0
      const next = all.map((change) => {
        const fields = readerNoteOf(change)
        if (!fields || fields.shareId !== shareId || !wanted.has(fields.key) || goneFromService(change)) return change
        const updated = heardApplied(change, { id: change.id, heard: { outcome: null, at: null }, replyIds: [], gone: true, at })
        this.#assertWellFormed(updated)
        marked += 1
        return updated
      })
      const kept = closedWithinBound(next, shareId, closedMost)
      if (marked > 0 || kept.length < next.length) await this.#writeAll(kept)
      return marked
    })
  }

  /**
   * A link's closed reader records (edits that could not be applied, born closed) kept within `most`
   * (review round 1 of ticket 11, F1): past it, the oldest whose note the service no longer holds
   * (`readerGone`: cleared, or answered unknown) are dropped from the ledger first. A record whose note
   * the service still holds is never dropped: it is what keeps the service's copy from being filed
   * twice (its request id). Writes only when something is dropped; returns how many were.
   */
  async boundReaderClosed(shareId: string, most: number): Promise<number> {
    return this.#run(async () => {
      const all = await this.#readAll()
      const kept = closedWithinBound(all, shareId, most)
      if (kept.length < all.length) await this.#writeAll(kept)
      return all.length - kept.length
    })
  }

  async saveVersion(ids: string[], versionId: string, statusById: Record<string, ChangeStatus>): Promise<Change[]> {
    return this.#run(async () => {
      const wanted = new Set(ids)
      const all = await this.#readAll()
      const updated: Change[] = []
      for (let i = 0; i < all.length; i += 1) {
        const current = all[i]
        if (!wanted.has(current.id)) continue
        if (current.snapshotId) continue
        const status = statusById[current.id]
        if (!status) continue
        const moved = this.#moved(current, status)
        const next: Change = moved.status === 'accepted' ? { ...moved, snapshotId: versionId, versionId } : moved
        this.#assertWellFormed(next)
        all[i] = next
        if (next.status === 'accepted') updated.push(next)
      }
      const missing = ids.filter((id) => !all.some((change) => change.id === id))
      if (missing.length > 0) throw new Error('One or more changes disappeared before saving the version.')
      await this.#writeAll(all)
      return updated
    })
  }
}

/** One reader record's answer from its link's service (see `ChangeStore.markReaderHeard`). */
export type ReaderHeardAck = { id: string; heard: ReaderHeard; replyIds: readonly string[]; fullIds?: readonly string[]; gone?: boolean; at: number }

/** A reader record with its link's service's answer applied (`ChangeStore.markReaderHeard`). */
function heardApplied(change: Change, ack: ReaderHeardAck): Change {
  const current = change as Change & OutsideChangeFields
  const sent = new Set(ack.replyIds)
  const full = new Set(ack.fullIds ?? [])
  const waiting = (r: ReaderReply): boolean => r.sent === undefined && r.notSent === undefined
  const replies = Array.isArray(current.readerReplies)
    ? current.readerReplies.filter(keptReply).map((r): ReaderReply => {
      if (!waiting(r)) return r
      if (ack.gone) return { ...r, notSent: 'gone' }
      if (sent.has(r.id)) return { ...r, sent: ack.at }
      if (full.has(r.id)) return { ...r, notSent: 'full' }
      return r
    })
    : undefined
  return ack.gone
    ? { ...current, readerGone: ack.at, ...(replies ? { readerReplies: replies } : {}) } as Change
    : { ...current, readerHeard: { outcome: ack.heard.outcome, at: ack.heard.at }, ...(replies ? { readerReplies: replies } : {}) } as Change
}

/** A reader record whose note its link's service no longer holds. */
const goneFromService = (change: Change): boolean => typeof (change as Change & OutsideChangeFields).readerGone === 'number'

/** `changes` with the link's closed reader records kept within `most` (`ChangeStore.boundReaderClosed`); the journal's order kept. */
function closedWithinBound(changes: readonly Change[], shareId: string, most: number): Change[] {
  const closed = changes.filter((change) => isRefusedOutsideChange(change) && readerNoteOf(change)?.shareId === shareId)
  const over = closed.length - most
  if (over <= 0) return [...changes]
  // Oldest first: the journal keeps records in the order they were filed.
  const dropped = new Set(closed.filter(goneFromService).slice(0, over).map((change) => change.id))
  return changes.filter((change) => !dropped.has(change.id))
}

/** Replies one reader's note keeps at most (the sharing service's OUTCOME_LIMITS.repliesPerNote). */
export const READER_REPLIES_MOST = 20
/** A reply's most characters (the service's OUTCOME_LIMITS.replyChars; the reply box says "of 1,000"). */
export const READER_REPLY_CHARS = 1000
const REPLY_ID = /^[A-Za-z0-9_-]{8,64}$/

/**
 * A writer's reply as the ledger keeps it. Tolerates any value. A reply both confirmed held (`sent`) and
 * refused (`notSent`) contradicts itself and is not one: never counted as sent, never sent again.
 */
export function isReaderReply(value: unknown): value is ReaderReply {
  return replyShape(value) && !((value as ReaderReply).sent !== undefined && (value as ReaderReply).notSent !== undefined)
}

/**
 * A reply the ledger keeps on rewrite: any well-shaped reply, a contradictory one too (the writer's
 * words are never dropped; the card shows it as refused, the sender skips it).
 */
const keptReply = (value: unknown): value is ReaderReply => replyShape(value)

function replyShape(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as Record<string, unknown>
  return typeof r.id === 'string' && REPLY_ID.test(r.id) && typeof r.text === 'string' && r.text.trim() !== '' && r.text.length <= READER_REPLY_CHARS
    && typeof r.at === 'number' && Number.isSafeInteger(r.at) && r.at > 0 && typeof r.by === 'string' && r.by.length <= 200
    && (r.sent === undefined || (typeof r.sent === 'number' && Number.isFinite(r.sent)))
    && (r.notSent === undefined || r.notSent === 'full' || r.notSent === 'gone')
}

/** Whether a workspace-relative path names the Change journal (any case, any `./` or doubled separators). The
 *  editor's save refuses it: the journal is written by ChangeStore alone. */
export function isChangeJournalPath(path: string): boolean {
  return typeof path === 'string' && posix.normalize(path.replace(/\\/g, '/')).replace(/^\.\//, '').toLowerCase() === JOURNAL_REL
}

/** The workspace-relative journal path (exported for tests + tooling). */
export function changeJournalPath(): string {
  return posix.normalize(JOURNAL_REL)
}
