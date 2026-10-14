import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { SearchIndex } from '../../src/main/search-index'

/**
 * Workspace.search reads from a content cache (src/main/search-index.ts), not from disk on every
 * keystroke. Two claims, each measured at the read seam the index owns:
 *   (a) a repeat query over an unchanged workspace performs ZERO file reads;
 *   (b) a file changed on disk is re-read and its new hit appears, without re-reading its neighbours.
 */
const FILE_COUNT = 500

function largeWorkspace(): { root: string; ws: Workspace } {
  const root = mkdtempSync(join(tmpdir(), 'wf-search-index-'))
  mkdirSync(join(root, 'notes'))
  for (let i = 0; i < FILE_COUNT; i += 1) {
    const dir = i % 2 === 0 ? root : join(root, 'notes')
    const body = Array.from({ length: 40 }, (_, line) => `line ${line} of piece ${i} about weather and rivers`).join('\n')
    writeFileSync(join(dir, `piece-${String(i).padStart(3, '0')}.md`), `---\ntitle: Piece ${i}\ntags: [${i % 5 === 0 ? 'river' : 'plain'}]\n---\n\n${body}\n`)
  }
  return { root, ws: new Workspace(root) }
}

test('a second identical query reads nothing from disk and answers from memory', async () => {
  const { ws } = largeWorkspace()

  const coldStart = performance.now()
  const cold = await ws.search('rivers')
  const coldMs = performance.now() - coldStart
  expect(cold.matches.length).toBe(300) // the cap holds
  expect(ws.searchIndex.reads).toBe(FILE_COUNT)

  const warmStart = performance.now()
  const warm = await ws.search('rivers')
  const warmMs = performance.now() - warmStart
  console.log(`search over ${FILE_COUNT} files: cold ${coldMs.toFixed(1)} ms, warm ${warmMs.toFixed(1)} ms`)

  expect(ws.searchIndex.reads).toBe(FILE_COUNT) // zero new reads
  expect(warm).toEqual(cold)

  // A tag query on the warm cache also stays in memory.
  const tagged = await ws.search('tag:river')
  expect(tagged.matches.length).toBe(FILE_COUNT / 5)
  expect(ws.searchIndex.reads).toBe(FILE_COUNT)
})

test('a file modified on disk is re-read alone and its new hit appears', async () => {
  const { root, ws } = largeWorkspace()
  await ws.search('unicorn')
  expect(ws.searchIndex.reads).toBe(FILE_COUNT)
  expect((await ws.search('unicorn')).matches).toEqual([])

  const target = join(root, 'notes', 'piece-007.md')
  writeFileSync(target, '---\ntitle: Seven\n---\n\nA unicorn walked in.\n')
  // Force a visibly different mtime even on a coarse filesystem clock.
  const later = new Date(Date.now() + 5_000)
  utimesSync(target, later, later)

  const { matches } = await ws.search('unicorn')
  expect(ws.searchIndex.reads).toBe(FILE_COUNT + 1)
  expect(matches).toEqual([{
    path: 'notes/piece-007.md', line: 5, column: 3, length: 7,
    preview: 'A unicorn walked in.', marks: [{ column: 3, length: 7 }], context: { before: ['---', ''], after: [''] },
    snippet: { text: 'A unicorn walked in.', marks: [{ column: 3, length: 7 }] },
  }])
})

test('files that leave the listing leave the cache; watcher invalidation forces a re-read', async () => {
  const reads: string[] = []
  const index = new SearchIndex(async (path) => { reads.push(path); return `text of ${path}` }, () => [])
  await index.refresh([{ path: 'a.md', modifiedAt: 1, size: 10 }, { path: 'b.md', modifiedAt: 1, size: 10 }])
  expect(index.size).toBe(2)
  expect(reads).toEqual(['a.md', 'b.md'])

  await index.refresh([{ path: 'a.md', modifiedAt: 1, size: 10 }])
  expect(index.size).toBe(1)
  expect(index.get('b.md')).toBeUndefined()
  expect(reads).toEqual(['a.md', 'b.md'])

  index.invalidate(['a.md'])
  await index.refresh([{ path: 'a.md', modifiedAt: 1, size: 10 }])
  expect(reads).toEqual(['a.md', 'b.md', 'a.md'])
})

test('a file that vanishes between listing and read is skipped, not fatal', async () => {
  const index = new SearchIndex(async (path) => { if (path === 'gone.md') throw new Error('ENOENT'); return 'ok' }, () => [])
  await index.refresh([{ path: 'gone.md', modifiedAt: 1, size: 1 }, { path: 'here.md', modifiedAt: 1, size: 2 }])
  expect(index.get('gone.md')).toBeUndefined()
  expect(index.get('here.md')?.content).toBe('ok')
})
