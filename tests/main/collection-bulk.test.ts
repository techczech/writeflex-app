import { expect, test } from 'bun:test'
import { runCollectionBatch } from '../../src/renderer/src/app/collection-bulk'

test('bulk changes continue after each failure and bound plain named outcomes', async () => {
  const visited: string[] = []
  const result = await runCollectionBatch(Array.from({ length: 10 }, (_, n) => `folder/file-${n}.md`), async path => {
    visited.push(path)
    if (Number(path.match(/file-(\d+)/)![1]) >= 4) throw new Error("Error invoking remote method 'write': Error: The document is locked.")
  })
  expect(visited).toHaveLength(10)
  expect(result.succeeded).toEqual(visited.slice(0, 4))
  expect(result.failed).toEqual(visited.slice(4))
  expect(result.message).toStartWith('Changed 4 of 10.')
  expect(result.message).toContain('file-4.md was not changed: The document is locked.')
  expect(result.message).toContain('and 3 more')
  expect(result.message).not.toContain('remote method')
})

test('filesystem failures have useful plain reasons and successful files still run', async () => {
  const result = await runCollectionBatch(['a.md', 'b.md'], async path => {
    if (path === 'a.md') throw new Error('EACCES: permission denied, write /private/example/a.md')
  })
  expect(result.message).toBe('Changed 1 of 2. a.md was not changed: Permission to change this document was denied.')
})

test('Folio batches use authored titles and refuse a false writer result', async () => {
  const { addCollectionBatchToFolio } = await import('../../src/renderer/src/app/collection-bulk')
  const calls: unknown[] = []
  const writer = { addPieces: async (...args: unknown[]) => { calls.push(args); return true } }
  const rows = [{ path: 'draft.md', title: 'Authored title', name: 'draft.md' }, { path: 'bare.md', title: null, name: 'bare.md' }]
  const result = await addCollectionBatchToFolio(writer, '', ['draft.md'], ['draft.md', 'bare.md'], rows)
  expect(result.succeeded).toEqual(['draft.md', 'bare.md'])
  expect(calls).toEqual([[{ dir: '', pieces: [{ path: 'draft.md', title: 'Authored title' }] }, [{ path: 'draft.md', title: 'Authored title' }, { path: 'bare.md', title: 'bare.md' }]]])
  await expect(addCollectionBatchToFolio({ addPieces: async () => false }, '', [], ['draft.md'], rows)).rejects.toThrow('not added')
})
