/**
 * What the renderer may learn from the backup helper (disabled-trial bridge,
 * _TASK-LOG/2026-10-25-vault-sync-bridge.md). Types and constants only: no Node, no IPC.
 *
 * The renderer asks about its own window's folder and names nothing: no vault id, path, socket or
 * command crosses the bridge. Main maps the window's opened folder to a vault the trusted trial
 * configuration registered, talks to the helper over its socket and checks every reply before any of
 * it reaches here.
 *
 * No answer is a protection claim. Helper protocol 1 carries no editor receipts, so edits made after
 * the helper's last capture are unknown, and backup never compares branches. Every answer that carries
 * helper state says so in `limits`; `protectionClaim` is the literal `false`.
 */

/** Helper protocol this bridge speaks. */
export const BACKUP_HELPER_PROTOCOL = 1

/** Writer-receipt methods the helper reserves and refuses in protocol 1 (protocol.ts RESERVED_RECEIPT_METHODS). */
export const BACKUP_HELPER_RESERVED_RECEIPT_METHODS = ['noteEdit', 'noteWriteStart', 'noteFlush'] as const
export type BackupHelperReceiptMethod = (typeof BACKUP_HELPER_RESERVED_RECEIPT_METHODS)[number]

/** Why an answer that carries helper state is still no protection claim. Always all three in protocol 1. */
export type BackupHelperLimit =
  /** The editor's edits are not reported to the helper: what was typed after its last capture is unknown. */
  | 'editor-edits-not-reported'
  /** The helper's own word: edits made after its last capture are unknown until the next capture. */
  | 'edits-after-last-capture-unknown'
  /** Backup verifies its own backup branch; it never compares with a shared branch or another machine. */
  | 'no-branch-comparison'

export const BACKUP_HELPER_LIMITS: readonly BackupHelperLimit[] = ['editor-edits-not-reported', 'edits-after-last-capture-unknown', 'no-branch-comparison']

export type ListView<T> = { count: number; items: T[]; omitted: number }

export type BackupBlockReason =
  | 'cloud-synced-location' | 'not-enabled' | 'enablement-stale' | 'unsupported-remote' | 'public-remote-unconfirmed'
  | 'visibility-unknown' | 'secret-found' | 'scanner-unavailable' | 'too-large-to-scan' | 'unsupported-history' | 'history-unavailable'

export type BackupBlockView = {
  reason: BackupBlockReason
  at: number
  message: string
  findings?: ListView<{ path: string; rule: string }>
  notScanned?: ListView<{ path: string; oid: string; size: number; binary: boolean }>
}

export type BackupCycleOutcome = 'verified' | 'blocked' | 'capture-failed' | 'push-failed' | 'verify-failed' | 'no-snapshot' | 'cancelled'

/** One backup cycle as the helper reported it. Snapshot and ref fields are the helper's exact values. */
export type BackupCycleView = {
  vault: string
  reason: 'schedule' | 'syncNow'
  startedAt: number
  finishedAt: number
  outcome: BackupCycleOutcome
  capture: { snapshot: string | null; committed: boolean; startedAt: number; changed: number; pending: ListView<string>; skipped: number } | null
  push: { state: 'pushed' | 'up-to-date' | 'blocked' | 'rejected' | 'failed' | 'no-snapshot'; reason?: string; message?: string } | null
  verify: { verified: boolean; state?: string; snapshot?: string; message?: string } | null
  block: BackupBlockView | null
  error: string | null
}

export type BackupEngineView = {
  machineId: string
  checkoutId: string
  protectionAgeSeconds: number
  oldestUnprotectedEdit: number | null
  lastVerifiedSnapshot: string | null
  lastVerifiedAt: number | null
  protectedThrough: number | null
  latestSnapshot: string | null
  latestRef: string | null
  lastPushed: { snapshot: string; ref: string; seq: number | null; coverage: number | null } | null
  pending: ListView<string>
  unlistedFolders: ListView<string>
  unflushedEditSince: number | null
  writing: ListView<string>
  lastError: { kind: 'push-rejected' | 'push-failed' | 'verify-failed' | 'verify-mismatch' | 'capture-failed'; at: number; message: string } | null
  recoveredFromDamagedRecord: boolean
  repositoryHooksNotRun: ListView<string>
  enabled: boolean
  remote: string | null
  block: BackupBlockView | null
}

/** The helper's summary, verbatim. "no-known-unprotected-edits" is not "protected". */
export type BackupHelperSummary = 'unknown' | 'not-enabled' | 'blocked' | 'error' | 'unprotected' | 'no-known-unprotected-edits'

export type BackupVaultView = {
  vault: string
  summary: BackupHelperSummary
  /** The helper's reasons for doubt, in its order; never empty, never shortened. */
  uncertainty: string[]
  helper: { state: 'idle' | 'cycling' | 'stopping' | 'stopped'; cycleStartedAt: number | null; nextDueAt: number | null; lastCycle: BackupCycleView | null }
  /** True only when the helper read the engine for this request; false is its last known answer. */
  fresh: boolean
  /** When the helper's engine answer was read; for a stale answer, how old it is. */
  engineObservedAt: number | null
  engine: BackupEngineView | null
  statusError: string | null
}

/** Main's own clock when it received and checked the reply. Never moved to a later time. */
type Observed = { observedAt: number }

type Limits = { protectionClaim: false; limits: BackupHelperLimit[] }

/** The last reply main checked for this window's vault, with its own time. Shown only as old. */
export type BackupHelperLastKnown = Observed & { vault: BackupVaultView }

export type BackupHelperUnavailableReason =
  /** No helper socket at the configured place, or it refused the connection. */
  | 'not-running'
  /** Connecting or the hello failed, timed out or was refused. */
  | 'connect-failed'
  /** The helper speaks another protocol. */
  | 'protocol-mismatch'
  /** The helper closed the connection or the request timed out; the connection was dropped. */
  | 'disconnected'
  /** The reply failed main's checks; the connection was dropped. */
  | 'bad-reply'
  /** The helper answered with an error for this request. */
  | 'helper-error'
  /** The helper is stopping. */
  | 'stopping'
  /** The helper does not know this window's registered vault id. */
  | 'unknown-vault'
  /** Too many requests are waiting; nothing was sent. */
  | 'busy'
  /** Connecting failed a moment ago; main waits before trying again. */
  | 'backing-off'

export type BackupHelperStatusAnswer =
  /** The trial is off (the default). Nothing was asked. */
  | { state: 'disabled' }
  /** This window's folder is not a vault the trial registered, or no folder is open. */
  | { state: 'not-registered' }
  /** The request carried arguments; the bridge takes none. */
  | { state: 'refused'; reason: 'unexpected-arguments' }
  /** The window closed or moved to another folder before the answer came; the answer was dropped. */
  | { state: 'stale'; reason: 'window-closed' | 'window-root-changed' }
  | (Observed & Limits & { state: 'unavailable'; reason: BackupHelperUnavailableReason; message: string; lastKnown: BackupHelperLastKnown | null })
  /** A Sync now is running on main's single helper connection; status is not queued behind a whole cycle. */
  | (Observed & Limits & { state: 'sync-running'; since: number; lastKnown: BackupHelperLastKnown | null })
  | (Observed & Limits & { state: 'reported'; helper: { protocol: number; helperVersion: string; startedAt: number; stopping: boolean }; vault: BackupVaultView })

export type BackupHelperSyncAnswer =
  | { state: 'disabled' }
  | { state: 'not-registered' }
  | { state: 'refused'; reason: 'unexpected-arguments' }
  | { state: 'stale'; reason: 'window-closed' | 'window-root-changed' }
  | (Observed & Limits & { state: 'unavailable'; reason: BackupHelperUnavailableReason; message: string })
  /** The cycle the helper ran for this request (or a follow-up it shared), as reported. */
  | (Observed & Limits & { state: 'cycle'; cycle: BackupCycleView })

/** IPC channels. Both take no arguments. */
export const BACKUP_HELPER_CHANNELS = { status: 'backup-helper:status', syncNow: 'backup-helper:sync-now' } as const

/**
 * Editor receipts (helper protocol 2, locked plan §13.7). The renderer (app/backup-helper-receipts.ts)
 * names a document by its own (path, docEpoch, gen); main stamps the owner of the sender's current binding,
 * never one the renderer chose, and the vault comes from the window's folder. Every answer that carries
 * receipt state keeps `protectionClaim: false` and all three limits; the renderer derives proof from the
 * per-document states only (sync/helper-sync-adapter.ts).
 */
export const BACKUP_RECEIPT_CHANNELS = { lifetime: 'backup-receipts:lifetime', reportEdit: 'backup-receipts:report-edit', status: 'backup-receipts:status' } as const

/** No receipt time before this (the helper's static check, plan §3). */
export const BACKUP_RECEIPT_EARLIEST_AT = 1_577_836_800_000

/** At most this many documents in one status request (helper MAX_WANT). */
export const BACKUP_RECEIPT_MAX_DOCS = 64

/** A document as the renderer names it: its path in the window's folder and its own epoch and generation. */
export type BackupReceiptDocInput = { path: string; docEpoch: number; gen: number }

/**
 * What every receipt call after the first carries (renderer app/backup-helper-receipts.ts):
 * - `lifetime`: the opaque token main issued for this window's binding (BACKUP_RECEIPT_CHANNELS.lifetime).
 *   Main refuses the call, before it changes anything, when the token is not its current lifetime for the
 *   window: a call sent under a folder (or a page, or a binding of the same folder) that main has since
 *   retired is never stamped with the replacement's owner. Required: a call without one is refused (a save
 *   without one gets no receipt), never given main's lifetime at the call's entry.
 * - `at`: the original wall time (ms) of the oldest edit the call carries, as the renderer read it when the
 *   edit was made (never refreshed while a report or save waits). Main keeps the earlier of this and its own
 *   time at entry, so a call never names a time later than its arrival; a renderer clock reading cannot make
 *   main's debt younger than the call. Absent: the call's own time.
 */
export type BackupReceiptCallMeta = { lifetime: string; at?: number }

/** An edit report: the document, its lifetime token and the time of its oldest edit main has not heard of. */
export type BackupReceiptEditInput = BackupReceiptDocInput & BackupReceiptCallMeta

/** The save metadata `file:save` may carry: the epoch and the gen the save captured with the buffer, its
 *  lifetime token and the time of the oldest edit those bytes carry that is not yet on disk. */
export type BackupReceiptSaveInput = { docEpoch: number; gen: number } & BackupReceiptCallMeta

/** The lifetime request: the folder the renderer shows. Main answers its current token only for that folder. */
export type BackupReceiptLifetimeAnswer =
  | { state: 'disabled' }
  | { state: 'not-registered' }
  | { state: 'refused'; reason: BackupReceiptRefusal }
  | { state: 'stale'; reason: 'window-closed' | 'window-root-changed' }
  | { state: 'bound'; lifetime: string }

export type BackupReceiptDocState = 'unknown' | 'edited-not-saved' | 'saved-not-registered' | 'receipt-registered' | 'captured' | 'remote-verified'

export type BackupReceiptLane = 'offline' | 'connecting' | 'open' | 'unavailable' | 'stopped'

export type BackupReceiptDoc = {
  path: string
  docEpoch: number
  gen: number
  /** The owner main stamped (this window's current binding). */
  owner: string
  state: BackupReceiptDocState
  /** Main's own recorded blob of the durable bytes of this gen, when it has one. */
  blobOid: string | null
  /** The oldest edit of this document main still owes the helper. */
  since: number | null
  /** When the helper's status row was read; null without a live row. */
  observedAt: number | null
  verifiedAt: number | null
  snapshot: string | null
}

/** `reconfiguring`: backup enrolment is being changed (main active-services.ts); nothing was stored and
 *  the window keeps what it owes until it is told to bind again. */
export type BackupReceiptRefusal = 'unexpected-arguments' | 'bad-request' | 'not-main-frame' | 'reconfiguring'

export type BackupReceiptStatusAnswer =
  | { state: 'disabled' }
  | { state: 'not-registered' }
  | { state: 'refused'; reason: BackupReceiptRefusal }
  | { state: 'stale'; reason: 'window-closed' | 'window-root-changed' | 'owner-replaced' }
  /** Receipts cannot be used for this window now (no identity, a damaged outbox). */
  | (Observed & Limits & { state: 'unavailable'; reason: 'no-identity' | 'outbox-damaged' })
  | (Observed & Limits & { state: 'reported'; lane: BackupReceiptLane; covered: boolean; docs: BackupReceiptDoc[]; uncertainty: string[] })

export type BackupReceiptEditAnswer =
  | { state: 'disabled' }
  | { state: 'not-registered' }
  | { state: 'refused'; reason: BackupReceiptRefusal }
  | { state: 'stale'; reason: 'window-closed' | 'window-root-changed' | 'owner-replaced' }
  | { state: 'unavailable'; reason: 'no-identity' | 'outbox-damaged' | 'not-stored' }
  /** Kept durably in main's outbox; whether the helper has it is a status question. */
  | { state: 'noted'; owner: string }
