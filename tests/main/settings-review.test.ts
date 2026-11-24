import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore as LegacyStore } from '../../src/main/settings'
import { openPreferences } from '../../src/main/shared-preferences'
import { runMigration, STAMP_FILE, storeOptions } from '../../src/main/settings-migration'
import { acquireLock } from '@app-patterns/settings/node'
import { emptyState } from '@app-patterns/settings'
import { handOverFor } from '../../src/shared/settings-schema'
import { requireSettingsPagePreference } from '../../src/main/main-window-settings'
import { run as cli } from '../../src/cli/settings-cli'
import { SharedSettingsStore } from '../../src/main/shared-settings-store'
import { APP_KEYS_SETTING, LEGACY_OVERRIDES_KEY } from '../../src/shared/keymap-overrides'
import { bridleChordOf, registry, writeflexIdOf } from '../../src/shared/bridle-commands'
const version = '0.29.0-alpha.1'
function fixture(values: Record<string, unknown>, extra = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'wf-settings-review-'))
  const file = join(dir, 'settings.json')
  fs.writeFileSync(file, JSON.stringify({ values, ...extra }))
  return { dir, file, legacy: new LegacyStore(file) }
}
test('A: an unwritable settings folder opens a read-only legacy overlay', async () => {
  const f = fixture({ 'editor.typewriter': true })
  const before = fs.readFileSync(f.file, 'utf8')
  fs.chmodSync(f.dir, 0o500)
  try {
    const opened = await openPreferences(f.legacy, f.dir, version, () => {})
    expect(opened.active).toBe(false)
    expect(opened.store.problem()).toBeTruthy()
    expect(f.legacy.get('editor.typewriter')).toBe(true)
    expect(await opened.store.set('editor.typewriter', false)).toMatchObject({ ok: false })
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before)
    expect(fs.existsSync(join(f.dir, STAMP_FILE))).toBe(false)
    await opened.close()
  } finally { fs.chmodSync(f.dir, 0o700) }
})
for (const code of ['EACCES', 'EROFS', 'ENOSPC', 'EPERM']) test(`A: ${code} while linking migration is an unavailable store, not failed startup`, async () => {
  const f = fixture({ 'editor.typewriter': true })
  const injected = { ...fs, linkSync: () => { throw Object.assign(new Error('synthetic write failure'), { code }) } } as typeof fs
  const opened = await openPreferences(f.legacy, f.dir, version, () => {}, { fs: injected })
  expect(opened.active).toBe(false)
  expect(f.legacy.get('editor.typewriter')).toBe(true)
  expect(fs.readdirSync(f.dir)).toEqual(['settings.json'])
  await opened.close()
})
test('B: generic app-key resets and Advanced reset never silently remove migrated shortcuts', async () => {
  const f = fixture({ [LEGACY_OVERRIDES_KEY]: JSON.stringify({ 'view.typewriter': 'X' }) })
  await runMigration(f.dir, version)
  const store = new SharedSettingsStore({ ...storeOptions(f.dir, version), watch: false })
  await store.ready
  try {
    const before = store.view().settings[APP_KEYS_SETTING]
    expect(await store.reset(APP_KEYS_SETTING)).toMatchObject({ ok: false })
    expect(await store.resetSection('advanced')).toMatchObject({ ok: true })
    expect(store.view().settings[APP_KEYS_SETTING]).toBe(before)
  } finally { await store.close() }
})
for (const action of ['row', 'section', 'shortcuts', 'all'] as const) test(`follow-up: migrated shortcut ${action} reset logs the actual prior chord and preserves legacy bytes`, async () => {
  const f = fixture({ [LEGACY_OVERRIDES_KEY]: JSON.stringify({ 'view.typewriter': 'X', 'plan.addPart': 'Y', 'plan.adoptPart': '' }) })
  const before = fs.readFileSync(f.file, 'utf8')
  await runMigration(f.dir, version)
  const store = new SharedSettingsStore({ ...storeOptions(f.dir, version), watch: false })
  await store.ready
  try {
    expect(store.view().keys).toEqual({})
    const result = action === 'row' ? await store.reset({ commandId: 'view.typewriter' }) : action === 'section' ? await store.resetSection('shortcuts') : action === 'shortcuts' ? await store.resetShortcuts() : await store.resetAll()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ids = action === 'row' ? [['view.typewriter', 'X']] : [['view.typewriter', 'X'], ['plan.add-part', 'Y'], ['plan.adopt-part', '']]
    for (const [commandId, from] of ids) {
      expect(result.entries.find(e => e.commandId === commandId)).toMatchObject({ commandId, from, to: registry.byId(commandId)!.key, who: { kind: 'you' } })
    }
    expect(store.view().settings[APP_KEYS_SETTING] ?? '').toBe(action === 'row' ? JSON.stringify({ 'plan.addPart': 'Y', 'plan.adoptPart': '' }) : '')
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before)
    await store.reload()
    for (const [commandId] of ids) expect(store.view().changes.some(e => e.commandId === commandId)).toBe(true)
    expect(await runMigration(f.dir, version)).toMatchObject({ kind: 'none' })
  } finally { await store.close(); fs.rmSync(f.dir, { recursive: true, force: true }) }
})
test('follow-up: rebinding a migrated key records its effective old chord once', async () => {
  const f = fixture({ [LEGACY_OVERRIDES_KEY]: JSON.stringify({ 'view.typewriter': 'X' }) })
  await runMigration(f.dir, version)
  const store = new SharedSettingsStore({ ...storeOptions(f.dir, version), watch: false })
  await store.ready
  try {
    const result = await store.rebind('view.typewriter', '⌘⌥T')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries.filter(e => e.commandId)).toMatchObject([{ commandId: 'view.typewriter', from: 'X', to: '⌘⌥T' }])
    expect(store.view().settings[APP_KEYS_SETTING] ?? '').toBe('')
    expect(store.view().keys['view.typewriter']).toBe('⌘⌥T')
  } finally { await store.close(); fs.rmSync(f.dir, { recursive: true, force: true }) }
})
test('C: physical Equal owns both legacy plus defaults', () => {
  expect(bridleChordOf('⌘+')).toBe('⌘=')
  expect(bridleChordOf('⌥⌘+')).toBe('⌘⌥=')
  expect(registry.byId('view.prose-increase')?.key).toBe('⌘=')
  expect(registry.checkRebind(registry.resolveBindings().bindings, 'view.typewriter', '⌘=')).toMatchObject({ kind: 'taken' })
})
test('C: an explicitly empty default binding is landed and stamped', async () => {
  const def = registry.defs.find(d => !d.fixed && !d.scope && d.key === '' && writeflexIdOf(d.id))!
  const id = writeflexIdOf(def.id)!
  const f = fixture({ [LEGACY_OVERRIDES_KEY]: JSON.stringify({ [id]: '' }) })
  expect(await runMigration(f.dir, version)).toMatchObject({ kind: 'first', notSaved: [] })
  expect(JSON.parse(fs.readFileSync(join(f.dir, STAMP_FILE), 'utf8')).keys[LEGACY_OVERRIDES_KEY]).toBeTruthy()
})
test('F: fixed contextual commands cannot be rebound', () => {
  for (const id of ['idea.materialise', 'navigation.follow-wikilink', 'edit.toggle-checkbox']) {
    expect(registry.byId(id)?.fixed).toBe(true)
    expect(registry.checkRebind(registry.resolveBindings().bindings, id, '⌘⌥Y')).toMatchObject({ kind: 'fixed' })
  }
})
for (const stamp of ['missing', 'broken']) test(`K: ${stamp} stamp preserves an intact store even after history has been trimmed`, async () => {
  const f = fixture({ 'editor.typewriter': true })
  await runMigration(f.dir, version)
  const path = join(f.dir, 'settings-v2.json')
  const state = JSON.parse(fs.readFileSync(path, 'utf8'))
  state.settings['editor.typewriter'] = false; state.changes = []
  fs.writeFileSync(path, JSON.stringify(state))
  if (stamp === 'missing') fs.unlinkSync(join(f.dir, STAMP_FILE))
  else fs.writeFileSync(join(f.dir, STAMP_FILE), '{broken')
  const before = fs.readFileSync(path, 'utf8')
  await runMigration(f.dir, version)
  expect(fs.readFileSync(path, 'utf8')).toBe(before)
})

for (const value of [{ key: 'arbitrary.endpoint', value: 'x' }, { key: 'guide.progress', value: 'x'.repeat(100_000) }, { key: 'keyboard.appKeys', value: '{}' }, { key: 'updates.alphaVersions', value: 'true' }, { key: 'updates.alphaVersions', value: Infinity }]) test(`E: custom preference writer refuses ${String(value.key)}/${typeof value.value}`, () => {
  expect(() => requireSettingsPagePreference(value)).toThrow()
})
test('E: the custom update controls retain their bounded boolean capability', () => {
  expect(requireSettingsPagePreference({ key: 'updates.alphaVersions', value: false })).toEqual({ key: 'updates.alphaVersions', value: false })
})
test('H: read-only migration fallback includes the legacy model defaults', async () => {
  const f = fixture({}, { modelDefaults: { provider: 'anthropic', modelId: 'claude-model', thinkingLevel: 'high' } })
  fs.writeFileSync(join(f.dir, 'settings-v2.json'), '{broken')
  const opened = await openPreferences(f.legacy, f.dir, version, () => {})
  expect(f.legacy.get('agent.model')).toBe('anthropic::claude-model')
  expect(f.legacy.get('agent.thinkingLevel')).toBe('high')
  expect(opened.store.view().settings['agent.model']).toBe('anthropic::claude-model')
  await opened.close()
})
test('B: CLI reset routes preserve app keys or explicitly refuse their direct reset', async () => {
  const f = fixture({ [LEGACY_OVERRIDES_KEY]: JSON.stringify({ 'view.typewriter': 'X' }) })
  await runMigration(f.dir, version)
  const path = join(f.dir, 'settings-v2.json')
  const before = JSON.parse(fs.readFileSync(path, 'utf8')).settings[APP_KEYS_SETTING]
  const io = { stdout: (_s: string) => {}, stderr: (_s: string) => {} }
  expect(await cli(['reset', '--section', 'advanced'], io, f.dir, version)).toBe(0)
  expect(JSON.parse(fs.readFileSync(path, 'utf8')).settings[APP_KEYS_SETTING]).toBe(before)
  expect(await cli(['reset', APP_KEYS_SETTING], io, f.dir, version)).not.toBe(0)
  expect(JSON.parse(fs.readFileSync(path, 'utf8')).settings[APP_KEYS_SETTING]).toBe(before)
})
test('B: resetting an app-key changelog entry is refused instead of silently removing keys', async () => {
  const f = fixture({ [LEGACY_OVERRIDES_KEY]: JSON.stringify({ 'view.typewriter': 'X' }) })
  await runMigration(f.dir, version)
  const path = join(f.dir, 'settings-v2.json'), state = JSON.parse(fs.readFileSync(path, 'utf8'))
  const value = state.settings[APP_KEYS_SETTING]
  state.changes.unshift({ id: 'app-key-entry', key: APP_KEYS_SETTING, from: '', to: value, at: 1, who: { kind: 'app-update', version } })
  fs.writeFileSync(path, JSON.stringify(state))
  const store = new SharedSettingsStore({ ...storeOptions(f.dir, version), watch: false })
  await store.ready
  try {
    expect(await store.resetEntry('app-key-entry')).toMatchObject({ ok: false })
    expect(store.view().settings[APP_KEYS_SETTING]).toBe(value)
  } finally { await store.close() }
})
test('L: hand-over recovery waits for the file lock and preserves a concurrent CLI commit', async () => {
  const f = fixture({ 'appearance.theme': 'light' })
  const path = join(f.dir, 'settings-v2.json')
  fs.writeFileSync(path, JSON.stringify(handOverFor({ 'appearance.theme': 'dark' })))
  const before = fs.readFileSync(path, 'utf8')
  const lock = await acquireLock(path)
  const migration = runMigration(f.dir, version)
  try {
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(fs.readFileSync(path, 'utf8')).toBe(before)
    const committed = { ...emptyState('writeflex'), settings: { 'appearance.theme': 'dark' } }
    fs.writeFileSync(path, JSON.stringify(committed))
  } finally { await lock.release() }
  expect(await migration).toEqual({ kind: 'none' })
  expect(JSON.parse(fs.readFileSync(path, 'utf8')).settings['appearance.theme']).toBe('dark')
})
for (const step of ['writeSync', 'stamp']) test(`A: failed ${step} returns a read-only overlay and removes its temporary file`, async () => {
  const f = fixture({ 'appearance.theme': 'dark' })
  const injected = { ...fs,
    ...(step === 'writeSync' ? { writeSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) } } : {
      renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to).endsWith(STAMP_FILE)) throw Object.assign(new Error('read only stamp'), { code: 'EROFS' })
        fs.renameSync(from, to)
      },
    }),
  } as typeof fs
  const opened = await openPreferences(f.legacy, f.dir, version, () => {}, { fs: injected })
  expect(opened.active).toBe(false)
  expect(f.legacy.get('appearance.theme')).toBe('dark')
  expect(fs.readdirSync(f.dir).some(name => name.endsWith('.tmp'))).toBe(false)
  await opened.close()
})

test('F: an older mixed app-key file is refused intact, never lossy-rewritten when a key becomes fixed', async () => {
  const f = fixture({})
  const path = join(f.dir, 'settings-v2.json')
  const state = { ...emptyState('writeflex'), settings: { [APP_KEYS_SETTING]: JSON.stringify({ 'view.typewriter': 'X', 'edit.toggleCheckbox': '⌘⌥Y' }) } }
  const before = JSON.stringify(state)
  fs.writeFileSync(path, before)
  expect(await runMigration(f.dir, version)).toMatchObject({ kind: 'refused' })
  expect(fs.readFileSync(path, 'utf8')).toBe(before)
})
