import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { factsReader } from '../../src/main/file-facts'
import { Workspace } from '../../src/main/workspace'

const original = {
  'a.md': '# Oldalpha\n',
  'b.md': '# Oldbravo\n',
  'c.md': '# Unchanged\n',
  'd.md': '# Olddelta\n',
}
const newTime = 1_750_000_010
const oldTime = newTime - 10

async function withCollection(run: (root: string, cacheDir: string, open: (path?: string) => Workspace) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'wf-search-cache-test-'))
  try {
    const root = join(scratch, 'folder')
    const cacheDir = join(scratch, 'app-data', 'search-index')
    await mkdir(root)
    for (const [path, content] of Object.entries(original)) {
      await writeFile(join(root, path), content)
      await utimes(join(root, path), oldTime, oldTime)
    }
    await run(root, cacheDir, (path = root) => new Workspace(path, { searchCacheDir: cacheDir }))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

test('relaunch reads only files edited while WriteFlex was closed', async () => {
  await withCollection(async (root, _cacheDir, open) => {
    const first = open()
    expect((await first.search('oldalpha')).matches.map((match) => match.path)).toEqual(['a.md'])
    await first.searchIndex.flush()

    const a = join(root, 'a.md')
    const old = await stat(a)
    await writeFile(a, '# Newalpha\n')
    await utimes(a, newTime, newTime)
    const edited = await stat(a)
    expect(edited.size).toBe(old.size)
    expect(edited.mtimeMs).toBeGreaterThan(old.mtimeMs)
    const b = join(root, 'b.md')
    const oldBravo = await stat(b)
    await writeFile(b, '# Newbravo with changed size\n')
    await utimes(b, oldTime, oldTime)
    const editedBravo = await stat(b)
    expect(editedBravo.mtimeMs).toBe(oldBravo.mtimeMs)
    expect(editedBravo.size).not.toBe(oldBravo.size)
    const d = join(root, 'd.md')
    const oldDelta = await stat(d)
    await writeFile(d, '# Newdelta with changed size and mtime\n')
    await utimes(d, newTime, newTime)
    const editedDelta = await stat(d)
    expect(editedDelta.size).not.toBe(oldDelta.size)
    expect(editedDelta.mtimeMs).toBeGreaterThan(oldDelta.mtimeMs)

    const reopened = open()
    expect((await reopened.search('newalpha')).matches.map((match) => match.path)).toEqual(['a.md'])
    expect((await reopened.search('newbravo')).matches.map((match) => match.path)).toEqual(['b.md'])
    expect((await reopened.search('newdelta')).matches.map((match) => match.path)).toEqual(['d.md'])
    expect((await reopened.search('oldalpha OR oldbravo OR olddelta')).total).toBe(0)
    expect(reopened.searchIndex.reads).toBe(3)
    await reopened.searchIndex.flush()

    const factsFirst = open()
    const files = await factsFirst.listFiles()
    const facts = await factsReader(factsFirst, files, files)
    expect((await facts.read(files.find((file) => file.path === 'a.md')!)).content).toBe('# Newalpha\n')
    expect(factsFirst.searchIndex.reads).toBe(0)
    await factsFirst.searchIndex.flush()
    expect((await readdir(root)).sort()).toEqual(Object.keys(original))
  })
})

test('the watcher still invalidates a same-size rewrite with the same listing mtime', async () => {
  await withCollection(async (root, _cacheDir, open) => {
    const first = open()
    await first.search('oldalpha')
    await first.searchIndex.flush()
    const a = join(root, 'a.md')
    const old = await stat(a)
    await writeFile(a, '# Newalpha\n')
    await utimes(a, oldTime, oldTime)
    const edited = await stat(a)
    expect([edited.mtimeMs, edited.size]).toEqual([old.mtimeMs, old.size])

    const reopened = open()
    // The listing stamp alone cannot detect this rewrite.
    expect((await reopened.search('oldalpha')).total).toBe(1)
    expect(reopened.searchIndex.reads).toBe(0)
    reopened.searchIndex.invalidate(['a.md'])
    expect((await reopened.search('oldalpha')).total).toBe(0)
    expect((await reopened.search('newalpha')).total).toBe(1)
    expect(reopened.searchIndex.reads).toBe(1)

    const noticeBeforeLoad = open()
    noticeBeforeLoad.searchIndex.invalidate(['a.md'])
    expect((await noticeBeforeLoad.search('oldalpha')).total).toBe(0)
    expect((await noticeBeforeLoad.search('newalpha')).total).toBe(1)
    expect(noticeBeforeLoad.searchIndex.reads).toBe(1)
    await reopened.searchIndex.flush()
    await noticeBeforeLoad.searchIndex.flush()
  })
})

const badSnapshots: Array<[string, (valid: string) => string]> = [
  ['malformed JSON', () => 'invalid JSON'],
  ['payload with a mismatched checksum', (valid) => valid.replace('Oldalpha', 'Badalpha')],
  ['older version', (valid) => JSON.stringify({ ...JSON.parse(valid), version: 0 })],
  ['truncated snapshot', (valid) => valid.slice(0, -12)],
]

test.each(badSnapshots)('relaunch rebuilds from disk with a %s', async (_case, damage) => {
  await withCollection(async (_root, cacheDir, open) => {
    const first = open()
    await first.search('oldalpha')
    await first.searchIndex.flush()
    const [file] = await readdir(cacheDir)
    const path = join(cacheDir, file)
    await writeFile(path, damage(await readFile(path, 'utf8')))

    const reopened = open()
    expect((await reopened.search('oldalpha')).matches.map((match) => match.path)).toEqual(['a.md'])
    expect((await reopened.search('badalpha')).total).toBe(0)
    expect(reopened.searchIndex.reads).toBe(Object.keys(original).length)
    await reopened.searchIndex.flush()
  })
})

test('relaunch drops a deleted file and reads only the file added while closed', async () => {
  await withCollection(async (root, _cacheDir, open) => {
    const first = open()
    expect((await first.search('oldalpha')).total).toBe(1)
    await first.searchIndex.flush()

    await unlink(join(root, 'a.md'))
    await writeFile(join(root, 'added.md'), '# Newalpha\n')
    await utimes(join(root, 'added.md'), oldTime, oldTime)

    const reopened = open()
    expect((await reopened.search('oldalpha')).total).toBe(0)
    expect((await reopened.search('newalpha')).matches.map((match) => match.path)).toEqual(['added.md'])
    expect((await reopened.search('unchanged')).total).toBe(1)
    expect(reopened.searchIndex.reads).toBe(1)
    await reopened.searchIndex.flush()

    const settled = open()
    expect((await settled.search('oldalpha')).total).toBe(0)
    expect((await settled.search('newalpha')).total).toBe(1)
    expect(settled.searchIndex.reads).toBe(0)
  })
})

test('a vault moved to another path cannot reuse a snapshot from the former path', async () => {
  await withCollection(async (root, cacheDir, open) => {
    await mkdir(join(root, '.writeflex'))
    await writeFile(join(root, '.writeflex', 'vault.json'), JSON.stringify({ name: 'Moved synthetic vault' }))
    const first = open()
    expect((await first.search('oldalpha')).total).toBe(1)
    await first.searchIndex.flush()
    const [formerSnapshot] = await readdir(cacheDir)

    const old = await stat(join(root, 'a.md'))
    const moved = root + '-moved'
    await rename(root, moved)
    const movedFile = join(moved, 'a.md')
    await writeFile(movedFile, '# Newalpha\n')
    await utimes(movedFile, oldTime, oldTime)
    const edited = await stat(movedFile)
    expect([edited.mtimeMs, edited.size]).toEqual([old.mtimeMs, old.size])

    const reopened = open(moved)
    expect((await reopened.search('oldalpha')).total).toBe(0)
    expect((await reopened.search('newalpha')).matches.map((match) => match.path)).toEqual(['a.md'])
    expect(reopened.searchIndex.reads).toBe(Object.keys(original).length)
    await reopened.searchIndex.flush()
    const snapshots = await readdir(cacheDir)
    expect(snapshots).toHaveLength(2)
    expect(snapshots).toContain(formerSnapshot)

    const settled = open(moved)
    expect((await settled.search('newalpha')).total).toBe(1)
    expect(settled.searchIndex.reads).toBe(0)
    expect((await readdir(moved)).sort()).toEqual(['.writeflex', ...Object.keys(original)])
  })
})
