import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace, type FileReadResult } from '../../src/main/workspace'
import { collectionPieces, listCollection } from '../../src/main/collection'
import { collectionCandidates, collectionLinks } from '../../src/main/wikilinks'
import { computeCollectionDigest } from '../../src/main/digest'
import { factsReader, mapBounded } from '../../src/main/file-facts'
import { VaultIndexService } from '../../src/main/vault-index-service'
import { isPathInSearchScope } from '../../src/shared/search-scope'

// The per-file facts cache (file-facts.ts over search-index.ts): a listing reads and derives a file
// once per (path, mtime, size), and every way a file can change makes the next listing see it.

let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-file-facts-'))
  ws = new Workspace(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

const piece = (status: string, heading: string): string => `---\nstatus: ${status}\n---\n\n# ${heading}\n\nBody text here.\n`

const byPath = async (dir = ''): Promise<Map<string, { title: string; status: string; words: number }>> =>
  new Map((await collectionPieces(ws, dir)).map((p) => [p.path, { title: p.metadata.title, status: p.metadata.status, words: p.derived.words }]))

test('a second listing reads nothing; an outside edit re-reads that file alone', async () => {
  await write('a.md', piece('draft', 'Alpha'))
  await write('b.md', piece('draft', 'Beta'))
  await write('notes/c.md', piece('draft', 'Gamma'))
  await collectionPieces(ws, '')
  expect(ws.searchIndex.reads).toBe(3)
  await collectionPieces(ws, '')
  await listCollection(ws, '')
  await collectionCandidates(ws, '')
  expect(ws.searchIndex.reads).toBe(3)

  await write('b.md', piece('final-final', 'Beta, renamed'))
  const pieces = await byPath()
  expect(ws.searchIndex.reads).toBe(4)
  expect(pieces.get('b.md')).toMatchObject({ title: 'Beta, renamed', status: 'final-final' })
})

test('an own save of the same size in the same mtime is seen: the save drops the cached entry', async () => {
  await write('a.md', piece('draft', 'Alpha'))
  expect((await byPath()).get('a.md')?.status).toBe('draft')
  const before = await stat(join(root, 'a.md'))
  await ws.saveFile('a.md', piece('final', 'Alpha'))
  // Same size, and the clock put back: only the own-write invalidation can tell.
  await utimes(join(root, 'a.md'), before.atime, before.mtime)
  expect((await byPath()).get('a.md')?.status).toBe('final')
})

test('a watcher change of the same size and mtime is seen once the watcher invalidates it', async () => {
  await write('a.md', piece('draft', 'Alpha'))
  expect((await byPath()).get('a.md')?.title).toBe('Alpha')
  const before = await stat(join(root, 'a.md'))
  await write('a.md', piece('draft', 'Omega'))
  await utimes(join(root, 'a.md'), before.atime, before.mtime)
  ws.searchIndex.invalidate(['a.md']) // what the workspace watcher does for an outside change
  expect((await byPath()).get('a.md')?.title).toBe('Omega')
})

test('renames and deletes: the old path goes, the new one carries the file\'s own title', async () => {
  await write('a.md', piece('draft', 'Alpha'))
  await write('b.md', piece('draft', 'Beta'))
  await byPath()
  await ws.renameFile('a.md', 'moved.md')
  await unlink(join(root, 'b.md'))
  const pieces = await byPath()
  expect([...pieces.keys()]).toEqual(['moved.md'])
  expect(pieces.get('moved.md')?.title).toBe('Alpha')
  const candidates = await collectionCandidates(ws, '')
  expect(candidates.map((c) => c.path)).toEqual(['moved.md'])
})

test('wikilink candidates and links follow an edit, and keep the candidate rule (frontmatter title first)', async () => {
  await write('a.md', '---\ntitle: Front title\n---\n\n## Not an H1\n\nSee [[b]].\n')
  await write('b.md', '# Bee\n\nNo links.\n')
  expect((await collectionCandidates(ws, '')).map((c) => c.title)).toEqual(['Front title', 'Bee'])
  expect((await collectionLinks(ws, '')).map((l) => `${l.from}->${l.to}`)).toEqual(['a.md->b.md'])
  await write('b.md', '# Bee\n\nNow links back to [[a]] and to [[nowhere at all]].\n')
  expect((await collectionLinks(ws, '')).map((l) => `${l.from}->${l.to}`)).toEqual(['a.md->b.md', 'b.md->a.md', 'b.md->null'])
})

test('files a search refresh leaves out of scope stay cached for the Collection', async () => {
  await write('cache/kept.md', '# Kept\n')
  await write('essay.md', '# Essay\n')
  await byPath()
  expect(ws.searchIndex.reads).toBe(2)
  const listing = await ws.listFiles()
  await ws.searchIndex.refresh(listing.filter((file) => isPathInSearchScope(file.path)))
  const pieces = await byPath()
  expect(ws.searchIndex.reads).toBe(2)
  expect(pieces.get('cache/kept.md')?.title).toBe('Kept')
  // ...until it leaves the listing.
  await unlink(join(root, 'cache/kept.md'))
  await byPath()
  expect(ws.searchIndex.get('cache/kept.md')).toBeUndefined()
})

test('a Workspace that overrides readFile is read through it, never through the disk cache', async () => {
  await write('a.md', '# On disk\n')
  class Overlay extends Workspace {
    override async readFile(path: string): Promise<FileReadResult> {
      const real = await super.readFile(path)
      return { ...real, content: '# Planned\n' }
    }
  }
  const overlay = new Overlay(root)
  await collectionPieces(ws, '') // fills the real Workspace's cache with the disk text
  expect((await collectionPieces(overlay, '')).map((p) => p.metadata.title)).toEqual(['Planned'])
  expect((await collectionCandidates(overlay, '')).map((c) => c.title)).toEqual(['Planned'])
  expect(overlay.searchIndex.reads).toBe(0)
})

test('a file that vanished after the listing fails as a direct read always did', async () => {
  await write('a.md', '# A\n')
  const listing = await ws.listFiles()
  await unlink(join(root, 'a.md'))
  const reader = await factsReader(ws, listing, listing)
  await expect(reader.read(listing[0])).rejects.toThrow()
})

test('folder pieces hide their own folder only: a sibling folder sharing the name prefix stays', async () => {
  await write('work/work.md', '# The work\n')
  await write('work/part.md', '# Part\n')
  await write('work-2/other.md', '# Other\n')
  await write('work/inner/deep.md', '# Deep\n')
  expect([...(await byPath()).keys()].sort()).toEqual(['work-2/other.md', 'work/work.md'])
})

test('the Digest is the same from a cold and a warm cache, and after an edit matches a fresh workspace', async () => {
  await write('a.md', piece('draft', 'Alpha'))
  await write('b.md', '# Bee\n\nLinks to [[Alpha]].\n')
  await write('undated.md', 'No heading, no date.\n')
  const cold = await computeCollectionDigest(ws, '')
  expect(await computeCollectionDigest(ws, '')).toEqual(cold)
  await write('a.md', piece('review', 'Alpha'))
  expect(await computeCollectionDigest(ws, '')).toEqual(await computeCollectionDigest(new Workspace(root), ''))
})

test('mapBounded keeps order and never runs more than its limit at once', async () => {
  let running = 0
  let peak = 0
  const out = await mapBounded([...Array(40).keys()], 4, async (n) => {
    running += 1
    peak = Math.max(peak, running)
    await new Promise((resolve) => setTimeout(resolve, 1))
    running -= 1
    return n * 2
  })
  expect(out).toEqual([...Array(40).keys()].map((n) => n * 2))
  expect(peak).toBe(4)
})

test('vault index: an unchanged index is not rewritten; a manifest is re-read only when it changes', async () => {
  await mkdir(join(root, '.writeflex'), { recursive: true })
  await writeFile(join(root, '.writeflex', 'vault.json'), '{"name":"V"}')
  await write('report/_report-structure.json', JSON.stringify({ files: [{ path: '01-a.md' }] }))
  await write('report/01-a.md', '# Part A\n')
  await write('essay.md', '# Essay\n')
  const cacheDir = await mkdtemp(join(tmpdir(), 'wf-file-facts-cache-'))
  try {
    const service = new VaultIndexService({ cacheDir })
    const first = await service.get(ws)
    const [snapshot] = await readdir(cacheDir)
    const written = (await stat(join(cacheDir, snapshot))).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 20))
    service.invalidate(root, ['essay.md'])
    expect(await service.get(ws)).toEqual(first)
    expect((await stat(join(cacheDir, snapshot))).mtimeMs).toBe(written)

    await write('report/_report-structure.json', JSON.stringify({ files: [{ path: '01-a.md' }, { path: '02-b.md' }] }))
    await write('report/02-b.md', '# Part B\n')
    service.invalidate(root, ['report/_report-structure.json', 'report/02-b.md'])
    const second = await service.get(ws)
    expect(second).not.toEqual(first)
    expect(second).toEqual(await new VaultIndexService({ cacheDir: null }).get(new Workspace(root)))
    expect((await stat(join(cacheDir, snapshot))).mtimeMs).not.toBe(written)
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test('collection search snapshot uses the shared cache, stays read-only and refreshes only changed text', async () => {
  const original = '---\ntags: [assessment, feedback]\n---\n# Title\n\nStudents rated feedback as useful.\n'
  await write('a.md', original)
  const first = await listCollection(ws, '', null, { includeSearchText: true })
  expect(first.rows[0].searchText).toContain('Students rated feedback as useful.')
  expect(first.rows[0].searchText).not.toContain('tags:')
  expect(first.rows[0].tags).toEqual(['assessment', 'feedback'])
  const reads = ws.searchIndex.reads
  await listCollection(ws, '', null, { includeSearchText: true })
  expect(ws.searchIndex.reads).toBe(reads)
  expect((await ws.readFile('a.md')).content).toBe(original)
  await write('a.md', original.replace('useful', 'helpful'))
  expect((await listCollection(ws, '', null, { includeSearchText: true })).rows[0].searchText).toContain('helpful')
  expect(ws.searchIndex.reads).toBe(reads + 1)
})
