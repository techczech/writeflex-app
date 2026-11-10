import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs'
/** Main-only access snapshot selection and private child streams. Refresh material has no field here. */
import type { ChildProcess } from 'node:child_process'
import type { Writable } from 'node:stream'
import { frame, validateSnapshot, EXPIRY_MARGIN_MS, MIN_WORK_MS, type CredentialSnapshot } from '../../backup-helper/github-credentials'
export type { CredentialSnapshot, AcceptedBinding } from '../../backup-helper/github-credentials'
export interface ChildVaultBinding { id: string; path: string; github?: { repository: string; repositoryId?: number; credentialMode?: 'host' } }
export interface ChildCredentialInput { snapshot: CredentialSnapshot; vaults: readonly ChildVaultBinding[] }
export function snapshotForChild(input: ChildCredentialInput, now = Date.now()): CredentialSnapshot {
  const snapshot = validateSnapshot(input.snapshot, now)
  const bindings = snapshot.bindings.filter(b => input.vaults.some(v => v.github?.credentialMode === 'host' && b.vaultId === v.id && b.realRoot === v.path && b.repositoryId === v.github.repositoryId && b.credentialPath.replace(/\.git$/, '').toLowerCase() === v.github.repository.toLowerCase()))
  for (const v of input.vaults) if (v.github?.credentialMode === 'host' && !bindings.some(b => b.vaultId === v.id)) throw new Error('GitHub credential binding unavailable')
  return validateSnapshot({ ...snapshot, bindings }, now)
}
export function prepareChildCredentials(input: ChildCredentialInput | null | undefined, now = Date.now()): { bytes: Buffer; runtimeMs: number; generation: number } | null {
  if (!input) return null
  const snapshot = snapshotForChild(input, now)
  const runtimeMs = snapshot.expiresAt - EXPIRY_MARGIN_MS - now
  if (runtimeMs < MIN_WORK_MS) throw new Error('GitHub credential lifetime too short')
  return { bytes: frame(snapshot), runtimeMs, generation: snapshot.generation }
}
export function sendChildCredentials(child: ChildProcess, bytes: Buffer): () => void {
  const snapshot = child.stdio[3] as Writable | null, lifetime = child.stdio[4] as Writable | null
  if (!snapshot || !lifetime) throw new Error('GitHub private streams unavailable')
  snapshot.on('error', () => undefined); lifetime.on('error', () => undefined)
  snapshot.end(bytes)
  return () => { snapshot.destroy(); lifetime.destroy() }
}

/** Bounded read of this trusted config path. Pin both file identity and exact selected bytes. */
function configuration(path: string) {
  const canonical = realpathSync(path)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > 256 * 1024) throw Error('GitHub child configuration refused')
    const buffer = Buffer.alloc(256 * 1024 + 1)
    let size = 0, count: number
    while ((count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) {
      size += count
      if (size > 256 * 1024) throw Error('GitHub child configuration refused')
    }
    const after = fstatSync(fd)
    const identity = (st: typeof before) => `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`
    if (size !== before.size || identity(before) !== identity(after) || realpathSync(path) !== canonical) throw Error('GitHub child configuration changed')
    return { canonical, identity: identity(after), bytes: buffer.subarray(0, size) }
  } finally { closeSync(fd) }
}

/** Bind the provider's selection to the actual child configuration, including the one-shot vault. */
export async function prepareConfiguredCredentials(input: ChildCredentialInput, args: readonly string[], now = Date.now()): Promise<(NonNullable<ReturnType<typeof prepareChildCredentials>> & { configurationCurrent(): boolean }) | null> {
  const at = args.indexOf('--config')
  if (at < 0 || !args[at + 1]) throw new Error('GitHub child configuration unavailable')
  const path = args[at + 1]!, pinned = configuration(path), text = pinned.bytes.toString('utf8')
  if (Buffer.byteLength(text) > 256 * 1024) throw new Error('GitHub child configuration refused')
  const config = JSON.parse(text) as { vaults?: ChildVaultBinding[] }
  if (!Array.isArray(config.vaults)) throw new Error('GitHub child configuration refused')
  const selected = args.indexOf('--vault')
  const vaults = config.vaults.filter(v => selected < 0 || v.id === args[selected + 1])
  if (selected >= 0 && vaults.length !== 1) throw new Error('GitHub child vault refused')
  // The file can narrow the provider's launch intent; accepted account bindings alone cannot widen it.
  const providerIds = new Set(input.vaults.map(v => v.id))
  if (providerIds.size !== input.vaults.length || new Set(vaults.map(v => v.id)).size !== vaults.length) throw new Error('GitHub child vault refused')
  for (const v of vaults) {
    const provider = input.vaults.find(p => p.id === v.id)
    if (v.github?.credentialMode === 'host' || provider?.github?.credentialMode === 'host') {
      if (!provider || provider.path !== v.path || provider.github?.credentialMode !== v.github?.credentialMode || provider.github?.repositoryId !== v.github?.repositoryId || provider.github?.repository.toLowerCase() !== v.github?.repository.toLowerCase()) throw new Error('GitHub child vault refused')
    }
  }
  const prepared = prepareChildCredentials({ snapshot: input.snapshot, vaults }, now)
  return prepared && { ...prepared, configurationCurrent() {
    try {
      const current = configuration(path)
      return current.canonical === pinned.canonical && current.identity === pinned.identity && current.bytes.equals(pinned.bytes)
    } catch { return false }
  } }
}
