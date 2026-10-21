import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Workspace } from '../../src/main/workspace'
import { assertCollectionMove } from '../../src/main/collection'
let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })
test('bulk move accepts only existing visible folders and refuses folder pieces at execution', async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-collection-move-'))
  const ws = new Workspace(root)
  await writeFile(join(root, 'a.md'), '# A\n')
  await mkdir(join(root, 'destination'))
  await mkdir(join(root, '.archive'))
  await expect(assertCollectionMove(ws, '', 'a.md', 'destination/a.md')).resolves.toBeUndefined()
  await expect(assertCollectionMove(ws, '', 'a.md', './a.md')).resolves.toBeUndefined()
  for (const target of ['missing/a.md', '.archive/a.md', '../escape/a.md']) {
    await expect(assertCollectionMove(ws, '', 'a.md', target)).rejects.toThrow('existing visible folder')
  }
  await mkdir(join(root, 'piece'))
  await writeFile(join(root, 'piece', '_piece_INDEX.md'), '---\npiece: one\n---\n# Piece\n')
  await writeFile(join(root, 'piece', 'piece.md'), '# Piece\n\nReal prose.\n')
  await expect(assertCollectionMove(ws, '', 'piece/piece.md', 'destination/piece.md')).rejects.toThrow('folder pieces')
})

test('the bulk rename path never creates a destination folder, even if it disappeared after validation', async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-collection-move-'))
  const ws = new Workspace(root)
  await writeFile(join(root, 'a.md'), '# A\n')
  await mkdir(join(root, 'destination'))
  await assertCollectionMove(ws, '', 'a.md', 'destination/a.md')
  await rm(join(root, 'destination'), { recursive: true })
  await expect(ws.renameFile('a.md', 'destination/a.md', { requireExistingDirectory: true })).rejects.toThrow()
  expect((await ws.readFile('a.md')).content).toBe('# A\n')
  expect(await Bun.file(join(root, 'destination/a.md')).exists()).toBe(false)
})

test('an outside-collection move is refused before folder-piece discovery or destination I/O', async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-collection-move-'))
  const ws = new Workspace(root)
  let scanned = false
  await expect(assertCollectionMove(ws, 'inside', 'outside.md', 'missing/a.md', async () => {
    scanned = true
    return new Set()
  })).rejects.toThrow('outside this collection')
  expect(scanned).toBe(false)
})
