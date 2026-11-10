/**
 * The one rule for the second names an object file may have in `.writeflex/folio-objects/` (ADR-0052):
 * the object's own crash-orphan temporary names `.<sha256>.<12 hex>.tmp`, in the same folder, that are the
 * same file as the object, and nothing else. Shared by the object store (folio-version-objects.ts) and the
 * backup history projection (src/backup-helper/history-projection.ts), so both judge a link count the same
 * way. Read-only; node:fs only, so the backup helper can import it.
 */
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

type Identity = { dev: number; ino: number }
const sameFile = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino

/**
 * Test seam only: lets a test change the folder at the exact instant between a scan of the temporary
 * names and the step that acts on what the scan found. Unset in production.
 */
export const folioObjectTestHooks: {
  afterTempScan?: (temps: readonly string[]) => Promise<void> | void
  afterOrphanScan?: (temps: readonly string[]) => Promise<void> | void
} = {}
/** The names in the objects folder that are this object's own temporary files and are the same file as `identity`. */
export async function ownTemps(dir: string, sha256: string, identity: Identity): Promise<string[]> {
  const pattern = new RegExp(`^\\.${sha256}\\.[0-9a-f]{12}\\.tmp$`)
  const names = (await readdir(dir).catch(() => [])).filter((name) => pattern.test(name))
  const found: string[] = []
  for (const name of names) {
    const entry = await lstat(join(dir, name)).catch(() => null)
    if (entry && entry.isFile() && sameFile(entry, identity)) found.push(join(dir, name))
  }
  return found
}

/**
 * Every name of the object file is accounted for: the object name itself plus this store's own
 * temporary names for it, nothing else. `entry` is the file as just looked at. A writer may remove its
 * temporary name while we look, so a count that does not add up is looked at again a few times.
 */
export async function onlyOwnNames(dir: string, sha256: string, entry: Identity & { nlink: number }): Promise<boolean> {
  let nlink = entry.nlink
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (nlink === 1) return true
    const temps = await ownTemps(dir, sha256, entry)
    await folioObjectTestHooks.afterTempScan?.(temps)
    const now = await lstat(join(dir, sha256)).catch(() => null)
    if (!now || !now.isFile() || !sameFile(now, entry)) return false
    // The names that justify the extra links are looked at again now, after the count: each must still
    // be the object's own file, and they must account for every extra link exactly.
    let confirmed = 0
    for (const temp of temps) {
      const again = await lstat(temp).catch(() => null)
      if (again && again.isFile() && sameFile(again, entry)) confirmed += 1
    }
    if (now.nlink - 1 === confirmed) return true
    nlink = now.nlink
    await new Promise((resolve) => setImmediate(resolve))
  }
  return false
}

