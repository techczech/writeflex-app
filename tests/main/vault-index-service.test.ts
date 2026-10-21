import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { readVaultWorkSettings, VaultIndexService } from '../../src/main/vault-index-service'
import { DEFAULT_SUPPORT_FOLDERS, DEFAULT_VAULT_HIDDEN } from '../../src/main/vault-works'
import { onVaultChanged, vaultStoreFor } from '../../src/main/vault-store'

/**
 * The seam behind the `vault:index` preload call: the per-root cached result of work detection over a
 * real folder, read through the search content cache, snapshotted to userData and never into the vault.
 */
function folder(files: Record<string, string>, vaultJson?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'wf-vault-index-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  if (vaultJson !== undefined) {
    mkdirSync(join(root, '.writeflex'))
    writeFileSync(join(root, '.writeflex', 'vault.json'), vaultJson)
  }
  return root
}

/** Every entry under a root with its size and mtime, to prove nothing inside it was written. */
function snapshotTree(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const info = statSync(path)
      out.push(`${relative(root, path)}:${entry.isDirectory() ? 'dir' : `${info.size}:${info.mtimeMs}`}`)
      if (entry.isDirectory()) walk(path)
    }
  }
  walk(root)
  return out.sort()
}

describe('VaultIndexService', () => {
  test('a root without vault.json is not a vault: null, nothing read, nothing written', async () => {
    const root = folder({ 'a.md': '# A' })
    const before = snapshotTree(root)
    const cacheDir = mkdtempSync(join(tmpdir(), 'wf-vault-cache-'))
    const ws = new Workspace(root)
    expect(await new VaultIndexService({ cacheDir }).get(ws)).toBeNull()
    expect(ws.searchIndex.reads).toBe(0)
    expect(existsSync(join(root, '.writeflex'))).toBe(false)
    expect(snapshotTree(root)).toEqual(before)
    expect(readdirSync(cacheDir)).toEqual([])
  })

  test('a vault gets its index; a second ask is the cached result with no reads; nothing is written inside the vault', async () => {
    const root = folder({
      'AGENTS.md': '# agents',
      'essay.md': '---\ntitle: Ignored\nstatus: draft\n---\n# The essay',
      'report/_report-structure.json': JSON.stringify({ files: [{ path: '01-a.md' }] }),
      'report/README.md': '---\nstatus: review\n---\n# The report',
      'report/01-a.md': '# Part A',
      'indexes/list.md': '# An index list',
    }, JSON.stringify({ name: 'Mine', hidden: [...DEFAULT_VAULT_HIDDEN, 'indexes'] }))
    const before = snapshotTree(root)
    const cacheDir = join(mkdtempSync(join(tmpdir(), 'wf-vault-cache-')), 'vault-index')
    const service = new VaultIndexService({ cacheDir })
    const ws = new Workspace(root)

    const first = await service.get(ws)
    expect(first?.works.map((w) => [w.path, w.kind, w.title, w.status])).toEqual([
      ['essay.md', 'file', 'The essay', 'draft'],
      ['report', 'folio', 'The report', 'review'],
    ])
    expect(first?.hidden).toEqual({ paths: ['AGENTS.md', 'indexes'], countText: '1 folder and 1 file hidden' })
    const readsAfterFirst = ws.searchIndex.reads

    const second = await service.get(ws)
    expect(second).toBe(first!)
    expect(ws.searchIndex.reads).toBe(readsAfterFirst)
    expect(service.directReads).toBe(0) // indexes/ is outside search scope but hidden, so never read

    expect(snapshotTree(root)).toEqual(before)
    const snapshots = readdirSync(cacheDir)
    expect(snapshots.length).toBe(1)
    expect(JSON.parse(readFileSync(join(cacheDir, snapshots[0]), 'utf8'))).toMatchObject({ root, index: first })
  })

  test('after a change is invalidated, the next ask recomputes and re-reads only the changed file', async () => {
    const root = folder({ 'a.md': '# A', 'b.md': '# B' }, '{}')
    const service = new VaultIndexService({ cacheDir: null })
    const ws = new Workspace(root)
    await service.get(ws)
    const reads = ws.searchIndex.reads
    expect(service.known(root)).toBe(true)

    writeFileSync(join(root, 'a.md'), '# A renamed in its heading, longer')
    writeFileSync(join(root, 'c.md'), '# C')
    service.invalidate(root, ['a.md', 'c.md'])
    ws.searchIndex.invalidate(['a.md', 'c.md'])
    const next = await service.get(ws)
    expect(next?.labels).toEqual({ 'a.md': 'A renamed in its heading, longer', 'b.md': 'B', 'c.md': 'C' })
    expect(ws.searchIndex.reads).toBe(reads + 2)
  })

  test('a 2,600-file vault recomputes warm well inside a second and reads each file once', async () => {
    const files: Record<string, string> = {}
    for (let t = 0; t < 26; t += 1) {
      for (let i = 0; i < 100; i += 1) files[`topic-${t}/sub-${i % 5}/piece-${i}.md`] = `---\nstatus: draft\n---\n# Piece ${t}.${i}\n\nSome body text.\n`
    }
    const root = folder(files, '{}')
    const service = new VaultIndexService({ cacheDir: null })
    const ws = new Workspace(root)
    const coldStart = performance.now()
    const cold = await service.get(ws)
    const coldMs = performance.now() - coldStart
    expect(cold?.works.length).toBe(2600)
    expect(ws.searchIndex.reads).toBe(2600)

    service.invalidate(root)
    const warmStart = performance.now()
    const warm = await service.get(ws)
    const warmMs = performance.now() - warmStart
    console.log(`vault index over 2,600 files: cold ${coldMs.toFixed(0)} ms, warm ${warmMs.toFixed(0)} ms`)
    expect(warm).toEqual(cold)
    expect(ws.searchIndex.reads).toBe(2600)
    expect(warmMs).toBeLessThan(1000)
  })
})

describe('VaultIndexService freshness and passes (ticket 02 fix round)', () => {
  /** A settings reader that waits for `open()` before answering, so a computation can be held mid-way. */
  function gatedSettings() {
    const waiting: Array<() => void> = []
    let calls = 0
    const settings = { hidden: [...DEFAULT_VAULT_HIDDEN], supportFolders: [...DEFAULT_SUPPORT_FOLDERS] }
    return {
      read: async () => { calls += 1; await new Promise<void>((resolve) => waiting.push(resolve)); return settings },
      open: () => { for (const resolve of waiting.splice(0)) resolve() },
      calls: () => calls,
    }
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

  test('a second ask while the first computation runs waits for it instead of answering null', async () => {
    const root = folder({ 'a.md': '# A' }, '{}')
    const gate = gatedSettings()
    const service = new VaultIndexService({ cacheDir: null, readSettings: gate.read })
    const ws = new Workspace(root)
    const first = service.get(ws)
    await tick()
    const second = service.get(ws)
    gate.open()
    const [a, b] = await Promise.all([first, second])
    expect(a?.labels).toEqual({ 'a.md': 'A' })
    expect(b).toBe(a)
    expect(gate.calls()).toBe(1)
  })

  test('a change invalidated mid-computation gets a new pass; a failed pass is not marked fresh', async () => {
    const root = folder({ 'a.md': '# A' }, '{}')
    const gate = gatedSettings()
    const service = new VaultIndexService({ cacheDir: null, readSettings: gate.read })
    const ws = new Workspace(root)
    const first = service.get(ws)
    await tick()
    writeFileSync(join(root, 'b.md'), '# B')
    service.invalidate(root, ['b.md'])
    const second = service.get(ws)
    gate.open()
    await first
    await tick()
    gate.open()
    expect((await second)?.labels).toEqual({ 'a.md': 'A', 'b.md': 'B' })
    expect(gate.calls()).toBe(2)

    let fail = true
    const flaky = new VaultIndexService({
      cacheDir: null,
      readSettings: async () => { if (fail) throw new Error('disk busy'); return { hidden: [], supportFolders: [] } },
    })
    await expect(flaky.get(ws)).rejects.toThrow('disk busy')
    fail = false
    expect((await flaky.get(ws))?.labels).toEqual({ 'a.md': 'A', 'b.md': 'B' })
  })

  test('detection repeats until no new out-of-scope file is asked for (main document found after its index note)', async () => {
    const root = folder({
      'indexes/topic/_topic_INDEX.md': '---\npiece: one\n---\n',
      'indexes/topic/_topic.md': '---\nstatus: draft\n---\n# The topic',
      'indexes/topic/a.md': '# A',
    }, '{}')
    const service = new VaultIndexService({ cacheDir: null })
    const index = await service.get(new Workspace(root))
    expect(index?.works.map((w) => [w.path, w.kind, w.title, w.status])).toEqual([['indexes/topic', 'folder-piece', 'The topic', 'draft']])
  })
})

describe('readVaultWorkSettings (through the vault store)', () => {
  test('null without vault.json; defaults for missing keys and for invalid JSON', async () => {
    expect(await readVaultWorkSettings(folder({}))).toBeNull()
    expect(await readVaultWorkSettings(folder({}, '{"name":"X"}'))).toEqual({ hidden: [...DEFAULT_VAULT_HIDDEN], supportFolders: [...DEFAULT_SUPPORT_FOLDERS] })
    expect(await readVaultWorkSettings(folder({}, '{not json'))).toEqual({ hidden: [...DEFAULT_VAULT_HIDDEN], supportFolders: [...DEFAULT_SUPPORT_FOLDERS] })
    expect(await readVaultWorkSettings(folder({}, '{"hidden":["x"],"supportFolders":["refs"]}'))).toEqual({ hidden: ['x'], supportFolders: ['refs'] })
  })

  test('a vault.json change told by the store invalidates the root; the next ask sees the new hidden set', async () => {
    const root = folder({ 'scratch-old/a.md': '# A', 'essay.md': '# Essay' }, '{"name":"V"}')
    const ws = new Workspace(root)
    const service = new VaultIndexService({ cacheDir: null })
    const stale: string[] = []
    const off = onVaultChanged((changed) => { if (changed === root) { stale.push(changed); service.invalidate(changed) } })
    try {
      expect((await service.get(ws))?.hidden.paths).not.toContain('scratch-old')
      const store = vaultStoreFor(root)
      const vault = await store.read()
      const saved = await store.save({ ...vault!.settings, hidden: ['scratch-old/'] }, vault!.hash)
      expect(saved.ok).toBe(true)
      expect(stale).toEqual([root])
      expect((await service.get(ws))?.hidden.paths).toContain('scratch-old')
    } finally { off() }
  })
})
