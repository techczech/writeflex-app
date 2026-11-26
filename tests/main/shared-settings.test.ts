// Shared settings (0.27): the command registry and its menu bar, the shortcut split, the slots, the
// Settings-window-only IPC, the legacy file overlay, the CLI and the import rule. Nothing here starts
// Electron or reads the real userData folder or Keychain: every store is in a temporary folder and the
// credential store is a fake.
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonChord, validateMenuCoverage } from '@app-patterns/commands'
import { NOT_IMPORTABLE } from '@app-patterns/settings'
import { SettingsStore as SharedStore } from '@app-patterns/settings/node'
import { catalogueSource, CATALOGUE_PATH } from '../../scripts/generate-command-catalogue'
import { COMMAND_CATALOGUE } from '../../src/shared/command-catalogue'
import { DEFS, MENUS, bridleChordOf, bridleIdOf, registryHoldsKeyOf, registry, writeflexChordOf, writeflexIdOf } from '../../src/shared/bridle-commands'
import { APP_KEYS_SETTING, appKeysError, overridesFromStore, splitOverrides } from '../../src/shared/keymap-overrides'
import { SETTINGS_V2_FILE, THIS_MAC_ONLY, schema } from '../../src/shared/settings-schema'
import { defaultChords } from '../../src/renderer/src/commands/chords'
import { canonicalChord } from '../../src/renderer/src/app/shortcuts'
import { allBindableCommands, commandRegistry } from '../../src/renderer/src/commands/registry'
import { NATIVE_MENU_COMMANDS } from '../../src/shared/native-menu-commands'
import { AuthKeySlots, type AuthLike } from '../../src/main/key-slots'
import { SETTINGS_ONLY_AUTH_CHANNELS, settingsWindowOnlyAuth } from '../../src/main/auth-guard'
import { SettingsStore as LegacyStore } from '../../src/main/settings'
import { storeOptions } from '../../src/main/settings-migration'
import { run as runSettingsCli } from '../../src/cli/settings-cli'
import { settingsPageOf } from '../../src/renderer/src/app/settings-page-of'

const fresh = (): string => mkdtempSync(join(tmpdir(), 'wf-shared-settings-'))

// ---- The registry ----------------------------------------------------------------------------

test('the generated command catalogue matches the renderer registry (run bun run commands:generate)', () => {
  expect(readFileSync(CATALOGUE_PATH, 'utf8')).toBe(catalogueSource())
})

test('active-file palette actions can be rebound without claiming the Files pane defaults', () => {
  for (const id of ['file.rename', 'file.move', 'file.duplicate', 'file.trash']) {
    expect(registry.byId(id)).toMatchObject({ key: '' })
    expect(registryHoldsKeyOf(id)).toBe(true)
  }
  expect(registry.byId('edit.select-next-occurrence')?.key).toBe('⌘D')
})

test('every palette command is in the shared registry, and every bindable one may be rebound unless fixed or scoped', () => {
  const palette = commandRegistry.filter((c) => c.surfaces.includes('palette'))
  for (const command of palette) {
    const id = bridleIdOf(command.id)
    expect(registry.byId(id), command.id).toBeDefined()
    if (command.id !== 'app.settings' && command.id !== 'app.shortcuts') expect(writeflexIdOf(id)).toBe(command.id)
  }
  const bindable = new Set(allBindableCommands().map((c) => c.id))
  // What the old Keycap Ledger would not rebind stays fixed in Settings › Shortcuts.
  for (const command of palette) if (!bindable.has(command.id) && !registry.byId(bridleIdOf(command.id))?.scope && registry.byId(bridleIdOf(command.id))?.group !== 'App') expect(registry.byId(bridleIdOf(command.id))?.fixed, command.id).toBe(true)
  expect(new Set(DEFS.map((d) => d.id)).size).toBe(DEFS.length)
})

test('the menu bar covers every command; the ones left out say why', () => {
  expect(validateMenuCoverage(registry, MENUS)).toEqual([])
  for (const def of registry.defs) if (def.noMenu) expect(def.noMenuReason, def.id).toBeTruthy()
})

test('chords convert between the renderer’s spelling and the registry’s without changing meaning', () => {
  for (const row of COMMAND_CATALOGUE) {
    for (const chord of row.keys) {
      const bridle = bridleChordOf(chord)
      if (!bridle) continue
      expect(canonChord(bridle)).toBe(bridle)
      expect(writeflexChordOf(bridle), `${row.id} ${chord}`).toBe(chord === '⌘?' || chord === '?' ? writeflexChordOf(bridle) : canonicalChord(chord.replace(/\+$/, '=')))
    }
  }
  expect(bridleChordOf('⇧⌘D')).toBe('⌘⇧D')
  expect(writeflexChordOf('⌘⌃⌥⇧K')).toBe('⌃⌥⇧⌘K')
})

test('the shared chords keep their jobs: palette, quick open, search, undo, redo, Settings and the cheat sheet', () => {
  const bindings = registry.bindingsOf({})
  expect(registry.commandForChord(bindings, '⌘⇧P')).toBe('app.command-palette')
  expect(registry.commandForChord(bindings, '⌘⇧K')).toBe('app.quick-open')
  expect(registry.commandForChord(bindings, '⌘⇧F')).toBe('app.search')
  expect(registry.commandForChord(bindings, '⌘,')).toBe('settings')
  expect(registry.commandForChord(bindings, '⌘/')).toBe('cheat')
  for (const id of ['app.command-palette', 'app.quick-open', 'app.search', 'edit.undo', 'edit.redo', 'tab.close']) expect(registry.byId(id)?.fixed).toBe(true)
})

test('main-owned menu items keep their old chords', () => {
  const keys = registry.bindingsOf({})
  expect(keys).toMatchObject({ 'file.new': '⌘N', 'folder.new': '⌘⌃N', 'window.new': '⌘⌥N', 'file.open': '⌘O', 'file.checkpoint': '⌘S', 'tab.close': '⌘W' })
  const fileLabels = registry.defs.map(d => d.label)
  for (const def of NATIVE_MENU_COMMANDS.filter(d => 'nativeKey' in d)) expect(fileLabels.filter((l) => l === def.label).length, def.label).toBe(1)
})

// ---- Shortcuts in two places ------------------------------------------------------------------

test('the renderer sees the registry’s overrides over the app layer, in its own spelling', () => {
  const overrides = overridesFromStore({ 'view.typewriter': '⌘⌥Y', 'edit.italic': '', 'file.new': '⌘⌥⇧N' }, JSON.stringify({ 'plan.addPart': 'P', 'view.typewriter': '⌘T' }))
  expect(overrides).toEqual({ 'view.typewriter': '⌥⌘Y', 'edit.italic': '', 'plan.addPart': 'P', 'file.new': '⌥⇧⌘N' })
})

test('splitting old overrides keeps removed keys removed and puts bare, scoped and refused keys in the app layer', () => {
  const split = splitOverrides({ 'edit.italic': '', 'plan.addPart': 'P', 'outline.indentListItem': '⌥⇥', 'app.quickOpen': '⌥⌘O', 'edit.bold': '⌘B', 'edit.mark': 'X' })
  expect(split.keys).toEqual({ 'edit.italic': '' })
  expect(JSON.parse(split.appKeys)).toEqual({ 'plan.addPart': 'P', 'outline.indentListItem': '⌥⇥', 'edit.mark': 'X' })
})

// ---- Accounts and keys ------------------------------------------------------------------------

class FakeAuth implements AuthLike {
  keys = new Map<string, string>()
  signedIn = new Set<string>()
  status(id: string) { return { configured: this.keys.has(id) || this.signedIn.has(id) } }
  setApiKey(id: string, key: string) { this.keys.set(id, key) }
  logout(id: string) { this.keys.delete(id); this.signedIn.delete(id) }
}

test('slots show connected or missing only, and never hand a key back', () => {
  const auth = new FakeAuth()
  auth.signedIn.add('openai-codex')
  const slots = new AuthKeySlots(auth)
  expect(slots.list()).toEqual([
    { id: 'accounts.chatgpt', label: 'ChatGPT', status: 'connected' },
    { id: 'accounts.anthropic', label: 'Anthropic API key', status: 'missing' },
    { id: 'accounts.zai', label: 'Z.ai API key', status: 'missing' },
  ])
  expect(slots.set('accounts.anthropic', 'sk-ant-0123456789abcdef')).toEqual({ ok: true })
  expect(auth.keys.get('anthropic')).toBe('sk-ant-0123456789abcdef')
  expect(JSON.stringify(slots.list())).not.toContain('sk-ant')
  expect(slots.set('accounts.anthropic', 'not-a-key-0123456789')).toMatchObject({ ok: false, refusal: 'shape' })
  expect(slots.set('accounts.chatgpt', 'anything')).toMatchObject({ ok: false }) // a sign-in takes no key
  expect(slots.remove('accounts.chatgpt')).toEqual({ ok: true })
  expect(auth.signedIn.has('openai-codex')).toBe(false)
})

test('secrets are schema slots: never stored, exported or listed with a value', async () => {
  const dir = fresh()
  const store = new SharedStore({ ...storeOptions(dir, '0.27.0'), watch: false, log: () => {} })
  await store.ready
  expect((await store.set('accounts.anthropic', 'sk-ant-should-not-store')).ok).toBe(false)
  await store.set('appearance.theme', 'dark')
  const exported = JSON.stringify(store.exportFile({ hostName: 'test' }))
  expect(exported).not.toContain('sk-ant')
  expect(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')).not.toContain('sk-ant')
  await store.close()
})

// ---- The import rule --------------------------------------------------------------------------

test('a settings file from elsewhere never sets the Diary folder (set on this Mac only)', async () => {
  for (const key of THIS_MAC_ONLY) expect(schema.def(key)?.importable).toBe(false)
  expect(schema.settings.filter((d) => d.type === 'path').map((d) => d.key)).toEqual(
    [...THIS_MAC_ONLY].filter((key) => schema.def(key)?.type === 'path'),
  )
  const from = fresh()
  const source = new SharedStore({ ...storeOptions(from, '0.27.0'), watch: false, log: () => {} })
  await source.ready
  await source.set('diary.folder', '/Users/someone/elsewhere')
  await source.set('backupTool.records', '/base/someone/.toolname')
  expect(source.view().settings['backupTool.records']).toBe('/base/someone/.toolname')
  await source.set('appearance.theme', 'dark')
  const file = source.exportFile({ hostName: 'other' })
  await source.close()
  const to = fresh()
  const target = new SharedStore({ ...storeOptions(to, '0.27.0'), watch: false, log: () => {} })
  await target.ready
  const preview = target.previewImport(file)
  expect(JSON.stringify(preview)).toContain(NOT_IMPORTABLE)
  const applied = await target.applyImport(preview, { file: 'other.json' })
  expect(applied.ok).toBe(true)
  expect(target.view().settings['diary.folder']).toBeUndefined()
  expect(target.view().settings['backupTool.records']).toBeUndefined()
  expect(target.view().settings['appearance.theme']).toBe('dark')
  await target.close()
})

test('a settings import leaves the experimental Git sync switch at its local default', async () => {
  const target = new SharedStore({ ...storeOptions(fresh(), '0.27.0'), watch: false, log: () => {} })
  try {
    await target.ready
    const before = target.view()
    const preview = target.previewImport({
      format: 'bridle-settings-export',
      version: 1,
      app: 'writeflex',
      settings: { 'experimental.gitVaultSync': true },
      keys: {},
    })
    expect((await target.applyImport(preview, { file: 'other.json' })).ok).toBe(true)
    expect(target.view()).toEqual(before)
    expect(preview.changes).toEqual([])
    expect(preview.skipped).toEqual([expect.objectContaining({ key: 'experimental.gitVaultSync', reason: NOT_IMPORTABLE })])
  } finally {
    await target.close()
  }
})

// ---- IPC ----------------------------------------------------------------------------------------

test('sign-in, sign-out and key channels answer only the Settings window; the provider list stays open', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc = { handle: (c: string, l: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(c, l) }, removeHandler: (c: string) => { handlers.delete(c) } }
  const settingsEvent = { from: 'settings' }
  const guarded = settingsWindowOnlyAuth(ipc, (event) => event === settingsEvent)
  for (const channel of ['bridle.auth:providers', ...SETTINGS_ONLY_AUTH_CHANNELS]) guarded.handle(channel, () => 'ran')
  expect(await handlers.get('bridle.auth:providers')!({ from: 'main' })).toBe('ran')
  for (const channel of SETTINGS_ONLY_AUTH_CHANNELS) {
    expect(() => handlers.get(channel)!({ from: 'main' })).toThrow()
    expect(await handlers.get(channel)!(settingsEvent)).toBe('ran')
  }
})

test('no WriteFlex IPC channel uses the shared package’s prefixes', () => {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(ts|tsx)$/.test(name)) files.push(path)
    }
  }
  walk(join(import.meta.dir, '../../src'))
  const channel = /(?:handle|invoke|send|on|multiplexIpcChannel<[^>]*>\([^,]+,)\s*\(\s*['"`]((?:bridle-)?settings:[^'"`]*)/
  expect("ipcMain.handle('settings:get'".match(channel)?.[1]).toBe('settings:get') // the check can see one
  expect("ipcRenderer.invoke('bridle-settings:view'".match(channel)?.[1]).toBe('bridle-settings:view')
  for (const file of files) expect(readFileSync(file, 'utf8').match(channel)?.[1], file).toBeUndefined()
  const host = readFileSync(join(import.meta.dir, '../../src/main/settings-host.ts'), 'utf8')
  expect(host).toContain("'menu:command'")
})

test('every Settings-window-only handler checks the whole event with the shared rule', () => {
  const ipc = readFileSync(join(import.meta.dir, '../../src/main/ipc.ts'), 'utf8')
  expect(ipc).toContain('if (!isSettingsSender(event)) throw')
  const index = readFileSync(join(import.meta.dir, '../../src/main/index.ts'), 'utf8')
  expect(index).toContain('if (!settingsApp?.isSettingsSender(event)) throw')
  const host = readFileSync(join(import.meta.dir, '../../src/main/settings-host.ts'), 'utf8')
  expect(host).toContain('host.isSettingsWindowSender(event as unknown')
})

// ---- The old file as the app's state file -------------------------------------------------------

test('once the shared store is attached, preferences are read from it and the old file is not written for them', async () => {
  const dir = fresh()
  const path = join(dir, 'settings.json')
  writeFileSync(path, JSON.stringify({ values: { 'appearance.theme': 'dark', 'export.lastFolder': '/tmp/out' } }))
  const legacy = new LegacyStore(path)
  const before = readFileSync(path, 'utf8')
  const shared = new Map<string, string | number | boolean>([['appearance.theme', 'light']])
  legacy.attachShared({
    owns: (key) => key === 'appearance.theme',
    get: (key) => shared.get(key) ?? null,
    values: () => Object.fromEntries(shared),
    persist: async (key, value) => { if (value === null) shared.delete(key); else shared.set(key, value) },
  })
  expect(legacy.get('appearance.theme')).toBe('light')
  expect(legacy.values()).toEqual({ 'appearance.theme': 'light', 'export.lastFolder': '/tmp/out', 'agent.mode': 'work' })
  await legacy.set('appearance.theme', 'dark', 'Theme')
  expect(shared.get('appearance.theme')).toBe('dark')
  expect(readFileSync(path, 'utf8')).toBe(before)
  await legacy.set('export.lastFolder', '/tmp/next', 'Export folder', { log: false })
  expect(JSON.parse(readFileSync(path, 'utf8')).values['appearance.theme']).toBe('dark') // the old value, as the old version wrote it
})

// ---- The CLI ------------------------------------------------------------------------------------

test('writeflex settings migrates first, then lists and sets through the same file, logged as an agent', async () => {
  const dir = fresh()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ values: { 'appearance.theme': 'dark' } }))
  let out = ''
  let err = ''
  const io = { stdout: (t: string) => { out += t }, stderr: (t: string) => { err += t }, env: {} }
  expect(await runSettingsCli(['get', 'appearance.theme', '--json'], io, dir, '0.27.0')).toBe(0)
  expect(out).toContain('dark')
  out = ''
  expect(await runSettingsCli(['set', 'editor.viewMode', 'raw'], io, dir, '0.27.0')).toBe(0)
  const saved = JSON.parse(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')) as { settings: Record<string, unknown>; changes: { who: { kind: string } }[] }
  expect(saved.settings['editor.viewMode']).toBe('raw')
  expect(saved.changes[0]?.who.kind).toBe('agent')
  out = ''
  expect(await runSettingsCli(['list', '--json'], io, dir, '0.27.0')).toBe(0)
  expect(out).not.toMatch(/sk-|"value":\s*"[^"]*key/i)
  expect(err).toBe('')
})

test('the CLI refuses to work over a settings file it cannot read', async () => {
  const dir = fresh()
  writeFileSync(join(dir, 'settings.json'), '{ broken')
  let err = ''
  expect(await runSettingsCli(['list'], { stdout: () => {}, stderr: (t: string) => { err += t } }, dir, '0.27.0')).toBe(1)
  expect(err).toContain('Nothing was changed')
})

test('old Settings section names open the matching page of the Settings window', () => {
  expect(settingsPageOf('sec-read-aloud')).toBe('read-aloud')
  expect(settingsPageOf('sec-account')).toBe('accounts')
  expect(settingsPageOf('sec-about')).toBe('updates')
  expect(settingsPageOf('sec-unknown')).toBeUndefined()
  expect(settingsPageOf(undefined)).toBeUndefined()
  expect(APP_KEYS_SETTING).toBe('keyboard.appKeys')
})


test('the migration-only app key layer rejects fixed, unknown, reserved and conflicting chords', () => {
  for (const value of [
    { 'app.quickOpen': '⌥⌘9' }, { 'not.aCommand': 'X' },
    { 'edit.mark': '⇧⌘P' }, { 'edit.mark': 'not a chord' },
    { 'edit.mark': 'X', 'edit.italic': 'X' },
  ]) expect(appKeysError(JSON.stringify(value))).not.toBeNull()
  expect(schema.def(APP_KEYS_SETTING)?.importable).toBe(false)
})

test('legacy generic access never writes or returns a secret or accepts the internal app key layer', async () => {
  const dir = fresh()
  const path = join(dir, 'settings.json')
  writeFileSync(path, JSON.stringify({ values: { 'accounts.anthropic': 'old-secret' }, changelog: [{ key: 'accounts.anthropic', old: null, new: 'old-secret', label: 'Key', at: 1 }] }))
  const store = new LegacyStore(path)
  const before = readFileSync(path, 'utf8')
  await expect(store.set('accounts.anthropic', 'new-secret', 'Key')).rejects.toThrow()
  await expect(store.set(APP_KEYS_SETTING, '{}', 'Keys')).rejects.toThrow()
  expect(store.get('accounts.anthropic')).toBeNull()
  expect(JSON.stringify(store.values())).not.toContain('secret')
  expect(JSON.stringify(store.changelog())).not.toContain('secret')
  expect(readFileSync(path, 'utf8')).toBe(before)
})

test('assistant defaults follow shared values and reset even with old modelDefaults present', () => {
  const dir = fresh()
  const path = join(dir, 'settings.json')
  writeFileSync(path, JSON.stringify({ modelDefaults: { provider: 'anthropic', modelId: 'old', thinkingLevel: 'high' } }))
  const store = new LegacyStore(path)
  const prefs = new Map<string, string>()
  store.attachShared({ owns: (k) => k.startsWith('agent.'), get: (k) => prefs.get(k) ?? null, values: () => Object.fromEntries(prefs), persist: async () => {} })
  expect(store.modelDefaults()).toEqual({})
  prefs.set('agent.model', 'openai-codex::new')
  prefs.set('agent.thinkingLevel', 'low')
  expect(store.modelDefaults()).toEqual({ provider: 'openai-codex', modelId: 'new', thinkingLevel: 'low' })
  prefs.clear()
  expect(store.modelDefaults()).toEqual({})
})

test('the new main-command sheet rows retain literal minus-key shortcuts', () => {
  const minus = commandRegistry.find((c) => c.id === 'view.proseDecrease')!
  expect(canonicalChord(minus.keys as string)).toBe('⌘-')
  // The sheet and palette formatter must not mistake a glyph chord's minus key for a spec separator.
  expect(defaultChords(minus)).toEqual(['⌘-'])
})
