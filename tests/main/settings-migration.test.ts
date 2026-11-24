import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from '@app-patterns/settings/node'
import { runMigration, storeOptions, LEGACY_FILE, STAMP_FILE, type MigrationStore } from '../../src/main/settings-migration'
import { APP_KEYS_SETTING } from '../../src/shared/keymap-overrides'
import { schema, SETTINGS_V2_FILE } from '../../src/shared/settings-schema'

const VERSION = '0.27.0-alpha.1'
const fresh = (): string => mkdtempSync(join(tmpdir(), 'wf-settings-migration-'))
const legacyFile = (values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ recents: [{ root: '/tmp/a' }], pinned: [], favourites: {}, changelog: [], ...extra, values }, null, 2)
const writeLegacy = (dir: string, values: Record<string, unknown>, extra?: Record<string, unknown>): string => {
  const text = legacyFile(values, extra)
  writeFileSync(join(dir, LEGACY_FILE), text)
  return text
}
const openStore = async (dir: string, who?: { kind: 'you' }) => {
  const store = new SettingsStore({ ...storeOptions(dir, VERSION), watch: false, log: () => {}, ...(who ? { who } : {}) })
  await store.ready
  return store
}
const stampOf = (dir: string) => JSON.parse(readFileSync(join(dir, STAMP_FILE), 'utf8')) as { keys: Record<string, { hash: string; at: number }> }
const tick = () => new Promise((r) => setTimeout(r, 5))

test('a missing old file is nothing to migrate: no new file, no stamp', async () => {
  const dir = fresh()
  expect(await runMigration(dir, VERSION)).toEqual({ kind: 'none' })
  expect(existsSync(join(dir, SETTINGS_V2_FILE))).toBe(false)
  expect(existsSync(join(dir, STAMP_FILE))).toBe(false)
})

test('first migration writes a new file with only schema preferences and never touches the old file', async () => {
  const dir = fresh()
  const before = writeLegacy(dir, {
    'appearance.theme': 'dark',
    'editor.proseSize': 21, // a number in the old file, a string in the schema
    'sounds.typing.scheme': 'typewriter', // the old spelling of deep
    'readingRoom.open': true, // state, not a preference
    'guide.progress': '{"a":1}',
    'accounts.anthropic': 'sk-ant-should-never-move',
    'counted:/tmp/a:': true,
  })
  const outcome = await runMigration(dir, VERSION)
  expect(outcome.kind).toBe('first')
  expect(readFileSync(join(dir, LEGACY_FILE), 'utf8')).toBe(before)
  const store = await openStore(dir)
  expect(store.view().settings).toEqual({
    'appearance.theme': 'dark',
    'editor.proseSize': '21',
    'sounds.typing.scheme': 'deep',
  })
  const text = readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')
  expect(text).not.toContain('sk-ant')
  expect(text).not.toContain('readingRoom.open')
  expect(store.view().changes.every((e) => (e.who as { kind: string }).kind === 'app-update')).toBe(true)
  await store.close()
  const stamp = stampOf(dir)
  expect(stamp.keys['appearance.theme']?.hash).toMatch(/^[0-9a-f]{32}$/)
  expect(JSON.stringify(stamp)).not.toContain('dark') // hashes only, never values
})

test('Crisp is the default in a fresh profile with no legacy file', async () => {
  const dir = fresh()
  expect(await runMigration(dir, VERSION)).toEqual({ kind: 'none' })
  const store = await openStore(dir)
  expect(store.view().settings['sounds.typing.scheme']).toBeUndefined()
  expect(schema.def('sounds.typing.scheme')?.default).toBe('crisp')
  await store.close()
})

test.each([
  ['Classic manual', 'deep', 'deep'],
  ['Crisp', 'crisp', 'crisp'],
  ['Soft', 'soft', 'soft'],
  ['no chosen set', undefined, 'crisp'],
] as const)('keeps PR 256 writing preferences with %s', async (_label, scheme, expected) => {
  const dir = fresh()
  const prefs = {
    'sounds.typing.enabled': true,
    'sounds.typing.volume': 0.4,
    'editor.typewriter': true,
    'editor.fixedLine': 0.42,
  }
  const key = 'sounds.typing.scheme'
  const before = writeLegacy(dir, scheme === undefined ? prefs : { ...prefs, [key]: scheme })
  expect((await runMigration(dir, VERSION)).kind).toBe('first')
  const check = (store: SettingsStore): void => {
    const saved = store.view().settings
    expect(saved).toMatchObject(prefs)
    expect(saved[key] ?? schema.def(key)?.default).toBe(expected)
    if (scheme === undefined) expect(saved[key]).toBeUndefined()
  }
  const first = await openStore(dir)
  check(first)
  await first.close()
  expect(await runMigration(dir, VERSION)).toEqual({ kind: 'none' })
  const reopened = await openStore(dir)
  check(reopened)
  await reopened.close()
  if (scheme !== undefined) expect(stampOf(dir).keys[key]).toBeDefined()
  expect(readFileSync(join(dir, LEGACY_FILE), 'utf8')).toBe(before)
})

test('an old file that does not parse stops the migration unstamped', async () => {
  const dir = fresh()
  writeFileSync(join(dir, LEGACY_FILE), '{ "values": { "appearance.theme": "dark" ')
  const outcome = await runMigration(dir, VERSION)
  expect(outcome.kind).toBe('unreadable')
  expect(existsSync(join(dir, SETTINGS_V2_FILE))).toBe(false)
  expect(existsSync(join(dir, STAMP_FILE))).toBe(false)
})

test('an old file that cannot be read stops the migration unstamped', async () => {
  if (process.getuid?.() === 0) return // root reads anything
  const dir = fresh()
  writeLegacy(dir, { 'appearance.theme': 'dark' })
  chmodSync(join(dir, LEGACY_FILE), 0o000)
  try {
    expect((await runMigration(dir, VERSION)).kind).toBe('unreadable')
    expect(existsSync(join(dir, SETTINGS_V2_FILE))).toBe(false)
  } finally {
    chmodSync(join(dir, LEGACY_FILE), 0o600)
  }
})

test('a refused value is never stamped and is retried without repeated logging', async () => {
  const dir = fresh()
  writeLegacy(dir, { 'appearance.theme': 'purple', 'editor.spellcheck': false })
  await runMigration(dir, VERSION)
  const store = await openStore(dir)
  expect(store.view().settings).toEqual({ 'editor.spellcheck': false })
  await store.close()
  expect(stampOf(dir).keys['appearance.theme']).toBeUndefined()
  const logs: string[] = []
  expect(await runMigration(dir, VERSION, { log: (line) => logs.push(line) })).toMatchObject({ kind: 'again', refused: ['appearance.theme'] })
  expect(await runMigration(dir, VERSION, { log: (line) => logs.push(line) })).toMatchObject({ kind: 'again', refused: ['appearance.theme'] })
  expect(logs).toHaveLength(0)
})

test('shortcuts keep their meaning: removed stays removed, bare and scoped keys stay in the app layer', async () => {
  const dir = fresh()
  writeLegacy(dir, { 'shortcuts.overrides': JSON.stringify({ 'edit.italic': '', 'view.typewriter': '⌥⌘Y', 'plan.addPart': 'P', 'outline.indentListItem': '' }) })
  await runMigration(dir, VERSION)
  const store = await openStore(dir)
  expect(store.view().keys).toEqual({ 'edit.italic': '', 'view.typewriter': '⌘⌥Y' })
  expect(JSON.parse(String(store.view().settings[APP_KEYS_SETTING]))).toEqual({ 'outline.indentListItem': '', 'plan.addPart': 'P' })
  await store.close()
})

test('a preference an older version changed is migrated again, as an app update', async () => {
  const dir = fresh()
  writeLegacy(dir, { 'appearance.theme': 'dark' })
  await runMigration(dir, VERSION)
  await tick()
  writeLegacy(dir, { 'appearance.theme': 'light', 'editor.spellcheck': false })
  const outcome = await runMigration(dir, VERSION)
  expect(outcome).toMatchObject({ kind: 'again', applied: expect.arrayContaining(['appearance.theme', 'editor.spellcheck']), kept: [] })
  const store = await openStore(dir)
  expect(store.view().settings).toEqual({ 'editor.spellcheck': false })
  expect(store.view().changes[0]?.who).toEqual({ kind: 'app-update', version: VERSION })
  await store.close()
})

test('a change made in the new version at or after the stamp is kept over the older version’s', async () => {
  const dir = fresh()
  writeLegacy(dir, { 'appearance.theme': 'dark' })
  await runMigration(dir, VERSION)
  await tick()
  const you = await openStore(dir, { kind: 'you' })
  expect((await you.set('appearance.theme', 'light')).ok).toBe(true)
  await you.close()
  writeLegacy(dir, { 'appearance.theme': 'dark', 'editor.spellcheck': false })
  writeLegacy(dir, { 'appearance.theme': 'light' }) // the older version saved again
  writeLegacy(dir, { 'appearance.theme': 'dark', 'editor.viewMode': 'raw' })
  // theme's old hash equals the stamp again (dark), so only viewMode changed
  expect(await runMigration(dir, VERSION)).toMatchObject({ kind: 'again', applied: ['editor.viewMode'] })
  writeLegacy(dir, { 'appearance.theme': 'light', 'editor.viewMode': 'raw' })
  const store0 = await openStore(dir)
  const outcome = await runMigration(dir, VERSION)
  await store0.close()
  expect(outcome).toMatchObject({ kind: 'again', kept: ['appearance.theme'] })
})

test('the conflict rule uses each key’s own stamp time', async () => {
  const dir = fresh()
  writeLegacy(dir, { 'appearance.theme': 'dark', 'editor.viewMode': 'markup' })
  await runMigration(dir, VERSION)
  await tick()
  // You change viewMode now (after its stamp).
  const you = await openStore(dir, { kind: 'you' })
  await you.set('editor.viewMode', 'clean')
  await you.close()
  await tick()
  // The older version changes theme; the re-migration applies it and re-stamps theme only.
  writeLegacy(dir, { 'appearance.theme': 'light', 'editor.viewMode': 'markup' })
  expect(await runMigration(dir, VERSION)).toMatchObject({ applied: ['appearance.theme'] })
  const stamp = stampOf(dir)
  expect(stamp.keys['appearance.theme']!.at).toBeGreaterThan(stamp.keys['editor.viewMode']!.at)
  await tick()
  // Now the older version changes viewMode: your change came after viewMode's stamp, so yours is kept.
  writeLegacy(dir, { 'appearance.theme': 'light', 'editor.viewMode': 'raw' })
  expect(await runMigration(dir, VERSION)).toMatchObject({ kept: ['editor.viewMode'] })
  const store = await openStore(dir)
  expect(store.view().settings['editor.viewMode']).toBeUndefined() // clean, the default
  await store.close()
})

test('never re-migrates over a store file that is unreadable, another app’s or a newer version’s', async () => {
  for (const content of ['not json', JSON.stringify({ format: 'bridle-settings', version: 1, app: 'talkweaver', settings: {}, keys: {}, changes: [] }), JSON.stringify({ format: 'bridle-settings', version: 999, app: 'writeflex', settings: {}, keys: {}, changes: [] })]) {
    const dir = fresh()
    writeLegacy(dir, { 'appearance.theme': 'dark' })
    writeFileSync(join(dir, SETTINGS_V2_FILE), content)
    const outcome = await runMigration(dir, VERSION)
    expect(outcome.kind).toBe('refused')
    expect(readFileSync(join(dir, SETTINGS_V2_FILE), 'utf8')).toBe(content)
    expect(existsSync(join(dir, STAMP_FILE))).toBe(false)
  }
})

test('only writes that landed are stamped: a failed write is tried again next launch', async () => {
  const dir = fresh()
  writeLegacy(dir, { 'appearance.theme': 'dark' })
  await runMigration(dir, VERSION)
  const firstStamp = stampOf(dir).keys['appearance.theme']
  writeLegacy(dir, { 'appearance.theme': 'light' })
  const real = new SettingsStore({ ...storeOptions(dir, VERSION), who: { kind: 'app-update', version: VERSION }, watch: false, log: () => {} })
  await real.ready
  real.refuseWrites('locked')
  expect(await runMigration(dir, VERSION, { open: () => real })).toMatchObject({ kind: 'again', notSaved: ['appearance.theme'] })
  expect(stampOf(dir).keys['appearance.theme']).toEqual(firstStamp!)
  expect(await runMigration(dir, VERSION)).toMatchObject({ kind: 'again', applied: ['appearance.theme'] })
})


test('keeping a newer value preserves its original stamp and protects repeated downgrades', async () => {
  const dir = fresh()
  writeLegacy(dir, { 'editor.viewMode': 'markup' })
  await runMigration(dir, VERSION)
  const at = stampOf(dir).keys['editor.viewMode']!.at
  await tick()
  const you = await openStore(dir, { kind: 'you' })
  await you.set('editor.viewMode', 'raw')
  await you.close()
  writeLegacy(dir, { 'editor.viewMode': 'clean' })
  expect(await runMigration(dir, VERSION)).toMatchObject({ kept: ['editor.viewMode'] })
  expect(stampOf(dir).keys['editor.viewMode']!.at).toBe(at)
  writeLegacy(dir, { 'editor.viewMode': 'markup' })
  expect(await runMigration(dir, VERSION)).toMatchObject({ kept: ['editor.viewMode'] })
  const store = await openStore(dir)
  expect(store.view().settings['editor.viewMode']).toBe('raw')
  await store.close()
})

test('a shortcut can transfer from an obsolete owner to another command in one migration', async () => {
  const dir = fresh()
  writeLegacy(dir, { 'shortcuts.overrides': JSON.stringify({ 'edit.bold': '⌃⌥⌘9' }) })
  await runMigration(dir, VERSION)
  writeLegacy(dir, { 'shortcuts.overrides': JSON.stringify({ 'edit.italic': '⌃⌥⌘9' }) })
  expect(await runMigration(dir, VERSION)).toMatchObject({ applied: ['shortcuts.overrides'], refused: [] })
  const store = await openStore(dir)
  expect(store.view().keys).toEqual({ 'edit.italic': '⌘⌃⌥9' })
  await store.close()
})

test('migration checks the locked on-disk changelog, including a write after opening its store', async () => {
  const dir = fresh()
  writeLegacy(dir, { 'editor.viewMode': 'markup' })
  await runMigration(dir, VERSION)
  await tick()
  writeLegacy(dir, { 'editor.viewMode': 'clean' })
  const stale = await openStore(dir)
  const you = await openStore(dir, { kind: 'you' })
  await you.set('editor.viewMode', 'raw')
  await you.close()
  expect(await runMigration(dir, VERSION, { open: () => stale })).toMatchObject({ kept: ['editor.viewMode'] })
  const store = await openStore(dir)
  expect(store.view().settings['editor.viewMode']).toBe('raw')
  await store.close()
})

test('refused shortcut entries are never stamped and are retried on every launch without repeated logging', async () => {
  const dir = fresh()
  writeLegacy(dir, { 'shortcuts.overrides': JSON.stringify({ 'app.quickOpen': '⌥⌘9' }) })
  await runMigration(dir, VERSION)
  // The empty accepted subset is stamped; no refused command is included in its entries.
  expect(stampOf(dir).keys['shortcuts.overrides']).toMatchObject({ entries: {}, written: {} })
  const logs: string[] = []
  expect(await runMigration(dir, VERSION, { log: (line) => logs.push(line) })).toMatchObject({ kind: 'again', refused: ['shortcuts.overrides/app.quickOpen'] })
  expect(await runMigration(dir, VERSION, { log: (line) => logs.push(line) })).toMatchObject({ kind: 'again', refused: ['shortcuts.overrides/app.quickOpen'] })
  expect(logs).toEqual([])
})

test('a user edit after the migration write but before its stamp remains protected', async () => {
  const dir = fresh()
  writeLegacy(dir, { 'editor.viewMode': 'markup' })
  await runMigration(dir, VERSION)
  await tick()
  writeLegacy(dir, { 'editor.viewMode': 'clean' })
  const moving = await openStore(dir)
  const update = moving.file.update.bind(moving.file)
  let edited = false
  moving.file.update = (async (step: any) => {
    const result = await update(step)
    if (!edited && result.ok && result.written) {
      edited = true
      await tick()
      const user = await openStore(dir, { kind: 'you' })
      await user.set('editor.viewMode', 'raw')
      await user.close()
    }
    return result
  }) as typeof moving.file.update
  expect(await runMigration(dir, VERSION, { open: () => moving })).toMatchObject({ applied: ['editor.viewMode'] })
  writeLegacy(dir, { 'editor.viewMode': 'markup' })
  expect(await runMigration(dir, VERSION)).toMatchObject({ kept: ['editor.viewMode'] })
  const store = await openStore(dir)
  expect(store.view().settings['editor.viewMode']).toBe('raw')
  await store.close()
})
