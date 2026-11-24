import type { GitVaultSyncResult, GitSyncReasonCode, GitSyncReason } from '../main/git-vault-sync-types'
import type { GitVaultDiscovery } from '../main/git-vault-discovery'
import type { BackupToolInfo, RemoteProtection } from './remote-protection'
export const stopSentences: Record<GitSyncReasonCode, string> = {
  'repository-state': 'This folder is not ready to receive changes. Finish the other operation in your repository, then try again.',
  'repository-changed': 'This folder or its branch has moved or changed. Check where it is kept, then turn sync off and on again.',
  unsupported: 'This folder uses a file or repository arrangement that WriteFlex cannot safely update. Update it with Git.',
  'sibling-changes': 'Another folder in this repository has changes that block the update. Save those changes with Git, then try again.',
  'local-changes': 'A document has newer writing or a separate saved version waiting. Finish saving it, then try again.',
  'index-busy': 'Another application is saving this repository. Wait for it to finish, then try again.',
  'secret-found': 'A possible password or key was found in a document. Remove it, then try again.',
  'scanner-unavailable': 'The password and key safety check could not finish. Repair the safety check, then try again.',
  'auth-refused': 'Sign-in was refused. Check your saved sign-in or access key with Git, then try again.',
  'network-unavailable': 'The place where this vault is kept cannot be reached. Check your connection and its location, then try again.',
  'push-rejected': 'The other copy kept changing while WriteFlex tried to send. Wait a moment, then try again.',
  'operation-failed': 'WriteFlex could not finish this update. Your local writing was kept. Try again.',
  'rollback-failed': 'WriteFlex could not finish restoring the update. Keep this folder here and check it with Git before trying again.',
  'outside-vault-commits': 'This repository has changes of your own outside this vault waiting to be sent. Send them with Git, then try again.',
  'content-conversion': 'This repository changes file contents or line endings when receiving them. Update it with Git before syncing here.',
  'git-renames': "This Mac's Git handles renames in a way WriteFlex cannot sync safely. Update Xcode or its Command Line Tools in Software Update, then try again.",
  'tools-missing': "Git sync needs Apple's Command Line Tools, which are not installed on this Mac.",
}
export type GitView = { root: string; result: GitVaultSyncResult; discovery: GitVaultDiscovery; gitFolder: boolean; busy: boolean; /** Sync is switched on but cannot run: no Command Line Tools. */ paused?: boolean; /** Vault sync with Git was switched off at launch (Settings › Advanced): none of it runs. */ experimentalOff?: boolean; /** Switched off, and this vault carries a sync marker (its preference or sync's own files). */ syncMarker?: boolean; wait: number; editedAt?: number; failedAt?: number; edits?: Record<string, number>; /** Writing the last quit could not send: being sent on this opening, then sent. */ leftAtQuit?: 'sending' | 'waiting' | 'sent'; /** Issue 257: what the backup tool's records and Git's ignore rules say about this folder's remote copy. */ protection?: RemoteProtection; /** Issue 257: the backup tool those records come from, named before they are first read. */ backupTool?: BackupToolInfo }

export function gitState(view: GitView, now = Date.now()) {
  const r = view.result
  const offline = r.reason?.code === 'network-unavailable' && (r.pending.length > 0 || r.internalPending.length > 0) && view.failedAt !== undefined && now - view.failedAt < 900000
  return r.reason && !offline ? 4 : r.pairs.length ? 5 : r.pending.length || r.internalPending.length || offline ? 3 : r.incoming.length ? 2 : 1
}
export const shortReason: Record<GitSyncReasonCode, string> = {
  'repository-state': 'needs attention', 'repository-changed': 'needs attention', unsupported: 'needs attention',
  'sibling-changes': 'needs attention', 'local-changes': 'check a document', 'index-busy': 'needs attention',
  'secret-found': 'check a document', 'scanner-unavailable': 'needs attention', 'auth-refused': 'sign in',
  'network-unavailable': 'offline', 'push-rejected': 'needs attention', 'operation-failed': 'needs attention',
  'rollback-failed': 'needs attention',
  'outside-vault-commits': 'needs attention', 'content-conversion': 'needs attention', 'git-renames': 'needs attention', 'tools-missing': 'needs attention',
}
/** Told to the writer when a quit could not send their last writing in time. */
export const leftAtQuitSentence = { sending: 'Some writing was not sent when WriteFlex last quit. It is being sent now.', waiting: 'Some writing may not have been sent when WriteFlex last quit. It will be sent when sync can run again.', sent: 'Writing that could not be sent when WriteFlex last quit has now been sent.' } as const
export const documents = (n: number) => `${n} document${n === 1 ? '' : 's'}`
export function stopSentence(reason: GitSyncReason): string {
  // The engine's sentence names this Mac's Git version.
  if (reason.code === 'git-renames' && reason.message) return reason.message
  if (reason.code === 'secret-found') {
    const path = reason.document ?? 'a document'
    const where = /(?:^|\/)\.bridle\/objects\//.test(path) ? `a saved version of a document (${path})` : path
    return `A possible password or key was found in ${where}. Remove it, then try again.`
  }
  return stopSentences[reason.code] + (reason.document ? ` Document or folder: ${reason.document}.` : '')
}
export const shortPath = (path: string) => path.length > 40 ? path.slice(0, 17) + '…' + path.slice(-22) : path


export type GitSyncAction = 'open' | 'status' | 'enable' | 'disable' | 'send' | 'fetch' | 'done' | 'wait' | 'e2e-idle' | 'install-tools' | 'check-tools'
export interface GitSyncAppPort {
  call(input: { action: GitSyncAction; value?: unknown }): Promise<GitView | null>
  buffers(input: { id: string; root: string; paths: string[] }): Promise<void>
  onPrepare(callback: (input: { id: string; root: string }) => void): () => void
}
