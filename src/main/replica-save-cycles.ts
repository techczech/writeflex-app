/**
 * Which texts of a synced document become replica versions (replica-versions.ts), as the editor saves,
 * and how no saved text is ever lost while that happens. Contract rule 3: whatever sync later does
 * (overwrites, a conflict copy, a late arrival), every text a Mac saved can be found again, also after
 * the app is killed, and nothing about it waits for OneDrive.
 *
 * TWO PLACES, ONE ORDER.
 *  1. LOCAL RECOVERY (`LocalRecovery`, in this Mac's application data, outside OneDrive and any File
 *     Provider): written and fsynced synchronously before a save is acknowledged. It holds the text each
 *     save wrote (one file per document per window session, overwritten by that session's next save) and each text a save, Keep mine or
 *     a restore is about to replace. Local disk only: no cloud placeholder, sync state or OneDrive
 *     service is consulted, so a slow or stalled OneDrive never holds up saving.
 *  2. THE REPLICA STORE in the Collection (synced): the same texts follow asynchronously as immutable
 *     versions. A local recovery file is removed only once its version is written there. A version that
 *     cannot be written (I/O failure, a folder replaced, OneDrive not answering) is reported and stays
 *     in local recovery, and is tried again (later in this run, on the next arrival, pass, wake or open).
 *
 *  - BEFORE a save replaces text on disk that no version keeps yet, that text is kept first: the
 *    document as found before this Mac's edits (`baseline`), or the other copy a writer overrides with
 *    Keep mine (`before-keep-mine`; a failure to keep it locally refuses the save). Text the previous
 *    save of this run wrote is not kept separately. An empty document is a text like any other.
 *  - The user-visible version is one per run of saves: written once the saves have paused for `quietMs`,
 *    and at the latest `maxWaitMs` after the first save of the run (`save`, its parent the text the run
 *    started from); at once (`flush`) when sync brings another text for the document, when a
 *    reconciliation pass starts, and when the Collection is closed in this window.
 *  - On opening (`recover`), local recovery files for this Collection become versions in the store.
 */
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_REPLICA_BYTES, sha256Hex, versionOfReplica, type ReplicaCause, type ReplicaVersions } from './replica-versions'
import type { Version } from '../engine'

export const SAVE_QUIET_MS = 30_000
export const SAVE_MAX_WAIT_MS = 120_000
/** Retries of a version that could not be written to the store: doubling from the quiet period, at most this far apart. */
const RETRY_CEILING_MS = 10 * 60_000
const HEADER_LIMIT = 16 * 1024
/** How many "already kept" facts a session remembers (to skip re-keeping a baseline); cleared when full. */
const KEPT_MEMORY = 2_000

type BeforeCause = Extract<ReplicaCause, 'baseline' | 'before-keep-mine' | 'before-restore' | 'preserve'>
/** Kept by a direct document write (the command line's WriteSession, an app-carried request). */
export type CommandCause = Extract<ReplicaCause, 'before-command' | 'command'>
const KEPT_CAUSES = new Set<string>(['baseline', 'before-keep-mine', 'before-restore', 'preserve', 'before-command', 'command'])
export type RecoveryEntry =
  | { kind: 'save'; path: string; parents: string[]; first: number; run?: string }
  | { kind: 'before'; path: string; cause: BeforeCause | CommandCause; parents?: string[] }
type Entry = RecoveryEntry
export type Recovered = Entry & { name: string; bytes: Buffer; mtimeMs: number }

/** Where local recovery lives when the caller does not say: TESTS ONLY (a unit test's own temporary
 *  folder). Every production caller passes `replicaRecoveryDir(<its application-data folder>)`. */
export const DEFAULT_RECOVERY_DIR = join(tmpdir(), 'writeflex-replica-recovery')

/** This variant's local recovery folder in its application-data folder (Electron `userData`, or the
 *  command line's `recordsPlace(env).own`): the app, its requests and its command line share it. */
export const replicaRecoveryDir = (appData: string): string => join(appData, 'replica-recovery')

/** The Collection's root as recovery keys it: its real path, so the app and a command line that typed
 *  the path differently (a link, a trailing segment) share one folder. */
function recoveryRoot(root: string): string {
  try { return realpathSync(root) } catch { return root }
}

/**
 * Local, durable, synchronous storage of texts not yet in the replica store: one folder per Collection in
 * this Mac's application data. Files are a JSON header line and the exact bytes, written to a temporary
 * file, fsynced and renamed. Never in the Collection, so never synced and never a cloud placeholder.
 */
export class LocalRecovery {
  readonly dir: string
  readonly root: string
  constructor(baseDir: string, root: string) {
    this.root = recoveryRoot(root)
    this.dir = join(baseDir, sha256Hex(Buffer.from(this.root, 'utf8')).slice(0, 24))
  }

  /**
   * NAMES. `.save` is the editor's one file per document per window session, written and removed only by the window that
   * saves (its run is newer than any older file). Every other entry is CONTENT-ADDRESSED: its name is made
   * of the document, the cause, the bytes' hash and (when it has them) its parents, so two processes (the
   * app, a command line, a second command line) that keep different texts never share a name, and a
   * process that removes a name after writing its version removes only bytes that version holds.
   */
  static nameFor(entry: Entry, bytes: Uint8Array): string {
    const path = sha256Hex(Buffer.from(entry.path, 'utf8')).slice(0, 32)
    if (entry.kind === 'save') return `${path}${entry.run ? `.${entry.run}` : ''}.save`
    const parents = entry.parents?.length ? `.${sha256Hex(Buffer.from(entry.parents.join(','), 'utf8')).slice(0, 12)}` : ''
    return `${path}.${entry.cause}.${sha256Hex(bytes).slice(0, 16)}${parents}.before`
  }

  /** Durable before it returns; throws when it cannot be written. */
  write(entry: Entry, bytes: Uint8Array): string {
    if (bytes.length > MAX_REPLICA_BYTES) throw new Error(`${entry.path} is too large to keep a recovery copy of.`)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const name = LocalRecovery.nameFor(entry, bytes)
    const header = Buffer.from(`${JSON.stringify({ ...entry, type: 'writeflex-replica-recovery', format: 1, root: this.root })}\n`, 'utf8')
    const staged = join(this.dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
    const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      for (const part of [header, Buffer.from(bytes)]) {
        let at = 0
        while (at < part.length) at += writeSync(fd, part, at, part.length - at)
      }
      fsyncSync(fd)
    } finally { closeSync(fd) }
    renameSync(staged, join(this.dir, name))
    return name
  }

  remove(name: string): void {
    try { unlinkSync(join(this.dir, name)) } catch { /* already gone */ }
  }

  /** Every recovery file of this Collection that reads as one. */
  list(): Recovered[] {
    let names: string[]
    try { names = readdirSync(this.dir) } catch { return [] }
    const out: Recovered[] = []
    for (const name of names) {
      if (name.startsWith('.') || !(name.endsWith('.save') || name.endsWith('.before'))) continue
      try {
        const info = lstatSync(join(this.dir, name))
        if (!info.isFile() || info.size > MAX_REPLICA_BYTES + HEADER_LIMIT) continue
        const mtimeMs = info.mtimeMs
        const raw = readFileSync(join(this.dir, name))
        const end = raw.indexOf(0x0a)
        if (end < 0 || end > HEADER_LIMIT) continue
        const header = JSON.parse(raw.subarray(0, end).toString('utf8')) as Record<string, unknown>
        if (header.type !== 'writeflex-replica-recovery' || header.format !== 1 || header.root !== this.root || typeof header.path !== 'string') continue
        const bytes = raw.subarray(end + 1)
        const parents = Array.isArray(header.parents) ? (header.parents as unknown[]).filter((p): p is string => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p)).slice(0, 8) : []
        if (header.kind === 'save' && name.endsWith('.save')) {
          const run = typeof header.run === 'string' && /^[0-9a-f]{24}$/.test(header.run) ? header.run : undefined
          const entry: Entry = { kind: 'save', path: header.path, parents, first: Number(header.first) || 0, ...(run ? { run } : {}) }
          if (LocalRecovery.nameFor(entry, bytes) !== name) continue
          out.push({ ...entry, name, bytes, mtimeMs })
        } else if (header.kind === 'before' && name.endsWith('.before') && KEPT_CAUSES.has(String(header.cause))) {
          // A content-addressed name must name these bytes: a torn or foreign file is not recovery.
          const entry: Entry = { kind: 'before', path: header.path, cause: header.cause as BeforeCause | CommandCause, ...(parents.length ? { parents } : {}) }
          if (LocalRecovery.nameFor(entry, bytes) !== name) continue
          out.push({ ...entry, name, bytes, mtimeMs })
        }
      } catch { /* unreadable: left for the next look */ }
    }
    return out
  }
}

type Pending = {
  text: string
  parents: string[]
  first: number
  timer: ReturnType<typeof setTimeout> | null
  failures: number
  flushing: Promise<void> | null
}

export class ReplicaSaveCycles {
  // A reopened Collection must not overwrite or retire recovery still owned by its old session.
  readonly #run = randomBytes(12).toString('hex')
  readonly #pending = new Map<string, Pending>()
  readonly #kept = new Set<string>()
  readonly #projections = new Set<Promise<void>>()
  readonly #quietMs: number
  readonly #maxWaitMs: number
  readonly #now: () => number
  readonly recovery: LocalRecovery
  #disposed = false

  constructor(
    readonly store: ReplicaVersions,
    readonly opts: {
      quietMs?: number; maxWaitMs?: number; now?: () => number; recoveryDir?: string
      onError?: (path: string, error: unknown) => void; onFlushed?: (path: string) => void; onKept?: () => void
    } = {},
  ) {
    this.#quietMs = opts.quietMs ?? SAVE_QUIET_MS
    this.#maxWaitMs = opts.maxWaitMs ?? SAVE_MAX_WAIT_MS
    this.#now = opts.now ?? Date.now
    this.recovery = new LocalRecovery(opts.recoveryDir ?? DEFAULT_RECOVERY_DIR, store.root)
  }

  /** A save of `path` is in its run (saved within the quiet window, not yet in the store). */
  isEditing(path: string): boolean {
    return this.#pending.has(path)
  }

  #remember(path: string, sha: string): void {
    if (this.#kept.size >= KEPT_MEMORY) this.#kept.clear()
    this.#kept.add(`${path}\0${sha}`)
  }

  /**
   * Keep `text`, about to be replaced, as a version of `path`: locally and durably now (throws when that
   * fails), and in the replica store asynchronously (the returned promise; it never rejects).
   */
  keepBefore(path: string, text: string | Uint8Array, cause: BeforeCause): Promise<void> {
    const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : Buffer.from(text)
    const sha = sha256Hex(bytes)
    if (this.#kept.has(`${path}\0${sha}`)) return Promise.resolve()
    const name = this.recovery.write({ kind: 'before', path, cause }, bytes)
    return this.#track((async () => {
      try {
        await this.store.capture({ path, bytes, cause, dedupe: 'path-hash' })
        this.#remember(path, sha)
        this.recovery.remove(name)
        this.opts.onKept?.()
      } catch (error) {
        // Stays in local recovery; written to the store by a later `recover`.
        this.opts.onError?.(path, error)
      }
    })())
  }

  #track(work: Promise<void>): Promise<void> {
    this.#projections.add(work)
    void work.finally(() => this.#projections.delete(work))
    return work
  }

  /**
   * Before a save replaces `diskText` (null: no file; '' is an empty document and is kept): keep it
   * unless it is the text this run itself saved last. Local and synchronous; the store follows.
   */
  beforeReplace(path: string, diskText: string | null, cause: 'baseline' | 'before-keep-mine' = 'baseline'): Promise<void> {
    if (diskText === null) return Promise.resolve()
    if (cause === 'baseline' && this.#pending.get(path)?.text === diskText) return Promise.resolve()
    return this.keepBefore(path, diskText, cause)
  }

  /**
   * A save of `path` wrote `written` over `basisText` (null: a new file). Synchronous: the local recovery
   * file is written and fsynced before this returns. Throws when it cannot be (the run still holds it).
   */
  saved(path: string, written: string, basisText: string | null): void {
    // In-flight editor writes may commit after disposal. Keep them locally, without restarting timers.
    const now = this.#now()
    const current = this.#pending.get(path)
    const parents = current?.parents ?? (basisText !== null ? [sha256Hex(Buffer.from(basisText, 'utf8'))] : [])
    const first = current?.first ?? now
    if (current?.timer) clearTimeout(current.timer)
    const entry: Pending = { text: written, parents, first, timer: null, failures: 0, flushing: current?.flushing ?? null }
    this.#pending.set(path, entry)
    if (!this.#disposed) this.#arm(path, entry, Math.max(0, Math.min(this.#quietMs, first + this.#maxWaitMs - now)))
    this.recovery.write({ kind: 'save', path, parents, first, run: this.#run }, Buffer.from(written, 'utf8'))
  }

  #arm(path: string, entry: Pending, wait: number): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => { entry.timer = null; void this.flush(path) }, wait)
    ;(entry.timer as { unref?: () => void }).unref?.()
  }

  /** Write the pending save of `path` (every path when none is named) to the store now. Never rejects. */
  async flush(path?: string): Promise<void> {
    const paths = path ? [path] : [...this.#pending.keys()]
    await Promise.all(paths.map((p) => this.#flushOne(p)))
  }

  #flushOne(path: string): Promise<void> {
    const pending = this.#pending.get(path)
    if (!pending) return Promise.resolve()
    // One capture at a time per document; a flush asked meanwhile waits for it, then writes what is newer.
    if (pending.flushing) {
      return pending.flushing.then(() => {
        const now = this.#pending.get(path)
        return now && now !== pending ? this.#flushOne(path) : undefined
      })
    }
    if (pending.timer) { clearTimeout(pending.timer); pending.timer = null }
    const run = (async () => {
      try {
        const { record } = await this.store.capture({ path, bytes: pending.text, cause: 'save', parents: pending.parents, dedupe: 'latest' })
        this.#remember(path, record.sha256)
        const now = this.#pending.get(path)
        if (now === pending) {
          this.#pending.delete(path)
          // The version is in the store: the local recovery copy is no longer needed.
          this.recovery.remove(LocalRecovery.nameFor({ kind: 'save', path, parents: [], first: 0, run: this.#run }, Buffer.alloc(0)))
        } else if (now && now.parents === pending.parents) {
          // A save arrived during the capture: its run continues from the version just written.
          now.parents = [record.sha256]
          try { this.recovery.write({ kind: 'save', path, parents: now.parents, first: now.first, run: this.#run }, Buffer.from(now.text, 'utf8')) } catch (error) { this.opts.onError?.(path, error) }
        }
        this.opts.onFlushed?.(path)
      } catch (error) {
        // Never dropped: reported, still pending here and in local recovery, tried again later.
        this.opts.onError?.(path, error)
        pending.failures += 1
        if (!this.#disposed && this.#pending.get(path) === pending) {
          this.#arm(path, pending, Math.min(RETRY_CEILING_MS, Math.max(1, this.#quietMs) * 2 ** pending.failures))
        }
      }
    })()
    pending.flushing = run
    return run.finally(() => { if (pending.flushing === run) pending.flushing = null })
  }

  /**
   * Local recovery files of this Collection (the app was killed inside a run, or the store could not be
   * written): each becomes a version in the store, then its file is removed. One that still cannot be
   * written stays for next time. Returns how many versions were added.
   */
  async recover(): Promise<number> {
    let added = 0
    for (const entry of this.recovery.list()) {
      // A run still open in this window is newer than its file: its own flush writes it.
      if (entry.kind === 'save' && this.#pending.has(entry.path)) continue
      try {
        const { created } = entry.kind === 'save'
          ? await this.store.capture({ path: entry.path, bytes: entry.bytes, cause: 'save', parents: entry.parents, dedupe: 'latest' })
          : await this.store.capture({ path: entry.path, bytes: entry.bytes, cause: entry.cause, parents: entry.parents ?? [], dedupe: 'path-hash' })
        if (created) added += 1
        if (!(entry.kind === 'save' && this.#pending.has(entry.path))) this.recovery.remove(entry.name)
      } catch (error) {
        this.opts.onError?.(entry.path, error)
      }
    }
    return added
  }

  /** A document renamed in this window: its pending save, and its local recovery file, follow it. */
  renamed(from: string, to: string): void {
    const pending = this.#pending.get(from)
    if (!pending) return
    this.#pending.delete(from)
    this.#pending.set(to, pending)
    this.#arm(to, pending, this.#quietMs)
    try {
      this.recovery.write({ kind: 'save', path: to, parents: pending.parents, first: pending.first, run: this.#run }, Buffer.from(pending.text, 'utf8'))
      this.recovery.remove(LocalRecovery.nameFor({ kind: 'save', path: from, parents: [], first: 0, run: this.#run }, Buffer.alloc(0)))
    } catch (error) { this.opts.onError?.(to, error) }
  }

  /** Every write to the store started so far has finished (kept or left in local recovery). */
  async idle(): Promise<void> {
    while (this.#projections.size) await Promise.all([...this.#projections])
  }

  /**
   * Write everything pending to the store, then stop. What could not be written stays in local recovery.
   * Every text here is already durable in local recovery, so the store is waited for at most `graceMs`
   * (OneDrive may not answer at all); a write still running then finishes or fails on its own, and its
   * local recovery file stays until a later `recover` has written it. Resolves true when everything was
   * written within the grace.
   */
  async dispose(graceMs = Infinity): Promise<boolean> {
    this.#disposed = true
    for (const pending of this.#pending.values()) if (pending.timer) { clearTimeout(pending.timer); pending.timer = null }
    const all = (async () => { await this.flush(); await this.idle() })()
    return withinGrace(all, graceMs)
  }
}

/** Whether `work` settled within `graceMs` (it keeps running past the grace; nothing is cancelled). */
export async function withinGrace(work: Promise<unknown>, graceMs: number): Promise<boolean> {
  if (graceMs === Infinity) { await work.catch(() => {}); return true }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, graceMs)); (timer as { unref?: () => void }).unref?.() })
  try {
    return await Promise.race([work.then(() => true as const, () => true as const), late])
  } finally { if (timer) clearTimeout(timer) }
}

/**
 * Local recovery entries not yet in the store, as Versions of the existing Versions list (Compare and
 * Restore read them through `localRecoveryBytes`). A text the store cannot be written to yet is then
 * never a hidden cache: it is listed as kept on this Mac only. Entries whose bytes the store already
 * lists for that document (record and object present) are left out.
 */
export function localRecoveryVersions(recovery: LocalRecovery, inStore: ReadonlyArray<{ path: string; sha256: string }>, device: string): Version[] {
  const kept = new Set(inStore.map((r) => `${r.path}\0${r.sha256}`))
  const out: Version[] = []
  const seen = new Set<string>()
  for (const entry of recovery.list()) {
    const sha = sha256Hex(entry.bytes)
    const key = `${entry.path}\0${sha}`
    if (kept.has(key) || seen.has(key)) continue
    seen.add(key)
    const ts = Math.max(0, Math.floor(entry.mtimeMs))
    const cause: ReplicaCause = entry.kind === 'save' ? 'save' : entry.cause
    const version = versionOfReplica({
      kind: 'writeflex-replica-version', format: 1, id: `rv_${ts.toString(36)}_${sha256Hex(Buffer.from(entry.name, 'utf8')).slice(0, 12)}`,
      path: entry.path, sha256: sha, bytes: entry.bytes.length, ts, device, cause, parents: entry.kind === 'save' ? entry.parents : entry.parents ?? [],
    })
    out.push({ ...version, name: `${version.name} (kept on this Mac; not yet in the synced version store)` })
  }
  return out
}

/** The exact bytes of a local recovery entry whose bytes hash to `sha`, or null. */
export function localRecoveryBytes(recovery: LocalRecovery, sha: string): Buffer | null {
  for (const entry of recovery.list()) if (sha256Hex(entry.bytes) === sha) return Buffer.from(entry.bytes)
  return null
}
