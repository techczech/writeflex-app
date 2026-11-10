/**
 * The backup control and receipt services as the rest of main holds them: one object each, registered
 * once on IPC, the save port and the non-atomic write policy, whose implementation is replaced when the
 * enrolled vaults change (enrolment.ts). Both are built from one trial configuration, so the control lane
 * and the receipts lane never disagree about which folder is which vault.
 *
 * Replacing them (`configure`):
 * 1. Every call from then on reaches holding services: a window's receipt call is refused as
 *    `reconfiguring` (nothing stored; its adapter keeps what it owes and binds again when told), a save
 *    gets no receipt, and an exclusive create in a formerly enrolled folder keeps refusing the copy route.
 * 2. The old instances are retired: every window lifetime and owner ends (the receipt service's own
 *    dispose), their sockets close, and this waits until every receipt call that had entered them and
 *    every save handle they issued has settled and every stream has finished its current pump, so no old
 *    write reaches a vault's outbox after a new instance has opened it.
 * 3. Only then are new services built for the new trial. Windows are told (`onChanged`) to ask for a new
 *    lifetime; each gets a new owner from the new instance.
 * If the old instance has not settled within SETTLE_LIMIT_MS, no new receipt service is built: receipts
 * stay held (saves go ahead as before, with no receipt) until WriteFlex restarts, and `configure`
 * answers `receipts-paused`. A divergent outbox is never risked. Settlement is only ever what the old
 * instance itself reported: every call and save handle ended, and every stream's `settled()` resolved
 * (or rejected: its pump has ended). Running out of time is never read as settlement, however close to
 * the deadline it lands; opening a stream is bounded by the same deadline.
 *
 * Copy guard (`setCopyGuard`): folders for which an exclusive create must refuse the copy route whatever
 * the current instance says, because a backup helper may be capturing them while no receipt instance is
 * serving them (enrolment.ts holds it from before the old helper is told to stop until a new helper is
 * running and its services are built, and keeps it when a stop is overdue or receipts are paused).
 * Ordinary atomic saves never ask.
 */
import { realpathSync } from 'node:fs'
import type { BackupReceiptService, MainSaveReceipt } from './receipt-service'
import type { BackupHelperService } from './service'
import { BACKUP_HELPER_TRIAL_DISABLED, type BackupHelperTrial } from './trial-config'

export const SETTLE_LIMIT_MS = 30_000

export type ServicePair = { helper: BackupHelperService; receipts: BackupReceiptService }

export type ActiveBackupServices = {
  readonly helper: BackupHelperService
  readonly receipts: BackupReceiptService
  /** The trial the current services were built from. */
  readonly trial: BackupHelperTrial
  configure(trial: BackupHelperTrial): Promise<'configured' | 'receipts-paused'>
  /** Real folder paths whose exclusive creates refuse the copy route regardless of the instance (replaces the set). */
  setCopyGuard(roots: ReadonlySet<string>): void
  /** Preserve current capture roots before account-driven helper retirement. */
  holdCopyGuard(): void
  dispose(): Promise<void>
}

export type ActiveServicesOptions = {
  make: (trial: BackupHelperTrial) => ServicePair
  /** Every window should drop its receipt lifetime and ask again. */
  onChanged?: () => void
  settleLimitMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Test seam (default fs.realpathSync), for the copy guard's folder comparison. */
  resolveRealSync?: (path: string) => string
}

const RECONFIGURING = { state: 'refused', reason: 'reconfiguring' } as const

export function createActiveBackupServices(options: ActiveServicesOptions): ActiveBackupServices {
  const settleLimit = options.settleLimitMs ?? SETTLE_LIMIT_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const resolveRealSync = options.resolveRealSync ?? realpathSync
  const disabled = options.make(BACKUP_HELPER_TRIAL_DISABLED)
  let copyGuard: ReadonlySet<string> = new Set()
  /** Refuses inside a guarded folder; a folder that cannot be resolved while anything is guarded refuses too. */
  const guarded = (root: string): boolean => {
    if (copyGuard.size === 0) return false
    try { return copyGuard.has(resolveRealSync(root)) } catch { return true }
  }
  type Instance = { pair: ServicePair; trial: BackupHelperTrial; inFlight: number }
  let current: Instance = { pair: disabled, trial: BACKUP_HELPER_TRIAL_DISABLED, inFlight: 0 }
  let paused = false
  let chain: Promise<unknown> = Promise.resolve()

  /** Counts a call into `instance` until it settles; a save handle counts until its completion settles. */
  function tracked<T>(instance: Instance, run: () => Promise<T>): Promise<T> {
    instance.inFlight += 1
    let p: Promise<T>
    try { p = run() } catch (error) { instance.inFlight -= 1; return Promise.reject(error) }
    return p.finally(() => { instance.inFlight -= 1 })
  }

  function handle(instance: Instance, receipt: MainSaveReceipt): MainSaveReceipt {
    instance.inFlight += 1
    let open = true
    const end = () => { if (open) { open = false; instance.inFlight -= 1 } }
    return {
      ...receipt,
      saved: (absolute, written) => receipt.saved(absolute, written).finally(end),
      failed: () => receipt.failed().finally(end),
    }
  }

  const receipts: BackupReceiptService = {
    lifetime: (sender, args) => { const i = current; return tracked(i, () => i.pair.receipts.lifetime(sender, args)) },
    reportEdit: (sender, args) => { const i = current; return tracked(i, () => i.pair.receipts.reportEdit(sender, args)) },
    status: (sender, args) => { const i = current; return tracked(i, () => i.pair.receipts.status(sender, args)) },
    beginSave: (senderId, root, path, meta) => {
      const i = current
      return tracked(i, async () => {
        const made = await i.pair.receipts.beginSave(senderId, root, path, meta)
        return made ? handle(i, made) : null
      })
    },
    // A folder that was enrolled keeps refusing the copy route until the old instance has settled, and a
    // guarded folder (a helper may be capturing it) refuses whatever the instance says.
    nonAtomicPolicy: (root) => (guarded(root) ? 'refuse' : current.pair.receipts.nonAtomicPolicy(root)),
    retireSender: (senderId) => current.pair.receipts.retireSender(senderId),
    dispose: () => { void dispose() },
    get ready() { return current.pair.receipts.ready },
    streamFor: (vault) => current.pair.receipts.streamFor(vault),
  }

  const helper: BackupHelperService = {
    status: (senderId) => current.pair.helper.status(senderId),
    syncNow: (senderId) => current.pair.helper.syncNow(senderId),
    disposeWindow: (senderId) => current.pair.helper.disposeWindow(senderId),
    dispose: () => { void dispose() },
  }

  /** `work` as it actually ended, or `timeout` when the deadline came first (never inferred from the clock). */
  async function within<T>(work: Promise<T>, deadline: number): Promise<{ ended: true; value: T } | { ended: false }> {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { ended: false }
    const ended = work.then((value) => ({ ended: true as const, value }))
    return Promise.race([ended, sleep(remaining).then(() => ({ ended: false as const }))])
  }

  /** Retires `old`; true only once the old instance itself showed that nothing of it can still write. */
  async function retire(old: Instance): Promise<boolean> {
    old.pair.helper.dispose()
    // Disposed first, so asking for a stream returns only one already opened, never opens another.
    old.pair.receipts.dispose()
    const streams = old.trial.enabled ? [...old.trial.vaults.values()].map((vault) => old.pair.receipts.streamFor(vault).catch(() => null)) : []
    const deadline = Date.now() + settleLimit
    while (old.inFlight > 0 && Date.now() < deadline) await sleep(20)
    if (old.inFlight > 0) return false
    for (const made of streams) {
      const opened = await within(made, deadline)
      if (!opened.ended) return false
      const stream = opened.value
      if (!stream) continue
      // A rejected `settled()` is a pump that has ended (with an error); only its own answer counts.
      const pumped = await within(stream.settled().catch(() => undefined), deadline)
      if (!pumped.ended) return false
    }
    return true
  }

  async function configureNow(trial: BackupHelperTrial): Promise<'configured' | 'receipts-paused'> {
    const old = current
    // The old instance keeps the non-atomic refusal for its folders while it settles. Windows are refused as
    // `reconfiguring`, not `disabled`, so their adapters keep what they owe for the next binding.
    const holding: ServicePair = {
      helper: disabled.helper,
      receipts: {
        ...disabled.receipts,
        lifetime: async () => RECONFIGURING,
        reportEdit: async () => RECONFIGURING,
        status: async () => RECONFIGURING,
        nonAtomicPolicy: (root) => old.pair.receipts.nonAtomicPolicy(root),
      },
    }
    current = { pair: holding, trial: BACKUP_HELPER_TRIAL_DISABLED, inFlight: 0 }
    options.onChanged?.()
    const settled = old.pair === disabled ? true : await retire(old)
    if (!settled || paused) {
      paused = true
      // Saves still refuse the copy route in folders the old instance served; receipts stay off.
      return 'receipts-paused'
    }
    current = trial.enabled ? { pair: options.make(trial), trial, inFlight: 0 } : { pair: disabled, trial: BACKUP_HELPER_TRIAL_DISABLED, inFlight: 0 }
    options.onChanged?.()
    return 'configured'
  }

  async function dispose(): Promise<void> {
    const old = current
    current = { pair: disabled, trial: BACKUP_HELPER_TRIAL_DISABLED, inFlight: 0 }
    if (old.pair !== disabled) await retire(old)
  }

  return {
    helper,
    receipts,
    get trial() { return current.trial },
    setCopyGuard(roots) { copyGuard = new Set(roots) },
    holdCopyGuard() { copyGuard = new Set([...copyGuard, ...(current.trial.enabled ? current.trial.vaults.keys() : [])]) },
    configure(trial) {
      const next = chain.then(() => configureNow(trial))
      chain = next.catch(() => undefined)
      return next
    },
    dispose,
  }
}
