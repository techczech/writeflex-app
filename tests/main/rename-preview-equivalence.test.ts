import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { moveFile, previewRename, renameFile, type RenameDoorDeps } from '../../src/main/rename-doors'
import { planRenameRepair, type RenameRepairPlanOptions } from '../../src/main/rename-repair'
import { RenameRepairMarkdownCache } from '../../src/main/rename-repair-markdown'
import { Workspace } from '../../src/main/workspace'

async function withVault<T>(
  files: Record<string, string>,
  run: (workspace: Workspace, put: (path: string, source: string) => Promise<void>) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'wf-rename-preview-equivalence-'))
  const put = async (path: string, source: string) => {
    const absolute = join(root, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, source)
  }
  try {
    for (const [path, source] of Object.entries(files)) await put(path, source)
    return await run(new Workspace(root), put)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function compare(
  workspace: Workspace, cache: RenameRepairMarkdownCache, from: string, to: string, options: RenameRepairPlanOptions = {},
) {
  // The uncached path is the original planning route used by CLI and other non-preview callers.
  const baseline = await planRenameRepair(workspace, from, to, options)
  const optimized = await planRenameRepair(workspace, from, to, { ...options, markdownCache: cache })
  expect(JSON.stringify(optimized)).toBe(JSON.stringify(baseline))
  return optimized
}

const manifest = JSON.stringify({
  schema_version: 1,
  files: [{ path: 'old.md', role: 'report-body', title: 'Old Part' }, { path: 'peer.md', role: 'section' }],
})
const inlineExample = '\x60[[old]]\x60'
const reference = [
  '---\r\nexample: "[[old]]"\r\n---',
  'Prose [[old]], [[./folio/old.md#intro|label]], [[Old Part]] and [[new]].',
  inlineExample + ' and \x60\x60[[new]]\x60\x60',
  '~~~\n[[old]]\n[[new]]\n~~~',
  '> ~~~\n> [[old]]\n> ~~~',
  '    [[old]]',
  'A line with a \x60multi\nline [[old]]\x60 example.',
  '| Link |\n| --- |\n| [[old]] |',
  '<!-- [[old]] -->',
  '~~~\n[[old]]',
].join('\r\n\r\n')

test('whole uncached and cached plans agree for Folios, authored code and moved front matter', async () => {
  await withVault({
    'folio/old.md': '---\nimage: ../art/cover.png\naliases: [Earlier]\n---\n# Old Part\n\n[Peer](peer.md)\n',
    'folio/peer.md': '# Peer\n',
    'folio/_folio_INDEX.md': '# Folio\n\n## Running order\n\n1. [[Old Part]] — a gloss\n2. [[./peer]]\n\n~~~\n[[old]]\n~~~\n',
    'folio/_report-structure.json': manifest,
    'reader.md': reference,
    'art/cover.png': 'Synthetic file bytes',
  }, async (workspace) => {
    const cache = new RenameRepairMarkdownCache()
    const from = 'folio/old.md'
    const inFolio = 'folio/new.md'
    const outside = 'archive/deep/new.md'
    const first = await compare(workspace, cache, from, inFolio)
    expect(first.manifestChanges).toHaveLength(1)
    expect(first.writes.find(({ path }) => path === 'reader.md')?.content).toContain(inlineExample)
    await compare(workspace, cache, from, inFolio)
    const moving = await compare(workspace, cache, from, outside)
    expect(moving.preservedReferences).toHaveLength(1)
    expect(moving.writes.find(({ path }) => path === outside)?.content).toContain('../../art/cover.png')
    await compare(workspace, cache, from, outside)
    await workspace.renameFile(from, outside)
    await compare(workspace, cache, from, outside)
  })
})

test('a warm cache agrees with the original planner for earlier moves in a batch', async () => {
  await withVault({
    'source/old.md': '---\nimage: ../art/cover.png\n---\n# Old Part\n\n[Peer](peer.md)\n',
    'done/peer.md': '# Peer\n\n[Old](../source/old.md#intro)\n',
    'reader.md': '[[./source/old]]\n',
    'art/cover.png': 'Synthetic file bytes',
  }, async (workspace) => {
    const cache = new RenameRepairMarkdownCache()
    const from = 'source/old.md'
    const to = 'done/old.md'
    await compare(workspace, cache, from, to)
    const batchMoves = new Map([['source/peer.md', 'done/peer.md']])
    const plan = await compare(workspace, cache, from, to, { batchMoves })
    expect(plan.writes.find(({ path }) => path === 'done/peer.md')?.content).toContain('[Old](old.md#intro)')
    await compare(workspace, cache, from, to, { batchMoves, outgoingLinksCarried: true })
    await workspace.renameFile(from, to)
    await compare(workspace, cache, from, to, { batchMoves })
  })
})

test('candidate lookup agrees when a preview names an occupied destination', async () => {
  await withVault({
    'old.md': '# Source\n',
    'new.md': '---\naliases: [Existing Alias]\n---\n# Already here\n',
    'reader.md': 'See [[Existing Alias]].\n',
  }, async (workspace) => {
    const plan = await compare(workspace, new RenameRepairMarkdownCache(), 'old.md', 'new.md')
    expect(plan.bystanderReferences).toHaveLength(1)
  })
})

test('cold, warm and edited plans match over 48 reproducible random vaults', async () => {
  let seed = 20261122
  const choose = (count: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return (seed >>> 16) % count
  }
  const targets = ['[[old]]', '[[new]]', '[[./source/old.md#top|old]]', '[[Earlier]]', '[[Same title]]', '[[./archive/new]]']
  for (let run = 0; run < 48; run += 1) {
    const files: Record<string, string> = {
      'source/old.md': '---\naliases: [Earlier]\n---\n# Same title\n',
      'other/same.mdx': '# Same title\n',
      'other/keep.md': '# Keep\n',
    }
    for (let index = 0; index < 8; index += 1) {
      const link = targets[choose(targets.length)]
      const text = ['See ' + link, 'Inline code: \x60' + link + '\x60', '~~~\n' + link + '\n~~~', '    ' + link, '> ' + link][choose(5)]
      files['note-' + index + '.md'] = '---\ntitle: Random ' + index + '\n---\n\n' + text + '\n\n' + targets[choose(targets.length)] + '\n'
    }
    await withVault(files, async (workspace, put) => {
      const cache = new RenameRepairMarkdownCache()
      await compare(workspace, cache, 'source/old.md', 'archive/new.md')
      await compare(workspace, cache, 'source/old.md', 'archive/new.md')
      await put('note-3.md', '[[./source/old]]\n')
      await put('new.md', '# Same title\n')
      await compare(workspace, cache, 'source/old.md', 'archive/new.md')
    })
  }
}, 20_000)

const deps = (workspace: Workspace): RenameDoorDeps => ({
  workspace,
  follow: { ledger: async () => {}, scratchpad: async () => {}, sharing: () => {} },
  checkpointer: { current: () => null, ready: async () => null },
  notify: { collectionChanged: () => {}, changedOnDisk: () => {} },
})

test('a second preview rereads changed text even when size and mtime match', async () => {
  await withVault({ 'old.md': '# Stable title\n', 'reader.md': '[[bad]]\n' }, async (workspace, put) => {
    const input = { path: 'old.md', newName: 'new.md' }
    const reader = join(workspace.root, 'reader.md')
    await utimes(reader, 1_700_000_000, 1_700_000_000)
    const original = await stat(reader)
    expect((await previewRename(workspace, input)).repairPaths).toEqual([])
    await put('reader.md', '[[old]]\n')
    await utimes(reader, original.atime, original.mtime)
    const edited = await stat(reader)
    expect([edited.size, edited.mtimeMs]).toEqual([original.size, original.mtimeMs])
    expect((await previewRename(workspace, input)).repairPaths).toEqual(['reader.md'])

    await put('reader.md', '~~~\n[[old]]\n~~~\n')
    await put('new-reader.md', '[[old]]\n')
    const result = await renameFile(deps(workspace), 'old.md', 'new.md')
    expect(result.repair.writtenPaths).toEqual(['new-reader.md'])
    expect(await readFile(reader, 'utf8')).toBe('~~~\n[[old]]\n~~~\n')
    expect(await readFile(join(workspace.root, 'new-reader.md'), 'utf8')).toBe('[[new]]\n')
  })
})

test('a move recomputes outgoing front-matter repairs against the final disk state', async () => {
  await withVault({
    'folio/old.md': '---\nimage: ../art/cover.png\n---\n# Old\n',
    'archive/keep.md': '# Keep\n',
  }, async (workspace, put) => {
    const input = { path: 'folio/old.md', newName: 'old.md', directory: 'archive/deep' }
    expect((await previewRename(workspace, input)).repairPaths).toEqual([])
    expect((await previewRename(workspace, input)).repairPaths).toEqual([])
    await put('art/cover.png', 'Synthetic file added after the previews')
    const result = await moveFile(deps(workspace), input.path, { to: 'folder', path: 'archive/deep/old.md' })
    expect(result.repair.writtenPaths).toEqual(['archive/deep/old.md'])
    expect(await readFile(join(workspace.root, 'archive/deep/old.md'), 'utf8')).toContain('../../art/cover.png')
  })
})
