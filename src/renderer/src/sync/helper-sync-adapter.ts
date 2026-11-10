import type { BackupHelperStatusAnswer, BackupHelperSyncAnswer, BackupReceiptDocState, BackupReceiptStatusAnswer, BackupVaultView } from '../../../shared/backup-helper'
import { proves, type HelperReceiptAdapter } from '../app/backup-helper-receipts'
import { sameSyncView, type SyncAdapter, type SyncInput, type SyncView } from './sync-status'

/** Renderer delivery bounds, independent of main's socket/request bounds. No timer polls at idle. */
export const HELPER_STATUS_TIMEOUT_MS = 10_000
export const HELPER_ACTION_TIMEOUT_MS = 370_000
export type HelperSyncApi = { status(): Promise<BackupHelperStatusAnswer>; syncNow(): Promise<BackupHelperSyncAnswer> }
type Options = { statusTimeoutMs?: number; actionTimeoutMs?: number; lifecycle?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> }
const limits = 'Editor coverage unknown: editor edits are not reported to the helper; edits after the last capture are unknown; shared branches are not compared. No protection claim is made.'
const receiptLimits = 'Editor edits are reported to the helper through main; edits after the last capture are unknown; shared branches are not compared. No protection claim is made.'
const sameScope = (a: SyncView, b: SyncView) => a.vaultId === b.vaultId && a.epoch === b.epoch
const vaultOf = (answer: BackupHelperStatusAnswer): BackupVaultView | null => answer.state === 'reported' ? answer.vault
  : answer.state === 'unavailable' || answer.state === 'sync-running' ? answer.lastKnown?.vault ?? null : null

const receiptWords: Record<BackupReceiptDocState, string> = {
  'remote-verified': 'remote-verified', captured: 'captured', 'receipt-registered': 'registered', 'saved-not-registered': 'saved, not registered',
  'edited-not-saved': 'edited, not saved', unknown: 'unknown',
}
/** Main's receipt states for the documents edited in this window, as one sentence; null without an answer. */
function receiptSentence(answer: BackupReceiptStatusAnswer | null): string | null {
  if (!answer || answer.state !== 'reported') return null
  const counts = new Map<BackupReceiptDocState, number>()
  for (const doc of answer.docs) counts.set(doc.state, (counts.get(doc.state) ?? 0) + 1)
  const states = [...counts].map(([state, n]) => `${n} ${receiptWords[state]}`).join(', ')
  return `Editor receipts for ${answer.docs.length} edited document${answer.docs.length === 1 ? '' : 's'}: ${states}${answer.covered ? '' : `; editor coverage not proven (${answer.uncertainty.join('; ')})`}.`
}

/** Main already validates the protocol and gates paths to this window's registered root.
 * The view identifies delivery only. `proven`: main's receipt status, read after this view was captured,
 * shows every document edited in it remote-verified at the captured gen (backup-helper-receipts.ts proves);
 * only then, with the engine's own fresh verified facts, does `backup.revision` name the view (plan §12).
 * Otherwise it stays null: a dated disk/remote observation with no editor coverage. */
export function mapHelperStatus(answer: BackupHelperStatusAnswer, view: SyncView, observation: number, previous?: SyncInput, proven = false): SyncInput {
  const result: SyncInput = { view, observation, availability: 'unavailable', connection: 'unknown', automatic: null,
    local: { dirtyPaths: [], complete: false }, backup: null, check: null, documents: [] }
  if (answer.state === 'disabled' || answer.state === 'not-registered') return { ...result, availability: 'unconfigured' }
  const vault = vaultOf(answer)
  const engine = vault?.engine
  if (engine) {
    if (engine.lastVerifiedAt !== null && engine.lastVerifiedSnapshot !== null) result.backup = {
      verifiedAt: engine.lastVerifiedAt, protectedThrough: engine.protectedThrough, revision: null, remoteRevision: engine.lastVerifiedSnapshot,
    }
    // No path is inferred for omitted items; a global oldest-edit date is not a per-file receipt.
    result.documents = engine.pending.items.map(path => ({ id: path, path, title: path, kind: 'changed' }))
    if (answer.state === 'reported' && answer.vault.fresh && answer.vault.engineObservedAt !== null
      && !answer.vault.statusError && !answer.helper.stopping && !['stopped', 'stopping'].includes(answer.vault.helper.state)) {
      result.automatic = engine.enabled
      result.availability = !engine.enabled ? 'unconfigured' : engine.block?.reason === 'scanner-unavailable' ? 'scanner-missing'
        : engine.block || engine.lastError ? 'unavailable' : 'ready'
      if (proven && result.backup && result.availability === 'ready') result.backup.revision = view.revision
    }
  } else if (previous && sameScope(previous.view, view)) {
    // Dated remote facts only, as a new value: no current evidence names an editor revision (plan §12).
    result.backup = previous.backup ? { ...previous.backup, revision: null } : null
    result.documents = previous.documents
  }
  return result
}

/** One instance per App/root. Unsubscribe settles renderer delivery; it cannot cancel a sent native cycle. */
export function createHelperSyncAdapter(api: HelperSyncApi, receipts?: HelperReceiptAdapter, options: Options = {}): SyncAdapter {
  const finite = (value: number | undefined, fallback: number) => value !== undefined && Number.isFinite(value) && value > 0 ? Math.min(value, 2_147_483_647) : fallback
  const statusTimeout = finite(options.statusTimeoutMs, HELPER_STATUS_TIMEOUT_MS)
  const actionTimeout = finite(options.actionTimeoutMs, HELPER_ACTION_TIMEOUT_MS)
  const lifecycle = options.lifecycle ?? (typeof window === 'undefined' ? undefined : window)
  type Scope = { view: SyncView; active: boolean; publish: (input: unknown) => void; counter: number; counterView: SyncView;
    cancels: Set<() => void>; previous?: SyncInput; answer?: BackupHelperStatusAnswer; lastVault?: BackupVaultView; action: object | null;
    read: { view: SyncView; observation: number; promise: Promise<SyncInput> } | null; requested: boolean }
  let scope: Scope | null = null
  const capture = (s: Scope, view: SyncView) => {
    if (!sameSyncView(s.counterView, view)) { s.counterView = { ...view }; s.counter = 0 }
    return { view: { ...view }, observation: ++s.counter }
  }
  const bounded = <T>(s: Scope, start: () => Promise<T>, ms: number, signal?: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    let done = false
    const finish = (error: Error | null, value?: T) => {
      if (done) return
      done = true; clearTimeout(timer); s.cancels.delete(cancel); signal?.removeEventListener('abort', cancel)
      if (error) reject(error); else resolve(value!)
    }
    const cancel = () => finish(new Error('Helper response delivery ended; native backup cancellation is not implied.'))
    const timer = setTimeout(() => finish(new Error('Helper response delivery timed out; native backup may still be running.')), ms)
    s.cancels.add(cancel)
    signal?.addEventListener('abort', cancel, { once: true })
    if (!s.active || signal?.aborted) { cancel(); return }
    // Promise.resolve catches a synchronous preload failure as well as rejection.
    Promise.resolve().then(() => s.active ? start() : Promise.reject(new Error('Helper response delivery ended.'))).then(value => finish(null, value), error => finish(error instanceof Error ? error : new Error('Helper response failed.')))
  })
  const dispose = (s: Scope) => {
    if (!s.active) return
    s.active = false
    for (const cancel of [...s.cancels]) cancel()
    s.action = null
    lifecycle?.removeEventListener('pagehide', onClose)
    lifecycle?.removeEventListener('beforeunload', onClose)
    if (scope === s) scope = null
  }
  const onClose = () => { if (scope) dispose(scope) }
  const requireScope = (view: SyncView): Scope => {
    if (!scope?.active || typeof view.vaultId !== 'string' || !view.vaultId.trim() || view.vaultId.includes('\0')
      || !Number.isSafeInteger(view.epoch) || view.epoch < 0 || !Number.isSafeInteger(view.revision) || view.revision < 0
      || !sameScope(scope.view, view) || view.revision < scope.view.revision) throw new Error('Helper response delivery no longer matches this view.')
    return scope
  }
  const read = (s: Scope, view: SyncView, reuse = true, signal?: AbortSignal): Promise<SyncInput> => {
    if (reuse && s.read && sameSyncView(s.read.view, view)) return s.read.promise
    const captured = capture(s, view)
    // The documents edited in this view, taken in the turn the view is captured (never later gens).
    const edited = receipts?.captured() ?? null
    const earlier = s.read
    const promise = bounded(s, async () => {
      if (earlier) await earlier.promise.catch(() => {})
      if (!s.active || signal?.aborted) throw new Error('Helper response delivery ended.')
      // Both asked after the capture. A receipt status that is not delivered proves nothing; it never fails the read.
      const [answer, receipt] = await Promise.all([api.status(), edited ? receipts!.status(edited).catch(() => null) : null])
      return { answer, proven: edited !== null && proves(edited, receipt) }
    }, statusTimeout, signal).then(({ answer, proven }) => {
      const input = mapHelperStatus(answer, captured.view, captured.observation, s.previous, proven)
      if (s.active && sameSyncView(s.view, captured.view) && (!s.previous || !sameSyncView(s.previous.view, captured.view) || s.previous.observation < captured.observation)) {
        s.answer = answer; s.previous = input; s.requested = false
        if (answer.state === 'disabled' || answer.state === 'not-registered') s.lastVault = undefined
        else s.lastVault = vaultOf(answer) ?? s.lastVault
      }
      return input
    })
    const pending = { view: captured.view, observation: captured.observation, promise }
    s.read = pending
    void promise.finally(() => {
      if (s.read === pending) {
        s.read = null
        if (s.active && s.requested && !s.action) request(s)
      }
    }).catch(() => {})
    return promise
  }
  const request = (s: Scope) => {
    if (!s.active) return
    if (s.action || s.read) { s.requested = true; return }
    s.requested = false
    const capturedView = { ...s.view }
    const promise = read(s, capturedView)
    const observation = s.read!.observation
    void promise.then(input => {
      if (s.active && !s.action && sameSyncView(s.view, capturedView)) s.publish(input)
    }, () => {
      if (s.active && !s.action && sameSyncView(s.view, capturedView)) {
        // A failed read is uncertainty, never a refreshed proof. Keep the original dated facts.
        s.answer = undefined
        const input = mapHelperStatus({ state: 'stale', reason: 'window-root-changed' }, capturedView, observation, s.previous)
        s.previous = input; s.publish(input)
      }
    }).finally(() => {
      if (s.active && s.requested && !s.action) { s.requested = false; request(s) }
    }).catch(() => {})
  }
  const action = async (actionView: SyncView, sync: boolean): Promise<SyncInput> => {
    const view = { ...actionView }
    const s = requireScope(view)
    if (s.action) throw new Error('A helper action is already in progress.')
    // The hook invalidates immediately but coalesces updateView. Adopt its newer
    // delivery view before capture, without attaching editor coverage to old facts.
    s.view = { ...view }
    const token = {}; s.action = token
    const delivery = new AbortController()
    // Sync allocates its observation before invoking IPC; the later status read owns its own capture.
    const captured = sync ? capture(s, view) : null
    try {
      if (!sync) return await read(s, view)
      return await bounded(s, async () => {
        const answer = await api.syncNow()
        if (!s.active || s.action !== token || !sameSyncView(s.view, view)) throw new Error('Helper response delivery no longer matches this view.')
        if (answer.state !== 'cycle') {
          const status: BackupHelperStatusAnswer = answer.state === 'unavailable' ? { ...answer, lastKnown: null } : answer
          const input = mapHelperStatus(status, captured!.view, captured!.observation, s.previous)
          s.previous = input; s.answer = status
          if (status.state === 'disabled' || status.state === 'not-registered') s.lastVault = undefined
          return input
        }
        // Cycle/push success is not a branch check or editor acknowledgement. Read the engine's own proof clock.
        return await read(s, view, false, delivery.signal)
      }, actionTimeout)
    } finally {
      delivery.abort()
      if (s.action === token) s.action = null
      if (s.active && s.requested) { s.requested = false; request(s) }
    }
  }
  return {
    subscribe(view, publish) {
      if (scope) dispose(scope)
      const s: Scope = { view: { ...view }, active: true, publish, counter: 0, counterView: { ...view }, cancels: new Set(), action: null, read: null, requested: false }
      scope = s
      lifecycle?.addEventListener('pagehide', onClose)
      lifecycle?.addEventListener('beforeunload', onClose)
      request(s)
      return {
        updateView(next) {
          if (!s.active) return
          if (!sameScope(s.view, next)) { dispose(s); return }
          if (!Number.isSafeInteger(next.revision) || next.revision <= s.view.revision) return
          s.view = { ...next }; request(s)
        },
        unsubscribe: () => dispose(s),
      }
    },
    actions: { check: view => action(view, false), syncNow: view => action(view, true) },
    coverageExplanation() {
      const s = scope
      const vault = s?.lastVault ?? null
      const engine = vault?.engine
      // Main's receipt answer replaces only the clause that edits are not reported; the other limits stay.
      const parts = [receipts?.lastStatus()?.state === 'reported' ? receiptLimits : limits]
      if (s?.previous?.availability === 'unconfigured') parts.push('The backup helper trial is not configured for this vault.')
      if (vault) parts.push(`Engine observation: ${vault.engineObservedAt === null ? 'unknown' : new Date(vault.engineObservedAt).toLocaleString('en-GB')}${s?.answer?.state !== 'reported' || !vault.fresh ? ' (last known only)' : ''}.`, ...vault.uncertainty)
      if (engine) {
        for (const [name, list] of [['Pending paths', engine.pending], ['Unlisted folders', engine.unlistedFolders], ['Writing paths', engine.writing], ['Repository hooks not run', engine.repositoryHooksNotRun]] as const)
          parts.push(`${name}: ${list.count}; ${list.items.length} listed; ${list.omitted} omitted.`)
      }
      const receiptLine = receiptSentence(receipts?.lastStatus() ?? null)
      if (receiptLine) parts.push(receiptLine)
      return parts.join(' ')
    },
  }
}
