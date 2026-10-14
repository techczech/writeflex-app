import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isPathInFolder, Workspace } from '../../src/main/workspace'

/**
 * Workspace.search with a folder scope (ticket 03, frame D4): the focused folder's pieces by default,
 * everywhere on request, and both piece counts from the same pass either way.
 */

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-search-scope-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function workspace(files: Record<string, string>): Promise<Workspace> {
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), body)
  }
  return new Workspace(root)
}

const archive = {
  'talks/ai-2026/parts/01-opening.md': '# Opening\nThe reader arrives with an expectation.',
  'talks/ai-2026/research/priming.md': '# Priming\nThe reader runs ahead; expectation sets the pace.',
  'talks/ai-2026/parts/02-models.md': '# Models\nNothing relevant here.',
  'talks/ai-2026-extra/note.md': 'reader expectation, in a sibling whose name shares the prefix',
  'essays/metaphor.md': 'Every reader brings an expectation.',
  'top.md': 'reader and expectation at the root',
}

test('a scoped search lists only the focused folder, nested sub-folders included, with both counts', async () => {
  const ws = await workspace(archive)
  const result = await ws.search('reader expectation', { scope: { folder: 'talks/ai-2026' } })
  expect(result.matches.map((m) => m.path).sort()).toEqual([
    'talks/ai-2026/parts/01-opening.md',
    'talks/ai-2026/research/priming.md',
  ])
  expect(result.total).toBe(2)
  expect(result.scope).toEqual({ folder: 'talks/ai-2026', results: 'folder', inFolder: 2, everywhere: 5 })
})

test('widening to everywhere lists every matching piece and still reports the in-folder count', async () => {
  const ws = await workspace(archive)
  const result = await ws.search('reader expectation', { scope: { folder: 'talks/ai-2026', results: 'everywhere' } })
  expect(result.matches).toHaveLength(5)
  expect(result.total).toBe(5)
  expect(result.scope).toEqual({ folder: 'talks/ai-2026', results: 'everywhere', inFolder: 2, everywhere: 5 })
})

test('an unscoped search is unchanged and carries no scope counts', async () => {
  const ws = await workspace(archive)
  const result = await ws.search('reader expectation')
  expect(result.total).toBe(5)
  expect(result.scope).toBeUndefined()
})

test('the cap applies to the listed side; the counts are never capped', async () => {
  const files: Record<string, string> = {}
  for (let i = 0; i < 6; i += 1) files[`focus/piece-${i}.md`] = 'needle'
  for (let i = 0; i < 4; i += 1) files[`elsewhere/piece-${i}.md`] = 'needle'
  const ws = await workspace(files)
  const scoped = await ws.search('needle', { maxResults: 3, scope: { folder: 'focus' } })
  expect(scoped.matches).toHaveLength(3)
  expect(scoped.total).toBe(6)
  expect(scoped.scope).toMatchObject({ inFolder: 6, everywhere: 10 })
})

test('an empty query answers with zero counts for a scoped search', async () => {
  const ws = await workspace(archive)
  expect(await ws.search('   ', { scope: { folder: 'talks' } })).toEqual({
    matches: [],
    total: 0,
    scope: { folder: 'talks', results: 'folder', inFolder: 0, everywhere: 0 },
  })
})

test('folder containment is by path segment, never by string prefix', () => {
  expect(isPathInFolder('talks/ai-2026/parts/x.md', 'talks/ai-2026')).toBe(true)
  expect(isPathInFolder('talks/ai-2026-extra/note.md', 'talks/ai-2026')).toBe(false)
  expect(isPathInFolder('anything.md', '')).toBe(true)
})
