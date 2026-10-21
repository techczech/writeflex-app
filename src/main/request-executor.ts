/**
 * The app's side of "when WriteFlex has the Collection open, the app carries out the command line's
 * writes" (specification sections 4 and 5; request-format.ts for the files). `RequestExecutor.drain`
 * reads the inbox once and answers every request in it. It needs no window: the running app calls it
 * from a watch on the inbox (request-inbox-watch.ts) and tests call it directly.
 *
 * THE INBOX IS UNTRUSTED. Any program that can write the folder, and on a synced folder any other
 * machine, can place a file there. So:
 *  - the inbox and the outbox are used only if each is an ordinary folder at its own place under
 *    `.writeflex`; each is opened once per look at the inbox and verified to be that same folder
 *    before every read, write and removal (request-files.ts, which also states the window Node leaves
 *    open); otherwise nothing is read and nothing is written;
 *  - NOTHING IN THE COLLECTION SAYS WHAT THE APP HAS DONE. The record of handled requests and the
 *    answers that could not be delivered are kept in the app's own application data
 *    (collection-records.ts), with the app's own undo journal for the changes it makes on request.
 *    None of them is read from anywhere else: not from the Collection, and not from the command
 *    line's own folder in application data, which a sandboxed agent may be allowed to write. A
 *    requested `undo` therefore acts only on a change this app made. A file placed in the Collection can therefore
 *    never be answered from, never be signed as the app's answer, and never undo anything: the only
 *    thing the app signs is an answer it has just made, or one it stored itself outside the Collection;
 *  - only a regular file named exactly `<id>.json` is a request (or `<id>.json.taken`, the name the
 *    app itself gives one it has claimed: request-claims.ts). It is read without following a link
 *    and under a size cap applied before reading. Anything else (a sync conflict copy, a link, a
 *    stray file) is ignored and reported, never acted on;
 *  - EVERY FOLDER IS LISTED UP TO A COUNT AND NO FURTHER. One look takes at most 2,000 directory
 *    entries of the inbox, and as many of the outbox and of each folder of records when it clears
 *    them (request-prune.ts), whatever the folders hold; `cut` in the result names a folder whose
 *    listing stopped there. Which entries a cut listing holds is the file system's order: an inbox
 *    holding more than the count may keep a request out of sight until it is cleared. What the
 *    executor remembers between looks is kept to a count too, the oldest forgotten first;
 *  - a request is checked against the closed schema (unknown fields, operations, arguments and wrong
 *    types are refused), must be recent, and every path it names is judged with the document-path
 *    rule before the operation starts;
 *  - the operation then runs with the command line's own operation code over the document-only view
 *    of the app's one Workspace (document-only-workspace.ts), so every read, save, create, move and
 *    path resolve is judged again where it happens, and every write is made by the WriteSession's
 *    primitives (cli/guarded-fs.ts), which judge the path once more at the write and never write
 *    through a link. Nothing a request can ask for writes outside the Collection: export is not a
 *    requestable operation, so the executor has no code that does. None of the Workspace's by-name writers (rename file, rename folder, create
 *    folder, duplicate) and no ScrapStore method is called.
 *
 * Every change the executor makes asks the shared Collection write gate (each WriteSession primitive
 * and each journal write does). A request that arrives while the app does not hold the Collection is
 * answered as refused. Replies are the app's own mail, not Collection content, and the
 * handled-request record is not in the Collection at all: they are written even then, which is what
 * lets the refusal be told.
 *
 * ONE REQUESTABLE OPERATION WRITES THE APP'S STORES AND NOT A DOCUMENT: `save-version`. It is not
 * made by the WriteSession. The executor hands it to `saveVersion`, which the app wires to its own
 * version and review stores and its agent's snapshot store (saved-text-version.ts). The request names
 * a document path, a name and a note; the author is the app's, the stores are the app's, the text is
 * what is saved on disk, and no Change is accepted or stamped on the way: a document with Changes the
 * app's own "Save version" would settle is refused with their number.
 *
 * A REQUEST IS ACTED ON ONCE ON THIS MAC. Before acting, its id is recorded as started in the app's
 * application data; after, the reply is stored there, then written to the outbox, then the request is
 * removed. The record is looked for in the release app's folder and the beta's, and written to this
 * app's own. Another Mac sharing the folder through sync has its own records and knows nothing of
 * these. A REQUEST IS CLAIMED BEFORE IT IS READ: renamed to `<id>.json.taken` in the inbox, which is
 * what lets `writeflex withdraw` tell a request not yet read from one being added
 * (request-claims.ts, which also says what becomes of a claimed file when the app stops). A request met again (the app stopped before clearing it) gets the stored
 * reply and is not carried out again; one found started and never finished is answered as refused,
 * pointing at the undo journal, where a change cut short is on record as interrupted. Records are
 * pruned after seven days; a request older than fifteen minutes is refused as expired, so a pruned
 * record can never let an old request through.
 *
 * SHOWN-FIRST REQUESTS ARE NEVER CARRIED OUT. A request that would change an existing document
 * (cli/review-format.ts) becomes a pending Change in the review ledger, for the writer to accept or
 * reject; the document is not touched. All of them found in one look are validated from scratch and
 * added in one write of the ledger (outside-change-ingest.ts). They do not expire, so a request filed
 * while the app was closed is added when the Collection is next opened. One look reads at most 500
 * request files and 16 MiB of them, oldest first, and leaves the rest for the next look.
 *
 * A failed operation is put back before the reply is written (cli/write-access.ts), so a refused
 * request is never left partly applied, WHILE THE APP STILL HOLDS THE COLLECTION. Once it does not,
 * nothing more is written to a document, putting back included: the change stays on record in the
 * app's own undo journal as interrupted, and the answer (`owner-lock-lost`) says what had been
 * changed. A file is put back only if it holds exactly what the request wrote to it.
 */
import { statSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { WritesPausedError } from './collection-write-gate'
import type { PathKind } from './document-path'
import { documentOnlyView } from './document-only-workspace'
import { NotADocumentPathError, type Workspace } from './workspace'
import type { WriteSeams } from './cli/guarded-fs'
import { HANDLED_KIND, UNDELIVERED_KIND, holdOtherRecords, holdRecords, recordsPlaceBeside, type RecordsPlace } from './collection-records'
import { Journal } from './cli/journal'
import { CliError, type Operation } from './cli/operation'
import { FolderNotUsableError, holdFolder, keepUpTo, privateFolder, rememberUpTo, type HeldFolder, type HeldWriteSeams } from './cli/request-files'
import {
  INBOX_DIR, MAX_REPLY_BYTES, MAX_REQUEST_BYTES, OUTBOX_DIR, idOfClaimedName, idOfFileName, looksLikeConflictCopy, parseReply, parseRequest,
  requestFileName, requestTime, type Reply, type RequestOperation, type WriteRequest,
} from './cli/request-format'
import { InboxClaims } from './request-claims'
import { HANDLED_KEEP_MS, STALE_FILE_MS, pruneRequestFolders, removeIfStale, type ListedFolder } from './request-prune'
import type { TrashMover } from './cli/system-trash'
import { quoted } from './cli/terminal-text'
import { replyMac } from './reply-key'
import { buildOperationTable } from './cli/table'
import { runWithAccess, type SharingFollow } from './cli/write-access'
import type { VersionSaveInput } from './cli/history-store'
import { VersionSaveRefused, type SavedTextVersion } from './saved-text-version'
import type { ChangeStore } from './changes'
import type { OutsideLook } from '../shared/outside-source'
import { addOutsideRequests, type IngestOutcome, type WaitingRequest } from './outside-change-ingest'
import {
  DEFERRED_RETRY_MS, MAX_CHANGES_PER_REQUEST, MAX_ENTRIES_LISTED, MAX_NAMES_REMEMBERED, MAX_UNDECIDED_PER_SOURCE, MAX_REFUSED_OUTSIDE_RECORDS, MAX_REQUESTS_PER_PASS, MAX_REQUEST_BYTES_PER_PASS, MAX_UNDECIDED_OUTSIDE_BYTES, MAX_UNDECIDED_OUTSIDE_CHANGES,
  OUTSIDE_AUTHORS, REPLY_WORTH_MS, isShownFirst,
} from './cli/review-format'
import { WriteSession, sessionWorkspace } from './cli/write-session'

/**
 * The operations that save a version when carried out, and so need the app's history store (its
 * agent's snapshot store) and an author: `save-version` itself, and `create`, which records the
 * creation as a first version (cli/agent-created-hook.ts). They are the only two that call
 * `WriteAccess.saveVersion`; no other request waits for the agent.
 */
export const OPERATIONS_SAVING_A_VERSION: ReadonlySet<string> = new Set(['save-version', 'create'])

export const REQUEST_MAX_AGE_MS = 15 * 60_000
/** A sender's clock may run ahead of this one's by this much. */
export const REQUEST_MAX_AHEAD_MS = 5 * 60_000
export { HANDLED_KEEP_MS, STALE_FILE_MS }

export type IgnoredFile = { name: string; why: 'conflict-copy' | 'not-a-request' }
export type HandledRequest = { id: string; outcome: Reply['outcome']; reason?: string; operation?: string; repeat: boolean }
/**
 * What one look at the inbox did with the shown-first requests in it (outside-change-ingest.ts), and
 * what it left: the look as the dock is given it (`OutsideLook`, shared/outside-source.ts) plus each
 * request's outcome. `left` requests are still in the inbox, untouched, for a later look.
 */
export type ReviewPass = OutsideLook & { outcomes: IngestOutcome[] }
/** `cut` is present when a folder held more entries than one look lists (2,000): it names each such folder. */
export type DrainResult = { handled: HandledRequest[]; ignored: IgnoredFile[]; review?: ReviewPass; cut?: ListedFolder[] }

export type RequestExecutorOptions = {
  /** The app's one Workspace for the Collection. The executor only ever acts through a document-only view of it. */
  workspace: Workspace
  /** This app's own application-data folder (Electron's `userData`). The handled-request records, the
   *  undelivered answers and the undo journal for this Collection are kept under it
   *  (collection-records.ts); the other variant's folder beside it is read, never written. */
  appData: string
  /** This Collection's reply key (reply-key.ts), made when the app took ownership; null when there is none.
   *  Every reply is signed with it. Without it nothing is carried out: the command line could not verify the answer. */
  replyKey: () => Promise<Buffer | null>
  /** Whether this app holds the Collection now. False while its owner lock is lost to another owner. */
  ownsCollection: () => boolean
  /** Whether this app holds the Collection's owner lock now, whatever its windows are bound to. Asked
   *  before a failed request's writes are put back: a window that closed mid-request no longer "owns"
   *  the Collection in the sense above, yet the app keeps the lock until `dispose` has resolved, and
   *  under it the putting back is safe. Default: `ownsCollection`. */
  holdsLock?: () => boolean
  /** Moves a real path to the system Trash (Electron's `shell.trashItem` in the app). */
  trash: TrashMover
  now?: () => Date
  /** Run one request's work in the app's own queue for writers that read, change and rewrite a file
   *  (the scrap store's) and as one turn of the Collection's write turn. `operation` is the request's:
   *  the app waits for its agent first only for `OPERATIONS_SAVING_A_VERSION` (collection-write-order.ts). */
  exclusive: <T>(work: () => Promise<T>, operation: string) => Promise<T>
  /** Save a version of a document's saved text into the app's own history stores, through the store
   *  objects the window already holds (saved-text-version.ts); `confirmOwner` throws when the app no
   *  longer holds the Collection. Absent (no stores to save into): a requested version save is refused. */
  saveVersion?: (input: VersionSaveInput, confirmOwner: () => Promise<void>) => Promise<SavedTextVersion>
  /** The window's review ledger for this Collection. Shown-first requests become pending Changes in
   *  it (outside-change-ingest.ts); absent, they are left in the inbox. */
  changes?: ChangeStore
  /** Told after a look at the inbox added or closed Changes, or moved their paths, so the dock lists them. */
  onReviewChanged?: (pass: ReviewPass | null) => void
  /** Told what every look that met a proposed change did (also one that added nothing), so it can be kept for the dock. */
  onLook?: (look: OutsideLook) => void
  /** Told the Collection-relative paths a request wrote, moved or trashed, so open tabs and views follow. */
  onChanged?: (paths: string[]) => void
  /** Sharing (ticket 04): told what a requested move or Trash finished, inside the request and before
   *  `onChanged`, so a link follows its piece (or ends) before any save signal names the paths. */
  sharing?: SharingFollow
  /** @internal Test seams. `afterActing` runs once the operation has finished and before its outcome is recorded. */
  seams?: { write?: WriteSeams; afterActing?: () => Promise<void>; beforeRead?: (id: string) => Promise<void>; reply?: HeldWriteSeams; afterReviewAdded?: () => Promise<void> }
}

type HandledRecord = { version: 1; id: string; at: string; reply?: Reply }
/** What one look holds: the two request folders in the Collection, and the records outside it (this app's own, and the other variant's to read). */
type Folders = { inbox: HeldFolder; outbox: HeldFolder; records: HeldFolder; otherRecords: HeldFolder[]; claims: InboxClaims }

/** Which arguments of each operation are Collection paths, and what they are judged as before it starts. */
const PATH_ARGS: Record<RequestOperation, Array<{ arg: string; kind: PathKind | 'either'; root?: boolean }>> = {
  create: [{ arg: 'path', kind: 'file' }],
  'create-folder': [{ arg: 'path', kind: 'folder' }],
  duplicate: [{ arg: 'path', kind: 'file' }],
  note: [{ arg: 'document', kind: 'file' }],
  scrap: [{ arg: 'document', kind: 'file' }],
  'create-manifest': [{ arg: 'folder', kind: 'folder', root: true }],
  capture: [{ arg: 'project', kind: 'either', root: true }],
  move: [{ arg: 'path', kind: 'file' }, { arg: 'to', kind: 'file', root: true }],
  'move-folder': [{ arg: 'path', kind: 'folder' }, { arg: 'to', kind: 'folder', root: true }],
  trash: [{ arg: 'path', kind: 'file' }],
  undo: [],
  'save-version': [{ arg: 'path', kind: 'file' }],
}
/** The arguments of a shown-first request that name a document (as cli/review-waiting.ts reads them). */
const SHOWN_FIRST_PATH_ARGS = ['path', 'source-path'] as const
/** What one look at the inbox may read: so many request files, so many bytes (cli/review-format.ts). */
type LookBudget = { read: number; bytes: number; left: number; because: Set<OutsideLook['leftBecause'][number]> }
function isFolderOnDisk(ws: { absolute: (path: string) => string }, path: string): boolean {
  try { return statSync(ws.absolute(path)).isDirectory() } catch { return false }
}
const CLOSED = 'WriteFlex closed this Collection while the request was being carried out, so it stopped. Run the command again.'
const LOST = 'WriteFlex does not hold this Collection at the moment, so it carried out nothing. Run the command again in a moment.'

export class RequestExecutor {
  readonly #options: RequestExecutorOptions
  readonly #table: Operation[] = buildOperationTable()
  readonly #now: () => Date
  /** Requests answered again from their record in this run, so a file that cannot be removed is not answered for ever. */
  readonly #repeated = new Set<string>()
  /** Shown-first requests the ledger had no room for, and when each may be read again. */
  readonly #deferred = new Map<string, number>()
  readonly #place: RecordsPlace
  #lastLook: OutsideLook | null = null
  #queue: Promise<unknown> = Promise.resolve()
  #disposed = false

  constructor(options: RequestExecutorOptions) {
    this.#options = options
    this.#now = options.now ?? (() => new Date())
    this.#place = recordsPlaceBeside(options.appData)
  }

  /** What the last look that met a proposed change did, for the dock; null before there was one. */
  get lastLook(): OutsideLook | null {
    return this.#lastLook
  }

  get root(): string {
    return this.#options.workspace.root
  }

  /** The inbox folder, made if missing, for whoever watches it. Throws if it cannot be used. */
  async inbox(): Promise<string> {
    return (await privateFolder(this.root, INBOX_DIR, true))!
  }

  /**
   * End this executor: the app is closing the Collection or binding the window to another. From this
   * call on it carries out nothing. A request not yet read is left in the inbox, untouched. The
   * request being carried out, if any, is refused at its next write, what it had written is put
   * back, and it is answered as refused and recorded, so it is never carried out later either.
   * Resolves once nothing of this executor's is running: the caller keeps the Collection's owner
   * lock until then.
   */
  dispose(): Promise<void> {
    this.#disposed = true
    return this.#queue.then(() => {}, () => {})
  }

  /** Why this executor may not write the Collection now, or null. */
  #notOwner(): string | null {
    if (this.#disposed) return CLOSED
    return this.#options.ownsCollection() ? null : LOST
  }

  /** @internal How much is remembered from look to look; never more than MAX_NAMES_REMEMBERED of either. */
  get remembered(): { repeated: number; deferred: number } {
    return { repeated: this.#repeated.size, deferred: this.#deferred.size }
  }

  /** Answer every request now in the inbox, one at a time, oldest first. Calls queue behind one another. */
  drain(): Promise<DrainResult> {
    if (this.#disposed) return Promise.resolve({ handled: [], ignored: [] })
    const result = this.#queue.then(() => this.#drain(), () => this.#drain())
    this.#queue = result.catch(() => {})
    return result
  }

  async #drain(): Promise<DrainResult> {
    const result: DrainResult = { handled: [], ignored: [] }
    const held: HeldFolder[] = []
    const hold = async (dir: string): Promise<HeldFolder> => {
      const folder = (await holdFolder(this.root, dir, true))!
      held.push(folder)
      return folder
    }
    let claims: InboxClaims | null = null
    try {
      const keep = async (folder: HeldFolder): Promise<HeldFolder> => { held.push(folder); return folder }
      const inbox = await hold(INBOX_DIR)
      claims = new InboxClaims(inbox)
      const folders: Folders = {
        inbox, outbox: await hold(OUTBOX_DIR), claims,
        records: await keep((await holdRecords(this.#place.own, this.root, HANDLED_KIND, true))!),
        otherRecords: [],
      }
      for (const other of await holdOtherRecords(this.#place, this.root, HANDLED_KIND)) folders.otherRecords.push(await keep(other))
      const nowMs = this.#now().getTime()
      const budget: LookBudget = { read: 0, bytes: 0, left: 0, because: new Set() }
      for (const [deferred, retryAt] of this.#deferred) if (retryAt <= nowMs) this.#deferred.delete(deferred)
      const waiting: WaitingRequest[] = []
      const cut = new Set<ListedFolder>()
      const done = (): DrainResult => (cut.size > 0 ? { ...result, cut: [...cut].sort() } : result)
      // At most so many entries, whatever the folder holds. Sorted by name, which starts with the time
      // the request says it was made: oldest first among those listed.
      const listing = await inbox.namesUpTo(MAX_ENTRIES_LISTED)
      if (listing.more) cut.add('inbox')
      const met = new Set<string>()
      for (const name of listing.names) {
        if (this.#disposed) return done()
        const claimed = idOfClaimedName(name)
        if (claimed !== null) claims.found(claimed)
        const id = idOfFileName(name) ?? claimed
        if (id === null) {
          if (name.endsWith('.tmp')) await removeIfStale(inbox, name, nowMs) // a request never renamed in
          else result.ignored.push({ name, why: looksLikeConflictCopy(name) ? 'conflict-copy' : 'not-a-request' })
          continue
        }
        // A request standing under both its names is one request.
        if (met.has(id)) continue
        met.add(id)
        const handled = await this.#handle(id, folders, budget, waiting)
        if (handled) result.handled.push(handled)
      }
      if (this.#disposed) return done()
      if (waiting.length > 0 || budget.left > 0) {
        result.review = await this.#addForReview(waiting, folders, budget)
        this.#lastLook = lookOf(result.review)
        try { this.#options.onLook?.(this.#lastLook) } catch { /* telling the window must not stop the look */ }
      }
      if (this.#disposed) return done()
      const undelivered = (): Promise<HeldFolder | null> => holdRecords(this.#place.own, this.root, UNDELIVERED_KIND, false)
      for (const folder of await pruneRequestFolders({ outbox: folders.outbox, records: folders.records, undelivered }, nowMs)) cut.add(folder)
      return done()
    } finally {
      // What this look read and did not settle goes back under its own name (request-claims.ts).
      await claims?.giveBack().catch(() => {})
      for (const folder of held) await folder.close()
    }
  }

  async #handle(id: string, folders: Folders, budget: LookBudget, waiting: WaitingRequest[]): Promise<HandledRequest | null> {
    // Bounded before anything of this request is read: an inbox can hold thousands of planted files.
    // What is past the limit stays where it is for the next look (every two seconds while open).
    if (this.#repeated.has(id)) return null
    if ((this.#deferred.get(id) ?? 0) > this.#now().getTime()) { budget.left += 1; budget.because.add('ledger-full'); return null }
    const size = Math.min((await folders.claims.look(id))?.size ?? 0, MAX_REQUEST_BYTES)
    if (budget.read >= MAX_REQUESTS_PER_PASS || budget.bytes + size > MAX_REQUEST_BYTES_PER_PASS) { budget.left += 1; budget.because.add('look-limit'); return null }
    budget.read += 1
    budget.bytes += size
    const key = await this.#options.replyKey().catch(() => null)
    const finish = async (answer: Reply, extra: { operation?: string; repeat?: boolean } = {}): Promise<HandledRequest> => {
      // Signed here, at the moment it is written, with the key of THIS ownership: a stored reply given
      // again after a restart is signed afresh, and one signed under an earlier key is of no use to anyone.
      const unsigned: Reply = { ...answer, ...(extra.operation && answer.operation === undefined ? { operation: extra.operation } : {}) }
      delete unsigned.mac
      const reply: Reply = key ? { ...unsigned, mac: replyMac(key, unsigned) } : unsigned
      await folders.records.write(requestFileName(id), `${JSON.stringify({ version: 1, id, at: this.#now().toISOString(), reply } satisfies HandledRecord)}\n`)
      await folders.outbox.write(requestFileName(id), `${JSON.stringify(reply)}\n`, this.#options.seams?.reply)
      // unlink never follows a link; a folder standing at the name stays and is not answered again (#repeated).
      await folders.claims.settle(id)
      return { id, outcome: reply.outcome, ...(reply.reason === undefined ? {} : { reason: reply.reason }), ...(extra.operation ? { operation: extra.operation } : {}), repeat: extra.repeat === true }
    }
    const refuse = (reason: string, code: Reply['code'] = 'refused'): Reply => ({ version: 1, id, outcome: 'refused', at: this.#now().toISOString(), reason, code })

    // Met before? Then it is never carried out again.
    const record = await this.#record([folders.records, ...folders.otherRecords], id)
    if (record) {
      if (this.#repeated.has(id)) return null
      rememberUpTo(this.#repeated, id, MAX_NAMES_REMEMBERED)
      const reply = record.reply ?? refuse(
        `WriteFlex stopped while it was carrying out this request (${id}), so it may be partly applied. It was not carried out again. Run "writeflex undo --list": a change that did not finish is listed as interrupted and can be undone.`,
        'failed',
      )
      return finish(reply, { repeat: true })
    }

    await this.#options.seams?.beforeRead?.(id)
    // Claimed, then read: from here `writeflex withdraw` can no longer take it back unseen.
    const read = await folders.claims.take(id, MAX_REQUEST_BYTES)
    if (read.kind === 'missing') return null
    if (read.kind === 'not-claimable') return finish(refuse(`The request file ${requestFileName(id)} could not be taken up to be read (something that is not a file stands at the name WriteFlex gives a request it is reading), so it was not read. Nothing was done.`))
    if (read.kind === 'not-a-file') return finish(refuse(`The request file ${requestFileName(id)} is not an ordinary file, so it was not read. Nothing was done.`))
    if (read.kind === 'too-large') return finish(refuse(`The request file ${requestFileName(id)} is ${read.size} bytes; the limit is ${MAX_REQUEST_BYTES}. It was not read. Nothing was done.`))
    const parsed = parseRequest(read.text, id, this.#table)
    if (!parsed.ok) return finish(refuse(`The request file ${requestFileName(id)} was refused: ${parsed.reason}. Nothing was done.`))
    const { request } = parsed

    // A shown-first request is never carried out and does not expire: it is set aside, and everything
    // set aside in this look is validated and added to the review ledger together (#addForReview).
    // While this app cannot add it (no ledger, the Collection not held), it waits in the inbox.
    if (isShownFirst(request.operation)) {
      if (this.#disposed) return null
      if (!this.#options.changes || this.#notOwner()) { budget.left += 1; budget.because.add('not-held') } else waiting.push({ id, request })
      return null
    }

    const age = this.#now().getTime() - (requestTime(id) ?? 0)
    if (age > REQUEST_MAX_AGE_MS || age < -REQUEST_MAX_AHEAD_MS) {
      return finish(refuse(`The request ${id} was made too long ago to carry out now (or its clock disagrees with this computer's). Nothing was done. Run the command again.`), { operation: request.operation })
    }
    if (!key) return finish(refuse('WriteFlex has no reply key for this Collection, so it could not sign an answer and carried out nothing. Close the Collection in WriteFlex and open it again, then run the command again.', 'failed'), { operation: request.operation })
    // Disposed while this request was being read: it was not started, so it is left as it is.
    if (this.#disposed) return null
    const notOwner = this.#notOwner()
    if (notOwner) return finish(refuse(notOwner), { operation: request.operation })
    const unfit = this.#unfitPath(request)
    if (unfit) return finish(refuse(unfit), { operation: request.operation })

    await folders.records.write(requestFileName(id), `${JSON.stringify({ version: 1, id, at: this.#now().toISOString() } satisfies HandledRecord)}\n`)
    // Ownership is asked again INSIDE the turn, immediately before the request is carried out: it
    // may have waited its turn, and a Collection that stopped being this app's meanwhile is not written.
    const act = async (): Promise<Reply> => {
      const lost = this.#disposed ? null : this.#notOwner()
      return lost ? refuse(lost) : this.#act(request, waiting)
    }
    const reply = await this.#options.exclusive(act, request.operation)
    await this.#options.seams?.afterActing?.()
    return finish(reply, { operation: request.operation })
  }

  /** Why a path the request names may not be acted on, in the command line's own words; null when all may. */
  #unfitPath(request: WriteRequest): string | null {
    const ws = this.#options.workspace
    for (const { arg, kind, root } of PATH_ARGS[request.operation as RequestOperation] ?? []) {
      const given = request.args[arg]
      if (given === undefined) continue
      const raw = String(given) // exactly as given: a path is never trimmed (cli/paths.ts)
      if (raw === '' || raw === '.' || raw === '/') {
        if (root) continue
        return 'A path is needed. Nothing was done.'
      }
      const rel = isAbsolute(raw) ? relative(ws.root, raw) : raw
      // What the path IS (a file or a folder) decides the hidden-folder rule, as in the closed-app route (research-capture.ts).
      const verdict = ws.classifyPath(rel, kind === 'either' ? (isFolderOnDisk(ws, rel) ? 'folder' : 'file') : kind)
      if (verdict === 'outside') return `${quoted(raw)} is outside the Collection. Nothing was done.`
      if (verdict === 'hidden') return `${quoted(raw)} is under a dot-folder or an ignored folder, which is not part of the Collection. Nothing was done.`
    }
    return null
  }

  /**
   * Carry out one valid request. Never throws: a failure is a refusal, made after everything was put back.
   * `waiting` is this look's shown-first requests already read: a move this request makes is applied to them.
   */
  async #act(request: WriteRequest, waiting: WaitingRequest[]): Promise<Reply> {
    const { workspace: appWorkspace, trash, seams, onChanged, saveVersion, sharing } = this.#options
    const at = (): string => this.#now().toISOString()
    const touched = new Set<string>()
    try {
      const operation = this.#table.find((candidate) => candidate.name === request.operation)!
      const view = documentOnlyView(appWorkspace)
      // The app's own journal, among its records: an undo request acts on nothing the app did not write itself (cli/journal.ts).
      const journal = new Journal(appWorkspace.root, this.#place, { now: this.#now, route: 'app' })
      // Undo leaves an intent like any other change, so one stopped partway can be finished (cli/journal.ts).
      const intent = journal.begin(request.operation)
      const confirmOwner = async (): Promise<void> => {
        const notOwner = this.#notOwner()
        if (notOwner) throw new CliError(notOwner)
      }
      const session = new WriteSession(view.workspace, {
        seams: seams?.write, intent, confirmOwner,
        // Putting back is asked only whether the app still holds the Collection's lock. A disposed
        // executor does (its caller keeps the lock until `dispose` resolves), so what it wrote is put
        // back; one whose Collection is another's now writes nothing more (cli/write-access.ts).
        confirmRollback: async () => { if (!(this.#options.holdsLock ?? this.#options.ownsCollection)()) throw new CliError(LOST) },
        // The app's own-write record, as for any change the app makes: the folder watcher does not echo it.
        onWrite: (path) => { touched.add(path); appWorkspace.recordOwnWrite(path) },
        // A request's write that succeeded with a notice (a second name left beside a new file): the window's
        // notice, as for the app's own saves; a notice that fails is recorded there, never thrown (workspace.ts).
        onNotice: (message) => { appWorkspace.announceWriteNotice(message) },
      })
      const workspace = sessionWorkspace(view.workspace, session)
      const result = await runWithAccess(
        {
          root: appWorkspace.root, operation: request.operation, session, workspace, journal, intent, trash, now: this.#now, byApp: true,
          ...(sharing ? { sharing } : {}),
          saveVersion: async (input) => {
            if (!saveVersion) throw new CliError('WriteFlex cannot save a version on request for this Collection. Nothing was saved.', 'failed')
            return saveVersion(input, confirmOwner)
          },
        },
        (write) => operation.run({
          workspace, output: 'json', cwd: appWorkspace.root, write, records: this.#place,
          stdin: async () => '',
          openUrl: async () => { throw new CliError('A request does not open anything.', 'failed') },
        }, request.args),
      )
      await this.#followMoves(request.operation, result.data, waiting)
      const reply: Reply = { version: 1, id: request.id, outcome: 'applied', at: at(), result: result.data, text: result.text }
      return Buffer.byteLength(JSON.stringify(reply)) > MAX_REPLY_BYTES
        ? { version: 1, id: request.id, outcome: 'applied', at: at(), result: {}, text: 'The result was too large to send back.' }
        : reply
    } catch (error) {
      // The code travels with the refusal, from the closed list: the command line never reads it out of the wording.
      const code: Reply['code'] = error instanceof CliError ? error.errorCode : error instanceof VersionSaveRefused ? error.code
        : error instanceof WritesPausedError ? 'writes-paused' : error instanceof NotADocumentPathError ? 'refused' : 'failed'
      // The operation's own words, as it prints them when run directly.
      return { version: 1, id: request.id, outcome: 'refused', at: at(), reason: error instanceof Error ? error.message : String(error), code }
    } finally {
      if (touched.size > 0) {
        try { onChanged?.([...touched].sort()) } catch { /* telling the window must not change the reply */ }
      }
    }
  }

  /**
   * Validate every shown-first request set aside in this look and add them to the review ledger in
   * one write; then answer and clear each one that was settled. The ledger write comes first: a request
   * the app stopped before clearing is read again, found in the ledger by its id, and not added twice.
   *
   * A request the ledger has no room for (the allowance for undecided outside Changes, in all or for
   * its source) is REFUSED when a command is waiting for the answer: the reply names how many
   * undecided changes there are and says the writer must clear some in WriteFlex. One that has been
   * waiting since the app was closed has nobody to tell, and stays in the inbox for a later look.
   *
   * A REPLY THAT CANNOT BE WRITTEN DOES NOT STOP THE LOOK. The request is settled all the same: it is
   * cleared from the inbox, and its signed answer is kept in the app's application data (collection-records.ts), where
   * `writeflex waiting` shows it once it has verified the signature. The failure is counted, and told once for the look.
   */
  async #addForReview(waiting: WaitingRequest[], folders: Folders, budget: LookBudget): Promise<ReviewPass> {
    const pass: ReviewPass = {
      at: this.#now().getTime(), filed: 0, changes: 0, closed: 0, unrecorded: 0, repeats: 0, left: budget.left, leftBecause: [], refusedFull: 0, repliesNotWritten: 0, outcomes: [],
      limits: {
        requestsPerLook: MAX_REQUESTS_PER_PASS, bytesPerLook: MAX_REQUEST_BYTES_PER_PASS, undecidedInLedger: MAX_UNDECIDED_OUTSIDE_CHANGES, undecidedPerSource: MAX_UNDECIDED_PER_SOURCE,
        undecidedBytesInLedger: MAX_UNDECIDED_OUTSIDE_BYTES, refusedRecordsInLedger: MAX_REFUSED_OUTSIDE_RECORDS, changesPerRequest: MAX_CHANGES_PER_REQUEST,
      },
    }
    const because = new Set(budget.because)
    const done = (): ReviewPass => ({ ...pass, leftBecause: [...because].sort() })
    const changes = this.#options.changes
    if (waiting.length === 0 || !changes) return done()
    try {
      pass.outcomes = await addOutsideRequests({ requests: waiting, workspace: this.#options.workspace, changes, now: this.#now })
    } catch (error) {
      // The ledger could not be written (another owner holds the Collection, a disk error): nothing
      // was added, and every request is still in the inbox for the next look.
      pass.left += waiting.length
      because.add('ledger-not-writable')
      pass.failed = error instanceof Error ? error.message : String(error)
      return done()
    }
    await this.#options.seams?.afterReviewAdded?.()
    const key = await this.#options.replyKey().catch(() => null)
    const nowMs = this.#now().getTime()
    const at = (): string => this.#now().toISOString()
    for (const outcome of pass.outcomes) {
      // Only a request just made has a command waiting for the answer; and only a signed answer is of use to it.
      const awaited = key !== null && Math.abs(nowMs - (requestTime(outcome.id) ?? 0)) <= REPLY_WORTH_MS
      if (outcome.kind === 'full' && !awaited) {
        pass.left += 1
        because.add('ledger-full')
        keepUpTo(this.#deferred, outcome.id, nowMs + DEFERRED_RETRY_MS, MAX_NAMES_REMEMBERED)
        continue
      }
      this.#deferred.delete(outcome.id)
      if (outcome.kind === 'full') pass.refusedFull += 1
      else if (outcome.repeat) pass.repeats += 1
      else if (outcome.kind === 'filed') { pass.filed += 1; pass.changes += outcome.changes.length } else { pass.closed += 1; if (!outcome.recorded) pass.unrecorded += 1 }
      if (awaited) {
        const operation = waiting.find((request) => request.id === outcome.id)?.request.operation
        const from = OUTSIDE_AUTHORS[outcome.source].name
        const unsigned: Reply = outcome.kind === 'filed'
          ? {
              version: 1, id: outcome.id, operation, outcome: 'applied', at: at(),
              result: { shown: 'now', request: outcome.id, path: outcome.path, changes: outcome.changes, source: outcome.source },
              // The command line prints the fixed first line and where the change is (outcome.ts); this adds only what those do not say.
              text: `${outcome.changes.length === 1 ? 'One change' : `${outcome.changes.length} changes`} to ${outcome.path}, shown as from ${from} (request ${outcome.id}).`,
            }
          : { version: 1, id: outcome.id, operation, outcome: 'refused', code: outcome.kind === 'full' ? 'review-allowance-full' : 'refused', at: at(), reason: outcome.kind === 'full' ? fullReason(outcome) : `${outcome.reason} Nothing was changed.${outcome.recorded ? ' WriteFlex lists it as a change that could not be applied.' : ''}` }
        const reply: Reply = { ...unsigned, mac: replyMac(key, unsigned) }
        try {
          await folders.outbox.write(requestFileName(outcome.id), `${JSON.stringify(reply)}\n`, this.#options.seams?.reply)
        } catch (error) {
          pass.repliesNotWritten += 1
          pass.failed ??= `A reply could not be written to the outbox (${error instanceof Error ? error.message : String(error)}). The requests were settled; "writeflex waiting" shows their outcomes.`
          // The answer is kept where the command line can still find it: the reply itself, SIGNED as it
          // would have been in the outbox (its id and operation are inside what is signed), in a folder of
          // its own. `writeflex waiting` shows it only if the signature verifies. If this fails too, the
          // ledger is the record.
          await this.#keepUndelivered(outcome.id, reply).catch(() => {})
        }
      }
      await folders.claims.settle(outcome.id).catch(() => {})
    }
    if (pass.filed + pass.closed - pass.unrecorded > 0) {
      try { this.#options.onReviewChanged?.(done()) } catch { /* telling the window must not stop the look */ }
    }
    return done()
  }

  async #keepUndelivered(id: string, reply: Reply): Promise<void> {
    const folder = (await holdRecords(this.#place.own, this.root, UNDELIVERED_KIND, true))!
    try { await folder.write(requestFileName(id), `${JSON.stringify(reply)}\n`) } finally { await folder.close() }
  }

  /**
   * An undecided outside Change follows a file or folder the app has just moved for a request
   * (`move`, `move-folder`, and the moves an `undo` puts back). Best effort: a Change that was not
   * moved closes with its reason when the writer tries to accept it.
   *
   * So do the shown-first requests this look has already read and set aside (`waiting`): they are
   * claimed, so the move's rewrite of the inbox (cli/review-waiting.ts) passes them by, and they are
   * not in the ledger yet. Their path arguments are moved here, in memory, before `#addForReview`
   * validates them. A request whose document is moved and then removed in the same look therefore
   * names the removed path and is closed as missing; it never lands on a different document that
   * appears later at the old path. What is given back to the inbox for a later look keeps the path
   * written in its file.
   */
  async #followMoves(operation: WriteRequest['operation'], data: unknown, waiting: WaitingRequest[]): Promise<void> {
    if (typeof data !== 'object' || data === null) return
    const result = data as { from?: unknown; to?: unknown; moved?: unknown }
    // In the order made: a folder move lists the folder and then its Index Note (`moved`), as an undo lists what it moved back.
    const listed = Array.isArray(result.moved) ? result.moved as Array<{ from?: unknown; to?: unknown }> : null
    const made: Array<{ from?: unknown; to?: unknown }> = operation === 'move-folder' || operation === 'undo' ? listed ?? (operation === 'move-folder' ? [result] : [])
      : operation === 'move' ? [result] : []
    const moves = made.filter((move): move is { from: string; to: string } => typeof move?.from === 'string' && typeof move.to === 'string' && move.from !== '' && move.to !== '')
    if (moves.length === 0) return
    for (let index = 0; index < waiting.length; index++) waiting[index] = this.#movedRequest(waiting[index], moves)
    const changes = this.#options.changes
    if (!changes) return
    let followed = 0
    for (const move of moves) followed += await changes.followRename(move.from, move.to).catch(() => 0)
    if (followed > 0) {
      try { this.#options.onReviewChanged?.(null) } catch { /* as above */ }
    }
  }

  /** `waiting` with its document path arguments moved through `moves`, in the order they were made; itself when none applies. */
  #movedRequest(waiting: WaitingRequest, moves: Array<{ from: string; to: string }>): WaitingRequest {
    const root = this.#options.workspace.root
    const args = { ...waiting.request.args }
    let changed = false
    for (const arg of SHOWN_FIRST_PATH_ARGS) {
      const given = args[arg]
      if (typeof given !== 'string') continue
      // Compared as a Collection path, as `#unfitPath` reads one; the moved path is written the same way.
      let current = isAbsolute(given) ? relative(root, given) : given
      const start = current
      for (const { from, to } of moves) {
        if (current === from) current = to
        else if (current.startsWith(`${from}/`)) current = `${to}${current.slice(from.length)}`
      }
      if (current !== start) { args[arg] = current; changed = true }
    }
    return changed ? { id: waiting.id, request: { ...waiting.request, args } } : waiting
  }

  /** The record of this request in the first of `places` that has one (this app's own, then the other variant's). */
  async #record(places: HeldFolder[], id: string): Promise<HandledRecord | null> {
    let read: Awaited<ReturnType<HeldFolder['read']>> = { kind: 'missing' }
    for (const records of places) {
      read = await records.read(requestFileName(id), MAX_REPLY_BYTES + 4096)
      if (read.kind !== 'missing') break
    }
    if (read.kind === 'missing') return null
    // A record that cannot be read still says the request was met: answered as not finished, never run again.
    const none: HandledRecord = { version: 1, id, at: this.#now().toISOString() }
    if (read.kind !== 'text') return none
    try {
      const raw = JSON.parse(read.text) as { reply?: unknown }
      const reply = raw.reply === undefined ? null : parseReply(JSON.stringify(raw.reply), id)
      return reply ? { ...none, reply } : none
    } catch {
      return none
    }
  }

}

/** The refusal for a request the ledger has no room for: the count, and what clears it. */
function fullReason(outcome: Extract<IngestOutcome, { kind: 'full' }>): string {
  const from = OUTSIDE_AUTHORS[outcome.source].name
  const what = outcome.because === 'source'
    ? `WriteFlex's review dock already holds ${outcome.ofSource} undecided changes from ${from}, and takes at most ${MAX_UNDECIDED_PER_SOURCE} from one source`
    : outcome.because === 'all'
      ? `WriteFlex's review dock already holds ${outcome.undecided} undecided changes from outside, and takes at most ${MAX_UNDECIDED_OUTSIDE_CHANGES}`
      : `WriteFlex's review dock already holds ${outcome.undecided} undecided changes from outside, and their text is at its size limit`
  return `${what}. Nothing was filed and nothing was changed. The writer must clear changes in WriteFlex (accept or reject them) before more can be shown for review.`
}

/** A look as it is kept for the dock: the pass without each request's outcome. */
function lookOf(pass: ReviewPass): OutsideLook {
  const { outcomes: _outcomes, ...look } = pass
  return look
}

export { FolderNotUsableError }
