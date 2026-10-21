/**
 * The vault store (vaults ticket 01): reading with defaults, the one create, pin operations applied
 * onto the file as it is on disk, the whole save's hash check, an unreadable file left alone, and the
 * change push (outside changes told once, own writes never told as outside).
 *
 * Seam: `VaultStore` over a real temporary folder.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { storeWriteSeams } from '../../src/main/checked-store-write'
import { onVaultChanged, VaultStore } from '../../src/main/vault-store'
import { DEFAULT_SUPPORT_FOLDERS, DEFAULT_VAULT_HIDDEN, VAULT_STEPS, type VaultChangedEvent } from '../../src/shared/vault'

let root: string
let outside: string
const vaultPath = (): string => join(root, '.writeflex', 'vault.json')
const writeVault = async (text: string): Promise<void> => {
  await mkdir(join(root, '.writeflex'), { recursive: true })
  await writeFile(vaultPath(), text)
}
const onDisk = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(vaultPath(), 'utf8'))

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-vault-'))
  outside = await mkdtemp(join(tmpdir(), 'wf-vault-outside-'))
  await mkdir(join(root, 'drafts', 'essays'), { recursive: true })
  await mkdir(join(root, 'reports'))
  await writeFile(join(root, 'notes.md'), '# Notes\n')
  await writeFile(join(root, 'data.txt'), 'not Markdown\n')
})
afterEach(async () => {
  for (const key of Object.keys(storeWriteSeams)) delete storeWriteSeams[key as keyof typeof storeWriteSeams]
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

describe('read', () => {
  test('a root without vault.json is not a vault, and reading creates nothing', async () => {
    expect(await new VaultStore(root).read()).toBeNull()
    expect(existsSync(join(root, '.writeflex'))).toBe(false)
  })

  test('a file naming only the vault reads with every default filled', async () => {
    await writeVault('{"name":"X"}')
    const vault = await new VaultStore(root).read()
    expect(vault?.unreadable).toBe(false)
    expect(vault?.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(vault?.settings).toEqual({
      version: 1, name: 'X', pins: [], hidden: [...DEFAULT_VAULT_HIDDEN], supportFolders: [...DEFAULT_SUPPORT_FOLDERS], statusMap: {}, ladder: [...VAULT_STEPS],
    })
  })

  test('an empty object is named for its folder', async () => {
    await writeVault('{}')
    expect((await new VaultStore(root).read())?.settings.name).toBe(basename(root))
  })
})

describe('create', () => {
  test('writes once with the proposed fields and defaults, then refuses', async () => {
    const store = new VaultStore(root)
    const made = await store.create({ name: 'Writing', statusMap: { draft: 'Drafting' } })
    expect(made.ok).toBe(true)
    const first = await readFile(vaultPath(), 'utf8')
    expect(JSON.parse(first)).toMatchObject({ version: 1, name: 'Writing', pins: [], statusMap: { draft: 'Drafting' } })
    const again = await store.create({ name: 'Other' })
    expect(again).toMatchObject({ ok: false, reason: 'exists' })
    expect(await readFile(vaultPath(), 'utf8')).toBe(first)
  })

  test('refuses an existing unreadable file and leaves its bytes', async () => {
    await writeVault('{ not json')
    expect(await new VaultStore(root).create()).toMatchObject({ ok: false, reason: 'exists' })
    expect(await readFile(vaultPath(), 'utf8')).toBe('{ not json')
  })

  test('refuses a bad field without writing', async () => {
    expect(await new VaultStore(root).create({ statusMap: { draft: 'Nearly' as never } })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(existsSync(join(root, '.writeflex'))).toBe(false)
  })
})

describe('pin operations', () => {
  test('unknown keys survive a pin write with their values and place', async () => {
    await writeVault(JSON.stringify({ name: 'X', future: { deep: [1, 'two', null] }, pins: [], zeta: true }))
    expect((await new VaultStore(root).addPin('reports')).ok).toBe(true)
    const raw = await onDisk()
    expect(Object.keys(raw)).toEqual(['name', 'future', 'pins', 'zeta'])
    expect(raw.future).toEqual({ deep: [1, 'two', null] })
    expect(raw.zeta).toBe(true)
    expect(raw.pins).toEqual(['reports'])
  })

  test('a change made on disk after the renderer read is kept by add, reorder and remove', async () => {
    await writeVault(JSON.stringify({ name: 'X', pins: ['reports'] }))
    const store = new VaultStore(root)
    const seen = await store.read()
    expect(seen?.settings.pins).toEqual(['reports'])
    // Another Mac adds a pin and a setting between the read and the operation.
    await writeVault(JSON.stringify({ name: 'X', pins: ['reports', 'drafts'], hidden: ['old'] }))
    expect((await store.addPin('drafts/essays')).ok).toBe(true)
    expect(await onDisk()).toEqual({ name: 'X', pins: ['reports', 'drafts', 'drafts/essays'], hidden: ['old'] })
    // The renderer reorders from its stale list; the pin it never saw keeps its place after the rest.
    await writeVault(JSON.stringify({ name: 'X', pins: ['reports', 'drafts', 'drafts/essays', 'later'], hidden: ['old'] }))
    expect((await store.reorderPins(['drafts/essays', 'reports', 'drafts', 'gone'])).ok).toBe(true)
    expect((await onDisk()).pins).toEqual(['drafts/essays', 'reports', 'drafts', 'later'])
    await writeVault(JSON.stringify({ name: 'Renamed', pins: ['drafts/essays', 'reports', 'drafts', 'later'] }))
    const removed = await store.removePin('reports')
    expect(removed.ok && removed.vault.settings.pins).toEqual(['drafts/essays', 'drafts', 'later'])
    expect((await onDisk()).name).toBe('Renamed')
  })

  test('addPin refuses .., absolute paths, missing folders and duplicates; stores the normal form', async () => {
    await writeVault('{"name":"X"}')
    const store = new VaultStore(root)
    for (const bad of ['../outside', 'drafts/../..', '/etc', join(root, 'reports'), 'missing', 'missing.md', '', '.']) {
      expect(await store.addPin(bad)).toMatchObject({ ok: false, reason: 'invalid' })
    }
    expect((await store.addPin('./drafts/essays/')).ok).toBe(true)
    expect(await store.addPin('drafts//essays')).toMatchObject({ ok: false, reason: 'invalid' })
    expect((await onDisk()).pins).toEqual(['drafts/essays'])
  })

  test('addPin refuses a folder link that leads outside the root', async () => {
    await writeVault('{"name":"X"}')
    await symlink(outside, join(root, 'away'))
    expect(await new VaultStore(root).addPin('away')).toMatchObject({ ok: false, reason: 'invalid' })
  })

  test('addPin accepts a Markdown document inside the root and the view tells each pin\'s kind', async () => {
    await writeVault('{"name":"X"}')
    await writeFile(join(root, 'drafts', 'essay.md'), '# Essay\n')
    const store = new VaultStore(root)
    expect((await store.addPin('notes.md')).ok).toBe(true)
    expect((await store.addPin('./drafts/essay.md')).ok).toBe(true)
    const result = await store.addPin('reports')
    expect(result.ok && result.vault.pinKinds).toEqual([['notes.md', 'document'], ['drafts/essay.md', 'document'], ['reports', 'folder']])
    expect((await onDisk()).pins).toEqual(['notes.md', 'drafts/essay.md', 'reports'])
    expect(await store.addPin('notes.md')).toMatchObject({ ok: false, reason: 'invalid' })
    await rm(join(root, 'notes.md'))
    expect((await store.read())?.pinKinds).toContainEqual(['notes.md', 'missing'])
    // A missing document still unpins.
    expect((await store.removePin('notes.md')).ok).toBe(true)
    expect((await onDisk()).pins).toEqual(['drafts/essay.md', 'reports'])
  })

  test('addPin refuses a file that is not .md, a link to a document outside the root, and .writeflex itself', async () => {
    await writeVault('{"name":"X"}')
    await writeFile(join(root, 'notes.markdown'), '# x\n')
    await writeFile(join(outside, 'secret.md'), '# Secret\n')
    await symlink(join(outside, 'secret.md'), join(root, 'linked.md'))
    await symlink(outside, join(root, 'away'))
    const store = new VaultStore(root)
    for (const bad of ['data.txt', 'notes.markdown', 'linked.md', 'away/secret.md', '.writeflex', '.writeflex/vault.json', '.WriteFlex/vault.json', '../outside/secret.md', join(root, 'notes.md')]) {
      expect(await store.addPin(bad)).toMatchObject({ ok: false, reason: 'invalid' })
    }
    expect((await onDisk()).pins).toBeUndefined()
  })

  test('a link inside the root to a document inside the root pins the document in its own spelling', async () => {
    await writeVault('{"name":"X"}')
    await symlink(join(root, 'notes.md'), join(root, 'alias.md'))
    expect((await new VaultStore(root).addPin('alias.md')).ok).toBe(true)
    expect((await onDisk()).pins).toEqual(['notes.md'])
  })

  test('folders and documents share one order: reorder and remove across kinds', async () => {
    await writeVault(JSON.stringify({ name: 'X', future: 1, pins: [] }))
    await writeFile(join(root, 'drafts', 'essay.md'), '# Essay\n')
    const store = new VaultStore(root)
    for (const pin of ['reports', 'notes.md', 'drafts', 'drafts/essay.md']) expect((await store.addPin(pin)).ok).toBe(true)
    expect((await store.reorderPins(['drafts/essay.md', 'reports', 'notes.md', 'drafts'])).ok).toBe(true)
    expect(await onDisk()).toEqual({ name: 'X', future: 1, pins: ['drafts/essay.md', 'reports', 'notes.md', 'drafts'] })
    expect((await store.removePin('notes.md')).ok).toBe(true)
    const view = await store.read()
    expect(view?.settings.pins).toEqual(['drafts/essay.md', 'reports', 'drafts'])
    expect(view?.pinKinds).toEqual([['drafts/essay.md', 'document'], ['reports', 'folder'], ['drafts', 'folder']])
  })

  test('a whole save and a create accept document pins and refuse a non-Markdown file', async () => {
    const store = new VaultStore(root)
    expect(await store.create({ pins: ['notes.md', 'data.txt'] })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await store.create({ pins: ['notes.md', 'missing.md'] })).toMatchObject({ ok: false, reason: 'invalid' })
    const created = await store.create({ pins: ['notes.md', 'reports'] })
    expect(created.ok && created.vault.pinKinds).toEqual([['notes.md', 'document'], ['reports', 'folder']])
    if (!created.ok) return
    // A pinned document deleted since stays on a save (its "not found" row), as a missing folder does.
    await rm(join(root, 'notes.md'))
    const saved = await store.save({ ...created.vault.settings, pins: ['reports', 'notes.md'] }, (await store.read())!.hash)
    expect(saved.ok && saved.vault.settings.pins).toEqual(['reports', 'notes.md'])
    expect(saved.ok && saved.vault.pinKinds).toEqual([['reports', 'folder'], ['notes.md', 'missing']])
    expect(await store.save({ pins: ['data.txt'] }, (await store.read())!.hash)).toMatchObject({ ok: false, reason: 'invalid' })
  })

  test('a folder or document the listing hides (inside a dot-folder or a tooling folder) is refused; a stored one reads missing, stays on a save and unpins', async () => {
    await writeVault('{"name":"X"}')
    await mkdir(join(root, '.drafts', 'deep'), { recursive: true })
    await writeFile(join(root, '.drafts', 'note.md'), '# Hidden\n')
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'pkg', 'readme.md'), '# Pkg\n')
    await mkdir(join(root, 'drafts', '.private'))
    await writeFile(join(root, '.dotted.md'), '# A dot-named document in a shown folder\n')
    await symlink(join(root, '.drafts'), join(root, 'shortcut'))
    const store = new VaultStore(root)
    for (const bad of ['.drafts/note.md', '.drafts', '.drafts/deep', 'node_modules/pkg', 'node_modules/pkg/readme.md', 'drafts/.private', 'shortcut/note.md', 'shortcut']) {
      expect(await store.addPin(bad)).toMatchObject({ ok: false, reason: 'invalid' })
    }
    // The listing shows a dot-named FILE in a shown folder, so it pins.
    expect((await store.addPin('.dotted.md')).ok).toBe(true)
    expect(await store.save({ pins: ['.dotted.md', '.drafts/note.md'] }, (await store.read())!.hash)).toMatchObject({ ok: false, reason: 'invalid' })
    // A pin stored before this rule (or by another app) reads missing, is kept by a save, and unpins.
    await writeVault('{"name":"X","pins":[".drafts/note.md","reports"]}')
    const seen = (await store.read())!
    expect(seen.pinKinds).toEqual([['.drafts/note.md', 'missing'], ['reports', 'folder']])
    expect((await store.save({ ...seen.settings, name: 'Y' }, seen.hash)).ok).toBe(true)
    expect((await onDisk()).pins).toEqual(['.drafts/note.md', 'reports'])
    expect((await store.removePin('.drafts/note.md')).ok).toBe(true)
    expect((await onDisk()).pins).toEqual(['reports'])
  })

  test('a folder named __proto__ keeps its own kind entry', async () => {
    await writeVault('{"name":"X"}')
    await mkdir(join(root, '__proto__'))
    await writeFile(join(root, '__proto__', 'constructor.md'), '# c\n')
    const store = new VaultStore(root)
    expect((await store.addPin('__proto__')).ok).toBe(true)
    const result = await store.addPin('__proto__/constructor.md')
    expect(result.ok && result.vault.pinKinds).toEqual([['__proto__', 'folder'], ['__proto__/constructor.md', 'document']])
    // The view survives a structured clone (the IPC hop) with the entry intact.
    expect(structuredClone((await store.read())!).pinKinds).toEqual([['__proto__', 'folder'], ['__proto__/constructor.md', 'document']])
  })

  test('a link out of the root gives one answer whether or not the outside target exists (add, save and view)', async () => {
    await symlink(outside, join(root, 'away'))
    await symlink(join(outside, 'gone'), join(root, 'dangling'))
    const answers = async (): Promise<unknown[]> => {
      await writeVault('{"name":"X","pins":["reports"]}')
      const store = new VaultStore(root)
      const out: unknown[] = []
      for (const probe of ['away/secret.md', 'away/sub', 'away/sub/deeper.md', 'dangling', 'dangling/x.md']) {
        out.push(await store.addPin(probe))
        const seen = (await store.read())!
        out.push(await store.save({ ...seen.settings, pins: ['reports', probe] }, seen.hash))
      }
      await writeVault('{"name":"X","pins":["away/secret.md","away/sub","away/sub/deeper.md","dangling","dangling/x.md"]}')
      const view = (await store.read())!
      out.push(view.pinKinds)
      out.push(view.settings.pins)
      return out.map((answer) => JSON.parse(JSON.stringify(answer, (key, value) => (key === 'hash' ? 'h' : value))))
    }
    const absent = await answers()
    await writeFile(join(outside, 'secret.md'), '# Secret\n')
    await mkdir(join(outside, 'sub'))
    await writeFile(join(outside, 'sub', 'deeper.md'), '# Deeper\n')
    await mkdir(join(outside, 'gone'))
    await writeFile(join(outside, 'gone', 'x.md'), '# x\n')
    const present = await answers()
    expect(present).toEqual(absent)
    for (const answer of absent.slice(0, 10)) expect(answer).toMatchObject({ ok: false, reason: 'invalid' })
    expect(absent[10]).toEqual([['away/secret.md', 'missing'], ['away/sub', 'missing'], ['away/sub/deeper.md', 'missing'], ['dangling', 'missing'], ['dangling/x.md', 'missing']])
  })

  test('a link chain that leaves the root and comes back gives one answer whether or not the outside hop exists (add, save and view)', async () => {
    // away -> outside/bridge -> root/reports; away.md -> outside/bridge.md -> root/notes.md
    await symlink(join(outside, 'bridge'), join(root, 'away'))
    await symlink(join(outside, 'bridge.md'), join(root, 'away.md'))
    // An in-vault link whose target walks through the outside link: inner -> away/x (relative)
    await symlink('away', join(root, 'inner'))
    const probes = ['away', 'away.md', 'inner']
    const answers = async (): Promise<unknown[]> => {
      await writeVault('{"name":"X","pins":["reports"]}')
      const store = new VaultStore(root)
      const out: unknown[] = []
      for (const probe of probes) {
        out.push(await store.addPin(probe))
        const seen = (await store.read())!
        out.push(await store.save({ ...seen.settings, pins: ['reports', probe] }, seen.hash))
      }
      await writeVault(JSON.stringify({ name: 'X', pins: probes }))
      const view = (await store.read())!
      out.push(view.pinKinds)
      out.push(view.settings.pins)
      return out.map((answer) => JSON.parse(JSON.stringify(answer, (key, value) => (key === 'hash' ? 'h' : value))))
    }
    const absent = await answers()
    await symlink(join(root, 'reports'), join(outside, 'bridge'))
    await symlink(join(root, 'notes.md'), join(outside, 'bridge.md'))
    const present = await answers()
    expect(present).toEqual(absent)
    for (const answer of absent.slice(0, 6)) expect(answer).toMatchObject({ ok: false, reason: 'invalid' })
    expect(absent[6]).toEqual([['away', 'missing'], ['away.md', 'missing'], ['inner', 'missing']])
  })

  test('a chain of links inside the root is followed hop by hop; a link loop refuses', async () => {
    await writeVault('{"name":"X"}')
    await mkdir(join(root, 'links'))
    await symlink('../reports', join(root, 'links', 'r1'))
    await symlink('links/r1', join(root, 'r2'))
    await symlink(join(root, 'r2'), join(root, 'r3'))
    await symlink('drafts', join(root, 'd1'))
    await writeFile(join(root, 'drafts', 'essays', 'one.md'), '# One\n')
    await symlink('d1/essays/one.md', join(root, 'one.md'))
    await symlink('loop-b', join(root, 'loop-a'))
    await symlink('loop-a', join(root, 'loop-b'))
    const store = new VaultStore(root)
    expect((await store.addPin('r3')).ok).toBe(true)
    expect((await store.addPin('d1/essays')).ok).toBe(true)
    const result = await store.addPin('one.md')
    expect(result.ok && result.vault.pinKinds).toEqual([['reports', 'folder'], ['drafts/essays', 'folder'], ['drafts/essays/one.md', 'document']])
    expect(await store.addPin('loop-a')).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await store.addPin('loop-a/x.md')).toMatchObject({ ok: false, reason: 'invalid' })
  })

  test("a link's '..' is taken after the links before it, as the filesystem does; a missing folder before '..' refuses", async () => {
    await writeVault('{"name":"X"}')
    await mkdir(join(root, 'sub', 'deep'), { recursive: true })
    await writeFile(join(root, 'sub', 'notes.md'), '# Sub notes\n')
    await symlink('sub/deep', join(root, 'a'))
    await symlink('a/../notes.md', join(root, 'pin.md'))
    await symlink('absent/../notes.md', join(root, 'ghost.md'))
    await symlink('notes.md/../reports', join(root, 'through-file'))
    await symlink('../notes.md', join(root, 'above.md'))
    const store = new VaultStore(root)
    const result = await store.addPin('pin.md')
    expect(result.ok && result.vault.pinKinds).toEqual([['sub/notes.md', 'document']])
    for (const bad of ['ghost.md', 'through-file', 'above.md']) expect(await store.addPin(bad)).toMatchObject({ ok: false, reason: 'invalid' })
    await writeVault('{"name":"X","pins":["ghost.md","above.md","pin.md"]}')
    expect((await store.read())!.pinKinds).toEqual([['ghost.md', 'missing'], ['above.md', 'missing'], ['pin.md', 'document']])
  })

  test('pins naming the .writeflex folder are dropped when the file is read', async () => {
    await writeVault(JSON.stringify({ name: 'X', pins: ['.writeflex/vault.json', 'notes.md'] }))
    expect((await new VaultStore(root).read())?.settings.pins).toEqual(['notes.md'])
  })

  test('pin operations on a root that is not a vault refuse and create nothing', async () => {
    expect(await new VaultStore(root).addPin('reports')).toMatchObject({ ok: false, reason: 'not-a-vault' })
    expect(existsSync(join(root, '.writeflex'))).toBe(false)
  })

  test('removing a pin already gone writes nothing', async () => {
    await writeVault('{"name":"X","pins":["reports"]}')
    expect((await new VaultStore(root).removePin('drafts')).ok).toBe(true)
    expect(await readFile(vaultPath(), 'utf8')).toBe('{"name":"X","pins":["reports"]}')
  })
})

describe('pin identity', () => {
  /** Does this test disk ignore case? Probed the way a person would: does the other spelling reach the folder. */
  const ignoresCase = async (): Promise<boolean> => {
    const a = await lstat(join(root, 'reports'))
    const b = await lstat(join(root, 'REPORTS')).catch(() => null)
    return Boolean(b && b.ino === a.ino)
  }

  test('spaces in a folder name are kept: " reports " and "reports" are two folders', async () => {
    await mkdir(join(root, ' reports '))
    await writeVault('{"name":"X"}')
    const store = new VaultStore(root)
    expect((await store.addPin(' reports ')).ok).toBe(true)
    expect((await store.addPin('reports')).ok).toBe(true)
    expect((await onDisk()).pins).toEqual([' reports ', 'reports'])
    expect((await store.removePin(' reports ')).ok).toBe(true)
    expect((await onDisk()).pins).toEqual(['reports'])
  })

  test('a name with only its spaces present on disk is not pinned as the trimmed one', async () => {
    await writeVault('{"name":"X"}')
    expect(await new VaultStore(root).addPin(' drafts')).toMatchObject({ ok: false, reason: 'invalid' })
  })

  test('composed and decomposed spellings of one folder are one pin, stored as spelled on disk', async () => {
    const onDiskName = 'cafe\u0301' // decomposed, as some tools create it
    await mkdir(join(root, onDiskName))
    await writeVault('{"name":"X"}')
    const store = new VaultStore(root)
    expect((await store.addPin('caf\u00e9')).ok).toBe(true)
    expect((await onDisk()).pins).toEqual([onDiskName])
    expect(await store.addPin(onDiskName)).toMatchObject({ ok: false, reason: 'invalid' })
    expect((await store.reorderPins(['caf\u00e9'])).ok).toBe(true)
    expect((await store.removePin('caf\u00e9')).ok).toBe(true)
    expect((await onDisk()).pins).toEqual([])
  })

  test('on a disk that ignores case, Reports and reports are one pin in the spelling on disk', async () => {
    await mkdir(join(root, 'Mixed'))
    await writeVault('{"name":"X"}')
    const store = new VaultStore(root)
    if (!(await ignoresCase())) {
      expect(await store.addPin('mixed')).toMatchObject({ ok: false, reason: 'invalid' })
      return
    }
    expect((await store.addPin('mixed')).ok).toBe(true)
    expect((await onDisk()).pins).toEqual(['Mixed'])
    expect(await store.addPin('MIXED')).toMatchObject({ ok: false, reason: 'invalid' })
    expect((await store.addPin('reports')).ok).toBe(true)
    expect((await store.reorderPins(['REPORTS', 'mixed'])).ok).toBe(true)
    expect((await onDisk()).pins).toEqual(['reports', 'Mixed'])
    expect((await store.removePin('mIxEd')).ok).toBe(true)
    expect((await onDisk()).pins).toEqual(['reports'])
  })
})

describe('values JSON numbers cannot hold', () => {
  for (const [label, text] of [
    ['an integer beyond the safe range', '{"name":"X","big":9007199254740993,"pins":[]}'],
    ['a number beyond the double range', '{"name":"X","big":1e400,"pins":[]}'],
    ['a nested precise number', '{"name":"X","big":{"deep":[0.10000000000000000000001]},"pins":[]}'],
  ] as const) {
    test(`${label} refuses a pin write and a save, naming the key, and leaves the bytes`, async () => {
      await writeVault(text)
      const store = new VaultStore(root)
      const result = await store.addPin('reports')
      expect(result).toMatchObject({ ok: false, reason: 'refused' })
      expect(!result.ok && result.message).toContain('"big"')
      const seen = (await store.read())!
      expect(await store.save({ ...seen.settings, name: 'Y' }, seen.hash)).toMatchObject({ ok: false, reason: 'refused' })
      expect(await readFile(vaultPath(), 'utf8')).toBe(text)
    })
  }

  test('a key written twice refuses (the first value would be dropped)', async () => {
    await writeVault('{"name":"X","twice":1,"twice":2}')
    expect(await new VaultStore(root).addPin('reports')).toMatchObject({ ok: false, reason: 'refused' })
  })

  test('ordinary values in any layout, escapes included, still write and keep their values', async () => {
    const text = '{\n  "name" : "X",\n  "future" : { "n" : [ 1, -2.5, 1.5e-7, true, null ], "s" : "caf\\u00e9 \\/ ok" },\n  "pins": []\n}'
    await writeVault(text)
    expect((await new VaultStore(root).addPin('reports')).ok).toBe(true)
    expect((await onDisk()).future).toEqual({ n: [1, -2.5, 1.5e-7, true, null], s: 'caf\u00e9 / ok' })
  })
})

describe('pin operations racing another writer', () => {
  test('a change that lands between the byte check and the rename is applied onto, not lost', async () => {
    await writeVault(JSON.stringify({ name: 'X', pins: ['reports'] }))
    let landed = false
    storeWriteSeams.afterContentCheck = async () => {
      if (landed) return
      landed = true
      await writeFile(vaultPath(), JSON.stringify({ name: 'X', pins: ['reports', 'drafts'], hidden: ['old'] }))
    }
    expect((await new VaultStore(root).addPin('drafts/essays')).ok).toBe(true)
    expect(await onDisk()).toEqual({ name: 'X', pins: ['reports', 'drafts', 'drafts/essays'], hidden: ['old'] })
  })

  test('a writer that changes the file on every attempt exhausts the retries: changed, and its last bytes stand', async () => {
    await writeVault(JSON.stringify({ name: 'X', pins: [] }))
    let attempts = 0
    let last = ''
    storeWriteSeams.afterContentCheck = async () => {
      attempts += 1
      last = JSON.stringify({ name: `Other ${attempts}`, pins: [] })
      await writeFile(vaultPath(), last)
    }
    const result = await new VaultStore(root).addPin('reports')
    expect(result).toMatchObject({ ok: false, reason: 'changed' })
    expect(!result.ok && result.vault?.settings.name).toBe(`Other ${attempts}`)
    expect(attempts).toBe(4)
    expect(await readFile(vaultPath(), 'utf8')).toBe(last)
  })
})

describe('whole save', () => {
  test('a stale hash returns changed and leaves the file untouched', async () => {
    await writeVault('{"name":"X"}')
    const store = new VaultStore(root)
    const seen = (await store.read())!
    await writeVault('{"name":"Y"}')
    const result = await store.save({ ...seen.settings, name: 'Z' }, seen.hash)
    expect(result).toMatchObject({ ok: false, reason: 'changed' })
    expect(!result.ok && result.vault?.settings.name).toBe('Y')
    expect(await readFile(vaultPath(), 'utf8')).toBe('{"name":"Y"}')
  })

  test('a current hash replaces the known fields and keeps unknown keys', async () => {
    await writeVault('{"name":"X","extra":42}')
    const store = new VaultStore(root)
    const seen = (await store.read())!
    const result = await store.save({ ...seen.settings, name: 'Z', hidden: ['tmp'] }, seen.hash)
    expect(result.ok).toBe(true)
    expect(await onDisk()).toMatchObject({ name: 'Z', extra: 42, hidden: ['tmp'], version: 1 })
  })
})

describe('invalid JSON', () => {
  test('reads as defaults + unreadable; pin operations and a plain save refuse; bytes unchanged', async () => {
    await writeVault('{"name": "X",,}')
    const store = new VaultStore(root)
    const vault = (await store.read())!
    expect(vault.unreadable).toBe(true)
    expect(vault.settings.name).toBe(basename(root))
    expect(await store.addPin('reports')).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(await store.removePin('reports')).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(await store.reorderPins([])).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(await store.save(vault.settings, vault.hash)).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(await readFile(vaultPath(), 'utf8')).toBe('{"name": "X",,}')
    // Only an explicit overwrite (no UI passes it this release) replaces it.
    expect((await store.save(vault.settings, vault.hash, { overwriteUnreadable: true })).ok).toBe(true)
    expect((await onDisk()).version).toBe(1)
  })

  test('a JSON array is unreadable too', async () => {
    await writeVault('[1,2]')
    expect((await new VaultStore(root).read())?.unreadable).toBe(true)
  })
})

describe('links', () => {
  test('a symlinked .writeflex refuses the write and writes nothing through it', async () => {
    await writeFile(join(outside, 'vault.json'), '{"name":"Outside"}')
    await symlink(outside, join(root, '.writeflex'))
    const store = new VaultStore(root)
    expect(await store.read()).toBeNull()
    expect(await store.create({ name: 'X' })).toMatchObject({ ok: false, reason: 'refused' })
    expect(await store.addPin('reports')).toMatchObject({ ok: false })
    expect(await readFile(join(outside, 'vault.json'), 'utf8')).toBe('{"name":"Outside"}')
  })

  test('a symlinked vault.json refuses every write and its target keeps its bytes', async () => {
    await mkdir(join(root, '.writeflex'))
    await writeFile(join(outside, 'target.json'), '{"name":"Outside"}')
    await symlink(join(outside, 'target.json'), vaultPath())
    const store = new VaultStore(root)
    const vault = (await store.read())!
    expect(vault.unreadable).toBe(true)
    expect(await store.addPin('reports')).toMatchObject({ ok: false, reason: 'refused' })
    expect(await store.create()).toMatchObject({ ok: false })
    expect(await store.save(vault.settings, vault.hash, { overwriteUnreadable: true })).toMatchObject({ ok: false, reason: 'refused' })
    expect(await readFile(join(outside, 'target.json'), 'utf8')).toBe('{"name":"Outside"}')
  })

  test('a hard-linked vault.json refuses the write', async () => {
    await writeVault('{"name":"X"}')
    await link(vaultPath(), join(outside, 'second-name.json'))
    const store = new VaultStore(root)
    expect(await store.addPin('reports')).toMatchObject({ ok: false, reason: 'refused' })
    const seen = (await store.read())!
    expect(await store.save(seen.settings, seen.hash)).toMatchObject({ ok: false, reason: 'refused' })
    expect(await readFile(join(outside, 'second-name.json'), 'utf8')).toBe('{"name":"X"}')
  })
})

describe('change push', () => {
  let events: Array<{ root: string; event: VaultChangedEvent }>
  let unsubscribe: () => void
  beforeEach(() => {
    events = []
    unsubscribe = onVaultChanged((changedRoot, event) => events.push({ root: changedRoot, event }))
  })
  afterEach(() => unsubscribe())

  test('an outside change is told once; the next look at the same bytes tells nothing', async () => {
    await writeVault('{"name":"X"}')
    const store = new VaultStore(root)
    await store.read()
    expect(await store.noticeDiskChange()).toBe(false)
    await writeVault('{"name":"From the other Mac"}')
    expect(await store.noticeDiskChange()).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]?.root).toBe(root)
    expect(events[0]?.event.outside).toBe(true)
    expect(events[0]?.event.vault?.settings.name).toBe('From the other Mac')
    expect(await store.noticeDiskChange()).toBe(false)
    expect(events).toHaveLength(1)
  })

  test('an own write is told as not outside, and the watcher event it causes tells nothing', async () => {
    await writeVault('{"name":"X"}')
    const store = new VaultStore(root)
    await store.read()
    await store.addPin('reports')
    expect(events.map((e) => e.event.outside)).toEqual([false])
    expect(events[0]?.event.vault?.settings.pins).toEqual(['reports'])
    expect(await store.noticeDiskChange()).toBe(false)
    expect(events).toHaveLength(1)
  })

  test('a vault made on another Mac, and then removed, is told both times', async () => {
    const store = new VaultStore(root)
    expect(await store.read()).toBeNull()
    await writeVault('{"name":"New"}')
    expect(await store.noticeDiskChange()).toBe(true)
    await rm(join(root, '.writeflex'), { recursive: true })
    expect(await store.noticeDiskChange()).toBe(true)
    expect(events.map((e) => e.event.vault?.settings.name ?? null)).toEqual(['New', null])
  })
})

describe('pins written by create and whole save', () => {
  const ignoresCase = async (): Promise<boolean> => {
    const a = await lstat(join(root, 'reports'))
    const b = await lstat(join(root, 'REPORTS')).catch(() => null)
    return Boolean(b && b.ino === a.ino)
  }

  test('create holds pins to the addPin rule: a missing folder, a non-Markdown file or an outside link refuses the whole create, naming it', async () => {
    await symlink(outside, join(root, 'away'))
    const store = new VaultStore(root)
    for (const bad of ['missing', 'data.txt', 'away']) {
      const result = await store.create({ name: 'X', pins: ['reports', bad] })
      expect(result).toMatchObject({ ok: false, reason: 'invalid' })
      expect(!result.ok && result.message).toContain(bad)
      expect(existsSync(join(root, '.writeflex'))).toBe(false)
    }
  })

  test('create stores pins in their spelling on disk, one per folder (composed/decomposed, and case on a disk that ignores it)', async () => {
    const decomposed = 'café'
    await mkdir(join(root, decomposed))
    await mkdir(join(root, 'Mixed'))
    const folds = await ignoresCase()
    const asked = folds ? ['café', decomposed, 'mixed', 'MIXED', './drafts/essays/'] : ['café', decomposed, 'Mixed', './drafts/essays/']
    expect((await new VaultStore(root).create({ pins: asked })).ok).toBe(true)
    expect((await onDisk()).pins).toEqual([decomposed, 'Mixed', 'drafts/essays'])
  })

  test('save keeps a pin already in the file whose folder is gone, but refuses to add a missing one, naming it', async () => {
    await writeVault('{"name":"X","pins":["reports","gone"]}')
    const store = new VaultStore(root)
    const seen = (await store.read())!
    const kept = await store.save({ ...seen.settings, pins: ['gone', 'reports'] }, seen.hash)
    expect(kept.ok).toBe(true)
    expect((await onDisk()).pins).toEqual(['gone', 'reports'])
    const now = (await store.read())!
    const before = await readFile(vaultPath(), 'utf8')
    const added = await store.save({ ...now.settings, pins: ['gone', 'reports', 'also-gone'] }, now.hash)
    expect(added).toMatchObject({ ok: false, reason: 'invalid' })
    expect(!added.ok && added.message).toContain('also-gone')
    expect(await readFile(vaultPath(), 'utf8')).toBe(before)
  })

  test('save refuses an outside link or a non-Markdown file as a pin, and leaves the bytes', async () => {
    await symlink(outside, join(root, 'away'))
    await writeVault('{"name":"X","pins":["reports"]}')
    const store = new VaultStore(root)
    const seen = (await store.read())!
    for (const bad of ['away', 'data.txt']) {
      const result = await store.save({ ...seen.settings, pins: ['reports', bad] }, seen.hash)
      expect(result).toMatchObject({ ok: false, reason: 'invalid' })
      expect(!result.ok && result.message).toContain(bad)
    }
    expect(await readFile(vaultPath(), 'utf8')).toBe('{"name":"X","pins":["reports"]}')
  })

  test('save re-spells pins as on disk and drops a second spelling of the same folder', async () => {
    await mkdir(join(root, 'Mixed'))
    await writeVault('{"name":"X"}')
    const store = new VaultStore(root)
    const seen = (await store.read())!
    const folds = await ignoresCase()
    const pins = folds ? ['mixed', 'Mixed', 'REPORTS', 'reports'] : ['Mixed', 'reports', 'reports/']
    expect((await store.save({ ...seen.settings, pins }, seen.hash)).ok).toBe(true)
    expect((await onDisk()).pins).toEqual(['Mixed', 'reports'])
  })
})
