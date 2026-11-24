import type { SecretScanner } from '@app-patterns/vault-sync'
import type { SettingsStore } from './settings'

export type GitSyncDocument = { path: string; kind: 'new' | 'changed' | 'removed' }
export type GitSyncPair = { id: string; local: string; other: string; from: string; at: number }
export type GitSyncReasonCode = 'repository-state' | 'repository-changed' | 'unsupported' | 'sibling-changes' | 'local-changes' | 'index-busy' | 'secret-found' | 'scanner-unavailable' | 'auth-refused' | 'network-unavailable' | 'push-rejected' | 'operation-failed' | 'rollback-failed' | 'outside-vault-commits' | 'content-conversion' | 'git-renames' | 'tools-missing'
export type GitSyncWarning = { code: 'history-kept' | 'machine-local-tracked' | 'internal-content-mismatch' | 'internal-value-selected' | 'internal-ledger-recovery' | 'internal-write-deferred' | 'local-write-preserved'; path: string; message: string; copy?: string }
export type GitSyncReason = { code: GitSyncReasonCode; message: string; document?: string }
export type GitVaultSyncResult = {
  state: 'off' | 'up-to-date' | 'incoming' | 'waiting-to-send' | 'stopped' | 'needs-you'
  enabled: boolean
  computerName: string
  pending: GitSyncDocument[]
  incoming: GitSyncDocument[]
  /** What this send or receive itself brought in (the shown `incoming` list may be an earlier one). */
  received?: GitSyncDocument[]
  pairs: GitSyncPair[]
  warnings: GitSyncWarning[]
  internalPending: string[]
  reason?: GitSyncReason
  lastSentAt?: number
  lastReceived?: { at: number; from: string }
  checkedAt?: number
  location?: { host: string; repository: string; branch: string; localPath?: string }
}
export type GitSyncRecord = {
  warnings?: GitSyncWarning[]; pairs: GitSyncPair[]; incoming: GitSyncDocument[]; remoteTip?: string; checkedAt?: number
  sentTip?: string; sentBase?: string; lastSentAt?: number; lastReceived?: { at: number; from: string }; reason?: GitSyncReason
  identity?: { root: string; gitDir: string; branch: string }
}
export type GitVaultSyncOptions = {
  settings: Pick<SettingsStore, 'get' | 'set'>
  withFileLock?: <T>(absolute: string, work: () => Promise<T>) => Promise<T>
  ownWrite?: (absolute: string, expected: import('./workspace-watcher').OwnWriteExpectation) => void
  computerName?: string
  scanner?: SecretScanner
  /** Trusted main-process configuration only; never renderer input. Tests isolate global Git config. */
  gitEnv?: Record<string, string>
  gitTimeoutMs?: number
  networkTimeoutMs?: number
  lockWaitMs?: number
  lockPollMs?: number
  pushAttempts?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Main-only fault/race seam; there is no renderer or production IPC for it. */
  checkpoint?: (phase: 'before-push' | 'before-apply' | 'after-write' | 'after-index-install') => Promise<void>
  /** Main-only test seam: whether this Mac's Git merges without detecting renames (default: measured, cached). */
  renameProbe?: () => Promise<import('./git-vault-sync-rename-probe').RenameProbe>
}
export type GitSyncCall = { unsavedPaths?: readonly string[]; clashFrom?: string }
export class GitSyncFailure extends Error {
  clash?: {document:string;from:string}
  constructor(readonly reason: GitSyncReason) { super(reason.message) }
}
export function refuse(code: GitSyncReasonCode, message: string, document?: string): never {
  throw new GitSyncFailure({ code, message, ...(document ? { document } : {}) })
}
export const siblingBlocked = (): never => refuse('sibling-changes', 'Another folder in this repository has changes that block the update.')
