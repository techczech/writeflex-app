import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigration, STAMP_FILE, storeOptions } from '../../src/main/settings-migration'
import { SharedSettingsStore } from '../../src/main/shared-settings-store'
import { SETTINGS_V2_FILE, preferencesFromLegacy } from '../../src/shared/settings-schema'
import { APP_KEYS_SETTING, effectiveBindings } from '../../src/shared/keymap-overrides'
import { GuideProgressStore } from '../../src/main/guide-progress-store'

const version = '0.27.0-alpha.4'
const fresh = () => mkdtempSync(join(tmpdir(), 'wf-settings-round-3-'))
const legacy = (dir: string, bindings: Record<string, string>) => writeFileSync(join(dir, 'settings.json'), JSON.stringify({ values: { 'shortcuts.overrides': JSON.stringify(bindings) } }))
const stamp = (dir: string) => JSON.parse(readFileSync(join(dir, STAMP_FILE), 'utf8'))
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

test('round 3: the review probe preserves a user rebind after 310 ordinary sets and repeated launches', async () => {
  const dir = fresh()
  legacy(dir, { 'edit.italic': '⌃⌥⌘9', 'edit.bold': '⌘W' })
  await runMigration(dir, version)
  const accepted = stamp(dir).keys['shortcuts.overrides']
  const store = await open(dir)
  expect((await store.rebind('edit.bold', '⌘⌃⌥7')).ok).toBe(true)
  for (let n = 0; n < 310; n++) expect((await store.set('appearance.theme', n % 2 ? 'light' : 'dark')).ok).toBe(true)
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
}, 20_000)

test('round 3: all-refused legacy data, including a round-two stamp with no subset entry, never resets shortcuts', async () => {
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

test('round 3: a refused chord freed in the current store lands individually and stays accepted on later launches', async () => {
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

test('round 3: retry protects a changed command from current state even with no retained history', async () => {
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

test('round 3: retry never steals a chord currently bound to another command', async () => {
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

test('round 3: a genuine accepted-subset downgrade edit still migrates under the per-key conflict rule', async () => {
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

test('round 3: a retry may replace the non-default value migration last wrote, without resetting other commands', async () => {
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

test('round 3: Guide progress waits for persistence before announcing and propagates a failed save', async () => {
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

test('round 3: a non-string legacy model provider is never coerced into a model reference', () => {
  for (const provider of [42, true, {}, []]) {
    expect(preferencesFromLegacy({ modelDefaults: { provider, modelId: 'gpt-5.5' } })['agent.model']).toBe('openai-codex::gpt-5.5')
  }
})

test('round 3: missing-store errors explain restoring the file or starting a fresh shared migration', async () => {
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
