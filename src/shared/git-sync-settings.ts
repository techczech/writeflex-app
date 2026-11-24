export const SYNC_VAULTS_KEY = 'sync.vaults'
/** Off by default (24 Nov 2026): Git vault sync is not yet proven between two Macs. Read once at launch: while off,
 *  none of its code is wired (git-sync-app registerSyncOff); the Sync tab shows only the remote-copy status. */
export const EXPERIMENTAL_GIT_SYNC_KEY = 'experimental.gitVaultSync'
export const experimentalGitSyncOn = (value: unknown): boolean => value === true
export const EXPERIMENTAL_GIT_SYNC_OFF = 'Vault sync with Git is switched off (experimental). Switch it on in Settings › Advanced; it takes effect the next time WriteFlex starts.'
export type SyncVaultPreference = { enabled: boolean; wait: 1 | 3 | 10; path?: string }
export function syncVaultPreferences(raw: unknown): Record<string, SyncVaultPreference> {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([id,v]: [string, any]) => /^[a-f0-9]{64}$/.test(id) && v && typeof v.enabled === 'boolean' && [1,3,10].includes(v.wait))) as Record<string, SyncVaultPreference>
  } catch { return {} }
}
export function syncPreferenceKey(key: string): { id: string; field: 'enabled' | 'wait' } | null {
  const enabled = /^git-vault-sync\.enabled\.([a-f0-9]{64})$/.exec(key)
  const wait = /^git-sync\.wait\.([a-f0-9]{64})$/.exec(key)
  return enabled ? {id:enabled[1]!,field:'enabled'} : wait ? {id:wait[1]!,field:'wait'} : null
}
export function migratedSyncPreferences(values: Record<string, unknown>): string | undefined {
  const out = syncVaultPreferences(values[SYNC_VAULTS_KEY])
  for (const [key,value] of Object.entries(values)) {
    const ref = syncPreferenceKey(key); if (!ref) continue
    const entry = out[ref.id] ?? {enabled:false,wait:3}
    if (ref.field === 'enabled' && typeof value === 'boolean') entry.enabled = value
    if (ref.field === 'wait' && [1,3,10].includes(Number(value))) entry.wait = Number(value) as 1|3|10
    out[ref.id] = entry
  }
  return Object.keys(out).length ? JSON.stringify(out) : undefined
}
