/**
 * Vault sidebar state that is not the tree: the per-vault view choices (Writing only, Titles | File names)
 * remembered on this Mac in localStorage (app-side, never in `vault.json`), and the count line.
 */
import type { VaultIndex } from '../../shared/vault-index'
import { inProgressCount, type VaultStep } from '../../shared/vault'

export type VaultSidebarPrefs = { writingOnly: boolean; titles: boolean }
export const DEFAULT_VAULT_SIDEBAR_PREFS: VaultSidebarPrefs = { writingOnly: true, titles: true }

type PrefStorage = Pick<Storage, 'getItem' | 'setItem'>

const prefsKey = (root: string): string => `writeflex:vault-sidebar:${root}`

export function readVaultSidebarPrefs(root: string, storage: PrefStorage | null = defaultStorage()): VaultSidebarPrefs {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(prefsKey(root)) ?? 'null')
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      return {
        writingOnly: typeof record.writingOnly === 'boolean' ? record.writingOnly : DEFAULT_VAULT_SIDEBAR_PREFS.writingOnly,
        titles: typeof record.titles === 'boolean' ? record.titles : DEFAULT_VAULT_SIDEBAR_PREFS.titles,
      }
    }
  } catch { /* unreadable: defaults */ }
  return { ...DEFAULT_VAULT_SIDEBAR_PREFS }
}

export function writeVaultSidebarPrefs(root: string, prefs: VaultSidebarPrefs, storage: PrefStorage | null = defaultStorage()): void {
  try { storage?.setItem(prefsKey(root), JSON.stringify(prefs)) } catch { /* convenience only */ }
  for (const watcher of [...prefWatchers]) if (watcher.root === root) watcher.fn(prefs)
}

type PrefWatcher = { root: string; fn: (prefs: VaultSidebarPrefs) => void }
const prefWatchers = new Set<PrefWatcher>()

/** Be told when a root's choices are written (the sidebar's controls and the palette's two toggles both
 *  write them, so each shows the other's change). Returns the unsubscribe. */
export function watchVaultSidebarPrefs(root: string, fn: (prefs: VaultSidebarPrefs) => void): () => void {
  const watcher: PrefWatcher = { root, fn }
  prefWatchers.add(watcher)
  return () => { prefWatchers.delete(watcher) }
}

function defaultStorage(): PrefStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

/** `142 works · 12 in progress`: in progress = works whose mapped step is Notes, Drafting, In review or Final. */
export function vaultCountText(works: VaultIndex['works'], statusMap: Readonly<Record<string, VaultStep>>): string {
  const inProgress = inProgressCount(works, statusMap)
  return `${works.length} ${works.length === 1 ? 'work' : 'works'} · ${inProgress} in progress`
}
