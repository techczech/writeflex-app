// Renderer-only choice labels; the persisted schema and its validation stay authoritative in main.
import type { Schema, SettingDef, SettingValue, SettingsState } from '@app-patterns/settings'
import { schema } from '../../shared/settings-schema'
import { TASK_GROUPS } from './commands/command-task-groups'
import { FIXED_LINE_PRESETS, FIXED_LINE_PRESET_LABELS, fixedLineCustomLabel } from './editor/fixed-line'
import { groupReadAloudVoices, type SpeechVoiceInfo } from './editor/speech-engine'
import { bridleIdOf, registry } from '../../shared/bridle-commands'
import { APP_KEYS_SETTING, appKeysStateError, effectiveBindings, parseOverrideJson } from '../../shared/keymap-overrides'

// Shortcuts uses the same ten task groups and order as the palette and the cheat sheet.
const shortcutRegistry = {
  ...registry,
  defs: TASK_GROUPS.flatMap(group => registry.defs.flatMap(def => {
    if (def.group === group) return [def]
    if (def.group === 'App' && group === 'Set up WriteFlex') return [{ ...def, group }]
    return []
  })),
}

/** Read-only projection for the shared UI; migrated bare keys cannot be written into its persisted keys map. */
export function settingsShortcutDisplay(state: SettingsState) {
  const appKeys = state.settings[APP_KEYS_SETTING]
  const migrated = Object.keys(parseOverrideJson(appKeys))
  if (!migrated.length || appKeysStateError(state.keys, appKeys)) return { state, registry: shortcutRegistry }
  const bindings = effectiveBindings(state.keys, appKeys)
  const keys = { ...Object.fromEntries(migrated.map(id => [bridleIdOf(id), bindings[bridleIdOf(id)]])), ...state.keys }
  return {
    state: { ...state, keys },
    registry: {
      ...shortcutRegistry,
      // Only this snapshot's display map may include the migration-only bare bindings. Recorder
      // validation and every write still use the authoritative registry and main-process policy.
      resolveBindings: (overrides?: Record<string, string>) => overrides === keys
        ? { bindings, rejected: [] } : registry.resolveBindings(overrides),
    },
  }
}

export function settingsDisplaySchema(state: SettingsState, voices: SpeechVoiceInfo[]): Schema {
  const { featured, other } = groupReadAloudVoices(voices)
  const labels = new Map<string, Map<SettingValue, string>>([
    ['readAloud.voiceURI', new Map([['', 'System voice'], ...[...featured, ...other].map(v => [v.uri, v.name] as [string, string])])],
    ['editor.fixedLine', new Map(Object.entries(FIXED_LINE_PRESETS).map(([key, value]) => [value, FIXED_LINE_PRESET_LABELS[key as keyof typeof FIXED_LINE_PRESETS]]))],
  ])
  for (const [key, options] of labels) {
    const value = state.settings[key]
    if (value === null || value === undefined || options.has(value)) continue
    options.set(value, key === 'editor.fixedLine' && typeof value === 'number' ? fixedLineCustomLabel(value) : String(value))
  }
  const settings = schema.settings.map((def): SettingDef => {
    const options = labels.get(def.key)
    return options ? { ...def, type: 'choice', options: [...options].map(([value, label]) => ({ value, label })) } : def
  })
  const byKey = new Map(settings.map(def => [def.key, def]))
  return { ...schema, sections: schema.sections.filter(s => s.id !== 'about'), settings, def: key => byKey.get(key) }
}
