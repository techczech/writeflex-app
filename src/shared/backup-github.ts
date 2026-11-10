/** Renderer-safe states only. Secret and path fields have no representation here. */
export type GitHubRepositoryView = { state: 'no-folder' | 'unsupported' | 'unchecked' | 'checking' | 'selecting' | 'expired' | 'candidate' | 'ready' | 'not-authorised' | 'unknown'; repository?: string; candidateId?: string }
export type GitHubView = {
  state: 'unconfigured' | 'disconnected' | 'starting' | 'waiting' | 'connected' | 'reauth-required' | 'disconnecting' | 'error'
  attemptId?: string
  login?: string
  reason?: 'cancelled' | 'denied' | 'expired' | 'offline' | 'invalid-response' | 'browser-failed' | 'other-window' | 'shutdown-unconfirmed' | 'storage' | 'refused' | 'disconnected'
  waiting?: { attemptId: string; userCode: string; expiresAt: number; canCancel: boolean; canOpen: boolean }
  repository: GitHubRepositoryView
}
export interface BackupGitHubPort {
  status(): Promise<GitHubView>; connect(): Promise<GitHubView>
  cancel(input: { attemptId: string }): Promise<GitHubView>; openBrowser(input: { attemptId: string }): Promise<GitHubView>
  repository(): Promise<GitHubView>; useRepository(input: { candidateId: string }): Promise<GitHubView>
  openRepositoryAccess(): Promise<GitHubView>; disconnect(): Promise<GitHubView>; openAuthorisations(): Promise<GitHubView>
  recover(): Promise<GitHubView>; onChanged(listener: () => void): () => void
}
export const BACKUP_GITHUB_CHANNELS = Object.freeze(Object.fromEntries(['status', 'connect', 'cancel', 'openBrowser', 'repository', 'useRepository', 'openRepositoryAccess', 'disconnect', 'openAuthorisations', 'recover', 'changed'].map(k => [k, `backup-github:${k}`]))) as Readonly<Record<keyof BackupGitHubPort | 'changed', string>>
export function opaqueArgument(args: unknown[], key: 'attemptId' | 'candidateId'): string | null {
  if (args.length !== 1 || !args[0] || typeof args[0] !== 'object' || Object.getPrototypeOf(args[0]) !== Object.prototype) return null
  const ds = Object.getOwnPropertyDescriptors(args[0])
  if (Reflect.ownKeys(ds).length !== 1 || !ds[key] || !Object.hasOwn(ds[key]!, 'value')) return null
  const id: unknown = ds[key]!.value
  return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) ? id : null
}
