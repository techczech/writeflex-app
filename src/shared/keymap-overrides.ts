// The renderer's shortcut overrides (`shortcuts.overrides`: renderer command id → display chord, '' =
// removed on purpose; commands/chords.ts) and where they are kept since shared settings: the settings
// store, in two places.
//
//   - A command the registry may rebind (not fixed, no scope) whose new key is a chord the registry
//     accepts, or '' (removed): the store's `keys`, under the registry id, so the Settings window's
//     Shortcuts page, the menu bar and `writeflex settings` see it.
//   - Valid bare or scoped keys use APP_KEYS_SETTING (JSON { renderer id: chord }).
//     Only migration populates this layer. Fixed, reserved, unknown and conflicting keys are refused.
//
// '' stays removed in both places: it never falls back to the default.
// Pure: no Electron, no React.
import { canonChord, isValidChord } from '@app-patterns/commands'
import { bridleChordOf, bridleIdOf, registry, registryHoldsKeyOf, writeflexChordOf, writeflexIdOf } from './bridle-commands'

/** renderer command id → display chord ('' = removed). */
export type OverrideMap = Record<string, string>

/** The synthesised value main serves to the renderer under the old key (useSettings reads it as before). */
export const LEGACY_OVERRIDES_KEY = 'shortcuts.overrides'
export const APP_KEYS_SETTING = 'keyboard.appKeys'

const MAX_CHORD_CHARS = 40
const CONTROL = /[\u0000-\u001f\u007f]/
const keepable = (s: unknown): s is string => typeof s === 'string' && s.length <= MAX_CHORD_CHARS && !CONTROL.test(s)

/** The old overrides' JSON, read tolerantly (the old app's own rule: anything malformed is no overrides). */
export function parseOverrideJson(raw: unknown): OverrideMap {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: OverrideMap = {}
    for (const [id, chord] of Object.entries(parsed as Record<string, unknown>)) if (keepable(chord) && id.length <= 200) out[id] = chord
    return out
  } catch {
    return {}
  }
}

/** App keys are migration-only, but still pass the same command and reservation rules. */
export function appKeysError(text: unknown): string | null {
  if (typeof text !== 'string') return 'Must be text'
  if (text.trim() === '') return null
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Must be a list of keys'
    const entries = Object.entries(value)
    const seen = new Set<string>()
    for (const [id, chord] of entries) {
      const def = registry.byId(bridleIdOf(id))
      if (!def || def.fixed) return 'Unknown or fixed command'
      if (!keepable(chord)) return 'Invalid shortcut'
      if (chord === '') continue
      const canonical = canonChord(chord)
      // Scoped keys use the registry's own bare-key grammar; global legacy letters are permitted.
      if (!isValidChord(canonical)) return 'Invalid shortcut'
      const scope = def.scope ?? ''
      const token = `${scope}:${canonical}`
      if (seen.has(token)) return 'Shortcut conflict'
      seen.add(token)
      if (registry.defs.some((other) => other.fixed && other.key === canonical)) return 'Reserved shortcut'
      for (const other of registry.defs) {
        if (other.id === def.id || (other.scope ?? '') !== scope) continue
        const replacement = value as Record<string, unknown>
        const otherId = writeflexIdOf(other.id) ?? other.id
        const otherChord = Object.hasOwn(replacement, otherId) ? replacement[otherId] : other.key
        if (typeof otherChord === 'string' && otherChord !== '' && canonChord(otherChord) === canonical) return 'Shortcut conflict'
      }
    }
    return null
  } catch { return 'Must be a list of keys' }
}

/** Validate the complete effective set, including collisions with shared overrides. */
export function appKeysStateError(keys: Readonly<Record<string, string>>, appKeys: unknown): string | null {
  const error = appKeysError(appKeys ?? '')
  if (error) return error
  const app = parseOverrideJson(appKeys)
  const effective = uncheckedBindings(keys, appKeys)
  for (const [id, chord] of Object.entries(app)) {
    if (!chord) continue
    const def = registry.byId(bridleIdOf(id))!
    for (const other of registry.defs) {
      if (other.id === def.id || (other.scope ?? '') !== (def.scope ?? '')) continue
      if (effective[other.id] && canonChord(chord) === effective[other.id]) return 'Shortcut conflict'
    }
  }
  return null
}

/** Canonical effective bindings shared by menus, renderer, palette and cheat sheet. */
function uncheckedBindings(keys: Readonly<Record<string, string>>, appKeys: unknown): Record<string, string> {
  const out = Object.fromEntries(registry.defs.map((def) => [def.id, def.key]))
  for (const [id, chord] of Object.entries(parseOverrideJson(appKeys))) {
    const def = registry.byId(bridleIdOf(id))
    if (def && !def.fixed) out[def.id] = chord === '' ? '' : canonChord(chord)
  }
  return { ...out, ...keys }
}

/** Every consumer uses this validated effective map; malformed app keys never affect dispatch. */
export function effectiveBindings(keys: Readonly<Record<string, string>>, appKeys: unknown): Record<string, string> {
  return uncheckedBindings(keys, appKeysStateError(keys, appKeys) ? '' : appKeys)
}

const sortedJson = (o: OverrideMap): string =>
  Object.keys(o).length === 0 ? '' : JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))

/** What the renderer applies: the app layer, with the registry's shortcut overrides (renderer spelling) over it. */
export function overridesFromStore(keys: Readonly<Record<string, string>>, appKeys: unknown): OverrideMap {
  const effective = effectiveBindings(keys, appKeys)
  const out: OverrideMap = {}
  for (const id of new Set([...Object.keys(keys), ...Object.keys(parseOverrideJson(appKeys)).map(bridleIdOf)])) {
    const rendererId = writeflexIdOf(id)
    if (rendererId) out[rendererId] = writeflexChordOf(effective[id] ?? '')
  }
  return out
}

/** The JSON string the renderer reads as `shortcuts.overrides` ('' when there are none). */
export function overridesValueFromStore(keys: Readonly<Record<string, string>>, appKeys: unknown): string {
  return sortedJson(overridesFromStore(keys, appKeys))
}

/**
 * Splits the old overrides into the registry's `keys` and the app layer, keeping their meaning: an
 * override equal to the command's default is dropped; valid bare and scoped keys use the app layer.
 * Refusals are returned to migration, which records their hashes separately and retries every run.
 */
export function splitOverrides(overrides: OverrideMap): { keys: Record<string, string>; appKeys: string; refused: string[] } {
  const refused: string[] = []
  const candidate: Record<string, string> = {}
  const app: OverrideMap = {}
  for (const [id, chord] of Object.entries(overrides)) {
    const bridleId = bridleIdOf(id)
    const def = registryHoldsKeyOf(id) ? registry.byId(bridleId) : undefined
    if (!def) {
      const command = registry.byId(bridleId)
      if (command && !command.fixed) app[id] = chord
      else refused.push(id)
      continue
    }
    if (chord === '') { candidate[bridleId] = ''; continue }
    const spelled = bridleChordOf(chord)
    if (!spelled) { app[id] = chord; continue }
    if (spelled === def.key) continue
    candidate[bridleId] = spelled
  }
  // Taking one override out can leave another without the room it had (a swap whose other half was
  // refused), so the set is judged again until the registry takes all of it.
  for (;;) {
    const { rejected } = registry.resolveBindings(candidate)
    if (rejected.length === 0) break
    for (const r of rejected) {
      const id = writeflexIdOf(r.commandId)
      if (id && overrides[id] !== undefined) app[id] = overrides[id]
      delete candidate[r.commandId]
    }
  }
  for (const id of Object.keys(app)) {
    const one = { [id]: app[id] }
    if (appKeysStateError(candidate, sortedJson(one))) { delete app[id]; refused.push(id) }
  }
  const accepted: OverrideMap = {}
  for (const [id, chord] of Object.entries(app)) {
    const trial = { ...accepted, [id]: chord }
    if (appKeysStateError(candidate, sortedJson(trial))) refused.push(id)
    else accepted[id] = chord
  }
  return { keys: candidate, appKeys: sortedJson(accepted), refused }
}

/** Invalid legacy data must not look like a successfully migrated empty override map. */
export function legacyOverridesError(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string') return 'Invalid shortcut overrides'
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'Invalid shortcut overrides'
    return null
  } catch { return 'Invalid shortcut overrides' }
}

/** Split a legacy map without silently dropping individually malformed entries. */
export function splitLegacyOverrides(raw: unknown): ReturnType<typeof splitOverrides> {
  const split = splitOverrides(parseOverrideJson(raw))
  if (!legacyOverridesError(raw) && typeof raw === 'string' && raw.trim()) {
    const entries = JSON.parse(raw) as Record<string, unknown>
    for (const [id, chord] of Object.entries(entries)) {
      if (!keepable(chord) || id.length > 200) split.refused.push(id)
    }
  }
  return split
}
