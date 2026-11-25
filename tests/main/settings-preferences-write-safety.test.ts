import { buildCommandMenu as nativeCommandMenu } from '../../src/shared/command-menu'
import { registry } from '../../src/shared/bridle-commands'
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore as LegacyStore } from '../../src/main/settings'
import { SettingsStore as BridleStore } from '@app-patterns/settings/node'
import { SharedSettingsStore } from '../../src/main/shared-settings-store'
import { openPreferences, followSharedSettingsMenu } from '../../src/main/shared-preferences'
import { MAIN_WINDOW_PREFERENCE_KEYS, writeMainWindowPreference } from '../../src/main/main-window-settings'
import { runMigration, storeOptions } from '../../src/main/settings-migration'
import { APP_KEYS_SETTING, effectiveBindings, overridesFromStore } from '../../src/shared/keymap-overrides'
import { SETTINGS_V2_FILE } from '../../src/shared/settings-schema'
import { run as cli } from '../../src/cli/settings-cli'
import { commandRegistry } from '../../src/renderer/src/commands/registry'
import { effectiveSheetChords } from '../../src/renderer/src/commands/chords'

const version = '0.27.0-alpha.2'
const fresh = () => mkdtempSync(join(tmpdir(), 'wf-settings-write-safety-'))
const legacy = (dir: string, values = {}) => {
  const path = join(dir, 'settings.json')
  writeFileSync(path, JSON.stringify({ values }))
  return new LegacyStore(path)
}
const migratingKeys = async (dir: string) => {
  legacy(dir, { 'shortcuts.overrides': JSON.stringify({ 'view.typewriter': 'X' }) })
  await runMigration(dir, version)
  const store = new SharedSettingsStore({ ...storeOptions(dir, version), watch: false, log: () => {} })
  await store.ready
  return store
}

test('unreadable/refused/unsaved migration leaves legacy preferences read-only and reports the store problem', async () => {
  for (const target of ['{broken', JSON.stringify({ format: 'bridle-settings', version: 999, app: 'writeflex' })]) {
    const dir = fresh()
    const old = legacy(dir, { 'editor.typewriter': true })
    writeFileSync(join(dir, SETTINGS_V2_FILE), target)
    const before = readFileSync(join(dir, 'settings.json'), 'utf8')
    const opened = await openPreferences(old, dir, version, () => {})
    expect(opened.active).toBe(false)
    expect(opened.store.problem()?.error).toContain('read-only')
    expect(old.get('editor.typewriter')).toBe(true)
    await expect(old.setPersisted('editor.typewriter', false, 'Typewriter')).rejects.toThrow('read-only')
    await expect(old.set('editor.typewriter', false, 'Typewriter')).rejects.toThrow('read-only')
    expect((await opened.store.set('editor.typewriter', false)).ok).toBe(false)
    await opened.close()
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(before)
    expect(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')).toBe(target)
    expect(readdirSync(dir).some((name) => name.includes('damaged'))).toBe(false)
  }
})

test('unreadable legacy JSON opens no shared file and still refuses schema preference writes', async () => {
  const dir = fresh()
  const old = legacy(dir)
  writeFileSync(join(dir, 'settings.json'), '{bad')
  const opened = await openPreferences(old, dir, version, () => {})
  expect(opened.active).toBe(false)
  await expect(old.setPersisted('editor.typewriter', true, 'Typewriter')).rejects.toThrow('read-only')
  expect(readdirSync(dir)).toEqual(['settings.json'])
  await opened.close()
})

test('main-window write waits for persistence and broadcasts the saved value or rollback on failure', async () => {
  const dir = fresh()
  const old = legacy(dir)
  let resolveWrite!: () => void
  let rejectWrite!: (error: Error) => void
  const pending = new Promise<void>((resolve, reject) => { resolveWrite = resolve; rejectWrite = reject })
  old.attachShared({ owns: (key) => key === 'editor.typewriter', get: () => null, values: () => ({}), persist: () => pending })
  const broadcasts: unknown[] = []
  let finished = false
  const writing = writeMainWindowPreference(old, { key: 'editor.typewriter', value: true, label: 'Typewriter' }, (key) => broadcasts.push({ key, value: old.get(key) })).finally(() => { finished = true })
  await Promise.resolve()
  expect(finished).toBe(false)
  expect(broadcasts).toEqual([])
  rejectWrite(new Error('disk unavailable'))
  await expect(writing).rejects.toThrow('disk unavailable')
  expect(broadcasts).toEqual([{ key: 'editor.typewriter', value: null }])
})

test('a real refused shared write returns its error, restores every editor and leaves both files unchanged', async () => {
  const dir = fresh()
  const old = legacy(dir, { 'editor.typewriter': true })
  const opened = await openPreferences(old, dir, version, () => {})
  const before = readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')
  ;(opened.store as SharedSettingsStore).refuseWrites('settings lock unavailable')
  const editors: unknown[][] = [[], []]
  await expect(writeMainWindowPreference(old, { key: 'editor.typewriter', value: false, label: 'Typewriter' }, (key) => editors.forEach((events) => events.push(old.get(key))))).rejects.toThrow('settings lock unavailable')
  expect(editors).toEqual([[true], [true]])
  expect(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')).toBe(before)
  await opened.close()
})

test('the main-window allow-list refuses secrets, keyboard, paths, models and Settings-only keys', async () => {
  const dir = fresh()
  const old = legacy(dir)
  const before = readFileSync(join(dir, 'settings.json'), 'utf8')
  for (const key of ['accounts.anthropic', 'keyboard.appKeys', 'shortcuts.overrides', 'diary.folder', 'cli.path', 'agent.model', 'agent.thinkingLevel', 'workspace.watchExternalChanges', 'permissions.createFiles', 'arbitrary.endpoint']) {
    await expect(writeMainWindowPreference(old, { key, value: 'secret-shaped-value', label: 'Key' }, () => { throw new Error('must not broadcast a refused target') })).rejects.toThrow('Settings window')
  }
  expect(MAIN_WINDOW_PREFERENCE_KEYS.has('editor.typewriter')).toBe(true)
  expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(before)
  expect(JSON.stringify(old.values())).not.toContain('secret-shaped-value')
  expect(JSON.stringify(old.changelog())).not.toContain('secret-shaped-value')
})

test('the existing assistant mode control persists through the main-window bridge', async () => {
  const dir = fresh()
  const old = legacy(dir)
  const opened = await openPreferences(old, dir, version, () => {})
  try {
    const changes: string[] = []
    await writeMainWindowPreference(old, { key: 'agent.mode', value: 'read-only', label: 'Assistant mode' }, key => changes.push(key))
    expect(old.get('agent.mode')).toBe('read-only')
    // Mode remains app state in the legacy file; it is not a transferable shared preference.
    expect(new LegacyStore(join(dir, 'settings.json')).get('agent.mode')).toBe('read-only')
    expect(changes).toEqual(['agent.mode'])
  } finally { await opened.close() }
})

test('rebind/reset removes migrated app keys in the same file write, even an app-only reset', async () => {
  for (const action of ['rebind', 'reset', 'reset-shortcuts', 'reset-section', 'reset-all']) {
    const dir = fresh()
    const store = await migratingKeys(dir)
    expect(JSON.parse(String(store.view().settings[APP_KEYS_SETTING]))).toEqual({ 'view.typewriter': 'X' })
    let writes = 0
    const update = store.file.update.bind(store.file)
    store.file.update = ((step: any) => update(async (read) => { const out = await step(read); if (out.write) writes += 1; return out })) as typeof store.file.update
    const result = action === 'rebind' ? await store.rebind('view.typewriter', '⌘⌥Y') : action === 'reset' ? await store.reset({ commandId: 'view.typewriter' }) : action === 'reset-shortcuts' ? await store.resetShortcuts() : action === 'reset-section' ? await store.resetSection('shortcuts') : await store.resetAll()
    expect(result.ok).toBe(true)
    expect(store.view().settings[APP_KEYS_SETTING]).toBeUndefined()
    expect(writes).toBe(1)
    await store.reset({ commandId: 'view.typewriter' })
    const state = store.view()
    const effective = effectiveBindings(state.keys, state.settings[APP_KEYS_SETTING])
    const renderer = overridesFromStore(state.keys, state.settings[APP_KEYS_SETTING])
    expect(effective['view.typewriter']).toBe('⌘T')
    expect(renderer['view.typewriter']).toBeUndefined()
    const row = commandRegistry.find((c) => c.sheetSource?.kind === 'command' && c.sheetSource.commandId === 'view.typewriter')!
    expect(effectiveSheetChords(row, renderer)).toEqual(['⌘T'])
    await store.close()
  }
})

test('CLI rebind/reset also removes migration-only overrides instead of resurrecting them', async () => {
  for (const args of [['--json', 'rebind', 'view.typewriter', 'cmd+alt+y'], ['--json', 'reset-shortcut', 'view.typewriter'], ['--json', 'reset', '--section=shortcuts'], ['rebind', 'view.typewriter', 'cmd+alt+y'], ['reset-shortcut', 'view.typewriter'], ['reset-shortcut', '--all', '--yes'], ['reset', '--section', 'shortcuts']]) {
    const dir = fresh()
    const store = await migratingKeys(dir)
    await store.close()
    let stdout = ''; let stderr = ''
    expect(await cli([...args, '--json'], { stdout: (s) => { stdout += s }, stderr: (s) => { stderr += s }, env: {} }, dir, version)).toBe(0)
    const saved = JSON.parse(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8'))
    expect(saved.settings[APP_KEYS_SETTING]).toBeUndefined()
    expect(saved.changes[0].who.kind === 'agent' || saved.changes[0].who.by?.kind === 'agent').toBe(true)
    expect(stderr).toBe('')
  }
})

test('app keys are not writable via the shared store, CLI, import or a forged import preview', async () => {
  const dir = fresh()
  const store = await migratingKeys(dir)
  const before = readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')
  expect((await store.set(APP_KEYS_SETTING, JSON.stringify({ 'app.quickOpen': '⌥⌘9' }))).ok).toBe(false)
  const preview = store.previewImport({ format: 'bridle-settings-export', version: 1, app: 'writeflex', settings: { [APP_KEYS_SETTING]: JSON.stringify({ 'edit.mark': 'X' }) }, keys: {} })
  expect(preview.changes).toEqual([])
  expect(preview.skipped.some((s) => s.key === APP_KEYS_SETTING)).toBe(true)
  const forged = await store.applyImport({ changes: [{ key: APP_KEYS_SETTING, from: '', to: '{"edit.mark":"Z"}', section: 'advanced' }], skipped: [], alreadyMatch: 0 }, { file: 'forged.json' })
  expect(forged.ok).toBe(false)
  await store.close()
  expect(await cli(['set', APP_KEYS_SETTING, '{"edit.mark":"Z"}', '--json'], { stdout: () => {}, stderr: () => {} }, dir, version)).toBe(2)
  expect(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')).toBe(before)
})


test('migrated bare keys remain in the renderer without becoming native menu accelerators', async () => {
  const store = await migratingKeys(fresh())
  const state = store.view()
  const renderer = overridesFromStore(state.keys, state.settings[APP_KEYS_SETTING])
  expect(renderer['view.typewriter']).toBe('X')
  const menu = nativeCommandMenu([{ id: 'view.typewriter', label: 'Typewriter mode', task: 'Stay focused', subgroup: 'Typewriter', chord: renderer['view.typewriter'], enabled: true }])
  const items = (nodes: typeof menu): typeof menu => nodes.flatMap(n => [n, ...items(n.submenu ?? [])])
  expect(items(menu).find(n => n.id === 'view.typewriter')?.accelerator).toBeUndefined()
  await store.close()
})

test('the Settings host rebuilds the menu when an app-only shortcut is reset', async () => {
  const dir = fresh()
  const old = legacy(dir, { 'shortcuts.overrides': '{"view.typewriter":"X"}' })
  const opened = await openPreferences(old, dir, version, () => {})
  let rebuilt = 0
  followSharedSettingsMenu(opened, { storeChanged: () => {}, rebuildMenu: () => { rebuilt += 1 } })
  expect((await opened.store.reset({ commandId: 'view.typewriter' })).ok).toBe(true)
  expect(rebuilt).toBe(1)
  await opened.close()
})


test('a migration whose hand-over was not saved exposes legacy values read-only', async () => {
  const dir = fresh()
  const old = legacy(dir, { 'editor.typewriter': true })
  const notSaving = new BridleStore({ ...storeOptions(fresh(), version), watch: false, log: () => {} })
  const opened = await openPreferences(old, dir, version, () => {}, { open: () => notSaving })
  expect(opened.migration.kind).toBe('not-saved')
  expect(opened.active).toBe(false)
  expect(opened.store.problem()?.error).toContain('could not be saved')
  await expect(writeMainWindowPreference(old, { key: 'editor.typewriter', value: false, label: 'Typewriter' }, () => {})).rejects.toThrow('read-only')
  expect(old.get('editor.typewriter')).toBe(true)
  expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).values['editor.typewriter']).toBe(true)
  expect(JSON.parse(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8'))['writeflex-legacy-preferences']).toBe(1)
  await opened.close()
})

test('CLI reset-all-shortcuts does not ask for confirmation when only ordinary preferences differ', async () => {
  const dir = fresh()
  legacy(dir, { 'appearance.theme': 'dark' })
  await runMigration(dir, version)
  let stdout = ''
  expect(await cli(['reset-shortcut', '--all', '--json'], { stdout: (s) => { stdout += s }, stderr: () => {}, env: {} }, dir, version)).toBe(0)
  expect(JSON.parse(stdout).changed).toBe(false)
  expect(JSON.parse(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')).settings['appearance.theme']).toBe('dark')
})
