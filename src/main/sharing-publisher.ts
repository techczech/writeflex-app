// The publisher (sharing ticket 03; spec sections 4.2, 5 rules 2 and 4, 6.1, 8). The one module that
// makes links for a piece, turns them off and on, and publishes the piece to every link that is on
// each time it is saved. The IPC (sharing-piece-ipc.ts) is a thin caller.
//
// What it holds:
//   - one record per link (settings.json `sharingLinks`, never a secret): the share id, the piece it
//     belongs to (Workspace root and path), its name and settings, on or off, and what was last
//     published (revision, time, the save it came from, the pictures it named) or why not;
//   - each link's owner token, in the secrets store (slot `sharing-links`, Keychain), never in a
//     record, a view, a log or an error.
//
// Rules:
//   R1 nothing leaves the Mac for a piece with no link that is on. `saved(root, paths)` is the one
//      subscription (the common post-save notification point, ipc.ts notifyCollectionChanged); it
//      publishes only the links whose piece is one of `paths`. Linked pieces are never published:
//      the rendering (sharing-render.ts) reads one file.
//   R2 one publish at a time per link, in order: every operation on a link (publish, turn off, turn
//      on, settings) queues behind the one before. Saves that arrive while a publish runs coalesce
//      into one more publish after it.
//   R3 turning a link off asks the service to delete the copy and its pictures (one transaction
//      there); open reader pages get the link-off page on their next request. Nothing is published
//      to a link that is off. Turning it on again keeps the address and publishes at once.
//   R4 a publish that fails keeps the time publishing last worked and says why, in plain words; the
//      window offers Retry. The link stays on: readers see the last copy that went out.
//   R5 one step: every picture the new copy needs is sent, then the page once. The service counts the
//      pictures waiting to be published apart from the published copy (500 pictures / 64 MiB each,
//      sharing service build 3), so a whole new set fits beside the copy readers have, and the page
//      PUT replaces that copy in one transaction: readers never get a partial copy (adviser ruling,
//      round 3, B). When the service says it is full while pictures are sent, the pictures a stopped
//      publish left waiting are cleared (DELETE staged) once and the pictures are sent again; full a
//      second time, the piece's own pictures are over the cap and it says so with the figure. A piece
//      whose own pictures are over the cap is refused before anything is sent. The link is never
//      turned off to make room.
//   R6 a picture the service says it is missing is no longer counted as held, and is sent again.
//   R8 the record changes only on the page PUT's 200: then revision, publishedAt, publishedSavedAt,
//      images, note and `problem: null` are written in one update. On any failure the only field
//      written is `problem`. So the record never names a revision the service does not hold as a
//      complete copy, and a restart part-way shows the last copy's time (and Retry, when the failure
//      was recorded). Pictures left waiting at the service cost nothing: the next publish finds them
//      there ("already"), or its page PUT or DELETE staged removes them.
//   R7 a new link's record is saved and read back before anything is published; when it cannot be,
//      the link is taken down again and nothing is published.
//   R9 a Folio link (ticket 09; `kind: 'folio'`, `path` the Folio's folder) publishes the whole Folio,
//      its parts in running order (sharing-folio.ts), on a save of anything inside the Folio's folder:
//      a part, the manifest or the Index Note (the running order), a part added or removed. Every
//      part keeps every rule of a shared piece (each is the piece rendering). A part missing on disk
//      is published as its title with "not available" and never stops the rest. Each part's ids
//      start with its key (`partKeys`, kept per part file, written with the rest of R8's one update),
//      so a note's block hint names its part whatever the order.
//   R11 (ticket 04, publishing follows the piece) a rename or move never ends a share: `moved` takes
//      every record at or under the old path to the new one (sharing-follow.ts F1), before the save
//      signal that follows the rename publishes it, and bumps each one's `generation`. Trash ends it:
//      `trashed` marks the record `ended` (saved first, so a restart still owes the removal), then
//      turns the link off at the service, which deletes the copy and its pictures; offline, the
//      removal is retried until it goes through. Only the in-app Trash and the command line's Trash end
//      a share. An ended link never publishes. When its file is back (restored from the Trash) the
//      page offers Turn on, which keeps the address.
//   R12 (ticket 04) the queue survives a restart: a save to a link that is on writes `queuedAt` to the
//      record before it is published; a publish that went through clears it (unless a later save came
//      in meanwhile). A publish that could not reach the service is tried again after a pause
//      (`retryMs`), and at once on `reconnected()`. Latest only (ruling R-E): whatever the file holds
//      when the publish runs is the copy, so readers get the latest save once and revisions never go
//      backwards; a reader page is a snapshot, so the saves in between are not sent one by one.
//   R13 (ticket 04 ruling R-A) a share is on a FILE (`fileId`, device, inode and birth time;
//      sharing-piece-identity.ts I0), recorded when it is made and refreshed on every publish, save and
//      rename. Content equality never moves a share.
//   R14 (R-B) a piece not where its share has it, outside WriteFlex (gone, or its folder cannot be read),
//      is "not found" (`lost`): the link stops publishing and NOTHING is removed. The writer turns it
//      off, or follows it to the one place in the Workspace that holds the same file (`followTo`, the
//      candidate main found, never a path a window names). The file back at its path: found again.
//   R15 (R-D) `reconcile` (at start, `resume()`, and when a Workspace is opened again) looks at every
//      share that is on: there and the same file, or another file at its path (R-C: an edit), it is
//      published if what it holds differs from what was published last (`publishedHash`) or a save is
//      queued; gone or unreadable, it is "not found" (R14). It never removes anything. A start's look
//      that finds the copy changed queues it on record before anything is sent (R16). A Workspace is
//      walked once a pass for "Follow to" candidates; what a walk found is dropped when the record
//      changed or the file came back while the walk ran (a recovery wins over the missing file).
//   R16 (R-F) a record change that ends, moves or queues a share is saved before anything acts on it.
//      When it cannot be saved the share stays as it was, the change is not made, and the link shows
//      the problem (`notSaved`) until a change to it is saved; a command-line signal is then kept.
//      Retry and every scheduled publish go through the same guard. A fact recorded after the event (a
//      publish that went through, the file found) is kept for this run when it cannot be saved, and the
//      link says it was not saved (`LINK_STATE_NOT_SAVED`): never kept in memory silently.
//   R10 the Shares list (ticket 10) reads, never writes: `linksIn(root)` lists a Workspace's records,
//      `opened(ids)` asks the service how many times each link was opened (with the link's owner
//      token, which goes nowhere else). Neither changes a record or publishes anything.
//
// No Electron import.
import { basename, resolve, sep } from 'node:path'
import type { SecretsStore } from './secrets-store'
import type { ServiceAccess, ServiceClient } from './sharing-client'
import type { RenderedPiece } from './sharing-render'
import type { RenderedFolio } from './sharing-folio'
import { linkAddress } from './sharing-own-address'
import { endedByTrash, followMove, isAtOrUnder } from './sharing-follow'
import { candidateIn, presenceOf, sameFile, scanIds, type Presence, type WorkspaceIds } from './sharing-piece-identity'
import { createPublishOnce, PublishStop } from './sharing-publish-once'
import { isEligiblePiece } from './sharing-source-eligibility'
import { ownerTokens } from './sharing-owner-tokens'
import { normaliseRoot } from './root-resolution'
import { readRecords, readerLinkLabel, type PublishedPartRecord, type ShareRecord } from './sharing-share-record'
import {
  FOLLOW_NOT_SAVED, FOLLOW_NOT_THERE, TURN_ON_NOT_SAVED, LINK_NOT_SAVED, LINK_STATE_NOT_SAVED, LINK_UNKNOWN, MAKE_FAILED, NOT_SET_UP_PROBLEM, RECORD_NOT_SAVED, SHARE_AUTH,
  SHARE_REFUSED, SHARE_UNREADABLE, TOKENS_NOT_SAVED, TURN_OFF_FAILED, TURN_ON_FAILED, cleanLinkName,
  type FolioPartView, type PieceSharingView, type ShareKind, type ShareLinkView, type ShareMark, type SharePublishProblem, type SharingLinkResult,
} from '../shared/sharing-links'

export { readRecords, readerLinkLabel, type PublishedPartRecord, type ShareRecord } from './sharing-share-record'

export interface SharingPublisherPorts {
  /** settings.json `sharingLinks`. */
  records: { read(): unknown; write(value: ShareRecord[]): boolean }
  secrets: SecretsStore
  /** Where the service is and this Mac's admin key (sharing-setup.ts serviceAccess); null when not set up. */
  access(): ServiceAccess | null
  client: ServiceClient
  /** Render the piece for publishing at `imagePath` (sharing-render.ts renderPieceForSharing). */
  render(root: string, path: string, imagePath: string): Promise<RenderedPiece>
  /**
   * Render the Folio at `dir` (sharing-folio.ts renderFolioLink), its parts under the keys `kept` holds
   * and new ones for new parts; null when `dir` is no longer a Folio. Absent: Folio links never publish.
   */
  renderFolio?(root: string, dir: string, imagePath: string, kept: Readonly<Record<string, string>>): Promise<{ folio: RenderedFolio; keys: Record<string, string> } | null>
  now?(): number
  /** The author's time zone for "Updated" on the page. */
  timeZone?(): string | null
  /** How long a save waits for more saves before it is published. */
  debounceMs?: number
  /** Something a window shows changed (a link, a publish). */
  changed?(): void
  /** Ticket 04: the file (or a Folio's folder) is on disk in `root` (a link ended by the Trash is back). Absent: never. */
  exists?(root: string, path: string): boolean
  /** Ticket 04 (R12): pauses before trying again after the service could not be reached; the last repeats. */
  retryMs?: readonly number[]
  /** Ticket 04 (R13, R14): what is at a path in a Workspace now. Default: lstat (sharing-piece-identity.ts). */
  presence?(root: string, path: string): Presence
  /** Ticket 04 (R14): one walk of `root`, every file and folder by identity (candidates for "Follow to"). Default: a bounded walk. */
  scanIds?(root: string): Promise<WorkspaceIds>
}

/** A command-line signal (sharing-follow-signals.ts), as the publisher applies it (R-G). */
export type ShareSignal = { root: string; shareId: string; from: string; generation: number } & ({ move: { from: string; to: string } } | { trashed: true })

/** Ticket 10: status reads for opened counts in flight at once. */
const OPENED_AT_ONCE = 4
const fileKind = (kind: ShareKind): 'file' | 'folder' => (kind === 'piece' ? 'file' : 'folder')

export function createSharingPublisher(ports: SharingPublisherPorts) {
  const now = ports.now ?? Date.now
  const debounceMs = ports.debounceMs ?? 400
  const retryMs = ports.retryMs ?? [5_000, 15_000, 30_000, 60_000, 120_000]
  /** R12: a pending try-again per link, and how many tries in a row could not reach the service. */
  const retries = new Map<string, ReturnType<typeof setTimeout>>()
  const misses = new Map<string, number>()
  const timeZone = (): string | null => {
    try { return ports.timeZone ? ports.timeZone() : Intl.DateTimeFormat().resolvedOptions().timeZone ?? null } catch { return null }
  }
  let records = readRecords(ports.records.read())
  const chains = new Map<string, Promise<void>>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const publishing = new Set<string>()
  /** Links with a save waiting to be published once the publish running now is done. */
  const pending = new Set<string>()
  /** R15: links whose waiting publish is a start's look, sent only when the copy changed. */
  const checkOnly = new Set<string>()
  /** R16: links whose last record change could not be saved: the problem they show. */
  const notSaved = new Map<string, SharePublishProblem>()
  const presence = ports.presence ?? presenceOf
  const scanWorkspace = ports.scanIds ?? ((root: string) => scanIds(root))
  let reconciling: Promise<void> = Promise.resolve()

  const changed = (): void => { try { ports.changed?.() } catch { /* a window that went away */ } }
  const save = (next: ShareRecord[]): boolean => {
    if (!ports.records.write(next.map((record) => ({ ...record, ended: record.ended ? { ...record.ended } : null, lost: record.lost ? { ...record.lost } : null, images: [...record.images], partKeys: { ...record.partKeys }, parts: record.parts.map((part) => ({ ...part })), ...(record.refusedSeen ? { refusedSeen: { ...record.refusedSeen } } : {}) })))) return false
    records = next
    return true
  }
  /**
   * A change that records a fact (what was published, why not, which file): kept in memory for this run
   * when it cannot be saved, and the link says so (R16); never kept in memory silently.
   */
  const update = (shareId: string, patch: Partial<ShareRecord>): ShareRecord | null => {
    const at = records.findIndex((record) => record.shareId === shareId)
    if (at === -1) return null
    const next = [...records]
    next[at] = { ...records[at], ...patch }
    if (save(next)) notSaved.delete(shareId)
    else {
      records = next
      notSaved.set(shareId, { kind: 'not-saved', reason: LINK_STATE_NOT_SAVED, at: now() })
      changed()
    }
    return next[at]
  }
  /** R16: a change that ends, moves or queues a share: made only when it is saved. Otherwise nothing changes and the links show why. */
  const commit = (next: ShareRecord[], shareIds: readonly string[]): boolean => {
    if (save(next)) {
      for (const shareId of shareIds) notSaved.delete(shareId)
      return true
    }
    for (const shareId of shareIds) notSaved.set(shareId, { kind: 'not-saved', reason: RECORD_NOT_SAVED, at: now() })
    changed()
    return false
  }
  const commitPatch = (shareId: string, patch: Partial<ShareRecord>): boolean => commit(records.map((record) => (record.shareId === shareId ? { ...record, ...patch } : record)), [shareId])
  /** R13: the piece's file (a Folio: its folder) at the record's path now, or null. */
  const idOf = (record: Pick<ShareRecord, 'root' | 'path' | 'kind'>): string | null => {
    const there = presence(record.root, record.path)
    return there.state === 'there' && there.kind === fileKind(record.kind) ? there.id : null
  }
  const find = (shareId: unknown): ShareRecord | null => records.find((record) => record.shareId === shareId) ?? null
  const samePiece = (record: ShareRecord, root: string, path: string, kind: ShareKind = 'piece'): boolean => record.kind === kind && resolve(record.root, record.path) === resolve(root, path)
  /** R9: a saved path is inside a Folio link's folder (or is the folder). */
  const insideFolio = (record: ShareRecord, root: string, path: string): boolean => {
    const folder = resolve(record.root, record.path)
    const saved = resolve(root, path)
    return saved === folder || saved.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`)
  }
  const missingOf = (record: ShareRecord): number => (record.kind === 'folio' && record.on && !record.problem ? record.parts.filter((part) => part.missing).length : 0)

  // ── Owner tokens (Keychain) ───────────────────────────────────────────────────────────────────
  const { tokenFor, heldTokenIds, forgetToken, keepToken } = ownerTokens(ports.secrets)

  // ── Views ─────────────────────────────────────────────────────────────────────────────────────
  /** Ticket 05: new and copied links read `access.linkAddress`, which serviceAccess takes from linksAddressNow (sharing-own-address.ts THE RULE). */
  function addressOf(record: ShareRecord, access: ServiceAccess | null): string {
    return linkAddress(access?.linkAddress ?? access?.address ?? '', record.shareId)
  }
  function linkView(record: ShareRecord, access: ServiceAccess | null): ShareLinkView {
    return {
      shareId: record.shareId, name: record.name, address: addressOf(record, access), cloudflareAddress: linkAddress(access?.address ?? '', record.shareId),
      comments: record.comments, notes: 'private',
      on: record.on, madeAt: record.madeAt, publishedAt: record.publishedAt, publishedSavedAt: record.publishedSavedAt,
      // R16 (Sol round 3 P3): a change not saved is said whether the link is on or off.
      problem: notSaved.get(record.shareId) ?? (record.on ? record.problem : null), note: record.on ? record.note : null, publishing: publishing.has(record.shareId) || pending.has(record.shareId),
      missingParts: missingOf(record),
      queued: record.queuedAt !== null && record.on && !record.ended,
      ended: record.ended ? { removed: record.ended.removed, back: ports.exists?.(record.root, record.path) === true } : null,
      lost: record.on && record.lost && !record.ended ? { why: record.lost.why, candidate: record.lost.candidate } : null,
    }
  }
  function markOf(links: readonly ShareRecord[]): ShareMark {
    const on = links.filter((record) => record.on)
    if (on.length === 0) return { kind: 'share' }
    if (on.some((record) => record.problem || record.lost || notSaved.has(record.shareId))) return { kind: 'not-published' }
    const missing = Math.max(0, ...on.map(missingOf))
    return missing > 0 ? { kind: 'shared', missing } : { kind: 'shared' }
  }
  /** A Folio's parts as the copy readers see now (the link that published last). */
  function folioParts(links: readonly ShareRecord[]): FolioPartView[] {
    const latest = links.filter((record) => record.on && record.publishedAt !== null)
      .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))[0]
    return (latest?.parts ?? []).map((part) => ({ title: part.title, missing: part.missing, fileName: basename(part.path), path: part.path }))
  }
  function view(root: string, path: string, kind: ShareKind = 'piece'): PieceSharingView {
    const access = ports.access()
    const links = records.filter((record) => samePiece(record, root, path, kind))
    return {
      ...(kind === 'folio' ? { folio: { parts: folioParts(links) } } : {}),
      ready: access !== null, address: access ? access.linkAddress ?? access.address : null, cloudflareAddress: access?.address ?? null, ownAddress: access?.ownAddress ?? null,
      addressUntil: access?.linkAddressUntil ?? null,
      links: links.map((record) => linkView(record, access)), mark: markOf(links),
    }
  }

  // ── One operation at a time per link (R2) ─────────────────────────────────────────────────────
  function enqueue<T>(shareId: string, operation: () => Promise<T>): Promise<T> {
    const before = chains.get(shareId) ?? Promise.resolve()
    const run = before.then(operation, operation)
    const settled = run.then(() => undefined, () => undefined)
    chains.set(shareId, settled)
    void settled.then(() => { if (chains.get(shareId) === settled) chains.delete(shareId) })
    return run
  }

  // ── Publishing ────────────────────────────────────────────────────────────────────────────────
  const { publishOnce } = createPublishOnce({
    access: () => ports.access(), client: ports.client, render: ports.render,
    ...(ports.renderFolio ? { renderFolio: ports.renderFolio } : {}),
    tokenFor, now, timeZone,
  })

  /**
   * `onlyIfChanged` (R-D): a start's look at a piece; nothing is sent when the copy is the one published last.
   * `durable` (R16): the publish is on record (`queuedAt`) before anything is sent; when that cannot be
   * saved nothing is sent and the link shows it was not saved.
   */
  async function publishNow(shareId: string, onlyIfChanged = false, durable = false): Promise<void> {
    const record = find(shareId)
    // R-B: a link whose piece is not found publishes nothing until the writer decides.
    if (!record || !record.on || record.ended || record.lost) return
    publishing.add(shareId)
    changed()
    try {
      // R8: the one update a publish that worked makes; publishOnce itself writes nothing.
      const queue = durable
        ? (): boolean => { const latest = find(shareId); return !latest || latest.queuedAt !== null || commitPatch(shareId, { queuedAt: now() }) }
        : undefined
      // The one source rule at the common boundary (Sol review round 3 of ticket 11, P1), before anything
      // is read: a piece whose path now holds a link (symlink) to a hidden or support file, or to one
      // outside the Collection, or no file, publishes nothing. The link needs attention as for a piece
      // that cannot be read (R4, R8: only `problem` is written) and the copy readers have stays (R-B).
      // A Folio's parts are each checked the same way as they are read (sharing-folio.ts).
      if (record.kind === 'piece' && !isEligiblePiece(record.root, record.path)) throw new PublishStop({ kind: 'unreadable', reason: SHARE_UNREADABLE, at: now() })
      const outcome = await publishOnce(record, onlyIfChanged, queue)
      // R-A: the file the piece is now, refreshed on every publish.
      const fileId = idOf(find(shareId) ?? record)
      const identity = fileId && fileId !== record.fileId ? { fileId } : {}
      if (outcome === null) {
        if (fileId && fileId !== record.fileId) update(shareId, identity)
      } else {
        // R12: the queue is clear unless a save came in while this one was on its way (it is waiting in `pending`).
        update(shareId, { ...outcome, ...identity, problem: null, ...(pending.has(shareId) ? {} : { queuedAt: null }) })
      }
      misses.delete(shareId)
    } catch (error) {
      // R8: a publish that failed writes only why.
      const problem = error instanceof PublishStop ? error.problem : { kind: 'refused' as const, reason: SHARE_REFUSED, at: now() }
      // R16: the queue could not be saved, so nothing was sent; the link already says so (`commit`).
      if (problem.kind === 'not-saved') return
      update(shareId, { problem })
      if (problem.kind === 'offline') tryAgainLater(shareId)
    } finally {
      publishing.delete(shareId)
      changed()
    }
  }

  function schedule(shareId: string, delay = debounceMs): void {
    const timer = timers.get(shareId)
    if (timer) clearTimeout(timer)
    pending.add(shareId)
    const fire = (): void => {
      timers.delete(shareId)
      void enqueue(shareId, async () => {
        if (!pending.delete(shareId)) return
        const only = checkOnly.delete(shareId)
        await publishNow(shareId, only, true)
      })
    }
    if (delay <= 0) { fire(); return }
    const next = setTimeout(fire, delay)
    ;(next as { unref?: () => void }).unref?.()
    timers.set(shareId, next)
  }

  /** R12: the service could not be reached: try this link again after a pause that grows, up to the last. */
  function tryAgainLater(shareId: string): void {
    if (retries.has(shareId)) return
    const count = misses.get(shareId) ?? 0
    misses.set(shareId, count + 1)
    const timer = setTimeout(() => { retries.delete(shareId); catchUp(shareId) }, retryMs[Math.min(count, retryMs.length - 1)])
    ;(timer as { unref?: () => void }).unref?.()
    retries.set(shareId, timer)
  }
  /** R11, R12: publish a link with a save waiting, or finish the removal a Trash owes. Once each. */
  function catchUp(shareId: string): void {
    const record = find(shareId)
    if (!record) return
    if (record.ended && !record.ended.removed) { void enqueue(shareId, () => endNow(shareId)); return }
    if (record.on && !record.ended && !record.lost && (record.queuedAt !== null || record.problem?.kind === 'offline')) { checkOnly.delete(shareId); schedule(shareId, 0) }
  }
  /** R11: turn the ended link off at the service: the copy and its pictures go. Offline: tried again later. */
  async function endNow(shareId: string): Promise<void> {
    const record = find(shareId)
    if (!record?.ended || record.ended.removed) return
    const access = ports.access()
    const owner = tokenFor(shareId)
    // Without the service or the link's key there is nothing this Mac can remove: the link stays ended and owed.
    if (!access || !owner) return
    const answer = await ports.client.turnOff(access.base, shareId, owner).catch(() => ({ kind: 'unreachable' as const }))
    if (answer.kind !== 'ok') { tryAgainLater(shareId); return }
    misses.delete(shareId)
    update(shareId, { on: false, images: [], problem: null, queuedAt: null, lost: null, ended: { at: record.ended.at, removed: true }, revision: Math.max(record.revision, answer.body.revision ?? 0) })
    changed()
  }
  function cancelTimers(shareId: string): void {
    for (const map of [timers, retries]) {
      const timer = map.get(shareId)
      if (timer) { clearTimeout(timer); map.delete(shareId) }
    }
    pending.delete(shareId)
    checkOnly.delete(shareId)
  }

  /** R1: the post-save notification. Publishes the links that are on for the pieces in `paths`. */
  function saved(root: string, paths: readonly string[]): void {
    if (paths.length === 0 || records.length === 0) return
    for (const { shareId } of [...records]) {
      const record = find(shareId)
      // R14: a link whose piece is not found publishes nothing until it is found again or followed.
      if (!record || !record.on || record.ended || record.lost) continue
      const hit = record.kind === 'folio'
        ? paths.some((path) => insideFolio(record, root, path))
        : paths.some((path) => samePiece(record, root, path))
      if (!hit) continue
      // R11, R14: a piece (or a Folio's folder) not on disk now is not published: it went to the Trash,
      // or the outside-change follower settles it (sharing-outside-changes.ts).
      if (ports.exists?.(record.root, record.path) === false) continue
      // R13, R-C: the file as it is now; an editor's save may put another file at the same path (the same piece).
      const fileId = idOf(record)
      if (fileId && fileId !== record.fileId) update(shareId, { fileId })
      // R12, R16: the save is on record before it is published, so a restart still publishes it. Not saved: not queued, and said.
      if (record.queuedAt === null && !commitPatch(shareId, { queuedAt: now() })) continue
      checkOnly.delete(shareId)
      schedule(shareId)
    }
  }

  /** R11, R16: every link at or under `from` in `root` takes `to`; a new generation each. False when it could not be saved. */
  function move(root: string, from: string, to: string): boolean {
    const ids: string[] = []
    const next = records.map((record) => {
      const followed = followMove(record, root, from, to)
      if (!followed) return record
      ids.push(record.shareId)
      const fileId = idOf(followed)
      // R13: the file at its new place; a piece found there is no longer "not found".
      return { ...followed, generation: record.generation + 1, ...(fileId ? { fileId, lost: null } : {}) }
    })
    if (ids.length === 0) return true
    const done = commit(next, ids)
    changed()
    return done
  }

  /** R15 (see the header). Never removes; a removal the Trash owes is finished. */
  function reconcile(root: string | null): Promise<void> {
    const run = reconciling.then(async () => {
      // P3: one walk per Workspace this pass, however many of its shares are missing.
      const walks = new Map<string, Promise<WorkspaceIds | null>>()
      const walkOf = (workspace: string): Promise<WorkspaceIds | null> => {
        let walk = walks.get(workspace)
        if (!walk) { walk = scanWorkspace(workspace).catch(() => null); walks.set(workspace, walk) }
        return walk
      }
      /** The piece is there (the same file, or another at its path: R-C): published if owed or changed. */
      const present = (shareId: string, record: ShareRecord, id: string): void => {
        if (id !== record.fileId || record.lost) update(shareId, { fileId: id, lost: null })
        // A publish already on its way (a save, the start's own look) is not asked for twice; without the
        // service set up on this Mac nothing could go out.
        if (pending.has(shareId) || publishing.has(shareId) || !ports.access()) return
        const owed = record.queuedAt !== null || record.problem?.kind === 'offline' || record.lost !== null
        if (owed) checkOnly.delete(shareId)
        else checkOnly.add(shareId)
        schedule(shareId, 0)
      }
      for (const { shareId } of [...records]) {
        const record = find(shareId)
        if (!record || (root !== null && record.root !== root)) continue
        if (record.ended) { catchUp(shareId); continue }
        if (!record.on) continue
        const kind = fileKind(record.kind)
        const there = presence(record.root, record.path)
        if (there.state === 'there' && there.kind === kind) { present(shareId, record, there.id); continue }
        const walk = there.state !== 'unreadable' && record.fileId ? await walkOf(record.root) : null
        // P2-3: what the walk found is dropped when the record changed while the Workspace was read (found,
        // saved, moved, turned off), and a file back at its path wins over the missing one.
        if (find(shareId) !== record) continue
        const again = presence(record.root, record.path)
        if (again.state === 'there' && again.kind === kind) { present(shareId, record, again.id); continue }
        const why = again.state === 'unreadable' ? 'unreadable' : 'gone'
        const found = why === 'gone' && walk && record.fileId ? candidateIn(walk, record.fileId, kind) : null
        cancelTimers(shareId)
        update(shareId, { lost: { at: record.lost?.at ?? now(), why, candidate: found !== null && !isAtOrUnder(found, record.path) ? found : null } })
      }
      changed()
    })
    reconciling = run.catch(() => {})
    return reconciling
  }

  const failFor = (record: ShareRecord, problem: { reason: string; fix: string }): SharingLinkResult => ({ ok: false, view: view(record.root, record.path, record.kind), problem })

  return {
    view,
    mark: (root: string, path: string, kind: ShareKind = 'piece'): ShareMark => markOf(records.filter((record) => samePiece(record, root, path, kind))),

    /** R1: the post-save notification. Publishes the links that are on for the pieces in `paths`. */
    saved,

    /** R11: `from` (a file or a folder) was renamed or moved to `to` in `root`: every link on it follows. False: not saved (R16), nothing moved. */
    moved: move,

    /** R11: `paths` (files or folders) in `root` went to the Trash: every share on them ends and its copy is removed. False: not saved (R16), nothing ended. */
    trashed(root: string, paths: readonly string[]): Promise<boolean> {
      const ending = records.filter((record) => !record.ended && endedByTrash(record, root, paths))
      if (ending.length === 0) return Promise.resolve(true)
      const ids = ending.map((record) => record.shareId)
      // Saved before the service is asked, so a restart still owes the removal.
      const at = now()
      if (!commit(records.map((record) => (ids.includes(record.shareId) ? { ...record, ended: { at, removed: !record.on }, queuedAt: null, problem: null, lost: null } : record)), ids)) return Promise.resolve(false)
      for (const shareId of ids) cancelTimers(shareId)
      changed()
      return Promise.all(ids.map((shareId) => enqueue(shareId, () => endNow(shareId)))).then(() => true)
    },

    /** What the outside-change follower watches: every share not ended, its file, whether it is not found. */
    followed(): Array<{ root: string; kind: ShareKind; path: string; parts: string[]; id: string | null; lost: boolean }> {
      return records.filter((record) => !record.ended)
        .map((record) => ({ root: record.root, kind: record.kind, path: record.path, parts: record.parts.map((part) => part.path), id: record.fileId, lost: record.lost !== null }))
    },

    /** R14: the piece (or Folio folder) at `path` in `root` is not there, or cannot be read: its links stop publishing. Nothing is removed. */
    notFound(root: string, path: string, why: 'gone' | 'unreadable'): void {
      const hit = records.filter((record) => !record.ended && record.root === root && record.path === path)
      for (const record of hit) {
        cancelTimers(record.shareId)
        update(record.shareId, { lost: { at: record.lost?.at ?? now(), why, candidate: record.lost?.candidate ?? null } })
      }
      if (hit.length > 0) changed()
    },

    /** R13, R-C: the file at `path` is there (the same one, or another file put at that path: an edit). Links not found there are found again. */
    found(root: string, path: string, id: string): void {
      let any = false
      for (const record of records.filter((entry) => !entry.ended && entry.root === root && entry.path === path)) {
        if (record.fileId === id && !record.lost) continue
        update(record.shareId, { fileId: id, lost: null })
        any = true
      }
      if (any) changed()
    },

    /** R14: the one place holding a not-found piece's file is `to`: offered to the writer as "Follow to". */
    offer(root: string, path: string, to: string): void {
      let any = false
      for (const record of records.filter((entry) => !entry.ended && entry.lost && entry.root === root && entry.path === path)) {
        if (record.lost!.candidate === to) continue
        update(record.shareId, { lost: { ...record.lost!, candidate: to } })
        any = true
      }
      if (any) changed()
    },

    /**
     * R14, the writer's choice: follow a not-found link to the place main found holding the same file.
     * Never a path a window names. Every link on that piece follows (a move), and the piece is published there.
     */
    async followTo(shareId: unknown): Promise<SharingLinkResult | null> {
      const record = find(shareId)
      if (!record) return null
      const to = record.lost?.candidate ?? null
      const there = to === null ? null : presence(record.root, to)
      // The writer's choice: a file that may be it (I0 'same' or 'unknown'), never one known to be another.
      if (to === null || !record.fileId || there?.state !== 'there' || there.kind !== fileKind(record.kind) || sameFile(there.id, record.fileId) === 'different') {
        if (record.lost?.candidate) { update(record.shareId, { lost: { ...record.lost, candidate: null } }); changed() }
        return failFor(record, FOLLOW_NOT_THERE)
      }
      if (!move(record.root, record.path, to)) return failFor(find(record.shareId) ?? record, FOLLOW_NOT_SAVED)
      saved(record.root, [to])
      return { ok: true, view: view(record.root, to, record.kind) }
    },

    /** R12, R15, at start: every owed removal finished, every queued link published, every share that is on looked at. */
    resume(): Promise<void> {
      return reconcile(null)
    },

    /** R15: a Workspace opened again: its shares looked at. */
    reconcile(root: string): Promise<void> {
      return reconcile(root)
    },

    /**
     * A command-line signal for one share (sharing-follow-signals.ts S3). Applied only when the share is
     * at the signal's generation and still where it was made; 'held' when it was made at a later
     * generation (the one before it has not landed); otherwise 'stale' (an earlier generation, another
     * place, a share ended or not there). 'failed': the change could not be saved (R16), so the signal is kept.
     */
    applySignal(signal: ShareSignal): 'applied' | 'stale' | 'held' | 'failed' {
      const record = find(signal.shareId)
      if (!record || record.ended || normaliseRoot(record.root) !== normaliseRoot(signal.root)) return 'stale'
      if (signal.generation > record.generation) return 'held'
      if (signal.generation < record.generation || record.path !== signal.from) return 'stale'
      if ('trashed' in signal) {
        const ended = { ...record, ended: { at: now(), removed: !record.on }, queuedAt: null, problem: null, lost: null }
        if (!commit(records.map((entry) => (entry === record ? ended : entry)), [record.shareId])) return 'failed'
        cancelTimers(record.shareId)
        changed()
        void enqueue(record.shareId, () => endNow(record.shareId))
        return 'applied'
      }
      const followed = followMove(record, record.root, signal.move.from, signal.move.to)
      if (!followed) return 'stale'
      const fileId = idOf(followed)
      const next = { ...followed, generation: record.generation + 1, ...(fileId ? { fileId, lost: null } : {}) }
      if (!commit(records.map((entry) => (entry === record ? next : entry)), [record.shareId])) return 'failed'
      changed()
      saved(record.root, [next.path])
      return 'applied'
    },

    /** R12: the network is back (or the Mac woke): try every link waiting on the service now. */
    reconnected(): void {
      for (const record of records) {
        const timer = retries.get(record.shareId)
        if (timer) { clearTimeout(timer); retries.delete(record.shareId) }
        misses.delete(record.shareId)
        catchUp(record.shareId)
      }
    },

    /** Make a link for the piece at `path`, or (kind 'folio') for the Folio whose folder is `path`. */
    async make(root: string, path: string, input: { name: unknown; comments: unknown }, kind: ShareKind = 'piece'): Promise<SharingLinkResult> {
      const fail = (where: string, at: string, problem: { reason: string; fix: string }): SharingLinkResult => ({ ok: false, view: view(where, at, kind), problem })
      const access = ports.access()
      if (!access) return fail(root, path, NOT_SET_UP_PROBLEM)
      const created = await ports.client.createShare(access)
      if (created.kind !== 'ok') return fail(root, path, MAKE_FAILED)
      const { shareId, ownerToken } = created.body
      if (!keepToken(shareId, ownerToken)) {
        // The link exists at the service but this Mac cannot keep its key: take it down again.
        await ports.client.turnOff(access.base, shareId, ownerToken).catch(() => null)
        return fail(root, path, TOKENS_NOT_SAVED)
      }
      const record: ShareRecord = {
        shareId, kind, root, path, name: cleanLinkName(input.name), comments: input.comments === true, on: true, madeAt: now(),
        revision: 0, publishedAt: null, publishedSavedAt: null, images: [], problem: null, note: null, partKeys: {}, parts: [], queuedAt: null, ended: null,
        // R13: the file the share is on, from the moment it is made.
        fileId: idOf({ root, path, kind }), generation: 0, publishedHash: null, lost: null,
      }
      // The record is what lets the writer find and turn off this link later (after a restart too), so
      // it is saved, and read back, before anything is published. When it is not, the link is taken
      // down again and nothing is published.
      const before = records
      const kept = save([...records, record]) && readRecords(ports.records.read()).some((entry) => entry.shareId === shareId)
      if (!kept) {
        records = before
        await ports.client.turnOff(access.base, shareId, ownerToken).catch(() => null)
        forgetToken(shareId)
        return fail(root, path, LINK_NOT_SAVED)
      }
      changed()
      pending.add(shareId)
      await enqueue(shareId, async () => { if (pending.delete(shareId)) await publishNow(shareId) })
      return { ok: true, view: view(root, path, kind), shareId }
    },

    async rename(shareId: unknown, name: unknown): Promise<SharingLinkResult | null> {
      const record = find(shareId)
      if (!record) return null
      update(record.shareId, { name: cleanLinkName(name) })
      changed()
      return { ok: true, view: view(record.root, record.path, record.kind) }
    },

    /** Readers can leave notes, or not: the next publish carries it (the service changes it on publish). */
    async setComments(shareId: unknown, comments: unknown): Promise<SharingLinkResult | null> {
      const record = find(shareId)
      if (!record) return null
      update(record.shareId, { comments: comments === true })
      changed()
      if (record.on) {
        pending.add(record.shareId)
        // R16: on record before anything is sent.
        await enqueue(record.shareId, async () => { if (pending.delete(record.shareId)) await publishNow(record.shareId, false, true) })
      }
      return { ok: true, view: view(record.root, record.path, record.kind) }
    },

    async turnOff(shareId: unknown): Promise<SharingLinkResult | null> {
      const record = find(shareId)
      if (!record) return null
      cancelTimers(record.shareId)
      return enqueue(record.shareId, async (): Promise<SharingLinkResult> => {
        const access = ports.access()
        const owner = tokenFor(record.shareId)
        if (!access) return failFor(record, NOT_SET_UP_PROBLEM)
        if (!owner) return failFor(record, { reason: SHARE_AUTH, fix: LINK_UNKNOWN.fix })
        const answer = await ports.client.turnOff(access.base, record.shareId, owner)
        if (answer.kind !== 'ok') return failFor(record, TURN_OFF_FAILED)
        // R14: a link turned off is no longer "not found": it publishes nothing anyway.
        // R16 (Sol round 3 P3): a turn-off that could not be saved still says so (`update`).
        update(record.shareId, { on: false, images: [], problem: null, queuedAt: null, lost: null, ...(record.ended ? { ended: { at: record.ended.at, removed: true } } : {}), revision: Math.max(record.revision, answer.body.revision ?? 0) })
        changed()
        return { ok: true, view: view(record.root, record.path, record.kind) }
      })
    },

    async turnOn(shareId: unknown): Promise<SharingLinkResult | null> {
      const record = find(shareId)
      if (!record) return null
      const result = await enqueue(record.shareId, async (): Promise<SharingLinkResult> => {
        const access = ports.access()
        const owner = tokenFor(record.shareId)
        if (!access) return failFor(record, NOT_SET_UP_PROBLEM)
        if (!owner) return failFor(record, { reason: SHARE_AUTH, fix: LINK_UNKNOWN.fix })
        const answer = await ports.client.turnOn(access.base, record.shareId, owner)
        if (answer.kind !== 'ok') return failFor(record, TURN_ON_FAILED)
        // R11: turning on again after the Trash (the file is back) ends nothing more: the share is on at the same address.
        // A new generation, so a command-line signal made before it (before a restore) is stale (S3).
        // R16: made only when saved; not saved, the link stays off here, says why, and nothing is published.
        const latest = find(record.shareId) ?? record
        if (!commitPatch(record.shareId, { on: true, images: [], problem: null, ended: null, lost: null, fileId: idOf(latest) ?? latest.fileId, generation: latest.generation + 1, revision: Math.max(latest.revision, answer.body.revision ?? 0) })) {
          changed()
          return failFor(latest, TURN_ON_NOT_SAVED)
        }
        changed()
        await publishNow(record.shareId, false, true)
        return { ok: true, view: view(record.root, record.path, record.kind) }
      })
      return result
    },

    /** Publish again now (Retry). On record first (R16): when that cannot be saved, nothing is sent and the link says so. */
    async retry(shareId: unknown): Promise<SharingLinkResult | null> {
      const record = find(shareId)
      if (!record) return null
      pending.add(record.shareId)
      await enqueue(record.shareId, async () => { if (pending.delete(record.shareId)) await publishNow(record.shareId, false, true) })
      return { ok: true, view: view(record.root, record.path, record.kind) }
    },

    /**
     * Ticket 10, the Shares list: every link made in the Workspace `root`, once each, in the order they
     * were made, with the view the Sharing page draws, and the address fields of a page's view.
     * `parts`: a Folio link's parts as last published.
     */
    linksIn(root: string): Omit<PieceSharingView, 'links' | 'mark' | 'folio'> & { links: Array<{ kind: ShareKind; path: string; parts: readonly PublishedPartRecord[]; link: ShareLinkView }> } {
      const access = ports.access()
      return {
        ready: access !== null, address: access ? access.linkAddress ?? access.address : null, cloudflareAddress: access?.address ?? null, ownAddress: access?.ownAddress ?? null,
        addressUntil: access?.linkAddressUntil ?? null,
        links: records.filter((record) => record.root === root)
          .map((record) => ({ kind: record.kind, path: record.path, parts: record.parts.map((part) => ({ ...part })), link: linkView(record, access) })),
      }
    },

    /**
     * Ticket 10: how many times readers opened each link, as the service counts it (service build 4,
     * `GET /shares/<id>` `opened`). Null for a link the service did not answer for (offline, no key on
     * this Mac, a service older than build 4). Asked with each link's owner token, never shown anywhere;
     * at most OPENED_AT_ONCE requests at a time. Ids that are no link of this Mac are left out.
     */
    async opened(shareIds: readonly string[]): Promise<Record<string, number | null>> {
      const access = ports.access()
      const known = [...new Set(shareIds)].filter((shareId) => find(shareId) !== null)
      const counts: Record<string, number | null> = {}
      let next = 0
      const worker = async (): Promise<void> => {
        while (next < known.length) {
          const shareId = known[next++]
          const owner = access ? tokenFor(shareId) : null
          if (!access || !owner) { counts[shareId] = null; continue }
          const answer = await ports.client.state(access.base, shareId, owner).catch(() => null)
          const value = answer?.kind === 'ok' ? answer.body.opened : undefined
          counts[shareId] = Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null
        }
      }
      await Promise.all(Array.from({ length: Math.min(OPENED_AT_ONCE, known.length) }, worker))
      return Object.fromEntries(known.map((shareId) => [shareId, counts[shareId] ?? null]))
    },

    /**
     * Ticket 07: the links whose readers' notes the collector asks for, in the Workspace `root`: where
     * the service is, each link's owner token (main only), the label its cards carry, and the
     * documents its notes may be on (the piece, or a Folio's parts as last published, in running order).
     * Links that are off are asked too: notes wait on the service until collected (spec 6.1).
     */
    noteSources(root: string): Array<{ shareId: string; label: string; paths: string[]; partKeys?: Record<string, string>; base: string; owner: string }> {
      const access = ports.access()
      if (!access) return []
      return records.filter((record) => record.root === root).flatMap((record) => {
        const owner = tokenFor(record.shareId)
        if (!owner) return []
        const paths = record.kind === 'folio' ? record.parts.filter((part) => !part.missing).map((part) => part.path) : [record.path]
        // A Folio's part keys route a note to the part its block hint names (sharing-reader-notes.ts place).
        return [{ shareId: record.shareId, label: readerLinkLabel(record), paths, ...(record.kind === 'folio' ? { partKeys: { ...record.partKeys } } : {}), base: access.base, owner }]
      })
    },

    /**
     * Ticket 07: every link, in any Workspace, that still has a note source (a record and its owner token).
     * Null when the tokens cannot be read just now (ticket 11, review 07 P3-B): a Keychain failure says
     * nothing about which links exist, so what is kept per link is not pruned on it.
     */
    noteShareIds(): string[] | null {
      const held = heldTokenIds()
      if (held === null) return null
      return records.filter((record) => held.includes(record.shareId)).map((record) => record.shareId)
    },

    // ── Ticket 07: the Limits panel ─────────────────────────────────────────────────────────────
    /** Refusals by reason the writer has acted on for this link (none: {}). */
    refusedSeen(shareId: string): Record<string, number> {
      return { ...(find(shareId)?.refusedSeen ?? {}) }
    },
    /** The writer acted on the Limits panel: refusals counted so far are seen; the panel shows only later ones. */
    acknowledgeRefused(shareId: string, byReason: Readonly<Record<string, number>>): void {
      const record = find(shareId)
      if (!record) return
      update(record.shareId, { refusedSeen: { ...byReason } })
      changed()
    },
    /**
     * Clear handled notes: delete these notes (keys the window's review list holds as decided) on the
     * service, at most 200 a request. The service deletes only notes already collected. Answers how many
     * went, and the keys it no longer holds (`gone`: cleared, or unknown to it; only keys asked about;
     * review round 1 of ticket 11, F1), or why none could.
     */
    async clearNotes(shareId: string, keys: readonly string[]): Promise<{ ok: true; cleared: number; gone: string[] } | { ok: false; why: 'offline' | 'old-service' | 'not-set-up' }> {
      const record = find(shareId)
      const access = ports.access()
      const owner = record ? tokenFor(record.shareId) : null
      if (!record || !access || !owner) return { ok: false, why: 'not-set-up' }
      let cleared = 0
      const gone: string[] = []
      const wanted = [...new Set(keys)]
      for (let at = 0; at < wanted.length; at += 200) {
        const asked = wanted.slice(at, at + 200)
        const answer = await ports.client.clearNotes(access.base, record.shareId, owner, asked).catch(() => ({ kind: 'unreachable' as const }))
        if (answer.kind === 'refused' && (answer.status === 404 || answer.status === 405)) return { ok: false, why: 'old-service' }
        if (answer.kind !== 'ok') return cleared > 0 ? { ok: true, cleared, gone } : { ok: false, why: 'offline' }
        cleared += Array.isArray(answer.body.cleared) ? answer.body.cleared.length : 0
        const named = new Set([...(Array.isArray(answer.body.cleared) ? answer.body.cleared : []), ...(Array.isArray(answer.body.unknown) ? answer.body.unknown : [])])
        gone.push(...asked.filter((key) => named.has(key)))
      }
      return { ok: true, cleared, gone }
    },
    /** Raise the limit for this link: the service doubles the link's own limits, up to its most. */
    async raiseLimit(shareId: string): Promise<{ ok: true; limits: unknown } | { ok: false; why: 'offline' | 'old-service' | 'not-set-up' | 'at-most'; limits?: unknown }> {
      const record = find(shareId)
      const access = ports.access()
      const owner = record ? tokenFor(record.shareId) : null
      if (!record || !access || !owner) return { ok: false, why: 'not-set-up' }
      const answer = await ports.client.raiseLimit(access.base, record.shareId, owner).catch(() => ({ kind: 'unreachable' as const }))
      if (answer.kind === 'ok') return { ok: true, limits: answer.body.limits }
      if (answer.kind === 'refused' && answer.code === 'limit_at_most') return { ok: false, why: 'at-most', limits: answer.extra.limits }
      if (answer.kind === 'refused' && (answer.status === 404 || answer.status === 405)) return { ok: false, why: 'old-service' }
      return { ok: false, why: 'offline' }
    },

    /** Tests: every queued and scheduled publish has finished. */
    async idle(): Promise<void> {
      await reconciling
      for (let round = 0; round < 50; round += 1) {
        if (timers.size === 0 && chains.size === 0) return
        await Promise.all([...chains.values()])
        if (timers.size > 0) await new Promise((done) => setTimeout(done, debounceMs + 5))
      }
    },

    /** The records as kept (tests). */
    records: (): readonly ShareRecord[] => records,
  }
}

export type SharingPublisher = ReturnType<typeof createSharingPublisher>
