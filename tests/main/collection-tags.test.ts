import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { addCollectionPieceTags } from '../../src/main/collection'
let root = ''
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })
test('explicit tagging merges tags without duplicating or altering prose; invalid tags and out-of-collection writes are refused', async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-collection-tags-'))
  await writeFile(join(root, 'a.md'), '---\ntags: [old]\nstatus: editing\n---\n# Keep\n\nExact prose.\n')
  const ws = new Workspace(root)
  await addCollectionPieceTags(ws, '', 'a.md', ['old', 'new'])
  const saved = await readFile(join(root, 'a.md'), 'utf8')
  expect(saved).toContain('status: editing')
  expect(saved).toEndWith('# Keep\n\nExact prose.\n')
  expect((await ws.readFile('a.md')).content).toBe(saved)
  await addCollectionPieceTags(ws, '', 'a.md', ['new'])
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(saved)
  await expect(addCollectionPieceTags(ws, 'elsewhere', 'a.md', ['bad'])).rejects.toThrow('outside')
  await expect(addCollectionPieceTags(ws, '', 'a.md', ['bad\ntag'])).rejects.toThrow('line breaks')
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(saved)
})

test('scalar comma-separated tags become distinct deduplicated list items', async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-collection-tags-'))
  await writeFile(join(root, 'a.md'), '---\ntags: alpha, beta, , alpha\n---\n# Keep\n')
  const ws = new Workspace(root)
  await addCollectionPieceTags(ws, '', 'a.md', ['beta', 'new tag'])
  const { parseFrontmatter } = await import('../../src/main/frontmatter')
  expect(parseFrontmatter((await ws.readFile('a.md')).content)?.tags).toEqual(['alpha', 'beta', 'new tag'])
})
test('a comma inside an authored list item stays one tag', async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-collection-tags-'))
  await writeFile(join(root, 'a.md'), '---\ntags:\n  - "alpha, beta"\n---\n# Keep\n')
  const ws = new Workspace(root)
  await addCollectionPieceTags(ws, '', 'a.md', ['new'])
  const { parseFrontmatter } = await import('../../src/main/frontmatter')
  expect(parseFrontmatter((await ws.readFile('a.md')).content)?.tags).toEqual(['alpha, beta', 'new'])
})

test('scalar tags still split beside block-list metadata', async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-collection-tags-'))
  await writeFile(join(root, 'a.md'), '---\ntags: "alpha, beta"\nrelated:\n  - "Other"\n---\n# Keep\n')
  const ws = new Workspace(root)
  await addCollectionPieceTags(ws, '', 'a.md', ['new'])
  const { parseFrontmatter } = await import('../../src/main/frontmatter')
  const parsed = parseFrontmatter((await ws.readFile('a.md')).content)
  expect(parsed?.tags).toEqual(['alpha', 'beta', 'new'])
  expect(parsed?.related).toEqual(['Other'])
})

test('scalar tags are left byte-for-byte unchanged when no tag is added', async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-collection-tags-'))
  const content = '---\ntags: alpha, beta\n---\n# Keep\n'
  await writeFile(join(root, 'a.md'), content)
  await addCollectionPieceTags(new Workspace(root), '', 'a.md', ['beta'])
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe(content)
})
test('an empty duplicate tags key does not override the effective scalar occurrence', async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-collection-tags-'))
  await writeFile(join(root, 'a.md'), '---\ntags: alpha, beta\ntags: []\n---\n# Keep\n')
  await addCollectionPieceTags(new Workspace(root), '', 'a.md', ['beta'])
  expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('---\ntags: alpha, beta\ntags: []\n---\n# Keep\n')
})
