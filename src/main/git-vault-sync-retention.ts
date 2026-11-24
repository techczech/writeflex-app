import { createHash } from 'node:crypto'
import type { SettingsStore } from './settings'
/** A live journal alone is no longer authority to prune a fork's foreign snapshot objects. */
import { lstat, readdir, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { sweepSnapshots } from '@bridle/core'
import { tryWithGitVaultIdle } from './git-vault-sync'
type SweepResult = Awaited<ReturnType<typeof sweepSnapshots>>
const refused = (reason: string): SweepResult => ({ status:'refused', reason, prunedEntries:0, removedObjects:0 })
export async function sweepSyncedSnapshots(storeDir: string, days: number, settings?: Pick<SettingsStore,'get'>): Promise<SweepResult> {
  const root = await realpath(dirname(storeDir)).catch(() => resolve(dirname(storeDir)))
  if (settings) for (let parent=root;;parent=dirname(parent)) {
    if (settings.get('git-vault-sync.enabled.'+createHash('sha256').update(parent).digest('hex')) === true) return refused('sync-enabled')
    if (parent===dirname(parent)) break
  }
  const result = await tryWithGitVaultIdle(root, async () => {
    try {
      const st = await lstat(storeDir)
      if (!st.isDirectory() || st.isSymbolicLink()) return refused('unsafe-history-folder')
      if ((await readdir(storeDir)).some(name => /^journal(?:[- ][^/]*)?\.jsonl\.sync-fork\.json$/.test(name))) return refused('sync-history-fork')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return refused('history-unavailable')
    }
    return sweepSnapshots(storeDir, days)
  })
  return result ?? refused('sync-in-progress')
}
