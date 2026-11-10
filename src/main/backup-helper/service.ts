/**
 * The backup-helper bridge as main sees it: a window asks about its own folder, never about a vault.
 *
 * - Off by default: with the disabled trial nothing resolves a folder or opens a socket.
 * - A window's folder (the workspace root bound to that window now) is resolved to its real path and
 *   looked up in the trusted trial's folder → vault-id map. No other vault id is reachable from that
 *   window; a window with no folder, or an unregistered one, gets `not-registered`.
 * - The answer is checked against the window after it arrives: a window that closed, moved to another
 *   folder, or whose folder no longer resolves to the same real folder of the same vault (or cannot be
 *   resolved at all) gets `stale` and nothing of the answer.
 * - Status and Sync now share one serialised connection (connection.ts). While a Sync now is running
 *   there, status is answered `sync-running` with the last checked answer and its own time, rather than
 *   queued behind a cycle that may take minutes. Sync now requests for the same vault share one request
 *   for as long as at least one window that asked is open; when the last of them closes, the request is
 *   withdrawn if it has not been sent (a sent cycle may still finish in the helper; nobody is told).
 * - The last checked status of a vault is kept with the time main received it and is only ever shown as
 *   `lastKnown`; an answer from an older request never replaces a newer one.
 * - Every answer carrying helper state says what it cannot know (`limits`), and `protectionClaim` is
 *   `false`: helper protocol 1 has no editor receipts and backup does not compare branches.
 * - Closing the last window that asked closes the connection and withdraws everything not yet sent on
 *   it; a later window opens a new one. `dispose` closes it for good.
 */
import { realpath } from 'node:fs/promises'
import {
  BACKUP_HELPER_LIMITS, type BackupHelperLastKnown, type BackupHelperStatusAnswer, type BackupHelperSyncAnswer, type BackupCycleView,
} from '../../shared/backup-helper'
import { createHelperConnection, type ConnectionAnswer, type ConnectPort, type HelperConnection } from './connection'
import { checkCycleResult, checkStatusResult } from './reply-check'
import { BACKUP_HELPER_TRIAL_DISABLED, type BackupHelperTrial } from './trial-config'

export type BackupHelperService = {
  status(senderId: number): Promise<BackupHelperStatusAnswer>
  syncNow(senderId: number): Promise<BackupHelperSyncAnswer>
  /** The window closed: drop its waiting requests and answers; close the connection when no window is left. */
  disposeWindow(senderId: number): void
  dispose(): void
}

export type BackupHelperServiceOptions = {
  trial?: BackupHelperTrial
  /** The workspace root bound to this window now, or null. Main's own state; never renderer input. */
  windowRoot: (senderId: number) => string | null
  resolveReal?: (path: string) => Promise<string>
  connect?: ConnectPort
  now?: () => number
}

const limits = () => ({ protectionClaim: false as const, limits: [...BACKUP_HELPER_LIMITS] })

/** The answer, or null as soon as the window closes: a closed window does not wait for work ahead of it. */
function untilClosed<T>(answer: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise<T | null>((resolve, reject) => {
    const closed = (): void => resolve(null)
    signal.addEventListener('abort', closed, { once: true })
    answer.then(resolve, reject).finally(() => signal.removeEventListener('abort', closed))
  })
}

export function createBackupHelperService(options: BackupHelperServiceOptions): BackupHelperService {
  const trial = options.trial ?? BACKUP_HELPER_TRIAL_DISABLED
  if (!trial.enabled) {
    const off = async () => ({ state: 'disabled' as const })
    return { status: off, syncNow: off, disposeWindow: () => undefined, dispose: () => undefined }
  }
  const resolveReal = options.resolveReal ?? realpath
  const now = options.now ?? Date.now
  const connection: HelperConnection = createHelperConnection({ socketPath: trial.socketPath, client: trial.client, connectTimeoutMs: trial.connectTimeoutMs, connect: options.connect, now })
  const windows = new Map<number, AbortController>()
  const lastKnown = new Map<string, { seq: number; known: BackupHelperLastKnown }>()
  type SharedSync = { since: number; answer: Promise<ConnectionAnswer<BackupCycleView>>; withdraw: AbortController; requesters: Set<number>; cleanups: Array<() => void> }
  /** Sync now requests that a window may still join, by vault. */
  const syncs = new Map<string, SharedSync>()
  /** Every Sync now not yet answered, joinable or withdrawn: while any is on the connection, status says so. */
  const unsettled = new Set<SharedSync>()
  let seq = 0
  let disposed = false

  const windowSignal = (senderId: number): AbortSignal => {
    let controller = windows.get(senderId)
    if (!controller) windows.set(senderId, controller = new AbortController())
    return controller.signal
  }

  const rootOf = (senderId: number): string | null => { try { return options.windowRoot(senderId) } catch { return null } }

  type Bound = { root: string; real: string; vault: string }

  /** The vault this window may name now, with the root and real folder it was found for. */
  async function bind(senderId: number): Promise<Bound | null> {
    const root = rootOf(senderId)
    if (!root) return null
    let real: string
    try { real = await resolveReal(root) } catch { return null }
    const vault = trial.enabled ? trial.vaults.get(real) : undefined
    return vault ? { root, real, vault } : null
  }

  /** Why nothing may reach this window now, judged from what is known without looking at the folder again. */
  function closedOrMoved(senderId: number, signal: AbortSignal, bound: Bound): 'window-closed' | 'window-root-changed' | null {
    if (disposed || signal.aborted) return 'window-closed'
    if (rootOf(senderId) !== bound.root) return 'window-root-changed'
    return null
  }

  /**
   * Why an answer for `bound` must not reach this window now, if it must not. The folder is resolved
   * again: the same spelling may now lead to another real folder, and a folder that cannot be resolved
   * cannot be shown to be the one asked about.
   */
  async function staleness(senderId: number, signal: AbortSignal, bound: Bound): Promise<'window-closed' | 'window-root-changed' | null> {
    const before = closedOrMoved(senderId, signal, bound)
    if (before) return before
    let real: string | null
    try { real = await resolveReal(bound.root) } catch { real = null }
    const after = closedOrMoved(senderId, signal, bound)
    if (after) return after
    if (real !== bound.real || !trial.enabled || trial.vaults.get(real) !== bound.vault) return 'window-root-changed'
    return null
  }

  /** Adds this window to a shared Sync now; when the last window that asked has closed, it is withdrawn. */
  function join(entry: SharedSync, vault: string, senderId: number, signal: AbortSignal): void {
    if (entry.requesters.has(senderId)) return
    entry.requesters.add(senderId)
    const leave = (): void => {
      entry.requesters.delete(senderId)
      if (entry.requesters.size > 0) return
      if (syncs.get(vault) === entry) syncs.delete(vault)
      entry.withdraw.abort()
    }
    signal.addEventListener('abort', leave, { once: true })
    entry.cleanups.push(() => signal.removeEventListener('abort', leave))
  }

  return {
    async status(senderId) {
      if (disposed) return { state: 'stale', reason: 'window-closed' }
      const signal = windowSignal(senderId)
      const bound = await bind(senderId)
      if (!bound) return { state: 'not-registered' }
      const before = closedOrMoved(senderId, signal, bound)
      if (before) return { state: 'stale', reason: before }
      const known = lastKnown.get(bound.vault)?.known ?? null
      if (unsettled.size > 0) {
        const since = Math.min(...[...unsettled].map((s) => s.since))
        return { state: 'sync-running', since, observedAt: now(), lastKnown: known, ...limits() }
      }
      const mySeq = ++seq
      const answer = await untilClosed(connection.request('status', bound.vault, trial.statusTimeoutMs, (result, receivedAt) => checkStatusResult(result, bound.vault, receivedAt), signal), signal)
      const after = await staleness(senderId, signal, bound)
      if (after || !answer) return { state: 'stale', reason: after ?? 'window-closed' }
      if (!answer.ok) {
        if (answer.reason === 'cancelled' || answer.reason === 'disposed') return { state: 'stale', reason: 'window-closed' }
        return { state: 'unavailable', reason: answer.reason, message: answer.message, observedAt: now(), lastKnown: lastKnown.get(bound.vault)?.known ?? null, ...limits() }
      }
      const stored = lastKnown.get(bound.vault)
      if (!stored || stored.seq < mySeq) lastKnown.set(bound.vault, { seq: mySeq, known: { observedAt: answer.receivedAt, vault: answer.value.vault } })
      return { state: 'reported', observedAt: answer.receivedAt, helper: answer.value.helper, vault: answer.value.vault, ...limits() }
    },

    async syncNow(senderId) {
      if (disposed) return { state: 'stale', reason: 'window-closed' }
      const signal = windowSignal(senderId)
      const bound = await bind(senderId)
      if (!bound) return { state: 'not-registered' }
      const before = closedOrMoved(senderId, signal, bound)
      if (before) return { state: 'stale', reason: before }
      let shared = syncs.get(bound.vault)
      if (!shared) {
        // Not tied to one window's signal: every open window of the same vault that asked keeps it.
        const withdraw = new AbortController()
        const answer = connection.request('syncNow', bound.vault, trial.syncTimeoutMs, (result, receivedAt) => checkCycleResult(result, bound.vault, receivedAt), withdraw.signal)
        const entry: SharedSync = { since: now(), answer, withdraw, requesters: new Set(), cleanups: [] }
        syncs.set(bound.vault, entry)
        unsettled.add(entry)
        void answer.finally(() => {
          if (syncs.get(bound.vault) === entry) syncs.delete(bound.vault)
          unsettled.delete(entry)
          for (const cleanup of entry.cleanups) cleanup()
        })
        shared = entry
      }
      join(shared, bound.vault, senderId, signal)
      const answer = await untilClosed(shared.answer, signal)
      const after = await staleness(senderId, signal, bound)
      if (after || !answer) return { state: 'stale', reason: after ?? 'window-closed' }
      if (!answer.ok) {
        if (answer.reason === 'cancelled' || answer.reason === 'disposed') return { state: 'stale', reason: 'window-closed' }
        return { state: 'unavailable', reason: answer.reason, message: answer.message, observedAt: now(), ...limits() }
      }
      return { state: 'cycle', observedAt: answer.receivedAt, cycle: answer.value, ...limits() }
    },

    disposeWindow(senderId) {
      const controller = windows.get(senderId)
      if (!controller) return
      controller.abort()
      windows.delete(senderId)
      if (windows.size === 0) connection.close()
    },

    dispose() {
      disposed = true
      for (const controller of windows.values()) controller.abort()
      windows.clear()
      connection.dispose()
    },
  }
}
