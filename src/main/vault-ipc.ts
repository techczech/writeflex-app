/**
 * The vault channels: the renderer asks about and changes the vault of its own window's root, and
 * nothing else. No channel takes a root or a file path; the root is the sender window's binding, held
 * in main. Pin paths are folder or `.md` document paths inside that root, checked by the store.
 *
 * Outside changes: the first time a renderer reads the vault of a root, a dedicated watcher on that
 * root's `.writeflex/vault.json` starts (vault-watcher.ts), independent of the document watcher and its
 * setting. Watchers of roots no window holds any more are stopped when a window closes or binds
 * another root (`onWindowReleased`), and also at the next read, change push or watcher touch; all of
 * them when the handlers are disposed.
 */
import type { VaultChangedEvent, VaultView, VaultWriteResult } from '../shared/vault'
import { onVaultChanged, vaultStoreFor } from './vault-store'
import { watchVaultFile, type VaultFileWatch } from './vault-watcher'

type IpcEvent = { sender: { id: number } }
export type VaultIpcRegistrar = { handle: (channel: string, handler: (event: IpcEvent, input: any) => unknown) => void }

export const VAULT_CHANGED_CHANNEL = 'vault:changed'

export type VaultIpcDependencies<State> = {
  stateForSender: (id: number) => State
  /** The window's bound root, or null when it has none. */
  rootOf: (state: State) => string | null
  /** Every live window state, for the change push. */
  allStates: () => State[]
  send: (state: State, channel: string, payload: unknown) => void
  /** Subscribes to "a window closed or left its root" (called after the window's binding changed);
   *  returns the unsubscribe. Each call stops the watchers of roots no window holds any more. */
  onWindowReleased?: (listener: () => void) => () => void
  /** @internal The watcher factory; tests pass a fake. */
  watchVault?: (root: string, onTouched: () => void) => VaultFileWatch
}

const NO_ROOT: VaultWriteResult = { ok: false, reason: 'not-a-vault', message: 'No folder is open in this window.', vault: null }

/** Register the handlers and the change push; returns the push's unsubscribe. */
export function registerVaultIpcHandlers<State>(ipc: VaultIpcRegistrar, deps: VaultIpcDependencies<State>): () => void {
  const storeOf = (event: IpcEvent) => {
    const root = deps.rootOf(deps.stateForSender(event.sender.id))
    return root ? vaultStoreFor(root) : null
  }

  const watchVault = deps.watchVault ?? ((root: string, onTouched: () => void) =>
    watchVaultFile(root, onTouched, { ignoresCase: vaultStoreFor(root).ignoresCase() }))
  const watches = new Map<string, VaultFileWatch>()
  let disposed = false
  /** Stop the watchers of roots no live window is bound to. */
  const prune = (): void => {
    const held = new Set(deps.allStates().map(deps.rootOf).filter((root): root is string => root !== null))
    for (const [root, watch] of watches) {
      if (held.has(root)) continue
      watch.dispose()
      watches.delete(root)
    }
  }
  const ensureWatch = (root: string): void => {
    prune()
    if (disposed || watches.has(root)) return
    try {
      watches.set(root, watchVault(root, () => {
        prune()
        if (!watches.has(root)) return
        void vaultStoreFor(root).noticeDiskChange().catch(() => {})
      }))
    } catch {
      // No watch possible on this disk: the vault still reads and writes; outside changes show on the next read.
    }
  }

  ipc.handle('vault:get', async (event): Promise<VaultView | null> => {
    const root = deps.rootOf(deps.stateForSender(event.sender.id))
    if (!root) return null
    ensureWatch(root)
    return vaultStoreFor(root).read()
  })
  ipc.handle('vault:create', async (event, input) => storeOf(event)?.create(input) ?? NO_ROOT)
  ipc.handle('vault:add-pin', async (event, input) => storeOf(event)?.addPin(input?.path) ?? NO_ROOT)
  ipc.handle('vault:remove-pin', async (event, input) => storeOf(event)?.removePin(input?.path) ?? NO_ROOT)
  ipc.handle('vault:reorder-pins', async (event, input) => storeOf(event)?.reorderPins(input?.order) ?? NO_ROOT)
  ipc.handle('vault:save', async (event, input) =>
    storeOf(event)?.save(input?.settings, input?.baseHash, { overwriteUnreadable: input?.overwriteUnreadable === true }) ?? NO_ROOT)

  const unsubscribe = onVaultChanged((root: string, change: VaultChangedEvent) => {
    for (const state of deps.allStates()) if (deps.rootOf(state) === root) deps.send(state, VAULT_CHANGED_CHANNEL, change)
    prune()
  })
  const unsubscribeRelease = deps.onWindowReleased?.(() => {
    if (!disposed) prune()
  })
  return () => {
    disposed = true
    unsubscribe()
    unsubscribeRelease?.()
    for (const watch of watches.values()) watch.dispose()
    watches.clear()
  }
}
