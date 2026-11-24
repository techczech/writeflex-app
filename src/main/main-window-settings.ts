import type { SettingsStore, SettingValue } from './settings'

/** Enumerated from App.tsx, its line-overlay chooser and the theme commands. */
export const MAIN_WINDOW_PREFERENCE_KEYS: ReadonlySet<string> = new Set([
  'updates.checkForNewVersions', 'agent.mode',
  'appearance.theme', 'chrome.actionBarVisible', 'chrome.actionBarItems',
  'editor.typewriter', 'editor.fixedLine', 'editor.focusMode', 'editor.leadStyle',
  'editor.viewMode', 'editor.proseSize', 'editor.lineWidth',
  'editor.lineFocus.on', 'editor.lineFocus.size', 'editor.lineFocus.dim', 'editor.lineFocus.follow',
  'editor.ruler.on', 'editor.ruler.covers', 'editor.ruler.opacity', 'editor.ruler.follow',
  'readAloud.voiceURI', 'readAloud.colour', 'readAloud.rate',
  'sounds.typing.enabled', 'sounds.ambient.enabled', 'diary.tick',
])

export function requireMainWindowPreference(key: string): void {
  if (!MAIN_WINDOW_PREFERENCE_KEYS.has(key)) throw new Error('Change this setting in the Settings window.')
}

/** A failed save publishes the persisted value as a rollback before returning the error. */
export async function writeMainWindowPreference(
  settings: SettingsStore,
  input: { key: string; value: SettingValue | null; label: string; log?: boolean },
  changed: (key: string) => void,
): Promise<{ value: SettingValue | null; changelog: ReturnType<SettingsStore['changelog']> }> {
  requireMainWindowPreference(input.key)
  try { await settings.setPersisted(input.key, input.value, input.label, { log: input.log !== false }) }
  finally { changed(input.key) }
  return { value: settings.get(input.key), changelog: settings.changelog() }
}

/** The legacy capability needed by the shared update controls; no arbitrary app-state writes. */
export function requireSettingsPagePreference(input: unknown): { key: string; value: boolean } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid setting.')
  const { key, value } = input as Record<string, unknown>
  if ((key !== 'updates.checkForNewVersions' && key !== 'updates.alphaVersions') || typeof value !== 'boolean') throw new Error('Change this preference through the shared Settings bridge.')
  return { key, value }
}
