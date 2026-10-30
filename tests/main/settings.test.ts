import { test, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as settingsModule from '../../src/main/settings'
import { SettingsStore } from '../../src/main/settings'
import { shippedExportPresetSettings } from '../../src/shared/export-presets'

test('export presets persist as structured app settings without writing in the Workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-export-presets-'))
  const workspace = join(dir, 'writing-folder')
  const settingsPath = join(dir, 'userData', 'settings.json')
  await mkdir(workspace)
  await Bun.write(join(workspace, 'draft.md'), '# Draft')
  const settings = shippedExportPresetSettings()
  settings.presets[1].choice.readerNotes = true

  const store = new SettingsStore(settingsPath)
  store.setExportPresetSettings(settings)

  expect(new SettingsStore(settingsPath).exportPresetSettings()).toEqual(settings)
  expect(JSON.parse(await readFile(settingsPath, 'utf8')).exportPresets).toEqual(settings)
  expect(await readdir(workspace)).toEqual(['draft.md'])
})

test('deleting every shipped export preset survives restart rather than reseeding defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-export-presets-empty-'))
  const settingsPath = join(dir, 'settings.json')
  const store = new SettingsStore(settingsPath)
  store.setExportPresetSettings({ presets: [] })
  expect(new SettingsStore(settingsPath).exportPresetSettings()).toEqual({ presets: [] })
})

test('recents: most recent first, deduplicated, capped at 10, persisted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-settings-'))
  const path = join(dir, 'settings.json')
  const store = new SettingsStore(path)
  for (let i = 0; i < 12; i += 1) store.touchRecent(`/tmp/w${i}`)
  store.touchRecent('/tmp/w3')
  const recents = store.recents()
  expect(recents.length).toBe(10)
  expect(recents[0].root).toBe('/tmp/w3')
  const reloaded = new SettingsStore(path)
  expect(reloaded.recents()[0].root).toBe('/tmp/w3')
})

test('model defaults round-trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-settings2-'))
  const store = new SettingsStore(join(dir, 'settings.json'))
  expect(store.modelDefaults()).toEqual({})
  store.setModelDefaults({ provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' })
  expect(new SettingsStore(join(dir, 'settings.json')).modelDefaults().modelId).toBe('gpt-5.5')
})

test('model defaults resolve from Settings and then the app built-in only', () => {
  expect(typeof (settingsModule as Record<string, unknown>).resolveModelDefaults).toBe('function')
  const resolveModelDefaults = (settingsModule as typeof settingsModule & {
    resolveModelDefaults: (defaults: Parameters<SettingsStore['setModelDefaults']>[0]) => unknown
  }).resolveModelDefaults
  expect(resolveModelDefaults({ provider: 'openai-codex', modelId: 'gpt-5.6-sol', thinkingLevel: 'high' })).toEqual({
    model: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
    thinking: 'high',
    sources: { model: 'settings', thinking: 'settings' },
  })
  expect(resolveModelDefaults({})).toEqual({
    model: { provider: 'openai-codex', id: 'gpt-5.5' },
    thinking: 'medium',
    sources: { model: 'built-in', thinking: 'built-in' },
  })
})

test('retired tab-layout preferences and changelog rows are discarded on load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-settings-retired-tabs-'))
  const path = join(dir, 'settings.json')
  await writeFile(path, JSON.stringify({
    recents: [], modelDefaults: {}, favourites: {},
    values: { 'editor.tabLayout': 'vertical', 'editor.spellcheck': false },
    changelog: [
      { key: 'editor.tabLayout', label: 'Tab layout', old: 'horizontal', new: 'vertical', at: 1 },
      { key: 'editor.spellcheck', label: 'Spellcheck', old: true, new: false, at: 2 },
    ],
  }))
  const store = new SettingsStore(path)
  expect(store.values()).toEqual({ 'agent.mode': 'work', 'editor.spellcheck': false })
  expect(store.changelog().map((entry) => entry.key)).toEqual(['editor.spellcheck'])
  const persisted = JSON.parse(await readFile(path, 'utf8')) as { values: Record<string, unknown>; changelog: Array<{ key: string }> }
  expect(persisted.values['editor.tabLayout']).toBeUndefined()
  expect(persisted.changelog.map((entry) => entry.key)).toEqual(['editor.spellcheck'])
  expect(store.set('editor.tabLayout', 'vertical', 'Tab layout')).toBeNull()
  expect(store.get('editor.tabLayout')).toBeNull()
})

// ---- Task 17: generic values + changelog-with-revert (the settings window's store) ----

test('values: generic get/set round-trip, persisted across a reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-settings-vals-'))
  const path = join(dir, 'settings.json')
  const store = new SettingsStore(path)
  expect(store.get('appearance.theme')).toBeNull() // unset reads null (renderer applies defaults)
  store.set('appearance.theme', 'dark', 'Appearance')
  store.set('editor.spellcheck', false, 'Spellcheck')
  expect(store.get('appearance.theme')).toBe('dark')
  expect(store.get('editor.spellcheck')).toBe(false)
  expect(store.values()).toEqual({ 'agent.mode': 'work', 'appearance.theme': 'dark', 'editor.spellcheck': false })
  const reloaded = new SettingsStore(path)
  expect(reloaded.get('appearance.theme')).toBe('dark')
  expect(reloaded.get('editor.spellcheck')).toBe(false)
})

test('changelog: every logged set prepends {key,label,old,new,at}; same-value sets do not log', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-settings-log-'))
  const path = join(dir, 'settings.json')
  const store = new SettingsStore(path)
  store.set('editor.typewriter', true, 'Typewriter mode')
  store.set('editor.typewriter', true, 'Typewriter mode') // no change → no entry
  store.set('editor.lineWidth', 'wide', 'Line width')
  const log = store.changelog()
  expect(log.length).toBe(2)
  // Newest first (the mockup prepends).
  expect(log[0]).toMatchObject({ key: 'editor.lineWidth', label: 'Line width', old: null, new: 'wide' })
  expect(log[1]).toMatchObject({ key: 'editor.typewriter', label: 'Typewriter mode', old: null, new: true })
  expect(typeof log[0].at).toBe('number')
  // A second change of the same key logs the true previous value.
  store.set('editor.lineWidth', 'narrow', 'Line width')
  expect(store.changelog()[0]).toMatchObject({ key: 'editor.lineWidth', old: 'wide', new: 'narrow' })
  // Persisted with the file.
  expect(new SettingsStore(path).changelog().length).toBe(3)
})

test('changelog: silent sets (log:false) change the value without an entry — the ⌘T path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-settings-silent-'))
  const store = new SettingsStore(join(dir, 'settings.json'))
  store.set('editor.typewriter', true, 'Typewriter mode', { log: false })
  expect(store.get('editor.typewriter')).toBe(true)
  expect(store.changelog()).toEqual([])
  // A later LOGGED change still reports the silent value as its honest `old`.
  store.set('editor.typewriter', false, 'Typewriter mode')
  expect(store.changelog()[0]).toMatchObject({ old: true, new: false })
})

test('revert: restores the entry’s old value, marks it reverted, appends NO new entry, persists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-settings-revert-'))
  const path = join(dir, 'settings.json')
  const store = new SettingsStore(path)
  store.set('editor.proseSize', '21', 'Prose size') // old: null (unset)
  store.set('appearance.theme', 'dark', 'Appearance')
  // Revert the theme change (index 0 = newest).
  const reverted = store.revert(0)
  expect(reverted).toMatchObject({ key: 'appearance.theme', old: null, new: 'dark', reverted: true })
  expect(store.get('appearance.theme')).toBeNull() // back to unset → the default applies
  expect(store.changelog().length).toBe(2) // no new entry — the row is marked, not re-logged
  expect(store.changelog()[0].reverted).toBe(true)
  // Reverting an already-reverted entry is a no-op.
  expect(store.revert(0)).toBeNull()
  expect(store.revert(99)).toBeNull() // out of range
  // Round-trip: the reverted flag and the restored value survive a reload.
  const reloaded = new SettingsStore(path)
  expect(reloaded.get('appearance.theme')).toBeNull()
  expect(reloaded.changelog()[0].reverted).toBe(true)
  expect(reloaded.get('editor.proseSize')).toBe('21') // the untouched entry keeps its value
})

test('revert candidate inspects a change without flipping settings before its external write succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-settings-revert-candidate-'))
  const store = new SettingsStore(join(dir, 'settings.json'))
  store.set('diary.counted:root:essays', true, 'Counted Collection: essays')
  expect(store.revertCandidate(0)).toMatchObject({ key: 'diary.counted:root:essays', old: null, new: true })
  expect(store.get('diary.counted:root:essays')).toBe(true)
  expect(store.changelog()[0].reverted).toBeUndefined()
})

test('revert re-fires honestly: a set AFTER a revert logs old = the reverted-to value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-settings-refire-'))
  const store = new SettingsStore(join(dir, 'settings.json'))
  store.set('editor.lineWidth', 'medium', 'Line width') // null → medium
  store.set('editor.lineWidth', 'wide', 'Line width') // medium → wide
  store.revert(0) // back to medium
  expect(store.get('editor.lineWidth')).toBe('medium')
  store.set('editor.lineWidth', 'narrow', 'Line width')
  // The log stays honest: the new entry's old is the value the revert restored.
  expect(store.changelog()[0]).toMatchObject({ old: 'medium', new: 'narrow' })
})

test('favourites: per-root toggle, order preserved, empty roots dropped, persisted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-settings-fav-'))
  const path = join(dir, 'settings.json')
  const store = new SettingsStore(path)
  expect(store.favourites('/ws/a')).toEqual([])
  expect(store.toggleFavourite('/ws/a', 'notes.md')).toEqual(['notes.md'])
  store.toggleFavourite('/ws/a', 'drafts/x.md')
  store.toggleFavourite('/ws/b', 'other.md') // a different root stays isolated
  expect(store.favourites('/ws/a')).toEqual(['notes.md', 'drafts/x.md'])
  expect(store.favourites('/ws/b')).toEqual(['other.md'])
  // Toggling the last one off drops the path; the list persists across a reload.
  expect(store.toggleFavourite('/ws/a', 'notes.md')).toEqual(['drafts/x.md'])
  const reloaded = new SettingsStore(path)
  expect(reloaded.favourites('/ws/a')).toEqual(['drafts/x.md'])
  expect(reloaded.favourites('/ws/b')).toEqual(['other.md'])
})

test('pinned: pin, unpin, reorder, locate; survives a reload; recents untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-pinned-'))
  const path = join(dir, 'settings.json')
  const store = new SettingsStore(path)
  store.touchRecent('/tmp/a')
  expect(store.pinned()).toEqual([])
  store.pin('/tmp/a')
  store.pin('/tmp/b')
  store.pin('/tmp/c')
  store.pin('/tmp/a') // already pinned: no duplicate
  expect(store.pinned()).toEqual(['/tmp/a', '/tmp/b', '/tmp/c'])
  expect(store.recents().map((r) => r.root)).toEqual(['/tmp/a'])

  expect(store.movePinned('/tmp/c', 0)).toBe(true)
  expect(store.pinned()).toEqual(['/tmp/c', '/tmp/a', '/tmp/b'])
  store.movePinned('/tmp/c', 99) // clamped to the end
  expect(store.pinned()).toEqual(['/tmp/a', '/tmp/b', '/tmp/c'])
  expect(store.movePinned('/tmp/zzz', 0)).toBe(false)

  expect(store.locatePinned('/tmp/b', '/tmp/b2')).toBe(true) // keeps its position
  expect(store.pinned()).toEqual(['/tmp/a', '/tmp/b2', '/tmp/c'])
  expect(store.locatePinned('/tmp/a', '/tmp/c')).toBe(true) // target already pinned: no duplicate
  expect(store.pinned()).toEqual(['/tmp/c', '/tmp/b2'])
  expect(store.locatePinned('/tmp/nope', '/tmp/x')).toBe(false)

  store.unpin('/tmp/b2')
  expect(store.pinned()).toEqual(['/tmp/c'])

  const reloaded = new SettingsStore(path)
  expect(reloaded.pinned()).toEqual(['/tmp/c'])
  expect(JSON.parse(await readFile(path, 'utf8')).pinned).toEqual(['/tmp/c'])
  expect(reloaded.isPinned('/tmp/c')).toBe(true)
})

test('pinned: a settings file without the key reads as no pins, and bad entries are dropped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-pinned-legacy-'))
  const path = join(dir, 'settings.json')
  await writeFile(path, JSON.stringify({ recents: [{ root: '/tmp/a', openedAt: 1 }] }))
  expect(new SettingsStore(path).pinned()).toEqual([])
  await writeFile(path, JSON.stringify({ pinned: ['/tmp/a', 3, '', '/tmp/a', '/tmp/b'] }))
  expect(new SettingsStore(path).pinned()).toEqual(['/tmp/a', '/tmp/b'])
})

test('a save writes settings.json in place as it always has: no temporary sibling is made or removed, and a symlinked file is written through', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-settings-inplace-'))
  const real = join(dir, 'elsewhere', 'real-settings.json')
  const path = join(dir, 'settings.json')
  await mkdir(join(dir, 'elsewhere'))
  await writeFile(real, '{}')
  await symlink(real, path)
  // Somebody else's file that happens to carry the name a temporary file would have.
  await writeFile(`${path}.tmp`, 'not ours\n')

  const store = new SettingsStore(path)
  store.touchRecent('/tmp/a')
  expect(store.setExampleState('writing', 7)).toBe(true)

  expect((await lstat(path)).isSymbolicLink()).toBe(true)
  const text = await readFile(real, 'utf8')
  const saved = JSON.parse(text)
  expect(text).toBe(JSON.stringify(saved, null, 2))
  expect(saved.recents.map((r: { root: string }) => r.root)).toEqual(['/tmp/a'])
  expect(saved.example).toEqual({ state: 'writing', at: 7 })
  expect(await readFile(`${path}.tmp`, 'utf8')).toBe('not ours\n')
  expect((await readdir(dir)).sort()).toEqual(['elsewhere', 'settings.json', 'settings.json.tmp'])
})

test('the example state is one word: absent only without the key, and any other form of the key reads as incomplete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-settings-example-'))
  const path = join(dir, 'settings.json')
  expect(new SettingsStore(path).exampleState()).toBe('absent')
  await writeFile(path, JSON.stringify({ recents: [] }))
  expect(new SettingsStore(path).exampleState()).toBe('absent')
  for (const state of ['writing', 'written', 'incomplete', 'removed']) {
    await writeFile(path, JSON.stringify({ example: { state, at: 1 } }))
    expect(new SettingsStore(path).exampleState()).toBe(state)
  }
  const present: unknown[] = [null, 'written', 7, true, [], [{ state: 'written', at: 1 }], {}, { state: 'written' }, { state: 'written', at: '1' }, { state: 'written', at: 1, root: '/x' }, { state: 'nonsense', at: 1 }, { at: 1 }]
  for (const example of present) {
    await writeFile(path, JSON.stringify({ example }))
    const store = new SettingsStore(path)
    expect(store.exampleState()).toBe('incomplete')
    // An unrelated save keeps the key present, exactly as it was found.
    store.touchRecent('/tmp/a')
    expect(JSON.parse(await readFile(path, 'utf8')).example).toEqual(example)
    expect(new SettingsStore(path).exampleState()).toBe('incomplete')
  }
  // A settings file that is there but cannot be read might have held a record.
  await writeFile(path, '{ "example": { "state": "wri')
  const broken = new SettingsStore(path)
  expect(broken.exampleState()).toBe('incomplete')
  broken.touchRecent('/tmp/a')
  expect(new SettingsStore(path).exampleState()).toBe('incomplete')
  // A store with no example state saves no example key.
  const clean = join(dir, 'clean.json')
  new SettingsStore(clean).touchRecent('/tmp/a')
  expect('example' in JSON.parse(await readFile(clean, 'utf8'))).toBe(false)
})

test('an example state that cannot be saved is reported, and the store keeps what it had', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-settings-example-fail-'))
  const path = join(dir, 'sub', 'settings.json')
  const store = new SettingsStore(path)
  await mkdir(join(dir, 'sub'))
  await chmod(join(dir, 'sub'), 0o500)
  try {
    expect(store.setExampleState('writing')).toBe(false)
    expect(store.exampleState()).toBe('absent')
  } finally {
    await chmod(join(dir, 'sub'), 0o700)
  }
  expect(store.setExampleState('writing')).toBe(true)
  await chmod(path, 0o400)
  try {
    expect(store.setExampleState('written')).toBe(false)
    expect(store.exampleState()).toBe('writing')
  } finally {
    await chmod(path, 0o600)
  }
})

// ---- the save is all or nothing --------------------------------------------------------------------

test('a save that fails part-way through its write leaves the settings file as it was, whole and readable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-settings-partial-'))
  const path = join(dir, 'settings.json')
  const first = new SettingsStore(path)
  first.touchRecent('/tmp/kept')
  expect(first.setExampleState('written', 1)).toBe(true)
  const before = await readFile(path, 'utf8')

  // A separate process, so the faulty disk is nobody else's: every write of the settings text puts
  // half of it down and then fails as a full disk does.
  const probe = Bun.spawn([process.execPath, '-e', String.raw`
    import { mock } from 'bun:test'
    import * as fs from 'node:fs'
    const real = { ...fs }
    let partial = 0
    void mock.module('node:fs', () => ({
      ...real,
      writeFileSync: (target, data, options) => {
        const text = String(data)
        real.writeFileSync(target, text.slice(0, Math.floor(text.length / 2)), options)
        partial += 1
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      },
    }))
    const { SettingsStore } = await import('./src/main/settings.ts')
    const store = new SettingsStore(process.env.WF_SETTINGS_PATH)
    const saved = store.setExampleFiles(['00 Start here.md', '11 Objects.md'])
    const state = store.setExampleState('removed')
    store.touchRecent('/tmp/lost')
    console.log(JSON.stringify({ saved, state, partial, files: store.exampleFiles().length, exampleState: store.exampleState() }))
  `], { cwd: new URL('../..', import.meta.url).pathname, env: { ...process.env, WF_SETTINGS_PATH: path }, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([probe.exited, new Response(probe.stdout).text(), new Response(probe.stderr).text()])
  if (exitCode !== 0) throw new Error(`The probe exited ${exitCode}: ${stderr}`)
  // The fault was really hit three times, each save said so, and the store kept what it had.
  expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '')).toEqual({ saved: false, state: false, partial: 3, files: 12, exampleState: 'written' })

  expect(await readFile(path, 'utf8')).toBe(before)
  expect(await readdir(dir)).toEqual(['settings.json']) // no half-written file left beside it
  const reopened = new SettingsStore(path)
  expect(reopened.exampleState()).toBe('written')
  expect(reopened.recents().map((recent) => recent.root)).toEqual(['/tmp/kept'])
})

test('a save replaces the file whole: its permissions are kept, nothing is left beside it, a symlinked settings file stays a link, and a link to nothing is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-settings-atomic-'))
  const path = join(dir, 'settings.json')
  const store = new SettingsStore(path)
  store.touchRecent('/tmp/a')
  await chmod(path, 0o600)
  store.touchRecent('/tmp/b')
  expect((await lstat(path)).mode & 0o777).toBe(0o600)
  expect(await readdir(dir)).toEqual(['settings.json'])
  expect(new SettingsStore(path).recents().map((recent) => recent.root)).toEqual(['/tmp/b', '/tmp/a'])

  // A settings file that is a link into another folder: the file it points at is replaced, the link is not.
  const elsewhere = await mkdtemp(join(tmpdir(), 'wf-settings-linked-'))
  const target = join(elsewhere, 'kept-settings.json')
  await writeFile(target, JSON.stringify({ recents: [{ root: '/tmp/old', openedAt: 1 }] }))
  const linkDir = await mkdtemp(join(tmpdir(), 'wf-settings-link-'))
  const link = join(linkDir, 'settings.json')
  await symlink(target, link)
  const linked = new SettingsStore(link)
  expect(linked.setExampleState('written', 1)).toBe(true)
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  expect((await lstat(target)).isFile()).toBe(true)
  expect(JSON.parse(await readFile(target, 'utf8')).example).toEqual({ state: 'written', at: 1 })
  expect(await readdir(linkDir)).toEqual(['settings.json'])
  expect(await readdir(elsewhere)).toEqual(['kept-settings.json'])

  // Two links to an existing file: the file at the end is replaced, both links stay links.
  const hop = join(linkDir, 'hop.json')
  const twoHop = join(linkDir, 'two-hop.json')
  await symlink(target, hop)
  await symlink(hop, twoHop)
  expect(new SettingsStore(twoHop).setExampleState('removed', 2)).toBe(true)
  expect((await lstat(twoHop)).isSymbolicLink()).toBe(true)
  expect((await lstat(hop)).isSymbolicLink()).toBe(true)
  expect((await lstat(target)).isFile()).toBe(true)
  expect(JSON.parse(await readFile(target, 'utf8')).example).toEqual({ state: 'removed', at: 2 })
  expect(await readdir(elsewhere)).toEqual(['kept-settings.json'])

  // A link that does not end at an existing file is refused: nothing is created, every link is kept.
  const refusedDir = await mkdtemp(join(tmpdir(), 'wf-settings-refused-'))
  const missing = join(elsewhere, 'later.json')
  const names = {
    dangling: join(refusedDir, 'dangling.json'), // -> a file that is not there
    chainStart: join(refusedDir, 'chain.json'), // -> chain-hop.json -> a file that is not there
    chainHop: join(refusedDir, 'chain-hop.json'),
    loopA: join(refusedDir, 'loop-a.json'), // -> loop-b.json -> loop-a.json
    loopB: join(refusedDir, 'loop-b.json'),
    toFolder: join(refusedDir, 'to-folder.json'), // -> a folder
  }
  await symlink(missing, names.dangling)
  await symlink(missing, names.chainHop)
  await symlink(names.chainHop, names.chainStart)
  await symlink(names.loopB, names.loopA)
  await symlink(names.loopA, names.loopB)
  await symlink(elsewhere, names.toFolder)
  for (const path of [names.dangling, names.chainStart, names.loopA, names.toFolder]) {
    const refused = new SettingsStore(path)
    expect(refused.setExampleState('writing', 1), path).toBe(false)
    expect(refused.setExampleFiles(['a.md']), path).toBe(false)
    refused.touchRecent('/tmp/c')
  }
  for (const path of Object.values(names)) expect((await lstat(path)).isSymbolicLink(), path).toBe(true)
  expect((await readdir(refusedDir)).sort()).toEqual(['chain-hop.json', 'chain.json', 'dangling.json', 'loop-a.json', 'loop-b.json', 'to-folder.json'])
  expect(await readdir(elsewhere)).toEqual(['kept-settings.json'])
  expect(existsSync(missing)).toBe(false)

  // Something that is not a file at the settings path is never replaced.
  const folder = join(dir, 'a-folder')
  await mkdir(folder)
  expect(new SettingsStore(folder).setExampleState('writing')).toBe(false)
  expect((await lstat(folder)).isDirectory()).toBe(true)
  expect(await readdir(folder)).toEqual([])
})

test('the list of written example files: only a list of names is a list; anything else reads as the twelve original files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wf-settings-example-files-'))
  const path = join(dir, 'settings.json')
  const original = new SettingsStore(path).exampleFiles() // no file, no key
  expect(original).toHaveLength(12)
  expect(original).toContain('04 Listen.md')
  for (const malformed of [[null, 42], ['04 Listen.md', 7], 'all', 42, false, null, {}, { length: 0 }]) {
    await writeFile(path, JSON.stringify({ example: { state: 'written', at: 1 }, exampleFiles: malformed }))
    expect(new SettingsStore(path).exampleFiles(), JSON.stringify(malformed)).toEqual(original)
  }
  await writeFile(path, JSON.stringify({ exampleFiles: ['00 Start here.md', 'not a lesson.md'] }))
  const store = new SettingsStore(path)
  expect(store.exampleFiles()).toEqual(['00 Start here.md', 'not a lesson.md'])
  expect(store.setExampleFiles(['a.md', 'a.md', 'b.md'])).toBe(true)
  expect(new SettingsStore(path).exampleFiles()).toEqual(['a.md', 'b.md'])
})
