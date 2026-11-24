import { DEFAULT_THEME, THEME_SETTING } from './appearance'
import { EXPERIMENTAL_GIT_SYNC_KEY, SYNC_VAULTS_KEY, migratedSyncPreferences } from './git-sync-settings'
// WriteFlex's settings schema (the shared Settings window, export and import, `writeflex settings`) and
// the bridge from the file WriteFlex used before shared settings.
//
// Before: userData/settings.json (src/main/settings.ts) held the preferences in `values` beside the
// app's state (recents, pins, favourites, export presets, the Example collection, the model defaults,
// the guide's progress, Counted Collection marks, the action bar's layout). That file stays the app's
// state file and the old version's file. The preferences move to a NEW file, userData/settings-v2.json
// (SETTINGS_V2_FILE), the shared store. Only schema-known, non-secret keys move (settingsFromLegacy).
//
// Keys and sign-ins are never in either file's preferences: they stay in userData/auth.json, and the
// window sees them as slots (connected or missing) only.
//
// Pure: no Electron, no node:, so main, the Settings window, the CLI and tests share it.
import { checkValue, defineSchema, type Migrated, type SettingDef, type SettingValue } from '@app-patterns/settings'
import { DEFAULT_TYPING_SCHEME } from './sound-pack'
import { APP_KEYS_SETTING, LEGACY_OVERRIDES_KEY, appKeysError, parseOverrideJson, splitOverrides } from './keymap-overrides'

export const APP_ID = 'writeflex'
export const APP_NAME = 'WriteFlex'
/** The shared store's file, beside the old settings.json (which it never replaces). */
export const SETTINGS_V2_FILE = 'settings-v2.json'

const on = (key: string, label: string, section: string, group: string, help?: string, dflt = true): SettingDef =>
  ({ key, label, section, group, type: 'toggle', default: dflt, ...(help ? { help } : {}) })

const choice = (key: string, label: string, section: string, group: string, options: [SettingValue, string][], dflt: SettingValue, help?: string): SettingDef =>
  ({ key, label, section, group, type: 'choice', default: dflt, options: options.map(([value, l]) => ({ value, label: l })), ...(help ? { help } : {}) })

const HEX_OR_PRESET = /^(terracotta|amber|green|blue|lilac|grey|#[0-9a-fA-F]{6})$/
const MODEL_REF = /^[a-z0-9][a-z0-9._-]*::\S{1,200}$/

/** The model the agent uses, written `provider::model id`, or '' for the app's own default. */
export function modelRefError(v: SettingValue): string | null {
  if (v === '') return null
  return typeof v === 'string' && MODEL_REF.test(v) ? null : 'Write the model as provider::model, for example openai-codex::gpt-5.5'
}

/**
 * Settings that name something to run, somewhere to send data, or a folder that becomes a code or data
 * path are `importable: false` (set on this Mac only). In WriteFlex that is the Diary folder: sessions
 * are written into it. There is no other path, endpoint or program among WriteFlex's settings, so no
 * pair of folders can overlap.
 */
export const THIS_MAC_ONLY: ReadonlySet<string> = new Set(['diary.folder'])

export const schema = defineSchema({
  app: APP_ID,
  sections: [
    { id: 'assistant', label: 'Assistant', icon: 'bot' },
    { id: 'writing', label: 'Writing', icon: 'pen-line' },
    { id: 'focus', label: 'Focus', icon: 'focus' },
    { id: 'read-aloud', label: 'Read aloud', icon: 'volume-2' },
    { id: 'sounds', label: 'Sounds', icon: 'music' },
    { id: 'reading-room', label: 'Reading Room', icon: 'book-open' },
    { id: 'diary', label: 'Diary', icon: 'notebook-pen' },
    { id: 'history', label: 'Saving and history', icon: 'history' },
    { id: 'advanced', label: 'Advanced', icon: 'wrench' },
    { id: 'scratchpad', label: 'Scratchpad', icon: 'clipboard' },
  ],
  settings: [
    { key: SYNC_VAULTS_KEY, label: 'Git vault sync preferences', section: 'history', group: 'Git sync', type: 'text', default: '{}', importable: false, help: 'Per-vault preferences on this Mac. Use the Git sync page or Change in the vault’s Sync tab.' },
    // ---- General / Appearance (All apps) ----
    on('integration.browserLinks', 'Open writeflex:// links from the browser', 'general', 'Links', 'Links of the form writeflex://open?… in a browser or another app open the document here.'),
    on('workspace.watchExternalChanges', 'Watch for external changes', 'general', 'Collections', 'Reflect edits made by other agents and apps in an open Collection.'),
    on('statusBar.showPlace', 'Show where you are in the status bar', 'general', 'Status bar'),
    on('chrome.actionBarVisible', 'Show the action bar', 'general', 'Action bar'),
    choice(THEME_SETTING, 'Theme', 'appearance', 'Theme', [['light', 'Light'], ['dark', 'Dark'], ['system', 'Match system']], DEFAULT_THEME),

    on('updates.checkForNewVersions', 'Check for new versions', 'general', 'Updates'),
    on('updates.alphaVersions', 'Include alpha versions', 'general', 'Updates', undefined, false),
    on('scratchpad.talkweaver', 'Browse TalkWeaver vaults', 'scratchpad', 'Sources', undefined, false),
    on('scratchpad.slidewell', 'Search SlideWell', 'scratchpad', 'Sources', undefined, false),
    { key: 'scratchpad.talkweaverVaults', label: 'TalkWeaver vaults', section: 'scratchpad', group: 'Sources', type: 'text', default: '', importable: false },
    // ---- Assistant ----
    { key: 'agent.model', label: 'Model', section: 'assistant', group: 'Model', type: 'text', default: '', validate: modelRefError, help: 'The model used for suggestions and housekeeping, written provider::model. Empty means WriteFlex’s default. The Model page lists the models you can use.' },
    choice('agent.thinkingLevel', 'Thinking', 'assistant', 'Model', [['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], 'medium'),
    on('permissions.proseEdits', 'Propose prose edits', 'assistant', 'What the agent may do', 'Always staged as suggestions.'),
    on('permissions.createFiles', 'Create files', 'assistant', 'What the agent may do'),
    on('permissions.renameFiles', 'Rename and move files', 'assistant', 'What the agent may do'),
    on('permissions.readWorkspace', 'Search and read the Collection', 'assistant', 'What the agent may do'),

    // ---- Writing ----
    choice('editor.viewMode', 'View mode', 'writing', 'Editor', [['clean', 'Clean'], ['markup', 'Markup'], ['raw', 'Raw']], 'clean'),
    choice('editor.lineWidth', 'Line width', 'writing', 'Editor', [['narrow', 'Narrow'], ['medium', 'Medium'], ['wide', 'Wide']], 'medium'),
    choice('editor.proseSize', 'Prose size', 'writing', 'Editor', [['', 'Standard'], ['17', '17'], ['19', '19'], ['21', '21']], ''),
    on('editor.spellcheck', 'Check spelling', 'writing', 'Editor'),

    // ---- Focus ----
    on('editor.typewriter', 'Typewriter mode', 'focus', 'Typewriter', 'Keep the line you are writing at a fixed height. The handle fades after 30 seconds of inactivity and returns when you move near the left edge or focus it with the keyboard.', false),
    { key: 'editor.fixedLine', label: 'Fixed line position', section: 'focus', group: 'Typewriter', type: 'number', default: 0.33, min: 0.1, max: 0.9, help: 'How far down the window the typewriter line sits: 0.33 is the top third, 0.5 the middle, 0.67 the lower third.' },
    choice('editor.focusMode', 'Focus mode', 'focus', 'Focus mode', [['', 'Off'], ['fade', 'Fade'], ['sentence', 'Sentence'], ['segment', 'Segment'], ['breakup', 'Breakup'], ['anchored', 'Anchored']], ''),
    choice('editor.leadStyle', 'Anchored lead-in style', 'focus', 'Focus mode', [['bold', 'Bold'], ['colour', 'Colour'], ['contrast', 'Contrast']], 'contrast'),
    on('editor.lineFocus.on', 'Line focus', 'focus', 'Line focus', undefined, false),
    choice('editor.lineFocus.size', 'Lines in focus', 'focus', 'Line focus', [[1, '1 line'], [3, '3 lines'], [5, '5 lines']], 3),
    choice('editor.lineFocus.dim', 'Dim the rest', 'focus', 'Line focus', [['light', 'Light'], ['medium', 'Medium'], ['dark', 'Dark']], 'medium'),
    choice('editor.lineFocus.follow', 'Line focus follows', 'focus', 'Line focus', [['cursor', 'Cursor'], ['typewriter', 'Typewriter'], ['read-aloud', 'Read-aloud'], ['by-hand', 'By hand']], 'cursor'),
    on('editor.ruler.on', 'Reading ruler', 'focus', 'Reading ruler', undefined, false),
    choice('editor.ruler.covers', 'Ruler covers', 'focus', 'Reading ruler', [['thin', 'Thin rule'], ['1', '1 line'], ['3', '3 lines'], ['5', '5 lines'], ['below', 'All below']], '3'),
    { key: 'editor.ruler.opacity', label: 'Ruler opacity', section: 'focus', group: 'Reading ruler', type: 'number', default: 35, min: 10, max: 100, unit: '%' },
    choice('editor.ruler.follow', 'Ruler follows', 'focus', 'Reading ruler', [['cursor', 'Cursor'], ['typewriter', 'Typewriter'], ['read-aloud', 'Read-aloud'], ['by-hand', 'By hand']], 'cursor'),

    // ---- Read aloud ----
    { key: 'readAloud.voiceURI', label: 'Voice', section: 'read-aloud', group: 'Voice', type: 'text', default: '', help: 'Empty means the system voice. The Voice page lists the voices on this Mac.' },
    { key: 'readAloud.rate', label: 'Default speed', section: 'read-aloud', group: 'Voice', type: 'number', default: 1, min: 0.5, max: 2.5, unit: '×' },
    choice('readAloud.scrollMode', 'Scrolling while reading', 'read-aloud', 'Reading', [['typewriter', 'Typewriter'], ['page', 'Page']], 'typewriter'),
    { key: 'readAloud.colour', label: 'Highlight colour', section: 'read-aloud', group: 'Highlight', type: 'text', default: 'terracotta', validate: (v) => (typeof v === 'string' && HEX_OR_PRESET.test(v) ? null : 'Use terracotta, amber, green, blue, lilac, grey or a colour like #c46242'), help: 'A preset (terracotta, amber, green, blue, lilac, grey) or a colour written #rrggbb.' },
    choice('readAloud.strength', 'Highlight strength', 'read-aloud', 'Highlight', [['soft', 'Soft'], ['medium', 'Medium'], ['strong', 'Strong']], 'medium'),

    // ---- Sounds ----
    on('sounds.typing.enabled', 'Typing sounds', 'sounds', 'Typing', 'Mechanical typewriter recordings with distinct sounds for keys, Space, Return and Backspace.', false),
    choice('sounds.typing.scheme', 'Typewriter', 'sounds', 'Typing', [['deep', 'Classic manual'], ['crisp', 'Crisp'], ['soft', 'Soft']], DEFAULT_TYPING_SCHEME,
      'Classic manual: Hermes Precisa 305, with a bell on Return. Crisp: brighter key strikes, with a ratchet on Return. Soft: damped manual keys and a quiet carriage return. Recordings by Joseph Sardin, _stubb and knufds (CC0). Full credits ship in resources/sounds/CREDITS.md.'),
    { key: 'sounds.typing.volume', label: 'Typing volume', section: 'sounds', group: 'Typing', type: 'number', default: 0.6, min: 0, max: 1 },
    on('sounds.ambient.enabled', 'Ambient sound', 'sounds', 'Ambient', 'Bundled background loops by jackthemurray (CC0) and cori (public domain). Full credits ship in resources/sounds/CREDITS.md.', false),
    choice('sounds.ambient.loop', 'Ambient sound', 'sounds', 'Ambient', [['white', 'Warm noise'], ['rain', 'Rain']], 'white'),
    { key: 'sounds.ambient.volume', label: 'Ambient volume', section: 'sounds', group: 'Ambient', type: 'number', default: 0.35, min: 0, max: 1 },

    // ---- Reading Room ----
    choice('readingRoom.side', 'Reading Room side', 'reading-room', 'Reading Room', [['left', 'Left'], ['right', 'Right']], 'left'),

    // ---- Diary ----
    { key: 'diary.folder', label: 'Diary folder', section: 'diary', group: 'Diary', type: 'path', default: '', importable: false, help: 'One diary, designated once: sessions land here from every Counted Collection. Set on this Mac only: an imported settings file never changes it.' },
    on('diary.tick', 'Tick while a session runs', 'diary', 'Sessions'),

    // ---- Saving and history ----
    choice('snapshots.frequency', 'Checkpoints around agent edits', 'history', 'Checkpoints', [['every', 'On'], ['manual', 'Off']], 'every'),
    choice('snapshots.retention', 'Keep history for', 'history', 'History', [['30', '30 days'], ['90', '90 days'], ['forever', 'Forever']], 'forever'),

    // ---- Advanced ----
    on(EXPERIMENTAL_GIT_SYNC_KEY, 'Vault sync with Git (experimental)', 'advanced', 'Experimental', 'Lets a vault send its changes to its Git repository and bring in changes from your other Macs. Not yet proven between two Macs. While off, WriteFlex sends and receives nothing. Takes effect the next time WriteFlex starts.', false),
    { key: APP_KEYS_SETTING, label: 'Keys kept by WriteFlex itself', section: 'advanced', group: 'Keyboard', type: 'text', default: '', importable: false, validate: appKeysError, help: 'Shortcuts the Shortcuts page cannot hold: keys inside the Plan and lists, and keys from an older WriteFlex the shared shortcuts refuse. Written as {"command": "chord"}.' },

    // ---- Accounts and keys (slots; the values are never in this file) ----
    { key: 'accounts.chatgpt', label: 'ChatGPT', section: 'accounts', group: 'Model providers', type: 'secret', default: null, help: 'Your ChatGPT sign-in, for the OpenAI models. Sign in on the Sign in page.' },
    { key: 'accounts.anthropic', label: 'Anthropic API key', section: 'accounts', group: 'Model providers', type: 'secret', default: null },
    { key: 'accounts.zai', label: 'Z.ai API key', section: 'accounts', group: 'Model providers', type: 'secret', default: null },
  ],
})

for (const key of THIS_MAC_ONLY) if (schema.def(key)?.importable !== false) throw new Error(`${key} must be importable: false`)

/** The slot ids and the auth provider each fronts. */
export const SLOT_PROVIDERS: Readonly<Record<string, string>> = {
  'accounts.chatgpt': 'openai-codex',
  'accounts.anthropic': 'anthropic',
  'accounts.zai': 'zai',
}
export const ACCOUNT_SLOTS: ReadonlySet<string> = new Set(['accounts.chatgpt'])

// ---------------------------------------------------------------------------------------------
// From the old settings.json
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>
const isRec = (x: unknown): x is Rec => Boolean(x) && typeof x === 'object' && !Array.isArray(x)

/** A legacy value in the shape the schema takes (the old file kept some numbers as strings and the reverse). */
export function coerceLegacy(key: string, value: unknown): unknown {
  const def = schema.def(key)
  if (!def) return value
  if (key === 'sounds.typing.scheme' && value === 'typewriter') return 'deep' // the value written before there were three
  if (def.type === 'number' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  if (def.type === 'choice' && def.options) {
    const match = def.options.find((o) => o.value === value || String(o.value) === String(value))
    if (match) return match.value
  }
  return value
}

/** Whether the store would take `value` for `key` (refused values are retried on later migrations). */
export function acceptedValue(key: string, value: unknown): boolean {
  const def = schema.def(key)
  return Boolean(def && def.type !== 'secret' && checkValue(def, value) === null)
}

/** The keys of the old file the migration reads: every schema preference, and the old shortcut overrides. */
export function legacyPreferenceKeys(): string[] {
  return [...schema.settings.filter((d) => d.type !== 'secret' && d.key !== APP_KEYS_SETTING).map((d) => d.key), LEGACY_OVERRIDES_KEY]
}

/**
 * The old file's preferences by key, coerced: only schema-known, non-secret keys and the shortcut
 * overrides. No size cap. The old top-level model defaults supply only absent assistant preference keys.
 * Other app state (recents, pins and the rest) is not taken.
 */
export function preferencesFromLegacy(file: unknown): Rec {
  const values = isRec(file) && isRec(file['values']) ? file['values'] : {}
  const out: Rec = {}
  const sync = migratedSyncPreferences(values)
  if (sync) out[SYNC_VAULTS_KEY] = sync
  for (const key of legacyPreferenceKeys()) {
    if (!Object.hasOwn(values, key)) continue
    const v = values[key]
    if (v === null || v === undefined) continue
    out[key] = key === LEGACY_OVERRIDES_KEY ? v : coerceLegacy(key, v)
  }
  const defaults = isRec(file) && isRec(file['modelDefaults']) ? file['modelDefaults'] : {}
  if (!Object.hasOwn(values, 'agent.model') && typeof defaults['modelId'] === 'string') {
    const provider = typeof defaults['provider'] === 'string' ? defaults['provider'] : 'openai-codex'
    out['agent.model'] = `${provider}::${defaults['modelId']}`
  }
  if (!Object.hasOwn(values, 'agent.thinkingLevel') && defaults['thinkingLevel'] !== undefined) {
    out['agent.thinkingLevel'] = defaults['thinkingLevel']
  }
  return out
}

/** Marks the hand-over file the migration writes for the store (a new settings-v2.json the store then rewrites as its own). */
export const LEGACY_MARK = 'writeflex-legacy-preferences'

/** The hand-over for a first migration: values the store accepts, and the shortcut overrides split in two. */
export function handOverFor(prefs: Rec): { [LEGACY_MARK]: 1; settings: Rec; keys: Record<string, string> } {
  const settings: Rec = {}
  for (const [key, value] of Object.entries(prefs)) {
    if (key === LEGACY_OVERRIDES_KEY) continue
    if (acceptedValue(key, value)) settings[key] = value
  }
  const split = splitOverrides(parseOverrideJson(prefs[LEGACY_OVERRIDES_KEY]))
  if (split.appKeys) settings[APP_KEYS_SETTING] = split.appKeys
  return { [LEGACY_MARK]: 1, settings, keys: split.keys }
}

/**
 * The store's migrate hook: reads the hand-over back. Anything else that is not a settings file is not
 * WriteFlex's: null, so the store sets it aside as damaged. Secrets are never taken.
 */
export function migrateLegacy(old: unknown): Migrated | null {
  if (!isRec(old) || old[LEGACY_MARK] !== 1 || !isRec(old['settings'])) return null
  const settings: Rec = {}
  for (const [k, v] of Object.entries(old['settings'])) if (schema.def(k) && schema.def(k)?.type !== 'secret') settings[k] = v
  const keys: Record<string, string> = {}
  if (isRec(old['keys'])) for (const [k, v] of Object.entries(old['keys'])) if (typeof v === 'string') keys[k] = v
  return { settings: settings as Migrated['settings'], keys }
}
