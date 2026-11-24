import {
  set, rebindMany, reset, resetSection, resetShortcuts, resetAll, resetEntry, applyImport, undoBatch,
  capChanges, MAX_CHANGES, type ChangeEntry, type Actor, type ImportPreview, type WriteRoute,
} from '@app-patterns/settings'
import { SettingsStore, type SettingsStoreOptions, type StoreResult, type StoreUndoResult } from '@app-patterns/settings/node'
import { schema } from '../shared/settings-schema'
import { APP_KEYS_SETTING, effectiveBindings, parseOverrideJson } from '../shared/keymap-overrides'
import { bridleIdOf, bridleChordOf } from '../shared/bridle-commands'
import { updateSettings, type StateOperation, type TransactionOptions } from './settings-transaction'
import { guardSettingsFile } from './settings-file-policy'

/** App policy over the public Bridle store; no vendored code is changed. */
export class SharedSettingsStore extends SettingsStore {
  private readonly version: string
  private readonly actor: Actor
  private readonly transactionOptions: TransactionOptions
  constructor(opts: SettingsStoreOptions) {
    super(opts)
    guardSettingsFile(this.file)
    this.transactionOptions = opts
    this.version = opts.appVersion
    this.actor = opts.who ?? { kind: 'you' }
  }
  override set(key: string, value: unknown): Promise<StoreResult> {
    if (key === APP_KEYS_SETTING) return Promise.resolve({ ok: false, code: 'rejected', error: 'These shortcuts are managed by migration. Use Shortcuts to rebind a command.' })
    return super.set(key, value)
  }
  private change(route: WriteRoute, operation: StateOperation, ids?: readonly string[] | 'all'): Promise<StoreResult> {
    return updateSettings(this, this.version, this.actor, (state, ctx) => {
      const out = operation(state, ctx)
      if (!out.ok) return out
      const touched = ids === 'all' ? null : new Set(ids ?? out.entries.flatMap((e) => e.commandId ? [e.commandId] : []))
      const app = parseOverrideJson(out.state.settings[APP_KEYS_SETTING])
      const previous = parseOverrideJson(state.settings[APP_KEYS_SETTING])
      if (Object.entries(app).some(([id, chord]) => previous[id] !== chord)) return { ok: false, code: 'invalid-value', error: 'Migrated shortcuts cannot be restored through this route. Use Shortcuts instead.' }
      for (const id of Object.keys(app)) if (touched === null || touched.has(bridleIdOf(id))) delete app[id]
      const cleaned = set(out.state, APP_KEYS_SETTING, Object.keys(app).length ? JSON.stringify(app) : '', ctx)
      if (!cleaned.ok) return cleaned
      let entries = [...cleaned.entries, ...out.entries]
      const migrated = Object.keys(previous).map(bridleIdOf).filter(id => !Object.hasOwn(state.keys, id) && (touched === null || touched.has(id)))
      if (!migrated.length) return { ...out, state: cleaned.state, entries }
      // The core only knows state.keys. Include the actual effective app-layer value in shortcut
      // history, even when resetting a migration-only binding produced no core command entry.
      const before = effectiveBindings(state.keys, state.settings[APP_KEYS_SETTING])
      const after = effectiveBindings(cleaned.state.keys, cleaned.state.settings[APP_KEYS_SETTING])
      for (const commandId of migrated) {
        const existing = entries.find(e => e.commandId === commandId)
        entries = entries.filter(e => e.commandId !== commandId)
        if (before[commandId] === after[commandId]) continue
        const entry: ChangeEntry = existing
          ? { ...existing, from: before[commandId], fromOrigin: 'local' }
          : { id: ctx.newId(), at: ctx.now(), commandId, from: before[commandId], to: after[commandId], who: cleaned.entries[0]?.who ?? out.entries[0]?.who ?? ctx.who, fromOrigin: 'local', toOrigin: 'local' }
        entries.unshift(entry)
      }
      if (entries.length > MAX_CHANGES) return { ok: false, code: 'too-many', error: `That would change more than ${MAX_CHANGES} settings at once` }
      const batch = out.batch ?? (entries.length > 1 ? ctx.newId() : undefined)
      entries = entries.map(e => ({ ...e, ...(batch ? { batch } : {}) }))
      return { ...out, ...(batch ? { batch } : {}), state: { ...cleaned.state, changes: capChanges([...entries, ...state.changes]) }, entries }
    }, { ...this.transactionOptions, route })
  }
  override rebind(commandId: string, chord: string): Promise<StoreResult> { return this.rebindMany([{ commandId, chord }]) }
  override rebindMany(pairs: readonly { commandId: string; chord: string }[]): Promise<StoreResult> {
    const normalized = pairs.map(pair => ({ ...pair, chord: pair.chord ? bridleChordOf(pair.chord) || pair.chord : '' }))
    return this.change('rebind', (s, ctx) => rebindMany(s, normalized, ctx), pairs.map((p) => p.commandId))
  }
  override reset(target: string | { commandId: string }): Promise<StoreResult> {
    if (target === APP_KEYS_SETTING) return Promise.resolve({ ok: false, code: 'rejected', error: 'Use Shortcuts to reset migrated keys.' })
    return this.change('reset', (s, ctx) => reset(s, target, ctx), typeof target === 'string' ? [] : [target.commandId])
  }
  override resetSection(section: string): Promise<StoreResult> {
    return this.change('reset-section', (s, ctx) => {
      if (section !== 'advanced') return resetSection(s, section, ctx)
      let state = s
      const entries: import('@app-patterns/settings').ChangeEntry[] = []
      for (const def of schema.settings.filter(d => d.section === section && d.key !== APP_KEYS_SETTING)) {
        const out = reset(state, def.key, ctx)
        if (!out.ok) return out
        state = out.state; entries.push(...out.entries)
      }
      return { ok: true, state, entries }
    }, section === 'shortcuts' ? 'all' : [])
  }
  override resetShortcuts(): Promise<StoreResult> { return this.change('reset-shortcuts', (s, ctx) => resetShortcuts(s, ctx), 'all') }
  override resetAll(): Promise<StoreResult> { return this.change('reset-all', (s, ctx) => resetAll(s, ctx), 'all') }
  override resetEntry(id: string): Promise<StoreResult> {
    return this.change('reset-entry', (s, ctx) => resetEntry(s, id, ctx))
  }
  override applyImport(preview: ImportPreview, opts: { file: string }): Promise<StoreResult> {
    return this.change('import', (s, ctx) => applyImport(s, preview, opts, { ...ctx, by: this.actor }))
  }
  override undoBatch(id: string): Promise<StoreUndoResult> {
    let skipped: Extract<StoreUndoResult, { ok: true }>['skipped'] = []
    return this.change('undo', (s, ctx) => { const out = undoBatch(s, id, ctx); skipped = out.skipped ?? []; return out }).then((out) => out.ok ? { ...out, skipped } : out)
  }
}
