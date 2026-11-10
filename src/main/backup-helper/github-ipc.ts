/** Strict sender and own-data checking before auth sees a request. */
import { BACKUP_GITHUB_CHANNELS, opaqueArgument, type GitHubView } from '../../shared/backup-github'
import type { GitHubAuth } from './github-auth'
type Event = { sender: { id: number; mainFrame?: unknown; isDestroyed?(): boolean }; senderFrame?: unknown }
type Registrar = { handle(channel: string, handler: (event: any, ...args: unknown[]) => unknown): void }
const refused: GitHubView = { state: 'error', reason: 'refused', repository: { state: 'unknown' } }
export function registerGitHubIpc(ipc: Registrar, auth: GitHubAuth, trusted: (event: Event) => boolean): void {
  for (const name of ['status', 'connect', 'cancel', 'openBrowser', 'repository', 'useRepository', 'openRepositoryAccess', 'disconnect', 'openAuthorisations', 'recover'] as const) {
    ipc.handle(BACKUP_GITHUB_CHANNELS[name], (event: Event, ...args: unknown[]) => {
      if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed?.() || !trusted(event)) return refused
      if (name === 'cancel' || name === 'openBrowser' || name === 'useRepository') {
        const id = opaqueArgument(args, name === 'useRepository' ? 'candidateId' : 'attemptId')
        return id === null ? refused : auth[name](event.sender.id, id)
      }
      return args.length ? refused : auth[name](event.sender.id)
    })
  }
}
