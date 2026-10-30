/**
 * The app's side of "one owner per Collection": the window manager claims a Collection before it
 * binds a window to it and releases it when that window has closed. Between the two, a timer keeps
 * the owner lock's heartbeat fresh, and `refreshNow` does so at once when the system resumes from
 * sleep.
 *
 * The app writes a Collection only while it holds the lock and has just confirmed it. In every other
 * case this module closes the Collection's write gate (collection-write-gate.ts) until the lock is
 * held again or the Collection is closed, and tells its watchers (`watch`):
 * - `lost`: a beat found another owner's record in the lock file;
 * - `unlockable`: the lock cannot be taken at all (`.writeflex` is a link or a file, or cannot be
 *   written). The Collection still opens, read-only; nothing is written to it, the lock included;
 * - `unverified`: the lock was held and a beat could not confirm or rewrite it.
 * The timer keeps running in all three, and each beat tries again, as `refreshNow` does on resume. Every
 * writer under the Collection asks that gate: the Workspace (document saves and autosaves; new,
 * duplicated and renamed files and folders; pasted images; whatever the agent or an app feature
 * writes through it), the version, scrap and review stores, export into the Collection, and the
 * delete and trash paths. Reads go on.
 *
 * Ownership also carries the Collection's REPLY KEY (reply-key.ts): made when the Collection is
 * taken (and again when a lost lock is taken back), removed when it is let go. The key, kept outside
 * every Collection, is what lets the command line know a reply is this app's; the lock is not.
 *
 * Electron-free (like window-close.ts) so opening and closing can be tested against a second real
 * process without a window.
 */
import { retryFolioDeclarations } from './folio-declaration'
import { settleVersionMoves } from './version-moves'
import { basename } from 'node:path'
import {
  acquireOwnerLock, ownerInPlainWords, refreshOwnerLock, releaseOwnerLock,
  OwnerLockBusyError, OwnerLockFolderError, OWNER_LOCK_HEARTBEAT_MS, OWNER_LOCK_STALE_MS,
  type OwnerLock, type OwnerLockEnv, type OwnerLockEvent, type OwnerLockRecord,
} from './owner-lock'
import { pauseCollectionWrites, resumeCollectionWrites } from './collection-write-gate'
import { createReplyKey, removeReplyKey } from './reply-key'

/**
 * How long the app waits for another owner before telling the user. The command line holds the lock
 * for one operation, normally well under a second; ten seconds covers a rename with link repair over
 * a large Collection on a synced disk, and is short enough that the start screen does not look hung.
 */
export const APP_OPEN_WAIT_MS = 10_000

export type OwnershipDiagnostic = (event: string, details: Record<string, unknown>) => unknown
/**
 * `lost`: another owner now holds an open Collection. `unavailable`: the lock of an open Collection
 * can no longer be taken or confirmed. `regained`: this app holds it again. A Collection that is
 * unlockable from the moment it is opened is not announced here (no window shows it yet): `claim`
 * answers `unlockable` and `unavailable(root)` is true.
 */
export type OwnershipChange = 'lost' | 'unavailable' | 'regained'
export type OwnershipWatcher = (root: string, change: OwnershipChange) => void

export type CollectionOwnershipOptions = {
  waitMs?: number
  /** Where this app keeps its reply keys (reply-key.ts): a folder in its own application-data folder.
   *  With it, a key is made each time a Collection is taken and removed when it is let go. */
  keyFolder?: string
  heartbeatMs?: number
  diagnostic?: OwnershipDiagnostic
  /** Test seam: clock, host and process identity for the lock. */
  env?: Omit<OwnerLockEnv, 'log'>
  /** Test seam: the heartbeat timer. Calls `beat` every `ms`; returns what stops it. Default: an unref'd `setInterval`. */
  schedule?: (beat: () => Promise<void>, ms: number) => () => void
}

const everyInterval = (beat: () => Promise<void>, ms: number): (() => void) => {
  const timer = setInterval(() => { void beat() }, ms)
  timer.unref()
  return () => clearInterval(timer)
}

type Held = {
  /** Null when the Collection is open without a lock: it cannot be taken, or it was lost to another owner. */
  lock: OwnerLock | null
  /** Writes are allowed in `owned` only. `unverified` keeps `lock`: it may still be this app's on disk. */
  state: 'owned' | 'lost' | 'unlockable' | 'unverified'
  /** Windows relying on this claim. A reopen can overlap the previous window's delayed release. */
  claims: number
  /** Stops this Collection's heartbeat timer. */
  stopTimer: (() => void) | null
}

/** The root itself is not there: opening fails, as it did before there was a lock. */
const NO_ROOT = new Set(['ENOENT', 'ENOTDIR'])
const failureCode = (error: unknown): string =>
  error instanceof OwnerLockFolderError ? 'not-a-folder' : (error as NodeJS.ErrnoException | undefined)?.code ?? (error instanceof Error ? error.name : 'unknown')
const describe = (record: OwnerLockRecord | null): Record<string, unknown> | null =>
  record ? { pid: record.pid, kind: record.kind, host: record.host, startedAt: record.startedAt, heartbeatAt: record.heartbeatAt } : null

export class CollectionOwnership {
  readonly #held = new Map<string, Held>()
  readonly #queues = new Map<string, Promise<unknown>>()
  readonly #waitMs: number
  readonly #heartbeatMs: number
  readonly #diagnostic: OwnershipDiagnostic
  readonly #env: OwnerLockEnv
  readonly #watchers: OwnershipWatcher[] = []
  readonly #keyFolder: string | undefined
  readonly #schedule: NonNullable<CollectionOwnershipOptions['schedule']>

  constructor(options: CollectionOwnershipOptions = {}) {
    this.#waitMs = options.waitMs ?? APP_OPEN_WAIT_MS
    this.#heartbeatMs = options.heartbeatMs ?? OWNER_LOCK_HEARTBEAT_MS
    this.#diagnostic = options.diagnostic ?? (() => {})
    this.#env = { ...options.env, log: (event) => this.#log(event) }
    this.#keyFolder = options.keyFolder
    this.#schedule = options.schedule ?? everyInterval
  }

  /**
   * Take the Collection at `root` (a canonical root) for this app, waiting for a short-lived owner.
   * Throws `OwnerLockBusyError` when another owner still has it after the wait. Resolves `unlockable`
   * when the lock cannot be taken for any other reason (`.writeflex` is a link or a file, or the
   * folder cannot be written): the Collection opens READ-ONLY, with its write gate closed from this
   * moment, and every beat tries again to take the lock.
   */
  claim(root: string): Promise<'owned' | 'unlockable'> {
    return this.#serialise(root, async () => {
      const existing = this.#held.get(root)
      if (existing) {
        existing.claims += 1
        if (existing.state === 'owned') await retryFolioDeclarations(root)
        return existing.state === 'owned' ? 'owned' : 'unlockable'
      }
      let lock: OwnerLock | null = null
      try {
        lock = await acquireOwnerLock(root, { ...this.#env, kind: 'app', waitMs: this.#waitMs })
        resumeCollectionWrites(root)
        this.#settleMoves(root, true)
        await retryFolioDeclarations(root)
        await this.#newKey(root)
      } catch (error) {
        if (error instanceof OwnerLockBusyError || NO_ROOT.has((error as NodeJS.ErrnoException).code ?? '')) throw error
        this.#diagnostic('owner-lock.unavailable', { root, code: failureCode(error) })
        // Closed before any window binds to the Collection, so not one write is made without the lock.
        pauseCollectionWrites(root, unavailableReason(root))
      }
      const stopTimer = this.#schedule(() => this.#beat(root), this.#heartbeatMs)
      this.#held.set(root, { lock, state: lock ? 'owned' : 'unlockable', claims: 1, stopTimer })
      return lock ? 'owned' : 'unlockable'
    })
  }

  /** Give up one claim; the lock file goes with the last. Safe for a root that was never claimed. */
  release(root: string, options: { all?: boolean } = {}): Promise<void> {
    return this.#serialise(root, async () => {
      const held = this.#held.get(root)
      if (!held) return
      held.claims -= 1
      if (held.claims > 0 && !options.all) return
      this.#held.delete(root)
      resumeCollectionWrites(root) // closed here: nothing of this app's is left to write it
      held.stopTimer?.()
      // The key goes first: once the lock is free, nothing signed by this ownership should still verify.
      if (this.#keyFolder) await removeReplyKey(this.#keyFolder, root)
      if (held.lock) await releaseOwnerLock(held.lock).catch((error) => this.#failed('release', root, error))
    })
  }

  async releaseAll(): Promise<void> {
    await Promise.all([...this.#held.keys()].map((root) => this.release(root, { all: true })))
  }

  /** True while this app holds the lock file for `root` and its last beat confirmed it (false while
   *  lost, unlockable or unverified). The one question that decides whether the app may write. */
  owns(root: string): boolean {
    return this.#held.get(root)?.state === 'owned'
  }

  /** True while `root` is open here but another owner holds its lock. */
  lost(root: string): boolean {
    return this.#held.get(root)?.state === 'lost'
  }

  /** True while `root` is open here and its lock cannot be taken or confirmed, though nobody else is known to hold it. */
  unavailable(root: string): boolean {
    const state = this.#held.get(root)?.state
    return state === 'unlockable' || state === 'unverified'
  }

  /** Be told when an open Collection's lock is lost to another owner, and when it is held again. */
  watch(watcher: OwnershipWatcher): void {
    this.#watchers.push(watcher)
  }

  /**
   * Beat every open Collection now instead of waiting for the timer. Called when the system resumes
   * from sleep: no timer ran meanwhile, so every heartbeat is as old as the sleep was long, which is
   * what another machine sharing the folder judges this app by.
   */
  async refreshNow(): Promise<void> {
    await Promise.all([...this.#held.keys()].map((root) => this.#beat(root)))
  }

  #tell(root: string, change: OwnershipChange): void {
    for (const watcher of this.#watchers) {
      try { watcher(root, change) } catch (error) { this.#failed('watcher', root, error) }
    }
  }

  #beat(root: string): Promise<void> {
    return this.#serialise(root, async () => {
      const held = this.#held.get(root)
      if (!held) return
      if (held.lock) {
        let outcome: 'refreshed' | 'lost'
        try {
          outcome = await refreshOwnerLock(held.lock)
        } catch (error) {
          // Not confirmed, so not written under: the lock may still be this app's, and the next beat asks again.
          if (held.state !== 'unverified') this.#failed('refresh', root, error)
          this.#stop(root, held, 'unverified')
          return
        }
        if (outcome === 'refreshed') {
          this.#resume(root, held)
          return
        }
        held.lock = null
        this.#stop(root, held, 'lost')
      }
      // No lock: another owner took the Collection while this window was open (another machine
      // sharing the folder judged this one gone, or the lock file was removed and taken), or it could
      // not be taken when the Collection was opened. Take it as soon as it can be taken.
      try {
        held.lock = await acquireOwnerLock(root, { ...this.#env, kind: 'app' })
      } catch (error) {
        if (error instanceof OwnerLockBusyError) {
          this.#stop(root, held, 'lost')
        } else {
          if (held.state !== 'unlockable') this.#failed('acquire', root, error)
          this.#stop(root, held, 'unlockable')
        }
        return
      }
      await this.#newKey(root)
      this.#resume(root, held)
    })
  }

  /** Close the write gate for `root` and say why, once per reason. */
  #stop(root: string, held: Held, state: 'lost' | 'unlockable' | 'unverified'): void {
    const before = held.state
    if (before === state) return
    held.state = state
    pauseCollectionWrites(root, state === 'lost' ? writesPausedReason(root) : unavailableReason(root))
    if (state === 'lost') this.#tell(root, 'lost')
    else if (before === 'owned' || before === 'lost') this.#tell(root, 'unavailable')
  }

  #resume(root: string, held: Held): void {
    if (held.state === 'owned') {
      this.#settleMoves(root)
      return
    }
    held.state = 'owned'
    resumeCollectionWrites(root)
    this.#settleMoves(root)
    this.#diagnostic('owner-lock.reclaimed', { root })
    this.#tell(root, 'regained')
  }

  #settleMoves(root: string, cancelUnmoved = false): void {
    try { settleVersionMoves(root, cancelUnmoved) } catch (error) {
      this.#failed('version-history-settle', root, error)
      console.error('WriteFlex could not settle version-history moves; the next owner check will retry.', { root, error })
    }
  }

  /** A fresh reply key for a Collection just taken. Without one the app still opens; requests are then refused unsigned. */
  async #newKey(root: string): Promise<void> {
    if (!this.#keyFolder) return
    await createReplyKey(this.#keyFolder, root).catch((error) => this.#failed('reply-key', root, error))
  }

  #failed(step: string, root: string, error: unknown): void {
    this.#diagnostic(`owner-lock.${step}-failed`, { root, message: error instanceof Error ? error.message : String(error) })
  }

  #log(event: OwnerLockEvent): void {
    if (event.event === 'owner-lock.recovered') {
      this.#diagnostic(event.event, { root: event.root, reason: event.reason, previous: describe(event.previous) })
    } else if (event.event === 'owner-lock.recovered-for-other') {
      this.#diagnostic(event.event, { root: event.root, reason: event.reason, previous: describe(event.previous), heldBy: describe(event.heldBy) })
    } else if (event.event === 'owner-lock.conflict-copies') {
      this.#diagnostic(event.event, { root: event.root, files: event.files })
    } else {
      this.#diagnostic(event.event, { root: event.root })
    }
  }

  /** One lock operation per root at a time, in call order: a reopen queues behind the close's release. */
  #serialise<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.#queues.get(root) ?? Promise.resolve()).then(operation, operation)
    const settled = result.catch(() => {})
    this.#queues.set(root, settled)
    void settled.then(() => { if (this.#queues.get(root) === settled) this.#queues.delete(root) })
    return result
  }
}

/**
 * Claim `root`, and when another owner still has it after the wait, ask the user whether to try
 * again. Resolves false when the user gives up: the Collection must then not be opened.
 */
export async function claimWithRetry(
  ownership: CollectionOwnership,
  root: string,
  askRetry: (busy: OwnerLockBusyError) => Promise<boolean>,
): Promise<boolean> {
  for (;;) {
    try {
      await ownership.claim(root)
      return true
    } catch (error) {
      if (!(error instanceof OwnerLockBusyError)) throw error
      if (!(await askRetry(error))) return false
    }
  }
}

/** The refusal each paused write carries; agents and the renderer's save path see this text. */
export function writesPausedReason(root: string): string {
  return `WriteFlex is not saving to “${basename(root)}” because another program has taken over the folder. Saving resumes by itself when that program lets go.`
}

/** The words shown when an open Collection's lock is lost. */
export function lostNotice(root: string): { message: string; detail: string } {
  return {
    message: `Saving to “${basename(root)}” is paused`,
    detail: 'Another program has taken over this folder, so WriteFlex has stopped saving to it: two programs must never change it at the same time. '
      + 'Nothing you have typed is lost. It stays in the open tabs, marked as not saved. '
      + 'Saving resumes by itself when the other program lets go; your next edit, or closing the tab or window, then saves as usual.',
  }
}

/** The refusal each write carries while the lock cannot be taken or confirmed. */
export function unavailableReason(root: string): string {
  return `WriteFlex is not saving to “${basename(root)}” because it cannot mark the folder as in use. Saving resumes by itself when it can.`
}

/** The words shown when a Collection opens without its lock, or its lock can no longer be confirmed. */
export function unavailableNotice(root: string): { message: string; detail: string } {
  return {
    message: `Saving to “${basename(root)}” is paused`,
    detail: 'WriteFlex could not mark this folder as in use, so it is not saving to it: without that mark, another program could change the folder at the same time. '
      + 'You can still read, search and copy. Anything you type stays in the open tabs, marked as not saved. '
      + 'WriteFlex keeps trying, and saving resumes by itself when it can; your next edit, or closing the tab or window, then saves as usual.',
  }
}

/** The words shown when the wait runs out. `thisHost` is passed in tests. */
export function busyNotice(busy: OwnerLockBusyError, thisHost: string): { message: string; detail: string } {
  const folder = basename(busy.root)
  const owner = busy.owner
  // The holder by kind and process number (ownerInPlainWords), so the writer can find it.
  const holder = owner ? ownerInPlainWords(owner) : ''
  const Holder = holder.charAt(0).toUpperCase() + holder.slice(1)
  const who = !owner
    ? 'Another program is writing to this folder.'
    : owner.host.toLowerCase() !== thisHost.toLowerCase()
      ? `${Holder} on ${owner.host} has this folder open. If it is closed there, this clears within ${Math.round(OWNER_LOCK_STALE_MS / 60_000)} minutes.`
      : owner.kind === 'command-line'
        ? `${Holder} is writing to this folder.`
        : `${Holder} has this folder open.`
  const waited = Math.max(1, Math.round(busy.waitedMs / 1000))
  return {
    message: `“${folder}” is in use by another program`,
    detail: `${who} WriteFlex waited ${waited} ${waited === 1 ? 'second' : 'seconds'} and has not opened the folder, so that two programs never change it at the same time.`,
  }
}
