/**
 * Whether a known root (a pin or a recent) is a vault, for the vault switcher (vaults ticket 06): the
 * vault's name from its `.writeflex/vault.json`, and its work count from the vault index snapshot in app
 * userData when one was saved, else null (`—`).
 *
 * Read-only by construction: it reads two files and stats a folder. It never creates anything in the
 * root, and it does not go through the vault store (vault-store.ts), whose per-root memory of the last
 * bytes decides which changes are told as outside changes; a read from here must not move that memory.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { inProgressCount, settingsFromRaw } from '../shared/vault'
import type { RootPresence } from '../shared/vault-switcher'
import { vaultSnapshotPath } from './vault-index-service'

const VAULT_FILE = join('.writeflex', 'vault.json')

export type VaultPresenceOptions = {
  /** The vault index snapshots folder (`<userData>/vault-index`), or null for no work counts. */
  cacheDir: string | null
}

/** The works a saved snapshot holds for `root`, or null when there is none or it cannot be read. */
export async function cachedWorks(cacheDir: string | null, root: string): Promise<Array<{ status: string | null }> | null> {
  if (!cacheDir) return null
  try {
    const parsed: unknown = JSON.parse(await readFile(vaultSnapshotPath(cacheDir, root), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as { root?: unknown; index?: { works?: unknown } }
    if (record.root !== root || !Array.isArray(record.index?.works)) return null
    return (record.index.works as Array<{ status?: unknown }>).map((w) => ({ status: typeof w?.status === 'string' ? w.status : null }))
  } catch {
    return null
  }
}

/** The work count a saved snapshot holds for `root`, or null when there is none or it cannot be read. */
export async function cachedWorkCount(cacheDir: string | null, root: string): Promise<number | null> {
  return (await cachedWorks(cacheDir, root))?.length ?? null
}

/** A vault's start-screen figures from its vault file and saved snapshot (read-only); null when `root` is no vault. */
export async function vaultFigures(root: string, cacheDir: string | null): Promise<{ name: string; works: number | null; inProgress: number | null } | null> {
  let bytes: string
  try {
    bytes = await readFile(join(root, VAULT_FILE), 'utf8')
  } catch {
    return null
  }
  let raw: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(bytes)
    if (value && typeof value === 'object' && !Array.isArray(value)) raw = value as Record<string, unknown>
  } catch { /* named after its folder, as rootPresence does */ }
  const settings = settingsFromRaw(raw, basename(root))
  const works = await cachedWorks(cacheDir, root)
  return { name: settings.name, works: works?.length ?? null, inProgress: works ? inProgressCount(works, settings.statusMap) : null }
}

/** What `root` is now: a vault (name, cached count), a plain folder, or gone. */
export async function rootPresence(root: string, options: VaultPresenceOptions): Promise<RootPresence> {
  try {
    if (!(await stat(root)).isDirectory()) return { kind: 'missing' }
  } catch {
    return { kind: 'missing' }
  }
  let bytes: string
  try {
    bytes = await readFile(join(root, VAULT_FILE), 'utf8')
  } catch {
    return { kind: 'folder' }
  }
  let raw: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(bytes)
    if (value && typeof value === 'object' && !Array.isArray(value)) raw = value as Record<string, unknown>
  } catch { /* an unreadable file still makes the root a vault, named after its folder (vault-store.ts rule) */ }
  return { kind: 'vault', name: settingsFromRaw(raw, basename(root)).name, works: await cachedWorkCount(options.cacheDir, root) }
}

/** Presence for many roots at once (the switcher's whole list). */
export async function rootPresences(roots: readonly string[], options: VaultPresenceOptions): Promise<Map<string, RootPresence>> {
  const entries = await Promise.all(roots.map(async (root) => [root, await rootPresence(root, options)] as const))
  return new Map(entries)
}
