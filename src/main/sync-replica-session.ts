/**
 * One window's replica versions and reconciliation for a Collection in OneDrive. Contract:
 * docs/plans/2026-11-03-sync-replicas-and-duplicate-reconciliation.md. Electron-free, so the whole flow
 * is tested with real folders (tests/main/sync-replicas*.test.ts); ipc.ts only calls it.
 *
 *  - editor saves: `beforeSave` keeps the text a save replaces, `saved` makes the saved text durable
 *    locally and starts or continues a save cycle (replica-save-cycles.ts). Neither waits for OneDrive.
 *  - arrivals (the watcher's paths, also when the window's "watch outside changes" display is off):
 *    the pending save cycle is written first (it is the text sync may just have replaced), then copies
 *    in those folders are reconciled, then what arrived is kept as a version. A document still arriving
 *    is looked at again after it has had time to settle, without needing another watcher event.
 *  - history arrivals (the watcher's second channel: a replica record or object another computer published
 *    arrived, whatever the display setting says): one whole-Collection pass, but only when the store now
 *    holds evidence the last pass did not see (a record it did not read, or a record whose object has
 *    since arrived). A record can be the first sign of the other computer's name, so the pass is not
 *    limited to folders. This app's own publications never reach here (`wasPublishedByThisApp`), and a
 *    pass that adds nothing new to the store asks for no further pass: no feedback loop.
 *  - opening the Collection and waking the Mac: local recovery is written to the store, then a
 *    reconciliation pass over the whole Collection.
 *  - the changed-on-disk banner's Merge (`preserve`) and a restore (`keepBeforeRestore`) keep the text
 *    they replace with no agent and without waiting for one.
 * Passes run one at a time; a request during a pass runs one more pass after it.
 *
 * LIFECYCLE. `dispose` closes admission at once (no new pass, arrival or retry starts), stops the pass in
 * flight before its next write (reconcile's `alive`) and waits for it and every arrival in flight, then
 * writes the pending save cycles (the normal shutdown flush) and resolves. A save cycle written during
 * disposal asks for a pass, which is refused because admission is closed: no deadlock, and nothing is
 * archived, merged or moved after the window let the Collection go.
 *
 * BOUNDED BY LOCAL DURABILITY. Every text this session keeps is in local recovery before it is
 * acknowledged, so disposal never needs OneDrive: it waits at most `disposeGraceMs` (default 5 s) for the
 * pass and the store, then resolves. Work still running past the grace is not cancelled (an fsync or rename
 * the operating system is carrying out on a File Provider folder cannot be), but it can no longer change a
 * document: admission is closed, `alive` is false, and every document write and move of a pass checks it in
 * the same synchronous step as its commit (sync-reconcile.ts). What it may still do is finish writing a
 * version into the synced store; a text not written there stays in local recovery for the next open.
 */
import { isSyncedLocation } from './sync-location'
import { readReplicaRecordsSync, REPLICA_DIR, replicaVersionsFor, sha256Hex, wasPublishedByThisApp, type ReplicaVersions } from './replica-versions'
import type { HistoryRoute } from './workspace-watcher'
import { localRecoveryBytes, localRecoveryVersions, ReplicaSaveCycles, withinGrace } from './replica-save-cycles'
import type { Version } from '../engine'
import { readSettled, reconcileSyncCopies, type ReconcileReport } from './sync-reconcile'
import type { PreserveResult } from '../shared/preserve-receipt'
import type { SaveBasis } from '../shared/save-basis'
import type { Workspace } from './workspace'
import { posix } from 'node:path'

export type SyncReplicaEvents = {
  /** Versions were kept (the Versions list should refresh). */
  versionsChanged?: () => void
  /** A pass finished; `written` are originals WriteFlex updated, `moved` copies it set aside. */
  reconciled?: (report: ReconcileReport, changed: { written: string[]; moved: string[] }) => void
  /** Pairs left for the writer (first time each is seen in this window). */
  divergent?: (pairs: ReconcileReport['divergent']) => void
  report?: (event: string, details: Record<string, unknown>) => void
}

export type SyncReplicaOptions = {
  device?: string
  aliases?: string[]
  quietMs?: number
  settleMs?: number
  now?: () => number
  /** This Mac's local recovery folder (application data, outside OneDrive). Tests use the temporary folder. */
  recoveryDir?: string
  /** Delay before a deferred arrival or pass is looked at again (default: settle time plus a second). */
  retryMs?: number
  /** The longest `dispose` waits for work in flight and the store (default 5 s); everything is durable locally. */
  disposeGraceMs?: number
}

export const DISPOSE_GRACE_MS = 5_000

const MAX_RETRIES = 5
const folderOf = (path: string): string => (posix.dirname(path) === '.' ? '' : posix.dirname(path))
const isDocument = (path: string): boolean => /\.(?:md|markdown|mdx)$/i.test(path)

export class SyncReplicaSession {
  readonly store: ReplicaVersions
  readonly cycles: ReplicaSaveCycles
  #running: Promise<ReconcileReport | null> | null = null
  #again: Set<string> | 'all' | null = null
  readonly #announced = new Set<string>()
  readonly #recentSaves = new Map<string, number>()
  readonly #inFlight = new Set<Promise<unknown>>()
  /** Documents that arrived while still being written: kept once they settle. */
  readonly #deferredArrivals = new Set<string>()
  #retryFolders: Set<string> | 'all' | null = null
  #retries = 0
  #retryTimer: ReturnType<typeof setTimeout> | null = null
  #closing = false
  #disposed: Promise<void> | null = null
  /** The store's records (`id`) and present records (`id+`) as the latest pass found them before it ran. */
  #seen: Set<string> | null = null
  readonly #waitingObjects = new Set<string>()
  readonly #historyPending = new Set<string>()
  #historyCheck: Promise<void> | null = null

  /** A session for `workspace` when it is in OneDrive; null (nothing changes) otherwise. The app names its
   *  local recovery folder (`replicaRecoveryDir(userData)`): production never uses the temporary folder. */
  static for(workspace: Workspace, events: SyncReplicaEvents, opts: SyncReplicaOptions & { recoveryDir: string }): SyncReplicaSession | null {
    return isSyncedLocation(workspace.root) ? new SyncReplicaSession(workspace, events, opts) : null
  }

  constructor(readonly workspace: Workspace, readonly events: SyncReplicaEvents = {}, readonly opts: SyncReplicaOptions = {}) {
    this.store = replicaVersionsFor(workspace.root, {
      ...(opts.device ? { device: opts.device } : {}), ...(opts.aliases ? { aliases: opts.aliases } : {}),
    })
    this.cycles = new ReplicaSaveCycles(this.store, {
      ...(opts.quietMs !== undefined ? { quietMs: opts.quietMs, maxWaitMs: Math.max(opts.quietMs, 1) * 4 } : {}),
      ...(opts.recoveryDir ? { recoveryDir: opts.recoveryDir } : {}),
      onError: (path, error) => this.events.report?.('sync-replicas.version-not-written', { path, message: error instanceof Error ? error.message : String(error) }),
      onKept: () => this.events.versionsChanged?.(),
      // A save cycle written: a pair deferred because this Mac was editing it can be reconciled now.
      // Refused (returns at once) while the session is closing, so disposal never waits on itself.
      onFlushed: (path) => { this.events.versionsChanged?.(); void this.reconcile([folderOf(path)]) },
    })
  }

  /** Whether the session still accepts work. */
  get open(): boolean { return !this.#closing }

  #now(): number { return (this.opts.now ?? Date.now)() }
  #settle(): { settleMs?: number } {
    // Settling is judged against file times, so on the real clock (`opts.now` is the editing clock).
    return this.opts.settleMs !== undefined ? { settleMs: this.opts.settleMs } : {}
  }

  #track<T>(work: Promise<T>): Promise<T> {
    this.#inFlight.add(work)
    void work.finally(() => this.#inFlight.delete(work)).catch(() => {})
    return work
  }

  /** This Mac saved `path` in the last ten seconds, or is in a save cycle: do not write it now. */
  busy(path: string): boolean {
    const at = this.#recentSaves.get(path)
    return this.cycles.isEditing(path) || (at !== undefined && this.#now() - at < 10_000)
  }

  /**
   * Before an editor save. The text it may replace is kept first, locally and durably (the store follows
   * asynchronously): the basis (what the buffer was based on) and, for Keep mine, the other copy it
   * overrides. A failure to keep the other copy throws and so refuses the Keep mine save (that text would
   * otherwise be lost); a failure to keep the baseline refuses the replacement too. Never waits for OneDrive.
   */
  beforeSave(path: string, basis: SaveBasis): void {
    if (this.#closing) throw new Error('This Collection is closing; a new save cannot start.')
    if (basis.kind !== 'disk' && basis.kind !== 'keep-mine') return
    if (basis.kind === 'keep-mine') {
      void this.#track(this.cycles.beforeReplace(path, basis.text, 'before-keep-mine'))
      return
    }
    try {
      void this.#track(this.cycles.beforeReplace(path, basis.text, 'baseline'))
    } catch (error) {
      this.events.report?.('sync-replicas.baseline-not-kept', { path, message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  /** After an editor save of `path` wrote `written` (over `basis`): durable locally before this returns. */
  saved(path: string, written: string, basis: SaveBasis): void {
    // A disk write admitted before closing may finish afterwards. Its original session still keeps it.
    this.#recentSaves.set(path, this.#now())
    try {
      this.cycles.saved(path, written, basis.kind === 'disk' || basis.kind === 'keep-mine' ? basis.text : null)
    } catch (error) {
      // The document itself is saved, but recovery failed. Do not acknowledge a durable save:
      // the IPC failure keeps the editor buffer held, with its outcome unknown.
      this.events.report?.('sync-replicas.recovery-not-written', { path, message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  /**
   * Keep `text`, the version of `path` the caller means, before something replaces it (the banner's
   * Merge). Kept only while the disk holds exactly that text; durable locally before the receipt is
   * given, in the store as soon as it can be written. No agent, and no waiting for OneDrive.
   */
  async preserve(path: string, text: string): Promise<PreserveResult> {
    if (this.#closing) return { kept: false, refused: 'unavailable' }
    const expected = sha256Hex(Buffer.from(text, 'utf8'))
    const disk = await readSettled(this.workspace.absolute(path), { settleMs: 0 })
    if (disk.kind !== 'settled') return { kept: false, refused: 'unavailable' }
    if (disk.sha !== expected) return { kept: false, refused: 'mismatch' }
    try {
      void this.#track(this.cycles.keepBefore(path, disk.bytes, 'preserve'))
      return { kept: true, receipt: { store: 'replica-versions', entryId: `pending:${expected.slice(0, 16)}`, sha256: expected } }
    } catch {
      return { kept: false, refused: 'unavailable' }
    }
  }

  /** The text a restore is about to replace: kept locally and durably first (throws when it cannot be). */
  keepBeforeRestore(path: string, text: string): void {
    if (this.#closing) throw new Error('The Collection is closing in this window.')
    void this.#track(this.cycles.keepBefore(path, text, 'before-restore'))
  }

  /**
   * Files arrived or changed outside WriteFlex (the watcher's paths). First the text this Mac saved last
   * is written to the store (sync may have just replaced it), then copies are reconciled in those
   * folders, then what arrived is kept as a version of each document still there that is not a copy.
   */
  arrived(paths: readonly string[]): Promise<void> {
    if (this.#closing) return Promise.resolve()
    return this.#track(this.#arrived(paths))
  }

  async #arrived(paths: readonly string[]): Promise<void> {
    const documents = paths.filter(isDocument)
    for (const path of documents) await this.cycles.flush(path)
    if (this.#closing) return
    const report = paths.length ? await this.reconcile([...new Set(paths.map(folderOf))]) : null
    const copies = new Set([...(report?.setAside ?? []), ...(report?.divergent ?? [])].map((row) => row.copy))
    let kept = false
    for (const path of documents) {
      if (this.#closing) return
      if (copies.has(path)) { this.#deferredArrivals.delete(path); continue }
      let absolute: string
      try { absolute = this.workspace.absolute(path) } catch { this.#deferredArrivals.delete(path); continue }
      const read = await readSettled(absolute, this.#settle())
      if (read.kind === 'absent') { this.#deferredArrivals.delete(path); continue }
      if (read.kind !== 'settled') {
        // Still arriving: looked at again once it has had time to settle (no further watcher event needed).
        this.#deferredArrivals.add(path)
        this.#retryLater()
        continue
      }
      this.#deferredArrivals.delete(path)
      if (this.#closing) return
      try {
        const { created } = await this.store.capture({ path, bytes: read.bytes, cause: 'incoming', dedupe: 'path-hash' })
        kept ||= created
      } catch (error) {
        this.events.report?.('sync-replicas.incoming-not-kept', { path, message: error instanceof Error ? error.message : String(error) })
      }
    }
    if (kept) this.events.versionsChanged?.()
  }

  /**
   * Replica history files arrived (records or objects another computer published; the watcher's second
   * channel). A whole-Collection pass follows when they add evidence the latest pass did not have; a burst
   * that adds none does nothing unless it delivers a shared base a deferred pair could not read.
   */
  historyArrived(paths: readonly string[]): Promise<void> {
    if (this.#closing || !paths.length) return Promise.resolve()
    for (const path of paths) this.#historyPending.add(path)
    if (this.#historyCheck) return this.#historyCheck
    // A stalled File Provider read must not start another scan for every arriving burst.
    const work = this.#drainHistory().finally(() => {
      this.#historyCheck = null
      if (!this.#closing && this.#historyPending.size) void this.historyArrived([...this.#historyPending])
    })
    this.#historyCheck = work
    return this.#track(work)
  }

  async #drainHistory(): Promise<void> {
    while (!this.#closing && this.#historyPending.size) {
      const paths = [...this.#historyPending]
      this.#historyPending.clear()
      await this.#historyArrived(paths)
    }
  }

  async #historyArrived(paths: readonly string[]): Promise<void> {
    try {
      const now = await this.#evidence()
      if (this.#closing) return
      const prefix = `${REPLICA_DIR}/objects/`
      const waitingObjectArrived = paths.some((path) => path.startsWith(prefix) && this.#waitingObjects.has(path.slice(prefix.length)))
      const seen = this.#seen
      if (!waitingObjectArrived && seen && [...now].every((key) => seen.has(key))) return
      this.events.report?.('sync-replicas.history-arrived', { records: now.size })
      this.events.versionsChanged?.()
      await this.reconcile()
    } catch (error) {
      if (!this.#closing) this.events.report?.('sync-replicas.history-read-failed', { message: error instanceof Error ? error.message : String(error) })
    }
  }

  async #evidence(): Promise<Set<string>> {
    const all = await this.store.records()
    const present = await this.store.records({ present: true })
    return new Set([...all.map((r) => r.id), ...present.map((r) => `${r.id}+`)])
  }

  /**
   * One reconciliation pass (the whole Collection when `folders` is absent). Never rejects. Asked for
   * while a pass runs, one more pass follows it (null is returned for the request that was folded in).
   * Refused (null) once the session is closing.
   */
  async reconcile(folders?: readonly string[]): Promise<ReconcileReport | null> {
    if (this.#closing) return null
    if (this.#running) {
      if (!folders || this.#again === 'all') this.#again = 'all'
      else { this.#again ??= new Set(); for (const folder of folders) this.#again.add(folder) }
      return null
    }
    const running = this.#pass(folders)
    this.#running = running
    this.#track(running)
    let report: ReconcileReport | null = null
    try {
      report = await running
      return report
    } finally {
      this.#running = null
      const again = this.#again
      this.#again = null
      if (!this.#closing) {
        if (again) void this.reconcile(again === 'all' ? undefined : [...again])
        else if (report?.deferred.length) this.#retryLater(folders ?? 'all')
        else if (!this.#deferredArrivals.size) this.#retries = 0
      }
    }
  }

  /** Something deferred (a copy or a document still arriving): look again after it has had time to settle,
   *  a bounded number of times; the next arrival, open or wake also looks again. */
  #retryLater(folders?: readonly string[] | 'all'): void {
    if (folders) {
      if (folders === 'all' || this.#retryFolders === 'all') this.#retryFolders = 'all'
      else { this.#retryFolders ??= new Set(); for (const folder of folders) this.#retryFolders.add(folder) }
    }
    if (this.#closing || this.#retryTimer || this.#retries >= MAX_RETRIES) return
    this.#retries += 1
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      if (this.#closing) return
      const arrivals = [...this.#deferredArrivals]
      const retryFolders = this.#retryFolders
      this.#retryFolders = null
      if (arrivals.length) void this.arrived(arrivals)
      if (retryFolders) void this.reconcile(retryFolders === 'all' ? undefined : [...retryFolders])
    }, this.opts.retryMs ?? (this.opts.settleMs ?? 3_000) + 1_000)
    ;(this.#retryTimer as { unref?: () => void }).unref?.()
  }

  async #pass(folders?: readonly string[]): Promise<ReconcileReport | null> {
    try {
      // Local recovery first (texts saved while the store could not be written, or before a crash).
      if (await this.cycles.recover()) this.events.versionsChanged?.()
      if (this.#closing) return null
      // What this pass sees of the store (only whole passes judge every pair, so only they count it).
      const seen = !folders ? await this.#evidence() : null
      if (this.#closing) return null
      const report = await reconcileSyncCopies({
        workspace: this.workspace, store: this.store,
        ...(folders ? { folders } : {}),
        busy: (path) => this.busy(path),
        alive: () => !this.#closing,
        beforePair: (original) => this.cycles.flush(original),
        ...this.#settle(),
      })
      // Commit the start-of-pass evidence only after the pass completes; a failed scan has not seen it.
      if (seen) this.#seen = seen
      if (!folders) this.#waitingObjects.clear()
      for (const row of report.deferred) if (row.waitingForObject) this.#waitingObjects.add(row.waitingForObject)
      const written = report.setAside.filter((row) => row.reason === 'fast-forward' || row.reason === 'merged').map((row) => row.original)
      const moved = report.setAside.map((row) => row.copy)
      if (report.setAside.length || report.divergent.length || report.deferred.length) {
        this.events.report?.('sync-replicas.reconciled', { setAside: report.setAside, divergent: report.divergent, deferred: report.deferred })
      }
      if (report.setAside.length || report.divergent.length) this.events.versionsChanged?.()
      this.events.reconciled?.(report, { written, moved })
      const fresh = report.divergent.filter((pair) => {
        const key = `${pair.original}\0${pair.copy}`
        if (this.#announced.has(key)) return false
        this.#announced.add(key)
        return true
      })
      if (fresh.length) this.events.divergent?.(fresh)
      return report
    } catch (error) {
      this.events.report?.('sync-replicas.reconcile-failed', { message: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  /**
   * Texts held only in local recovery (the store could not be written yet, or a command line exited
   * first), as Versions for the existing Versions list; Compare and Restore read them by `localBytes`.
   */
  localVersions(): Version[] {
    return localRecoveryVersions(this.cycles.recovery, readReplicaRecordsSync(this.workspace.root), this.store.device)
  }

  /** The exact bytes of a local recovery text hashing to `sha`, or null. Local disk only. */
  localBytes(sha: string): Buffer | null {
    return localRecoveryBytes(this.cycles.recovery, sha)
  }

  /** Every write started so far (store writes, arrivals, passes) has finished. For tests and shutdown. */
  async settled(): Promise<void> {
    while (this.#inFlight.size) await Promise.allSettled([...this.#inFlight])
    await this.cycles.idle()
  }

  /**
   * Close admission now, stop and wait for the pass and arrivals in flight, write every pending save
   * cycle (what cannot be written stays in local recovery), then resolve. Idempotent.
   */
  dispose(): Promise<void> {
    if (this.#disposed) return this.#disposed
    this.#closing = true
    this.#historyPending.clear()
    if (this.#retryTimer) clearTimeout(this.#retryTimer)
    this.#retryTimer = null
    this.#again = null
    const grace = this.opts.disposeGraceMs ?? DISPOSE_GRACE_MS
    const started = Date.now()
    this.#disposed = (async () => {
      const drained = await withinGrace((async () => { while (this.#inFlight.size) await Promise.allSettled([...this.#inFlight]) })(), grace)
      const written = await this.cycles.dispose(Math.max(0, grace - (Date.now() - started)))
      if (!drained || !written) this.events.report?.('sync-replicas.dispose-grace-expired', { graceMs: grace, passesFinished: drained, storeWritten: written })
    })()
    return this.#disposed
  }
}

/**
 * The history route of a Collection's watcher (workspace-watcher.ts `HistoryRoute`), for a Collection in
 * OneDrive only (undefined elsewhere: its watcher is as before). Bound to `workspace`: an arrival is given
 * only to the session `current()` returns for that same Workspace, so a late callback of a watcher that
 * outlived its binding reaches neither a disposed session nor another Collection's.
 */
export function replicaHistoryRoute(workspace: Workspace, current: () => SyncReplicaSession | null): HistoryRoute | undefined {
  if (!isSyncedLocation(workspace.root)) return undefined
  return {
    isOwn: (path, at) => wasPublishedByThisApp(workspace.root, path, at),
    onArrived: (paths) => {
      const session = current()
      if (session?.workspace === workspace && session.open) void session.historyArrived(paths)
    },
  }
}

/** What preserving needs of an agent: its History snapshot of the document. */
export type PreservingAgent = { snapshotForPreserve: (path: string) => Promise<{ id: string; hash: string } | null> }

/**
 * The banner's Merge keep (`snapshot:preserve`). In a OneDrive Collection the replica store answers first
 * and an agent still starting is never waited for; an agent already running is asked only when the replica
 * store could not keep it. Elsewhere: History through the agent, as it always was.
 */
export async function preserveDocumentVersion(input: {
  path: string
  text: string
  replicas: SyncReplicaSession | null
  liveAgent: PreservingAgent | null
  pendingAgent: Promise<PreservingAgent> | null
  preserveVersion: (input: { text: string; history: (() => Promise<{ id: string; hash: string } | null>) | null }) => Promise<PreserveResult>
}): Promise<PreserveResult> {
  const { path, text, replicas, liveAgent } = input
  if (replicas) {
    const result = await replicas.preserve(path, text)
    if (result.kept || result.refused !== 'unavailable' || !liveAgent) return result
    return input.preserveVersion({ text, history: () => liveAgent.snapshotForPreserve(path) })
  }
  const agentNow = liveAgent ?? input.pendingAgent
  return input.preserveVersion({ text, history: agentNow ? async () => (await agentNow).snapshotForPreserve(path) : null })
}

/** What a restore needs of an agent: a checkpoint of the document in History. */
export type CheckpointingAgent = { checkpointFile: (path: string) => Promise<unknown> }

/**
 * The checkpoint a restore makes before and after it writes (version-content.ts `restoreVersionContent`),
 * in a OneDrive Collection: the text it replaces is kept by the replica store (locally and durably, with
 * no agent) the first time; an agent already running also checkpoints, an agent still starting is never
 * waited for, and its failure does not stop a restore the replica store has covered.
 */
export function replicaCheckpointer(input: {
  replicas: SyncReplicaSession
  read: (path: string) => Promise<string | null>
  liveAgent: () => CheckpointingAgent | null
}): (path: string) => Promise<void> {
  let keptBefore = false
  return async (path) => {
    if (!keptBefore) {
      keptBefore = true
      const current = await input.read(path)
      if (current !== null) input.replicas.keepBeforeRestore(path, current)
    }
    const live = input.liveAgent()
    if (live) await live.checkpointFile(path).catch(() => {})
  }
}
