// Moving WriteFlex's preferences from the old userData/settings.json into the shared settings store,
// userData/settings-v2.json (0.27, shared settings).
//
// Rules (orchestrator, 2026-10-20):
//   - The store writes a NEW file. The old settings.json is never rewritten, copied or deleted here: it
//     is read, and only its schema-known, non-secret preferences are taken (preferencesFromLegacy).
//     There is no size cap on that read. (The app goes on keeping its state there: recents, pins,
//     favourites and the rest are not preferences.)
//   - A read or parse failure of the old file stops the migration with nothing written and nothing
//     stamped. Only a missing file means there is nothing to migrate.
//   - The stamp, userData/settings-v2-migration.json, records per preference a hash of the value the
//     old file held (never the value) and the time it was stamped. Only writes that landed are stamped;
//     refusals are recorded separately and retried individually on every run. Shortcut stamps also
//     keep hashes of accepted entries and bindings last written by migration, never their values.
//   - On a later launch, a preference whose old-file hash differs from its stamp (an older WriteFlex
//     ran after a downgrade and changed it) is migrated again, logged as an app update, unless the new
//     store's changelog changed that key at or after that key's stamp time (app-update entries do not
//     count): then the new value is kept, preserving its original stamp time.
//   - Never re-migrate over a store file that cannot be read, is from a newer version, or is not
//     WriteFlex's: the migration stops and the store keeps it as it is.
//   - '' stays removed. Valid bare and scoped keys use the migration-only app layer.
//     Fixed, reserved, unknown and conflicting shortcuts are refused and retried.
//
// Runs before anything reads a preference: the app and `writeflex settings` call runMigration() and
// only then open the store they read from. No Electron here: tests run it on a temporary folder.
import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { commandsAdapter, set as setValue, reset as resetValue, rebindMany as bindValues, type ChangeEntry, type OpContext, type OpResult, type SettingsState } from '@app-patterns/settings'
import { MAX_FILE_BYTES, SettingsFile, type SettingsStore, type LockOptions } from '@app-patterns/settings/node'
import { updateSettings } from './settings-transaction'
import { SharedSettingsStore } from './shared-settings-store'
import { MIGRATION_STAMP_FILE, MISSING_STORE_MESSAGE, settingsFileProblem, guardSettingsFile } from './settings-file-policy'
import { registry, bridleIdOf, bridleChordOf, registryHoldsKeyOf } from '../shared/bridle-commands'
import { APP_KEYS_SETTING, LEGACY_OVERRIDES_KEY, appKeysStateError, parseOverrideJson, splitLegacyOverrides, splitOverrides, effectiveBindings, legacyOverridesError } from '../shared/keymap-overrides'
import {
  APP_ID, LEGACY_MARK, SETTINGS_V2_FILE, acceptedValue, handOverFor, legacyPreferenceKeys, migrateLegacy, preferencesFromLegacy, schema,
} from '../shared/settings-schema'

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)

export const LEGACY_FILE = 'settings.json'
export const STAMP_FILE = MIGRATION_STAMP_FILE
const STAMP_FORMAT = 'writeflex-settings-migration'

/** One stamped preference: a hash of the old file's value ('' when the old file had none) and when it was stamped. */
export type StampEntry = {
  hash: string
  at: number
  /** Legacy-value hashes for accepted shortcut entries, including individually retried entries. */
  entries?: Record<string, string>
  /** Hashes of canonical effective bindings last written by migration; never user-written values. */
  written?: Record<string, string>
}
export type Stamp = { format: typeof STAMP_FORMAT; version: string; keys: Record<string, StampEntry>; refusals: Record<string, Refusal> }

/** The options every WriteFlex settings store is opened with (the app, the CLI, the migration). */
export function storeOptions(dir: string, version: string) {
  return { dir, app: APP_ID, schema, registry: commandsAdapter(registry), appVersion: version, migrate: migrateLegacy, fileName: SETTINGS_V2_FILE, beforeWrite: settingsWriteRule }
}

/** Same authority rule for the app, generic CLI writes and migration. */
export const settingsWriteRule: import('@app-patterns/settings').BeforeWrite = (proposal) => {
  const beforeApp = parseOverrideJson(proposal.before.settings[APP_KEYS_SETTING])
  const afterApp = parseOverrideJson(proposal.next.settings[APP_KEYS_SETTING])
  if (proposal.route !== 'migration' && Object.entries(afterApp).some(([id, chord]) => beforeApp[id] !== chord)) return { reject: 'Only migration may populate app shortcuts.' }
  if (['set', 'reset-entry'].includes(proposal.route) && proposal.keys.includes(APP_KEYS_SETTING)) return { reject: 'These shortcuts are managed by migration. Use Shortcuts instead.' }
  const error = appKeysStateError(proposal.next.keys, proposal.next.settings[APP_KEYS_SETTING])
  return error ? { reject: error } : undefined
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

type LegacyRead = { kind: 'missing' } | { kind: 'ok'; prefs: Rec } | { kind: 'unreadable'; reason: string }

/** The old settings.json's preferences. Missing is "nothing to migrate"; anything else that fails is unreadable. No size cap. */
export function readLegacy(fs: typeof nodeFs, dir: string): LegacyRead {
  let text: string
  try {
    text = fs.readFileSync(join(dir, LEGACY_FILE), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', reason: `settings.json could not be read (${code ?? 'error'})` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'unreadable', reason: 'settings.json is not valid JSON' }
  }
  if (!isRec(parsed)) return { kind: 'unreadable', reason: 'settings.json is not a settings file' }
  if (parsed['values'] !== undefined && !isRec(parsed['values'])) return { kind: 'unreadable', reason: 'settings.json has no readable preferences' }
  return { kind: 'ok', prefs: preferencesFromLegacy(parsed) }
}

/** What settings-v2.json is now, read raw before any store opens it. */
type StoreFileRead =
  | { kind: 'missing' }
  | { kind: 'hand-over' } // our own hand-over, not yet rewritten by the store
  | { kind: 'store' }
  | { kind: 'refused'; reason: string } // unreadable, damaged, another app's, or a newer format

function readStoreFile(fs: typeof nodeFs, dir: string, version: string): StoreFileRead {
  let text: string
  let bytes: number
  try {
    const data = fs.readFileSync(join(dir, SETTINGS_V2_FILE))
    bytes = data.byteLength
    if (bytes > MAX_FILE_BYTES) return { kind: 'refused', reason: settingsFileProblem(undefined, bytes, version)! }
    text = data.toString('utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'refused', reason: `settings-v2.json could not be read (${code ?? 'error'})` }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { kind: 'refused', reason: 'settings-v2.json cannot be read as settings' }
  }
  const problem = settingsFileProblem(raw, bytes, version)
  if (problem) return { kind: 'refused', reason: problem }
  return { kind: isRec(raw) && raw[LEGACY_MARK] === 1 ? 'hand-over' : 'store' }
}

function readStamp(fs: typeof nodeFs, dir: string): Stamp | null {
  try {
    const s: unknown = JSON.parse(fs.readFileSync(join(dir, STAMP_FILE), 'utf8'))
    if (!isRec(s) || s['format'] !== STAMP_FORMAT || !isRec(s['keys'])) return null
    const readHashes = (value: unknown): Record<string, string> | undefined => isRec(value)
      ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && /^[a-f0-9]{32}$/.test(entry[1])))
      : undefined
    const keys: Record<string, StampEntry> = {}
    for (const [k, e] of Object.entries(s['keys'])) {
      if (!isRec(e) || typeof e['hash'] !== 'string' || typeof e['at'] !== 'number' || !Number.isFinite(e['at'])) continue
      const entries = readHashes(e['entries'])
      const written = readHashes(e['written'])
      keys[k] = { hash: e['hash'], at: e['at'], ...(entries ? { entries } : {}), ...(written ? { written } : {}) }
    }
    const refusals: Record<string, Refusal> = {}
    if (isRec(s['refusals'])) {
      for (const [key, entry] of Object.entries(s['refusals'])) {
        if (!legacyPreferenceKeys().includes(key) && !key.startsWith(`${LEGACY_OVERRIDES_KEY}/`)) continue
        if (isRec(entry) && typeof entry['hash'] === 'string' && /^[a-f0-9]{32}$/.test(entry['hash']) && typeof entry['at'] === 'number' && Number.isFinite(entry['at'])) {
          refusals[key] = { key, hash: entry['hash'], at: entry['at'], reason: typeof entry['reason'] === 'string' ? entry['reason'].slice(0, 200) : 'invalid-value' }
        }
      }
    }
    return { format: STAMP_FORMAT, version: typeof s['version'] === 'string' ? s['version'] : '', keys, refusals }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Writing (only our own files: the hand-over and the stamp)
// ---------------------------------------------------------------------------------------------

function writeTemp(fs: typeof nodeFs, dir: string, name: string, value: unknown): string {
  const tmp = join(dir, `.${name}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    const data = Buffer.from(JSON.stringify(value, null, 2), 'utf8')
    let off = 0
    while (off < data.length) off += fs.writeSync(fd, data, off, data.length - off)
    fs.fsyncSync(fd)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* our failed temporary write only */ }
    throw error
  } finally {
    fs.closeSync(fd)
  }
  return tmp
}

/** A new file only: linked into place, so an existing file is never replaced. False when one was already there. */
function writeNewFile(fs: typeof nodeFs, dir: string, name: string, value: unknown): boolean {
  fs.mkdirSync(dir, { recursive: true })
  const tmp = writeTemp(fs, dir, name, value)
  try {
    fs.linkSync(tmp, join(dir, name))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return false
    throw error
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* harmless */ }
  }
}

/** Replaces the migration's own stamp; hand-over changes use SettingsFile's lock. */
function replaceOwnFile(fs: typeof nodeFs, dir: string, name: string, value: unknown): void {
  const tmp = writeTemp(fs, dir, name, value)
  try {
    fs.renameSync(tmp, join(dir, name))
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* harmless */ }
    throw error
  }
}

type Refusal = { key: string; hash: string; reason: string; at: number }
function writeStamp(fs: typeof nodeFs, dir: string, version: string, keys: Record<string, StampEntry>, refusals: Record<string, Refusal>): void {
  replaceOwnFile(fs, dir, STAMP_FILE, { format: STAMP_FORMAT, version, keys, refusals })
}

// ---------------------------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------------------------

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (isRec(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x))
const hashOf = (v: unknown): string => createHash('sha256').update(canon(v)).digest('hex').slice(0, 32)

/** Hash only the accepted subset; pending entries have their own refusal records. */
function acceptedOverrides(raw: unknown, pending: ReadonlySet<string>, previous: Record<string, string> = {}): Record<string, string> {
  const refused = new Set(splitLegacyOverrides(raw).refused)
  return Object.fromEntries(Object.entries(parseOverrideJson(raw)).filter(([id, value]) =>
    !pending.has(id) && (!refused.has(id) || previous[id] === hashOf(value))))
}

function entryHashes(entries: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(entries).map(([id, value]) => [id, hashOf(value)]))
}

function bindingHashes(state: SettingsState, entries: Record<string, string>): Record<string, string> {
  const effective = effectiveBindings(state.keys, state.settings[APP_KEYS_SETTING])
  return Object.fromEntries(Object.keys(entries).map((id) => [id, hashOf(effective[bridleIdOf(id)] ?? null)]))
}

/** The old file's preferences now: every preference key → hash ('' when the old file holds none). */
function hashesOf(prefs: Rec, accepted: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of legacyPreferenceKeys()) {
    if (!Object.hasOwn(prefs, key)) { out[key] = ''; continue }
    out[key] = hashOf(key === LEGACY_OVERRIDES_KEY && !legacyOverridesError(prefs[key]) ? accepted : prefs[key])
  }
  return out
}

/** The part of SettingsStore the migration uses; a SettingsStore opened with who: app-update fits. */
export type MigrationStore = Pick<SettingsStore, 'ready' | 'problem' | 'view' | 'file' | 'reload' | 'close'>

/** The store refused the value itself (not the file): trying again would give the same answer. */
const VALUE_REFUSALS: ReadonlySet<string> = new Set(['unknown-key', 'unknown-command', 'secret', 'invalid-value', 'invalid-chord', 'rejected', 'not-possible', 'already', 'not-found', 'too-many'])

/** Whether the store's changelog changed `key` at or after `at`, by anyone but an app update. */
function changedSince(changes: readonly ChangeEntry[], key: string, at: number): boolean {
  return changes.some((e) => {
    if (e.at < at) return false
    const who = e.who as { kind: string; by?: { kind: string } }
    const actor = who.kind === 'reset' ? who.by?.kind ?? 'you' : who.kind
    if (actor === 'app-update') return false
    if (key === LEGACY_OVERRIDES_KEY) return typeof e.commandId === 'string' || e.key === APP_KEYS_SETTING || (e.targets?.some((t) => t === APP_KEYS_SETTING || registry.isCommandId(t)) ?? false)
    return e.key === key || (e.targets?.includes(key) ?? false)
  })
}

/** What the opened store holds for a preference key (its default when it stores none). */
function storedValue(store: MigrationStore, key: string): unknown {
  const s = store.view().settings
  return Object.hasOwn(s, key) ? s[key] : schema.def(key)?.default
}

/** Whether the store now holds the old file's shortcut overrides, split as the migration splits them. */
function shortcutsLanded(store: MigrationStore, raw: unknown): boolean {
  if (legacyOverridesError(raw)) return false
  const split = splitLegacyOverrides(raw)
  const keys = store.view().keys
  if (Object.entries(split.keys).some(([id, chord]) => (keys[id] ?? registry.byId(id)?.key) !== chord)) return false
  return (storedValue(store, APP_KEYS_SETTING) ?? '') === split.appKeys
}

/** Retry exactly one command against the current effective state; never reset other commands. */
function migrateOneShortcut(state: SettingsState, ctx: OpContext, id: string, raw: unknown): OpResult {
  const commandId = bridleIdOf(id)
  const def = registry.byId(commandId)
  if (!def || def.fixed || typeof raw !== 'string' || parseOverrideJson(JSON.stringify({ [id]: raw }))[id] !== raw) {
    return { ok: false, code: 'invalid-value', error: 'Invalid legacy shortcut' }
  }
  const appKeys = parseOverrideJson(state.settings[APP_KEYS_SETTING])
  const chord = bridleChordOf(raw)
  if (registryHoldsKeyOf(id) && (raw === '' || chord)) {
    delete appKeys[id]
    const app = setValue(state, APP_KEYS_SETTING, Object.keys(appKeys).length ? JSON.stringify(appKeys) : '', ctx)
    if (!app.ok) return app
    const bound = bindValues(app.state, [{ commandId, chord }], ctx)
    return bound.ok ? { ...bound, entries: [...bound.entries, ...app.entries] } : bound
  }
  const reset = Object.hasOwn(state.keys, commandId) ? resetValue(state, { commandId }, ctx) : { ok: true as const, state, entries: [] }
  if (!reset.ok) return reset
  appKeys[id] = raw
  const app = setValue(reset.state, APP_KEYS_SETTING, JSON.stringify(appKeys), ctx)
  return app.ok ? { ...app, entries: [...app.entries, ...reset.entries] } : app
}

export type MigrationOutcome =
  | { kind: 'none' }
  | { kind: 'first'; preferences: number; notSaved: string[] }
  | { kind: 'again'; applied: string[]; kept: string[]; refused: string[]; notSaved: string[] }
  /** The hand-over did not land (the store could not write): nothing stamped; tried again next time. */
  | { kind: 'not-saved'; reason?: string }
  /** settings-v2.json is unreadable, a newer version's or not WriteFlex's: nothing written. */
  | { kind: 'refused'; reason: string }
  /** The old settings.json could not be read or parsed: nothing written, nothing stamped. */
  | { kind: 'unreadable'; reason: string }

export type MigrationOptions = {
  /** Opens a store on `dir` logging as who: app-update; closed here. Default: a SettingsStore with storeOptions(). */
  open?: () => MigrationStore
  fs?: typeof nodeFs
  now?: () => number
  lock?: LockOptions
  log?: (line: string) => void
}

/**
 * Before the store the app (or the CLI) reads from is opened. See the rules at the top of the file.
 */
export async function runMigration(dir: string, version: string, opts: MigrationOptions = {}): Promise<MigrationOutcome> {
  try { return await migrate(dir, version, opts) }
  catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    const reason = `The settings migration could not be saved (${typeof code === 'string' ? code : 'write error'}).`
    opts.log?.(`[settings] ${reason}`)
    return { kind: 'not-saved', reason }
  }
}

async function migrate(dir: string, version: string, opts: MigrationOptions): Promise<MigrationOutcome> {
  const fs = opts.fs ?? nodeFs
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  const open = opts.open ?? (() => new SharedSettingsStore({
    ...storeOptions(dir, version), who: { kind: 'app-update', version }, watch: false, log, ...(opts.lock ? { lock: opts.lock } : {}),
  }))

  const legacy = readLegacy(fs, dir)
  if (legacy.kind === 'unreadable') return { kind: 'unreadable', reason: legacy.reason }
  const target = readStoreFile(fs, dir, version)
  if (target.kind === 'refused') return { kind: 'refused', reason: target.reason }
  if (target.kind === 'missing' && fs.existsSync(join(dir, STAMP_FILE))) return { kind: 'refused', reason: MISSING_STORE_MESSAGE }
  if (legacy.kind === 'missing' && target.kind !== 'hand-over') return { kind: 'none' }
  const prefs = legacy.kind === 'ok' ? legacy.prefs : {}
  const stamp = readStamp(fs, dir)
  // Without provenance, legacy data cannot outrank an intact store (its history may be trimmed).
  if (target.kind === 'store' && !stamp) return { kind: 'none' }
  const before = stamp?.keys ?? {}
  const refusals = { ...stamp?.refusals }
  const raw = prefs[LEGACY_OVERRIDES_KEY]
  const shortcutError = legacyOverridesError(raw)
  const rawEntries: Rec = !shortcutError && typeof raw === 'string' && raw.trim() ? JSON.parse(raw) as Rec : {}
  const pending = new Set<string>()
  // Keep a previously refused entry out of the bulk subset even if it has become valid. Only the
  // individual retry below may promote it, after checking the current binding under the store lock.
  for (const key of Object.keys(refusals)) {
    if (!key.startsWith(`${LEGACY_OVERRIDES_KEY}/`)) continue
    const id = key.slice(LEGACY_OVERRIDES_KEY.length + 1)
    if (Object.hasOwn(rawEntries, id)) pending.add(id)
    else if (!shortcutError) delete refusals[key]
  }
  if (!shortcutError) delete refusals[LEGACY_OVERRIDES_KEY]
  const previousEntries = before[LEGACY_OVERRIDES_KEY]?.entries ?? {}
  for (const id of splitLegacyOverrides(raw).refused) {
    if (previousEntries[id] !== hashOf(rawEntries[id])) pending.add(id)
  }
  const accepted = acceptedOverrides(raw, pending, previousEntries)
  const hashes = hashesOf(prefs, accepted)
  const refuse = (key: string, value: unknown, reason = 'invalid-value'): void => {
    const hash = hashOf(value)
    if (refusals[key]?.hash === hash) {
      if (refusals[key].reason !== reason) refusals[key] = { ...refusals[key], reason }
      return
    }
    log(`[settings] ${key} from the older version was not applied: ${reason === 'newer-binding' ? 'the current binding was kept' : 'the value is not one this version takes'}`)
    refusals[key] = { key, hash, reason, at: now() }
  }

  const firstStampAt = now()
  let first = false
  if (target.kind === 'missing') {
    first = writeNewFile(fs, dir, SETTINGS_V2_FILE, handOverFor(prefs))
    if (!first) return { kind: 'none' }
  } else if (target.kind === 'hand-over') {
    const file = new SettingsFile(join(dir, SETTINGS_V2_FILE), { ...(opts.lock ? { lock: opts.lock } : {}) })
    guardSettingsFile(file)
    const handover = await file.update(read => {
      // A CLI process may have taken the hand-over while this launch waited for its lock.
      if (read.kind !== 'ok' || !isRec(read.raw) || read.raw[LEGACY_MARK] !== 1
        || settingsFileProblem(read.raw, Buffer.byteLength(JSON.stringify(read.raw)), version)) return { result: false }
      return { result: true, write: handOverFor(prefs) }
    })
    if (!handover.ok) return { kind: 'not-saved', reason: handover.error }
    first = handover.result
    if (!first && !stamp) return { kind: 'none' }
  }

  const store = open()
  try {
    await store.ready
    const problem = store.problem()
    if (problem) return { kind: 'refused', reason: problem.error }
    if (first) {
      if (readStoreFile(fs, dir, version).kind === 'hand-over') return { kind: 'not-saved' }
      const keys: Record<string, StampEntry> = {}
      const notSaved: string[] = []
      for (const [key, hash] of Object.entries(hashes)) {
        const held = Object.hasOwn(prefs, key)
        const landed = !held || (key === LEGACY_OVERRIDES_KEY
          ? !shortcutError && shortcutsLanded(store, JSON.stringify(accepted))
          : acceptedValue(key, prefs[key]) && canon(storedValue(store, key)) === canon(prefs[key]))
        if (landed) {
          keys[key] = { hash, at: firstStampAt, ...(key === LEGACY_OVERRIDES_KEY ? { entries: entryHashes(accepted), written: bindingHashes(store.view(), accepted) } : {}) }
        } else {
          notSaved.push(key)
          if (key === LEGACY_OVERRIDES_KEY ? Boolean(shortcutError) : !acceptedValue(key, prefs[key])) refuse(key, prefs[key])
        }
      }
      for (const id of pending) refuse(`${LEGACY_OVERRIDES_KEY}/${id}`, rawEntries[id])
      writeStamp(fs, dir, version, keys, refusals)
      const moved = Object.keys(prefs).filter((key) => !notSaved.includes(key) && (key === LEGACY_OVERRIDES_KEY ? Object.keys(accepted).length > 0 : acceptedValue(key, prefs[key]))).length
      return { kind: 'first', preferences: moved, notSaved }
    }

    const next: Record<string, StampEntry> = { ...before }
    // Alpha.3 did not stamp an empty accepted subset. Establish that neutral baseline without
    // writing preferences: there is no accepted binding to re-apply or shortcut to reset.
    if (!shortcutError && !next[LEGACY_OVERRIDES_KEY] && Object.keys(accepted).length === 0) {
      next[LEGACY_OVERRIDES_KEY] = { hash: hashes[LEGACY_OVERRIDES_KEY], at: 0, entries: {}, written: {} }
    }
    const changed = Object.keys(hashes).filter((key) => (next[key]?.hash ?? (stamp ? '' : null)) !== hashes[key])
    const applied: string[] = []
    const kept: string[] = []
    const refused: string[] = []
    const notSaved: string[] = []
    const transaction = { beforeWrite: settingsWriteRule, route: 'migration' as const, now, log }
    let subsetReady = true
    for (const key of changed) {
      const since = before[key]?.at ?? 0
      let keep = false
      const result = await updateSettings(store, version, { kind: 'app-update', version }, (state, ctx) => {
        if ((key === LEGACY_OVERRIDES_KEY && shortcutError) || (key !== LEGACY_OVERRIDES_KEY && Object.hasOwn(prefs, key) && !acceptedValue(key, prefs[key]))) return { ok: false, code: 'invalid-value', error: 'Invalid legacy preference' }
        if (changedSince(state.changes, key, since)) {
          keep = true
          return { ok: true, state, entries: [] }
        }
        if (key === LEGACY_OVERRIDES_KEY) {
          const split = splitOverrides(accepted)
          if (split.refused.length) return { ok: false, code: 'invalid-value', error: 'The accepted legacy subset cannot be applied together.' }
          const pendingIds = new Set([...pending].map(bridleIdOf))
          const pairs = [...new Set([...Object.keys(state.keys), ...Object.keys(split.keys)])]
            .filter((id) => !pendingIds.has(id))
            .map((commandId) => ({ commandId, chord: split.keys[commandId] ?? registry.byId(commandId)?.key ?? '' }))
          const bindings = bindValues(state, pairs, ctx)
          if (!bindings.ok) return bindings
          const appKeys = { ...parseOverrideJson(split.appKeys) }
          for (const [id, chord] of Object.entries(parseOverrideJson(state.settings[APP_KEYS_SETTING]))) if (pending.has(id)) appKeys[id] = chord
          const app = setValue(bindings.state, APP_KEYS_SETTING, Object.keys(appKeys).length ? JSON.stringify(appKeys) : '', ctx)
          return app.ok ? { ...app, entries: [...app.entries, ...bindings.entries] } : app
        }
        return Object.hasOwn(prefs, key) ? setValue(state, key, prefs[key], ctx) : resetValue(state, key, ctx)
      }, transaction)
      if (keep) {
        kept.push(key)
        next[key] = { ...next[key], hash: hashes[key], at: since }
      } else if (result.ok) {
        applied.push(key)
        const at = result.entries.length ? Math.min(...result.entries.map((entry) => entry.at)) : since
        next[key] = { hash: hashes[key], at }
        if (key === LEGACY_OVERRIDES_KEY) {
          const retained = Object.fromEntries(Object.entries(before[key]?.written ?? {}).filter(([id]) => pending.has(id)))
          next[key].entries = entryHashes(accepted)
          next[key].written = { ...retained, ...bindingHashes(result.state, accepted) }
        }
        delete refusals[key]
      } else {
        if (key === LEGACY_OVERRIDES_KEY) subsetReady = false
        if (VALUE_REFUSALS.has(result.code)) { refused.push(key); refuse(key, prefs[key]) }
        else { notSaved.push(key); log(`[settings] ${key} from the older version was not applied yet; it is tried again next launch`) }
      }
    }

    for (const id of pending) {
      const key = `${LEGACY_OVERRIDES_KEY}/${id}`
      if (!subsetReady) { notSaved.push(key); continue }
      let keep = false
      const result = await updateSettings(store, version, { kind: 'app-update', version }, (state, ctx) => {
        const out = migrateOneShortcut(state, ctx, id, rawEntries[id])
        if (!out.ok) return out
        const def = registry.byId(bridleIdOf(id))!
        const current = effectiveBindings(state.keys, state.settings[APP_KEYS_SETTING])[def.id] ?? ''
        const lastWritten = next[LEGACY_OVERRIDES_KEY]?.written?.[id]
        if (current !== def.key && hashOf(current) !== lastWritten) {
          keep = true
          return { ok: true, state, entries: [] }
        }
        return out
      }, transaction)
      if (keep) {
        kept.push(key)
        refuse(key, rawEntries[id], 'newer-binding')
      } else if (result.ok) {
        applied.push(key)
        delete refusals[key]
        accepted[id] = rawEntries[id] as string
        const previous = next[LEGACY_OVERRIDES_KEY]
        next[LEGACY_OVERRIDES_KEY] = {
          hash: hashOf(accepted), at: previous?.at ?? 0,
          entries: { ...previous?.entries, [id]: hashOf(rawEntries[id]) },
          written: { ...previous?.written, ...bindingHashes(result.state, { [id]: rawEntries[id] as string }) },
        }
      } else if (VALUE_REFUSALS.has(result.code)) {
        refused.push(key)
        refuse(key, rawEntries[id])
      } else notSaved.push(key)
    }
    if (!stamp || canon(next) !== canon(before) || canon(refusals) !== canon(stamp.refusals)) writeStamp(fs, dir, version, next, refusals)
    if (changed.length === 0 && pending.size === 0) return { kind: 'none' }
    return { kind: 'again', applied, kept, refused, notSaved }
  } finally {
    await store.close()
  }
}
