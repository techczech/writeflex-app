/**
 * What the command line can see of its own proposed changes without asking the app: the requests
 * still in the inbox, the answers the app could not deliver, and how full the review dock is. And the
 * one thing it does to waiting requests besides filing and withdrawing them: when the command line
 * (or the app, for a request) moves a document or a folder, the requests waiting for it, and the
 * undecided outside Changes in the review ledger, are given the new path.
 *
 * NOTHING HERE IS WRITEFLEX SPEAKING UNLESS IT IS SIGNED.
 *  - The inbox is a folder anything can write. What `waiting` lists from it is "request files found in
 *    the inbox": what each file says about itself (its operation, its path, its declared source). It
 *    is presented as that and never as something WriteFlex has checked or said.
 *  - An undelivered answer is a reply to a shown-first request that the app could not put in the
 *    outbox. It keeps the reply itself, `<id>.json`, in its application data, outside the Collection
 *    (collection-records.ts), where either variant of the app may have left it. It is a reply the app signed
 *    with this Collection's reply key, exactly as it signs a reply in the outbox: the id and the
 *    operation are inside what is signed. Its outcome is shown ONLY if the signature verifies under a
 *    key the app holds for this Collection now. Anything else at such a name (unsigned, signed with
 *    another key, not a reply at all) is shown as its id with "outcome unknown" and none of its
 *    content. The app makes a new key each time it takes the Collection and removes it when it lets
 *    go, so an answer signed under an earlier ownership no longer verifies and reads as unknown: the
 *    narrow, safe result. The writer sees the real outcome in WriteFlex.
 *
 * EVERYTHING IS BOUNDED BEFORE IT IS READ. A folder is listed through `HeldFolder.namesUpTo`, which
 * stops taking directory entries at a count; each file is read through the held folder's capped,
 * no-follow reader; and reading stops at a total number of files and of bytes. The result says when a
 * listing was cut, and by which limit. Withdrawing a request scans nothing: the file's name is the
 * request id, which is pattern-checked (review-operations.ts).
 *
 * The review ledger is READ here, and written only by `followInReview`, through `access.followLedger`
 * (history-store.ts) under the command line's own owner lock.
 */
import { RecordsNotUsableError, UNDELIVERED_KIND, holdOtherRecords, holdRecords, type RecordsPlace } from '../collection-records'
import { readReplyKeys, replyIsSigned } from '../reply-key'
import { outsideSourceOf } from '../outside-change-fields'
import type { Workspace } from '../workspace'
import { checkedStoresForReading } from './history-store'
import { CliError, type Operation } from './operation'
import type { ErrorCode } from './outcome'
import { FolderNotUsableError, holdFolder, type HeldFolder } from './request-files'
import { INBOX_DIR, MAX_REPLY_BYTES, MAX_REQUEST_BYTES, idOfClaimedName, idOfFileName, parseReply, parseRequest, requestFileName, requestTime, type WriteRequest } from './request-format'
import { MAX_ENTRIES_LISTED, MAX_REQUESTS_PER_PASS, MAX_REQUEST_BYTES_PER_PASS, OUTSIDE_AUTHORS, declaredSource, isShownFirst, type OutsideSource } from './review-format'
import { capped } from './terminal-text'
import type { WriteAccess } from './write-access'

/** The arguments of a shown-first request that name a document. */
const PATH_ARGS = ['path', 'source-path']
/** At most this many directory entries of a folder are considered in one listing (defined once, in review-format.ts). */
export { MAX_ENTRIES_LISTED }
/** A path, and a refusal's reason, are shown up to this many characters. */
const SHOWN_PATH_CHARS = 300
const SHOWN_REASON_CHARS = 2000

/** Which limit cut a listing short, or null when everything there was considered. */
export type ListingCut = 'entries' | 'requests' | 'bytes' | null

/** `beingAdded` is present on a request WriteFlex has claimed (request-claims.ts): it is being read and
 *  added to the review dock now, or was when the app stopped, and can no longer be withdrawn. */
export type Waiting = { id: string; at: string | null; operation: string; path: string; source: string; beingAdded?: true }

async function held(root: string, dir: string, what: string): Promise<HeldFolder | null> {
  try { return await holdFolder(root, dir, false) } catch (error) {
    if (error instanceof FolderNotUsableError) throw new CliError(`${what} cannot be read: ${error.message}`)
    throw error
  }
}

const table = async (): Promise<Operation[]> => (await import('./table')).buildOperationTable()

/**
 * Each shown-first request in the inbox, in name order (oldest first when the listing is whole). The
 * limits are applied BEFORE the thing they bound: entries as the directory is read, the count of
 * files before a file is opened, the bytes from the size the capped reader would be asked for.
 */
async function eachWaiting(inbox: HeldFolder, visit: (name: string, request: WriteRequest, claimed: boolean) => Promise<void>): Promise<{ unreadable: number; cut: ListingCut; considered: number }> {
  const operations = await table()
  const listing = await inbox.namesUpTo(MAX_ENTRIES_LISTED)
  let cut: ListingCut = listing.more ? 'entries' : null
  let unreadable = 0
  let bytes = 0
  let read = 0
  const met = new Set<string>()
  for (const name of listing.names) {
    // `<id>.json`, or `<id>.json.taken`: the same request once WriteFlex has claimed it (request-claims.ts).
    const claimed = idOfClaimedName(name)
    const id = idOfFileName(name) ?? claimed
    if (id === null || met.has(id)) continue
    met.add(id)
    if (read >= MAX_REQUESTS_PER_PASS) { cut ??= 'requests'; break }
    const size = (await inbox.look(name))?.size ?? 0
    if (bytes + Math.min(size, MAX_REQUEST_BYTES) > MAX_REQUEST_BYTES_PER_PASS) { cut ??= 'bytes'; break }
    read += 1
    // The capped, no-follow reader: a link, a pipe or an oversized file is never read.
    const file = await inbox.read(name, Math.min(MAX_REQUEST_BYTES, MAX_REQUEST_BYTES_PER_PASS - bytes))
    if (file.kind === 'missing') continue
    if (file.kind !== 'text') { unreadable += 1; continue }
    bytes += Buffer.byteLength(file.text)
    const parsed = parseRequest(file.text, id, operations)
    if (!parsed.ok) { unreadable += 1; continue }
    if (isShownFirst(parsed.request.operation)) await visit(name, parsed.request, claimed !== null)
  }
  return { unreadable, cut, considered: read }
}

/** The request files in the inbox that are proposed changes: what each file states, nothing WriteFlex has said. */
export async function waitingRequests(root: string): Promise<{ requests: Waiting[]; unreadable: number; cut: ListingCut }> {
  const inbox = await held(root, INBOX_DIR, 'The inbox')
  if (!inbox) return { requests: [], unreadable: 0, cut: null }
  const requests: Waiting[] = []
  try {
    const { unreadable, cut } = await eachWaiting(inbox, async (_name, request, claimed) => {
      const at = requestTime(request.id)
      requests.push({
        id: request.id, at: at === null ? null : new Date(at).toISOString(), operation: request.operation,
        path: capped(String(request.args.path ?? ''), SHOWN_PATH_CHARS), source: OUTSIDE_AUTHORS[declaredSource(request.args.source)].name,
        ...(claimed ? { beingAdded: true as const } : {}),
      })
    })
    return { requests, unreadable, cut }
  } finally {
    await inbox.close()
  }
}

/**
 * An answer the app could not deliver. `filed` and `refused` are WriteFlex's own word, verified by
 * its signature; `unknown` is everything that could not be verified, and carries nothing but the id.
 */
export type Settled =
  | { id: string; outcome: 'filed' | 'refused'; verified: true; operation: string; at: string; code?: ErrorCode; reason?: string }
  | { id: string; outcome: 'unknown'; verified: false }

/**
 * The undelivered answers for this Collection (see the top of this file), from the application-data
 * folders of `place`: read only, this process's own and the other variant's. `keyFolders` are where
 * the app keeps this Collection's reply key; with no key there, every answer is `unknown`. The limits
 * are for all the folders together.
 */
export async function settledUndelivered(root: string, place: RecordsPlace, keyFolders: string[]): Promise<{ settled: Settled[]; cut: ListingCut }> {
  const folders: HeldFolder[] = []
  const byId = new Map<string, Settled>()
  let cut: ListingCut = null
  try {
    try {
      const own = await holdRecords(place.own, root, UNDELIVERED_KIND, false)
      if (own) folders.push(own)
    } catch (error) {
      if (error instanceof RecordsNotUsableError) throw new CliError(`The undelivered answers cannot be read: ${error.message}`)
      throw error
    }
    folders.push(...await holdOtherRecords(place, root, UNDELIVERED_KIND))
    if (folders.length === 0) return { settled: [], cut: null }
    const keys = await readReplyKeys(keyFolders, root)
    let read = 0
    let bytes = 0
    for (const folder of folders) {
      const listing = await folder.namesUpTo(MAX_ENTRIES_LISTED)
      if (listing.more) cut ??= 'entries'
      for (const name of listing.names) {
        const id = idOfFileName(name)
        if (id === null) continue
        if (read >= MAX_REQUESTS_PER_PASS) { cut ??= 'requests'; break }
        const size = (await folder.look(name))?.size ?? 0
        if (bytes + Math.min(size, MAX_REPLY_BYTES) > MAX_REQUEST_BYTES_PER_PASS) { cut ??= 'bytes'; break }
        read += 1
        const file = await folder.read(name, MAX_REPLY_BYTES)
        if (file.kind === 'missing') continue
        if (file.kind === 'text') bytes += Buffer.byteLength(file.text)
        const reply = file.kind === 'text' ? parseReply(file.text, id) : null
        // The signature is over everything parsed, the id and the operation among it. Nothing of an
        // answer that does not verify is used: not its outcome, not its reason, not its time.
        if (!reply || !isShownFirst(reply.operation ?? '') || keys.length === 0 || !replyIsSigned(keys, reply)) {
          if (!byId.has(id)) byId.set(id, { id, outcome: 'unknown', verified: false })
          continue
        }
        byId.set(id, {
          id, outcome: reply.outcome === 'applied' ? 'filed' : 'refused', verified: true, operation: reply.operation as string, at: reply.at,
          ...(reply.code === undefined ? {} : { code: reply.code }), ...(reply.reason === undefined ? {} : { reason: capped(reply.reason, SHOWN_REASON_CHARS) }),
        })
      }
    }
    return { settled: [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), cut }
  } finally {
    for (const folder of folders) await folder.close()
  }
}

/** How many undecided Changes from outside the review ledger holds, in all and per source. Read only. */
export async function ledgerRoom(ws: Workspace): Promise<{ undecided: number; bySource: Partial<Record<OutsideSource, number>> }> {
  const bySource: Partial<Record<OutsideSource, number>> = {}
  let undecided = 0
  for (const change of await checkedStoresForReading(ws).changes.list()) {
    const source = outsideSourceOf(change)
    if (source === null || (change.status !== 'pending' && change.status !== 'held')) continue
    undecided += 1
    bySource[source] = (bySource[source] ?? 0) + 1
  }
  return { undecided, bySource }
}

type Move = { from: string; to: string }
/** Where `path` is after `moves`, applied in the order they were made (a folder moved, then a file in it renamed); null when none of them moved it. */
const movedPath = (path: string, moves: Move[]): string | null => {
  let current = path
  for (const { from, to } of moves) {
    if (current === from) current = to
    else if (current.startsWith(`${from}/`)) current = `${to}${current.slice(from.length)}`
  }
  return current === path ? null : current
}

/**
 * Give the requests waiting in the inbox the new path of a document or folder that has just been
 * moved. Each request keeps its id and its name; only the path inside it changes, and the file is
 * replaced whole. The move's own journal entry records `from` and `to`, and `undo` calls this again
 * with the moves reversed, which puts the requests back as they were.
 *
 * Bounded as every listing here is (`cut` says by which limit, when one applied). A file is rewritten
 * only if it is a request of exactly the expected shape: its name is the id inside it, it parses
 * against the closed schema as a shown-first operation, and the rewritten file, parsed again from the
 * bytes about to be written, is that same request with nothing but the path changed and within the
 * size a request may have. Anything else is left exactly as it is (`skipped`): among it a request
 * WriteFlex has claimed, which is WriteFlex's to read as it stands.
 */
export async function rewriteWaitingPaths(root: string, moves: Move[]): Promise<{ rewritten: string[]; skipped: number; cut: ListingCut }> {
  if (moves.length === 0) return { rewritten: [], skipped: 0, cut: null }
  const inbox = await held(root, INBOX_DIR, 'The inbox')
  if (!inbox) return { rewritten: [], skipped: 0, cut: null }
  const rewritten: string[] = []
  let skipped = 0
  try {
    const operations = await table()
    const { cut } = await eachWaiting(inbox, async (name, request) => {
      const args = { ...request.args }
      let changed = false
      for (const arg of PATH_ARGS) {
        const next = typeof args[arg] === 'string' ? movedPath(args[arg] as string, moves) : null
        if (next !== null) { args[arg] = next; changed = true }
      }
      if (!changed) return
      const body = `${JSON.stringify({ version: 1, id: request.id, operation: request.operation, args })}\n`
      const again = name === requestFileName(request.id) && Buffer.byteLength(body) <= MAX_REQUEST_BYTES ? parseRequest(body, request.id, operations) : null
      const same = again?.ok === true && again.request.operation === request.operation
        && Object.keys(again.request.args).length === Object.keys(request.args).length
        && Object.entries(again.request.args).every(([key, value]) => (PATH_ARGS.includes(key) ? typeof value === 'string' : value === request.args[key]))
      if (!same) { skipped += 1; return }
      await inbox.write(name, body)
      rewritten.push(request.id)
    })
    return { rewritten, skipped, cut }
  } finally {
    await inbox.close()
  }
}

/**
 * After a move the command line (or the app, for a request) made: the waiting requests follow it,
 * and so do the undecided outside Changes already in the review ledger (specification section 5).
 * The app follows its own ledger (request-executor.ts); with no app, the command line holds the
 * owner lock and follows it through `access.followLedger` (history-store.ts). Never fails the move:
 * what could not be followed is a notice.
 */
export async function followInReview(access: WriteAccess, moves: Move[]): Promise<{ data: Record<string, unknown>; lines: string[] }> {
  const data: Record<string, unknown> = {}
  const lines: string[] = []
  try {
    const { rewritten, skipped, cut } = await rewriteWaitingPaths(access.workspace.root, moves)
    if (rewritten.length > 0) {
      data.waitingRequestsMoved = rewritten
      lines.push(`${rewritten.length} proposed change${rewritten.length === 1 ? '' : 's'} waiting for review ${rewritten.length === 1 ? 'was' : 'were'} given the new path.`)
    }
    if (skipped > 0 || cut !== null) {
      data.waitingRequestsNotFollowed = { skipped, cut }
      lines.push(`Not every waiting request could be looked at or given the new path${cut ? ` (the inbox holds more than the command line reads at once: limit on ${cut})` : ''}; WriteFlex will close those it cannot place.`)
    }
  } catch (error) {
    lines.push(`The proposed changes waiting for review could not be given the new path (${error instanceof Error ? error.message : String(error)}); WriteFlex will close those it cannot place.`)
  }
  if (access.byApp || !access.followLedger) return { data, lines } // the app moves its own ledger's Changes itself (request-executor.ts)
  try {
    const moved = await access.followLedger(moves)
    if (moved > 0) {
      data.reviewChangesMoved = moved
      lines.push(`${moved} change${moved === 1 ? '' : 's'} in WriteFlex's review dock ${moved === 1 ? 'was' : 'were'} given the new path.`)
    }
  } catch (error) {
    lines.push(`The changes in WriteFlex's review dock could not be given the new path (${error instanceof Error ? error.message : String(error)}); accepting one that names the old path closes it with the reason.`)
  }
  return { data, lines }
}
