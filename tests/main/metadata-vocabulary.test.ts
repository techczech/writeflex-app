import { expect, test } from 'bun:test'
import { workspaceMetadataValues, METADATA_SCAN_LIMITS } from '../../src/main/metadata-vocabulary'

test('workspace scan excludes this document, skips malformed and oversized files, and ranks lists once per document', async () => {
  const contents = { 'own.md': '---\nauthor: Myself\n---\n', 'a.md': '---\nauthor: Jane\ntags: [work, work]\n---\n', 'b.md': '---\nauthor: Jane\n---\n', 'bad.md': '---\nauthor: "broken\n---\n', 'large.md': '---\nauthor: Huge\n---\n' }
  const read: string[] = []
  const ws = { listFiles: async () => Object.keys(contents).map(path => ({ path, modifiedAt: 1, size: path === 'large.md' ? METADATA_SCAN_LIMITS.fileBytes + 1 : 100 })), readFile: async (path: string) => { read.push(path); return { content: contents[path as keyof typeof contents] } } }
  const values = await workspaceMetadataValues(ws, 'own.md')
  expect(values.author).toEqual([{ value: 'Jane', count: 2 }])
  expect(values.tags).toEqual([{ value: 'work', count: 1 }])
  expect(read).not.toContain('large.md')
  expect(read).not.toContain('own.md')
  await workspaceMetadataValues(ws, 'own.md')
  expect(read).toHaveLength(3)
})

test('scan caps files and total bytes, invalidates changed files, and isolates workspaces', async () => {
  let version = 1, reads = 0
  const ws = { listFiles: async () => Array.from({ length: 2000 }, (_, i) => ({ path: `${i}.md`, modifiedAt: version, size: METADATA_SCAN_LIMITS.fileBytes })), readFile: async () => { reads++; return { content: `---\nauthor: Writer ${version}\n---\n` } } }
  const result = await workspaceMetadataValues(ws)
  expect(reads).toBeLessThanOrEqual(METADATA_SCAN_LIMITS.files)
  expect(reads * METADATA_SCAN_LIMITS.fileBytes).toBeLessThanOrEqual(METADATA_SCAN_LIMITS.totalBytes)
  expect(result.author[0].value).toBe('Writer 1')
  version++
  expect((await workspaceMetadataValues(ws)).author[0].value).toBe('Writer 2')
  expect((await workspaceMetadataValues({ ...ws, readFile: async () => ({ content: '---\nauthor: Other\n---\n' }) })).author[0].value).toBe('Other')
})

test('stray malformed header text cannot seed suggestions', async () => {
  const ws = { listFiles: async () => [{ path: 'bad.md', size: 80, modifiedAt: 1 }], readFile: async () => ({ content: '---\nnot yaml at all\nauthor: Misleading\n---\n' }) }
  expect((await workspaceMetadataValues(ws)).author).toEqual([])
})

test('valid multiline and nested values do not hide flat workspace suggestions', async () => {
  const ws = { listFiles: async () => [{ path: 'rich.md', size: 200, modifiedAt: 1 }], readFile: async () => ({ content: '---\nauthor: Jane\nstandfirst: |\n  A real introduction.\ncustom:\n  nested: retained\ntags: [workshop]\n---\n\nBody\n' }) }
  const values = await workspaceMetadataValues(ws)
  expect(values.author).toEqual([{ value: 'Jane', count: 1 }])
  expect(values.tags).toEqual([{ value: 'workshop', count: 1 }])
})

test('a file with an opaque entry seeds no suggestions, even when its value looks like a block scalar', async () => {
  const ws = { listFiles: async () => [{ path: 'odd.md', size: 80, modifiedAt: 1 }], readFile: async () => ({ content: '---\n[a]: |\n  text\nauthor: Misleading\n---\n' }) }
  expect((await workspaceMetadataValues(ws)).author).toEqual([])
})
