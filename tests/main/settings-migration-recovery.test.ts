import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyState, set, type ChangeEntry, type OpContext } from '@app-patterns/settings'
import { MAX_FILE_BYTES, runSettingsCli, acquireLock } from '@app-patterns/settings/node'
import { runMigration, storeOptions, STAMP_FILE } from '../../src/main/settings-migration'
import { SharedSettingsStore } from '../../src/main/shared-settings-store'
import { SettingsStore as LegacyStore } from '../../src/main/settings'
import { openPreferences } from '../../src/main/shared-preferences'
import { updateSettings } from '../../src/main/settings-transaction'
import { APP_KEYS_SETTING, effectiveBindings, splitOverrides } from '../../src/shared/keymap-overrides'
import { SETTINGS_V2_FILE, preferencesFromLegacy } from '../../src/shared/settings-schema'
import { runShortcutMutation } from '../../src/cli/settings-shortcuts'
import { GuideProgressStore } from '../../src/main/guide-progress-store'

const stamp = (dir: string) => JSON.parse(readFileSync(join(dir, STAMP_FILE), 'utf8'))

describe('migration acceptance, store writes and CLI compatibility', () => {
  const version = '0.27.0-alpha.3'
  const fresh = () => mkdtempSync(join(tmpdir(), 'wf-settings-compat-'))
  const legacy = (dir: string, values: Record<string, unknown>, extra = {}) => writeFileSync(join(dir, 'settings.json'), JSON.stringify({ values, ...extra }))
  const storeAt = async (dir: string, extra = {}) => {
    const store = new SharedSettingsStore({ ...storeOptions(dir, version), watch: false, log: () => {}, ...extra })
    await store.ready
    return store
  }

  test('an invalid app-layer entry does not evict an independent valid entry', () => {
    const split = splitOverrides({ 'plan.addPart': 'X', 'edit.bold': '⌘W' })
    expect(JSON.parse(split.appKeys)).toEqual({ 'plan.addPart': 'X' })
    expect(split.refused).toEqual(['edit.bold'])
  })

  test('downgrade shortcut edits land their accepted subset, retry per-entry refusals and log each new hash once', async () => {
    const dir = fresh()
    legacy(dir, { 'shortcuts.overrides': JSON.stringify({ 'edit.italic': '⌃⌥⌘9' }) })
    await runMigration(dir, version)
    const overrides = { 'plan.addPart': 'X', 'edit.bold': '⌘W' }
    legacy(dir, { 'shortcuts.overrides': JSON.stringify(overrides) })
    const logs: string[] = []
    const opts = { log: (line: string) => logs.push(line) }
    expect(await runMigration(dir, version, opts)).toMatchObject({ kind: 'again', applied: ['shortcuts.overrides'], refused: ['shortcuts.overrides/edit.bold'], notSaved: [] })
    const store = await storeAt(dir)
    expect(store.view().keys).toEqual({})
    expect(JSON.parse(String(store.view().settings[APP_KEYS_SETTING]))).toEqual({ 'plan.addPart': 'X' })
    await store.close()
    expect(stamp(dir).refusals['shortcuts.overrides/edit.bold'].hash).toMatch(/^[a-f0-9]{32}$/)
    expect(stamp(dir).keys['shortcuts.overrides/edit.bold']).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(await runMigration(dir, version, opts)).toMatchObject({ kind: 'again', refused: ['shortcuts.overrides/edit.bold'] })
    expect(logs).toHaveLength(1)
    legacy(dir, { 'shortcuts.overrides': JSON.stringify({ ...overrides, 'edit.bold': '⌘,' }) })
    await runMigration(dir, version, opts)
    expect(logs).toHaveLength(2)
    legacy(dir, { 'shortcuts.overrides': JSON.stringify({ ...overrides, 'edit.bold': '⌃⌥⌘9' }) })
    expect(await runMigration(dir, version, opts)).toMatchObject({ applied: ['shortcuts.overrides/edit.bold'], refused: [] })
    expect(stamp(dir).refusals).toEqual({})
    expect(logs).toHaveLength(2) // a valid individual retry is not logged as another refusal
  })

  test('first-run report counts a partially accepted shortcut preference that landed', async () => {
    const dir = fresh()
    legacy(dir, { 'shortcuts.overrides': JSON.stringify({ 'plan.addPart': 'X', 'edit.bold': '⌘W' }) })
    expect(await runMigration(dir, version)).toMatchObject({ kind: 'first', preferences: 1, notSaved: [] })
    expect(Object.keys(stamp(dir).refusals)).toEqual(['shortcuts.overrides/edit.bold'])
  })

  for (const [label, text] of [
    ['version zero', JSON.stringify({ ...emptyState('writeflex'), version: 0 })],
    ['oversized', JSON.stringify({ ...emptyState('writeflex'), padding: 'x'.repeat(MAX_FILE_BYTES) })],
    ['non-object', '[]'],
  ] as const) {
    test(`${label} is refused before opening, untouched, unstamped and never archived`, async () => {
      const dir = fresh()
      legacy(dir, { 'appearance.theme': 'dark' })
      writeFileSync(join(dir, SETTINGS_V2_FILE), text)
      let opened = false
      expect(await runMigration(dir, version, { open: () => { opened = true; throw new Error('must not open') } })).toMatchObject({ kind: 'refused' })
      expect(opened).toBe(false)
      expect(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')).toBe(text)
      expect(existsSync(join(dir, STAMP_FILE))).toBe(false)
      expect(readdirSync(dir).some((file) => file.includes('.damaged-'))).toBe(false)
    })
  }

  test('a stamped store removed or set aside never re-applies legacy preferences', async () => {
    for (const setAside of [false, true]) {
      const dir = fresh()
      legacy(dir, { 'appearance.theme': 'dark' })
      await runMigration(dir, version)
      const before = readFileSync(join(dir, STAMP_FILE), 'utf8')
      if (setAside) renameSync(join(dir, SETTINGS_V2_FILE), join(dir, 'settings-v2.json.damaged-test'))
      else rmSync(join(dir, SETTINGS_V2_FILE))
      const opened = await openPreferences(new LegacyStore(join(dir, 'settings.json')), dir, version, () => {})
      expect(opened.migration).toMatchObject({ kind: 'refused' })
      expect(opened.store.problem()?.error).toContain('missing')
      await opened.close()
      expect(existsSync(join(dir, SETTINGS_V2_FILE))).toBe(false)
      expect(readFileSync(join(dir, STAMP_FILE), 'utf8')).toBe(before)
    }
  })

  test('atomic command writes run beforeWrite under the lock and respect its refusal', async () => {
    const dir = fresh()
    const store = await storeAt(dir, { beforeWrite: () => ({ reject: 'guarded' }) })
    expect(await store.rebind('edit.bold', '⌘⌃⌥9')).toMatchObject({ ok: false, code: 'rejected', error: 'guarded' })
    expect(store.view().keys).toEqual({})
    expect(existsSync(join(dir, SETTINGS_V2_FILE))).toBe(false)
    await store.close()
  })

  test('atomic writes fit the changelog by byte size without splitting an old batch', async () => {
    const dir = fresh()
    const changes: ChangeEntry[] = Array.from({ length: 10 }, (_, n) => ({ id: `old-${n}`, at: 1, key: 'editor.typewriter', from: false, to: true, who: { kind: 'agent', name: 'x'.repeat(200) }, ...(n >= 8 ? { batch: 'old-batch' } : {}) }))
    const state = { ...emptyState('writeflex'), changes }
    const initial = JSON.stringify(state, null, 2) + '\n'
    writeFileSync(join(dir, SETTINGS_V2_FILE), initial)
    const maxBytes = Buffer.byteLength(initial) + 100
    const store = await storeAt(dir, { maxBytes })
    expect((await store.rebind('edit.bold', '⌘⌃⌥9')).ok).toBe(true)
    expect(Buffer.byteLength(readFileSync(join(dir, SETTINGS_V2_FILE)))).toBeLessThanOrEqual(maxBytes)
    expect(store.view().changes.some((entry) => entry.batch === 'old-batch')).toBe(false)
    expect(store.view().changes[0].commandId).toBe('edit.bold')
    await store.close()
  })

  test('damage appearing after open is refused under the lock without an archive or default write', async () => {
    const dir = fresh()
    legacy(dir, { 'appearance.theme': 'dark' })
    await runMigration(dir, version)
    const store = await storeAt(dir)
    const invalid = JSON.stringify({ ...emptyState('writeflex'), version: 0 })
    writeFileSync(join(dir, SETTINGS_V2_FILE), invalid)
    expect((await updateSettings(store, version, { kind: 'you' }, (state, ctx) => set(state, 'editor.typewriter', true, ctx))).ok).toBe(false)
    expect(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')).toBe(invalid)
    expect(readdirSync(dir).some((file) => file.includes('.damaged-'))).toBe(false)
    expect((await runMigration(dir, version)).kind).toBe('refused')
    await store.close()
  })

  test('top-level legacy model defaults migrate only when each values key is absent', async () => {
    const defaults = { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' }
    expect(preferencesFromLegacy({ modelDefaults: defaults })).toMatchObject({ 'agent.model': 'openai-codex::gpt-5.5', 'agent.thinkingLevel': 'high' })
    expect(preferencesFromLegacy({ modelDefaults: defaults, values: { 'agent.model': 'anthropic::claude-opus-4-6', 'agent.thinkingLevel': null } })).toMatchObject({ 'agent.model': 'anthropic::claude-opus-4-6' })
    expect(preferencesFromLegacy({ modelDefaults: defaults, values: { 'agent.thinkingLevel': null } })).not.toHaveProperty('agent.thinkingLevel')
    const dir = fresh()
    legacy(dir, {}, { modelDefaults: defaults })
    await runMigration(dir, version)
    const old = new LegacyStore(join(dir, 'settings.json'))
    const shared = await openPreferences(old, dir, version, () => {})
    expect(old.modelDefaults()).toEqual(defaults)
    await shared.close()
  })

  test('reverting a migrated legacy changelog entry persists its reverted marker across reopening', async () => {
    const dir = fresh()
    legacy(dir, { 'editor.typewriter': true }, { changelog: [{ key: 'editor.typewriter', label: 'Typewriter', old: false, new: true, at: 1 }] })
    const old = new LegacyStore(join(dir, 'settings.json'))
    const shared = await openPreferences(old, dir, version, () => {})
    expect(await old.revertPersisted(0)).toMatchObject({ reverted: true })
    await shared.close()
    const reopened = new LegacyStore(join(dir, 'settings.json'))
    expect(reopened.changelog()[0].reverted).toBe(true)
    expect(await reopened.revertPersisted(0)).toBeNull()
  })

  test('unowned CLI verbs pass unknown and future arguments through without parsing them', async () => {
    const dir = fresh()
    const io = { stdout: () => {}, stderr: () => {} }
    expect(await runShortcutMutation(['list', '--future-option', 'x'], io, dir, version)).toBeUndefined()
    expect(await runShortcutMutation(['changes', '--limit=2'], io, dir, version)).toBeUndefined()
    expect(readdirSync(dir)).toEqual([])
  })

  test.each(['text', 'json'])('CLI mutation %s and exit codes match Bridle for unchanged app-layer cases', async (format) => {
    const dir = fresh()
    const nativeDir = fresh()
    const source = await storeAt(fresh(), { now: () => 1000, newId: () => 'source' })
    await source.set('appearance.theme', 'dark')
    const exportPath = join(fresh(), 'export.json')
    writeFileSync(exportPath, JSON.stringify(source.exportFile({ hostName: 'round-two' })))
    await source.close()
    for (const args of [
      ['rebind', 'edit.bold', 'cmd+ctrl+alt+9'],
      ['rebind', 'edit.bold', 'cmd+ctrl+alt+9'],
      ['rebind', 'missing.command', 'X'],
      ['rebind', 'edit.bold', 'bad+9'],
      ['reset-shortcut', '--all'],
      ['reset-shortcut', 'edit.bold'],
      ['reset-shortcut', '--all'],
      ['reset', '--all'],
      ['reset', '--section', 'shortcuts'],
      ['undo-import', '--last'],
      ['import', exportPath],
      ['import', exportPath, '--yes'],
      ['import', exportPath],
      ['undo-import', '--last'],
      ['import', exportPath + '.missing'],
      ['rebind', 'edit.bold'],
      ['reset-shortcut', 'edit.bold', '--yes'],
      ['reset-shortcut', 'edit.bold', '--all'],
      ['reset', '--all', '--section', 'shortcuts'],
      ['rebind', 'edit.bold', 'ctrl+alt+cmd+plus', '--json=true'],
      ['rebind', 'edit.bold', 'cmd+ctrl+alt+9', '--agent='],
      ['rebind', 'edit.bold', '⌘⌘9'],
      ['rebind', 'edit.bold', 'cmd+ctrl+alt+8', '--yes'],
    ]) {
      const argv = [...args, ...(format === 'json' ? ['--json'] : [])]
      const capture = () => {
        let stdout = '', stderr = '', n = 0
        return { io: { stdout: (s: string) => { stdout += s }, stderr: (s: string) => { stderr += s }, now: () => 1000, newId: () => `id-${n++}` }, output: () => ({ stdout, stderr }) }
      }
      const app = capture(), native = capture()
      const opts = storeOptions(nativeDir, version)
      const expected = await runSettingsCli(argv, { ...opts, version }, native.io)
      expect(await runShortcutMutation(argv, app.io, dir, version)).toBe(expected)
      expect(app.output()).toEqual(native.output())
    }
  }, 15_000) // Each format runs 23 mutations through both implementations over real settings stores.


  test('legacy set, model defaults and revert use the awaited writer with no synchronous stub', async () => {
    const dir = fresh()
    legacy(dir, {}, { changelog: [{ key: 'editor.typewriter', old: null, new: true, label: 'Typewriter', at: 1 }] })
    const old = new LegacyStore(join(dir, 'settings.json'))
    const before = readFileSync(join(dir, 'settings.json'), 'utf8')
    const prefs = new Map<string, string | number | boolean>()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    old.attachShared({
      owns: () => true,
      get: (key) => prefs.get(key) ?? null,
      values: () => Object.fromEntries(prefs),
      async persist(key, value) {
        await gate
        if (value === null) prefs.delete(key)
        else prefs.set(key, value)
      },
    })
    let finished = false
    const writing = old.set('editor.typewriter', true, 'Typewriter').finally(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(prefs.size).toBe(0)
    release()
    await writing
    await old.setModelDefaults({ provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' })
    expect(old.modelDefaults()).toEqual({ provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' })
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(before)
    await old.revert(0)
    expect(prefs.has('editor.typewriter')).toBe(false)
    expect(new LegacyStore(join(dir, 'settings.json')).changelog()[0].reverted).toBe(true)
  })

  test('stamp keys and refusal records are read with one parse, and resolved refusals are removed', async () => {
    const dir = fresh()
    const accepted = { 'plan.addPart': 'X' }
    legacy(dir, { 'shortcuts.overrides': JSON.stringify({ ...accepted, 'edit.bold': '⌘W' }) })
    await runMigration(dir, version)
    legacy(dir, { 'shortcuts.overrides': JSON.stringify(accepted) })
    let reads = 0
    const countedFs = { ...fs, readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === join(dir, STAMP_FILE)) reads++
      return fs.readFileSync(...args)
    }) as typeof fs.readFileSync }
    expect(await runMigration(dir, version, { fs: countedFs })).toMatchObject({ kind: 'none' })
    expect(reads).toBe(1)
    expect(stamp(dir).refusals).toEqual({})
  })

  test('CLI locked-write exit codes and output match Bridle', async () => {
    for (const json of [false, true]) {
      const appDir = fresh(), nativeDir = fresh()
      const locks = await Promise.all([appDir, nativeDir].map((dir) => acquireLock(join(dir, SETTINGS_V2_FILE))))
      try {
        const capture = () => {
          let text = ''
          return { io: { stdout: (s: string) => { text += s }, stderr: (s: string) => { text += s } }, output: () => text }
        }
        const app = capture(), native = capture()
        const argv = ['rebind', 'edit.bold', 'cmd+ctrl+alt+9', ...(json ? ['--json'] : [])]
        const lock = { waitMs: 0 }
        expect(await runShortcutMutation(argv, app.io, appDir, version, lock)).toBe(4)
        expect(await runSettingsCli(argv, { ...storeOptions(nativeDir, version), version, lock }, native.io)).toBe(4)
        expect(app.output()).toBe(native.output())
      } finally {
        await Promise.all(locks.map((lock) => lock.release()))
      }
    }
  })

  test('the acceptance size cap counts file bytes exactly as Bridle does, before UTF-8 decoding', async () => {
    const dir = fresh()
    legacy(dir, { 'appearance.theme': 'light' })
    await runMigration(dir, version) // Keep valid provenance; lost stamps deliberately preserve the store.
    legacy(dir, { 'appearance.theme': 'dark' })
    // Bridle decodes these bytes to replacement characters in an ignored field. The actual file is
    // below its byte cap even though re-encoding the decoded text would exceed it.
    const bytes = Buffer.concat([
      Buffer.from(JSON.stringify(emptyState('writeflex')).slice(0, -1) + ',"padding":"'),
      Buffer.alloc(Math.floor(MAX_FILE_BYTES / 3), 0xff),
      Buffer.from('"}'),
    ])
    expect(bytes.byteLength).toBeLessThan(MAX_FILE_BYTES)
    expect(Buffer.byteLength(bytes.toString('utf8'))).toBeGreaterThan(MAX_FILE_BYTES)
    writeFileSync(join(dir, SETTINGS_V2_FILE), bytes)
    expect(await runMigration(dir, version)).toMatchObject({ kind: 'again' })
    expect(JSON.parse(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')).settings['appearance.theme']).toBe('dark')
    expect(readdirSync(dir).some((file) => file.includes('.damaged-'))).toBe(false)
  })
})

describe('migration retry and failed writes', () => {
  const version = '0.27.0-alpha.4'
  const fresh = () => mkdtempSync(join(tmpdir(), 'wf-settings-retry-'))
  const legacy = (dir: string, bindings: Record<string, string>) => writeFileSync(join(dir, 'settings.json'), JSON.stringify({ values: { 'shortcuts.overrides': JSON.stringify(bindings) } }))
  const open = async (dir: string) => {
    const store = new SharedSettingsStore({ ...storeOptions(dir, version), watch: false, log: () => {} })
    await store.ready
    return store
  }
  const bindings = (store: SharedSettingsStore) => effectiveBindings(store.view().keys, store.view().settings[APP_KEYS_SETTING])
  const forgetHistory = (dir: string) => {
    const path = join(dir, SETTINGS_V2_FILE)
    const state = JSON.parse(readFileSync(path, 'utf8'))
    state.changes = []
    writeFileSync(path, JSON.stringify(state))
  }

  test('repeated launches preserve a user rebind after its history entry is evicted', async () => {
    const dir = fresh()
    legacy(dir, { 'edit.italic': '⌃⌥⌘9', 'edit.bold': '⌘W' })
    await runMigration(dir, version)
    const accepted = stamp(dir).keys['shortcuts.overrides']
    const store = await open(dir)
    expect((await store.rebind('edit.bold', '⌘⌃⌥7')).ok).toBe(true)
    // Seed 299 ordinary changes in one write so the 300-entry history still holds the rebind.
    // The remaining real sets exercise eviction without syncing the whole file for every seed change.
    const seededSets = 299
    const { schema, registry: commands } = storeOptions(dir, version)
    const ctx: OpContext = { schema, commands, who: { kind: 'you' }, now: Date.now, newId: randomUUID }
    let seeded = store.view()
    for (let n = 0; n < seededSets; n++) {
      const result = set(seeded, 'appearance.theme', n % 2 ? 'light' : 'dark', ctx)
      expect(result.ok).toBe(true)
      if (result.ok) seeded = result.state
    }
    expect(seeded.changes).toHaveLength(300)
    expect(seeded.changes.at(-1)?.commandId).toBe('edit.bold')
    expect((await store.file.update(() => ({ write: seeded, result: undefined }))).ok).toBe(true)

    for (let n = seededSets; n < 310; n++) expect((await store.set('appearance.theme', n % 2 ? 'light' : 'dark')).ok).toBe(true)
    expect(store.view().changes).toHaveLength(300)
    expect(store.view().changes.some((entry) => entry.commandId === 'edit.bold')).toBe(false)
    await store.close()
    const persisted = readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')
    for (let run = 0; run < 2; run++) {
      expect(await runMigration(dir, version)).toMatchObject({ kind: 'again', applied: [], refused: ['shortcuts.overrides/edit.bold'] })
      const reopened = await open(dir)
      expect(bindings(reopened)['edit.bold']).toBe('⌘⌃⌥7')
      expect(bindings(reopened)['edit.italic']).toBe('⌘⌃⌥9')
      await reopened.close()
      expect(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')).toBe(persisted)
      expect(stamp(dir).keys['shortcuts.overrides']).toEqual(accepted)
    }
  })

  test('all-refused legacy data, including a round-two stamp with no subset entry, never resets shortcuts', async () => {
    const dir = fresh()
    legacy(dir, { 'edit.bold': '⌘W' })
    await runMigration(dir, version)
    const store = await open(dir)
    await store.rebind('edit.italic', '⌘⌃⌥9')
    await store.rebind('edit.bold', '⌘⌃⌥7')
    await store.close()
    forgetHistory(dir)
    const oldStamp = stamp(dir)
    delete oldStamp.keys['shortcuts.overrides'] // the stamp written by alpha.3 for an all-refused map
    writeFileSync(join(dir, STAMP_FILE), JSON.stringify(oldStamp))
    const before = readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')
    await runMigration(dir, version)
    expect(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')).toBe(before)
    const reopened = await open(dir)
    expect(bindings(reopened)['edit.italic']).toBe('⌘⌃⌥9')
    expect(bindings(reopened)['edit.bold']).toBe('⌘⌃⌥7')
    await reopened.close()
  })

  test('a refused chord freed in the current store lands individually and stays accepted on later launches', async () => {
    const dir = fresh()
    legacy(dir, { 'plan.addPart': 'X', 'edit.bold': '⌘I' })
    await runMigration(dir, version) // bold conflicts with italic's default
    const store = await open(dir)
    await store.rebind('edit.italic', '⌘⌃⌥8')
    await store.rebind('edit.mark', '⌘⌃⌥7')
    await store.close()
    expect(await runMigration(dir, version)).toMatchObject({ kind: 'again', applied: ['shortcuts.overrides/edit.bold'], refused: [] })
    const reopened = await open(dir)
    expect(bindings(reopened)['edit.bold']).toBe('⌘I')
    expect(bindings(reopened)['edit.italic']).toBe('⌘⌃⌥8')
    expect(bindings(reopened)['edit.mark']).toBe('⌘⌃⌥7')
    expect(bindings(reopened)['plan.add-part']).toBe('X')
    await reopened.close()
    const after = readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')
    expect(await runMigration(dir, version)).toMatchObject({ kind: 'none' })
    expect(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')).toBe(after)
    expect(stamp(dir).refusals).toEqual({})
  })

  test('retry protects a changed command from current state even with no retained history', async () => {
    const dir = fresh()
    legacy(dir, { 'edit.bold': '⌘I' })
    await runMigration(dir, version)
    const store = await open(dir)
    await store.rebind('edit.bold', '⌘⌃⌥7')
    await store.rebind('edit.italic', '⌘⌃⌥8')
    await store.close()
    forgetHistory(dir)
    const before = readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')
    expect(await runMigration(dir, version)).toMatchObject({ applied: [], kept: ['shortcuts.overrides/edit.bold'] })
    expect(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')).toBe(before)
  })

  test('retry never steals a chord currently bound to another command', async () => {
    const dir = fresh()
    legacy(dir, { 'edit.bold': '⌘I' })
    await runMigration(dir, version)
    const store = await open(dir)
    await store.rebind('edit.italic', '⌘⌃⌥8')
    await store.rebind('edit.mark', '⌘I')
    await store.close()
    forgetHistory(dir)
    const before = readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')
    expect(await runMigration(dir, version)).toMatchObject({ applied: [], refused: ['shortcuts.overrides/edit.bold'] })
    expect(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')).toBe(before)
  })

  test('a genuine accepted-subset downgrade edit still migrates under the per-key conflict rule', async () => {
    const dir = fresh()
    legacy(dir, { 'edit.italic': '⌃⌥⌘9', 'edit.bold': '⌘W' })
    await runMigration(dir, version)
    const before = stamp(dir).keys['shortcuts.overrides'].hash
    legacy(dir, { 'edit.italic': '⌃⌥⌘8', 'edit.bold': '⌘W' })
    expect(await runMigration(dir, version)).toMatchObject({ applied: ['shortcuts.overrides'], refused: ['shortcuts.overrides/edit.bold'] })
    expect(stamp(dir).keys['shortcuts.overrides'].hash).not.toBe(before)
    const store = await open(dir)
    expect(bindings(store)['edit.italic']).toBe('⌘⌃⌥8')
    await store.rebind('edit.italic', '⌘⌃⌥7')
    await store.close()
    legacy(dir, { 'edit.italic': '⌃⌥⌘6', 'edit.bold': '⌘W' })
    expect(await runMigration(dir, version)).toMatchObject({ kept: ['shortcuts.overrides'], applied: [] })
  })

  test('a retry may replace the non-default value migration last wrote, without resetting other commands', async () => {
    const dir = fresh()
    legacy(dir, { 'edit.bold': '⌃⌥⌘9' })
    await runMigration(dir, version)
    legacy(dir, { 'edit.bold': '⌘W' })
    await runMigration(dir, version)
    const store = await open(dir)
    expect(bindings(store)['edit.bold']).toBe('⌘⌃⌥9')
    await store.rebind('edit.italic', '⌘⌃⌥8')
    await store.close()
    forgetHistory(dir)
    legacy(dir, { 'edit.bold': '⌃⌥⌘7' })
    expect(await runMigration(dir, version)).toMatchObject({ applied: ['shortcuts.overrides/edit.bold'] })
    const reopened = await open(dir)
    expect(bindings(reopened)['edit.bold']).toBe('⌘⌃⌥7')
    expect(bindings(reopened)['edit.italic']).toBe('⌘⌃⌥8')
    await reopened.close()
  })

  test('Guide progress waits for persistence before announcing and propagates a failed save', async () => {
    let finish!: () => void
    const pending = new Promise<null>((resolve) => { finish = () => resolve(null) })
    const events: string[] = []
    const guide = new GuideProgressStore({ get: () => null, set: () => pending })
    guide.onChange = (key) => events.push(key)
    const saving = guide.commandRan('fold.current')
    expect(events).toEqual([])
    finish()
    await saving
    expect(events).toEqual(['guide.progress'])
    const rejected = new GuideProgressStore({ get: () => null, set: async () => { throw new Error('not saved') } })
    rejected.onChange = () => events.push('failed-save')
    await expect(rejected.commandRan('fold.current')).rejects.toThrow('not saved')
    expect(events).not.toContain('failed-save')
  })

  test('a non-string legacy model provider is never coerced into a model reference', () => {
    for (const provider of [42, true, {}, []]) {
      expect(preferencesFromLegacy({ modelDefaults: { provider, modelId: 'gpt-5.5' } })['agent.model']).toBe('openai-codex::gpt-5.5')
    }
  })

  test('missing-store errors explain restoring the file or starting a fresh shared migration', async () => {
    const dir = fresh()
    legacy(dir, {})
    await runMigration(dir, version)
    const store = await open(dir)
    rmSync(join(dir, SETTINGS_V2_FILE))
    const outcome = await runMigration(dir, version)
    expect(outcome).toMatchObject({ kind: 'refused' })
    if (outcome.kind === 'refused') {
      expect(outcome.reason).toContain('start fresh')
      expect(outcome.reason).toContain(STAMP_FILE)
      expect(outcome.reason).toContain('close WriteFlex')
    }
    const result = await store.set('appearance.theme', 'dark')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('start fresh')
    await store.close()
  })
})
