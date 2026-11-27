// Shared preferences can be available or explicitly read-only. Refused files are never opened.
import { emptyState, exportFile, commandsAdapter, previewImport, type SettingValue, type SettingsState } from '@app-patterns/settings'
import type { SettingsStoreLike } from '@app-patterns/settings-electron'
import { SharedSettingsStore } from './shared-settings-store'
import { runMigration, storeOptions, type MigrationOutcome, type MigrationOptions } from './settings-migration'
import { schema, APP_ID, acceptedValue, coerceLegacy, preferencesFromLegacy } from '../shared/settings-schema'
import { APP_KEYS_SETTING, LEGACY_OVERRIDES_KEY, overridesValueFromStore, splitOverrides, parseOverrideJson } from '../shared/keymap-overrides'
import { SYNC_VAULTS_KEY } from '../shared/git-sync-settings'
import { registry } from '../shared/bridle-commands'
import type { SettingsStore as LegacyStore, SharedPreferences } from './settings'

export type PreferenceStore = SettingsStoreLike & { close(): Promise<void> }
export type SharedSettings = {
  store: PreferenceStore
  active: boolean
  migration: MigrationOutcome
  onPreferencesChanged(listener: (keys: string[]) => void): void
  onStoreChanged(listener: (state: SettingsState) => void): void
  close(): Promise<void>
}

export async function openPreferences(legacy: LegacyStore, dir: string, version: string, log: (line: string) => void, migrationOptions: MigrationOptions = {}): Promise<SharedSettings> {
  const migration = await runMigration(dir, version, { ...migrationOptions, log })
  const listeners: ((keys: string[]) => void)[] = []
  const storeListeners: ((state: SettingsState) => void)[] = []
  const owns = (key: string): boolean => key === LEGACY_OVERRIDES_KEY || Boolean(schema.def(key))
  let store: PreferenceStore
  let active = false
  const unavailable = migration.kind === 'unreadable' || migration.kind === 'refused' || migration.kind === 'not-saved'
  if (unavailable) {
    const reason = `WriteFlex preferences are read-only: ${'reason' in migration ? migration.reason : 'the new settings file could not be saved'}. Open Settings to see the store problem.`
    log(`[settings] ${reason}`)
    const legacyValues = legacy.values()
    const values = { ...legacyValues }
    for (const [key, raw] of Object.entries(preferencesFromLegacy({ values: legacyValues, modelDefaults: legacy.legacyModelDefaults() }))) {
      const value = coerceLegacy(key, raw)
      if (acceptedValue(key, value)) values[key] = value as SettingValue
    }
    const state = emptyState(APP_ID)
    for (const [key, raw] of Object.entries(values)) {
      const value = coerceLegacy(key, raw)
      if (acceptedValue(key, value)) state.settings[key] = value as SettingValue
    }
    const split = splitOverrides(parseOverrideJson(values[LEGACY_OVERRIDES_KEY]))
    state.keys = split.keys
    if (split.appKeys) state.settings[APP_KEYS_SETTING] = split.appKeys
    const safeOverrides = overridesValueFromStore(split.keys, split.appKeys)
    if (safeOverrides) values[LEGACY_OVERRIDES_KEY] = safeOverrides
    else delete values[LEGACY_OVERRIDES_KEY]
    const refused = async () => ({ ok: false as const, code: 'refused' as const, error: reason })
    store = {
      view: () => structuredClone(state),
      problem: () => ({ code: 'refused', error: reason }),
      set: refused,
      reset: refused,
      rebind: refused,
      rebindMany: refused,
      resetSection: refused,
      resetAll: refused,
      resetEntry: refused,
      undoBatch: refused,
      applyImport: refused,
      recordSecret: refused,
      previewImport: (file, apply) => previewImport(state, file, { schema, commands: commandsAdapter(registry), apply }),
      exportFile: (opts) => exportFile(state, { appVersion: version, now: Date.now(), schema, commands: commandsAdapter(registry), ...opts }),
      close: async () => {},
    }
    legacy.attachShared({
      owns,
      get: (key) => values[key] ?? null,
      values: () => Object.fromEntries(Object.entries(values).filter(([key]) => owns(key))),
      async persist() {
        throw new Error(reason)
      },
    })
  } else {
    let last: SettingsState | null = null
    const writable = new SharedSettingsStore({
      ...storeOptions(dir, version), log,
      onChange: (state) => {
        for (const listener of storeListeners) listener(state)
        const before = last
        last = state
        if (!before) return
        const keys = new Set<string>()
        for (const key of new Set([...Object.keys(before.settings), ...Object.keys(state.settings)])) {
          if (before.settings[key] !== state.settings[key]) keys.add(key)
        }
        if (keys.has(APP_KEYS_SETTING) || JSON.stringify(before.keys) !== JSON.stringify(state.keys)) keys.add(LEGACY_OVERRIDES_KEY)
        if (keys.size) {
          for (const listener of listeners) listener([...keys])
        }
      },
    })
    await writable.ready
    last = writable.view()
    store = writable
    active = !writable.problem()
    const read = (key: string): SettingValue | null => {
      const state = writable.view()
      if (key === LEGACY_OVERRIDES_KEY) return overridesValueFromStore(state.keys, state.settings[APP_KEYS_SETTING]) || null
      return state.settings[key] ?? null
    }
    const shared: SharedPreferences = {
      owns,
      get: read,
      values: () => {
        const overrides = read(LEGACY_OVERRIDES_KEY)
        return { ...writable.view().settings, ...(overrides ? { [LEGACY_OVERRIDES_KEY]: overrides } : {}) }
      },
      async persist(key, value, opts) {
        if (!active) {
          throw new Error(writable.problem()?.error ?? 'WriteFlex preferences are read-only.')
        }
        if (key === LEGACY_OVERRIDES_KEY || key === APP_KEYS_SETTING) {
          throw new Error('Change shortcuts in Settings › Shortcuts.')
        }
        const result = key === SYNC_VAULTS_KEY && opts?.log === false && typeof value === 'string'
          ? await writable.setSyncVaultPreferences(value)
          : value === null ? await writable.reset(key) : await writable.set(key, value)
        if (!result.ok) {
          throw new Error(result.error)
        }
      },
    }
    legacy.attachShared(shared)
  }
  return {
    store,
    active,
    migration,
    onPreferencesChanged: (fn) => { listeners.push(fn) },
    onStoreChanged: (fn) => { storeListeners.push(fn) },
    close: () => store.close(),
  }
}

/** App-layer changes also affect menus when the shared registry's keys are unchanged. */
export function followSharedSettingsMenu(shared: SharedSettings, host: { storeChanged(state: SettingsState): void; rebuildMenu(): void }): void {
  let appKeys = shared.store.view().settings[APP_KEYS_SETTING]
  shared.onStoreChanged((state) => {
    host.storeChanged(state)
    const next = state.settings[APP_KEYS_SETTING]
    if (appKeys !== next) {
      appKeys = next
      host.rebuildMenu()
    }
  })
}
