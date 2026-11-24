// Refuse damaged files before Bridle's optional recovery can archive or replace them.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { commandsAdapter, loadState } from '@app-patterns/settings'
import { MAX_FILE_BYTES, type SettingsFile } from '@app-patterns/settings/node'
import { APP_KEYS_SETTING, appKeysStateError } from '../shared/keymap-overrides'
import { registry } from '../shared/bridle-commands'
import { migrateLegacy, schema } from '../shared/settings-schema'

export const MIGRATION_STAMP_FILE = 'settings-v2-migration.json'
export const MISSING_STORE_MESSAGE = 'settings-v2.json is missing after migration; preferences are read-only. Restore the shared settings file. To start fresh, close WriteFlex, move settings-v2-migration.json aside, then reopen WriteFlex to migrate settings.json again.'

/** Bridle SettingsStore's acceptance probe, using its exported loader and exact byte limit. */
export function settingsFileProblem(raw: unknown, bytes: number, version: string): string | null {
  if (bytes > MAX_FILE_BYTES) return 'settings-v2.json exceeds the settings file size limit'
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'settings-v2.json cannot be read as settings'
  const loaded = loadState(raw, {
    schema, commands: commandsAdapter(registry), appVersion: version, migrate: migrateLegacy,
    now: () => 0, newId: () => 'probe',
  })
  if (loaded.problem === 'other-app') return 'settings-v2.json belongs to another app'
  if (loaded.problem === 'newer-version') return 'settings-v2.json is from a newer settings version'
  if (invalidStoredAppKeys(raw)) return 'settings-v2.json contains invalid migrated shortcuts; it was left untouched'
  return loaded.problem === 'not-settings' ? 'settings-v2.json cannot be read as settings' : null
}

function invalidStoredAppKeys(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const state = raw as { settings?: Record<string, unknown>; keys?: Record<string, string> }
  if (!state.settings || !Object.hasOwn(state.settings, APP_KEYS_SETTING)) return false
  return Boolean(appKeysStateError(state.keys ?? {}, state.settings[APP_KEYS_SETTING]))
}

const guarded = new WeakSet<SettingsFile>()

/**
 * SettingsFile.update calls the public read() under its lock BEFORE deciding to set aside damage.
 * Convert damage to a refusal at that boundary, for writes and reloads alike. No vendor fork.
 */
export function guardSettingsFile(file: SettingsFile): void {
  if (guarded.has(file)) return
  guarded.add(file)
  const read = file.read.bind(file)
  file.read = async () => {
    const result = await read()
    if (result.kind === 'ok' && invalidStoredAppKeys(result.raw)) return { kind: 'refused', error: 'settings-v2.json contains invalid migrated shortcuts; it was left untouched.' }
    if (result.kind === 'damaged') return { kind: 'refused', error: 'settings-v2.json is damaged; preferences are read-only and the file was left untouched.' }
    if (result.kind === 'missing' && existsSync(join(dirname(file.path), MIGRATION_STAMP_FILE))) {
      return { kind: 'refused', error: MISSING_STORE_MESSAGE }
    }
    return result
  }
}
