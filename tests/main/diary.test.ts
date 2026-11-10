import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Workspace } from '../../src/main/workspace'
import {
  appendDiarySession,
  countedCollections,
  isCountedCollection,
  setCollectionCounted,
  diaryCaptureRoot,
  isInsideDiaryRoot,
  invalidateCountedCollectionCache,
  persistDiarySession,
  type DiarySessionRecord,
} from '../../src/main/diary'
import { parseFrontmatter } from '../../src/main/frontmatter'
import { pauseCollectionWrites, resumeCollectionWrites } from '../../src/main/collection-write-gate'

let root: string
let diaryRoot: string
let workspace: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-diary-workspace-'))
  diaryRoot = await mkdtemp(join(tmpdir(), 'wf-diary-record-'))
  workspace = new Workspace(root)
})

afterEach(async () => {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(diaryRoot, { recursive: true, force: true }),
  ])
})

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

function session(overrides: Partial<DiarySessionRecord> = {}): DiarySessionRecord {
  return {
    id: 'session-1',
    startedAt: new Date(2026, 7, 2, 9, 12).getTime(),
    minutes: 4,
    netWords: 25,
    pieces: ['essays/one.md'],
    ...overrides,
  }
}

test('Counted mark round-trips through the strict frontmatter writer and creates the Index Note once', async () => {
  await write('essays/one.md', '# One\n')
  await setCollectionCounted(workspace, 'essays', true)
  const index = await readFile(join(root, 'essays', '_essays_INDEX.md'), 'utf8')
  expect(index).toContain('diary: counted')
  expect(await isCountedCollection(workspace, 'essays')).toBe(true)
  expect(await countedCollections(workspace)).toEqual([{ root, dir: 'essays', name: 'essays', pieces: 1 }])

  await setCollectionCounted(workspace, 'essays', false)
  const uncounted = await readFile(join(root, 'essays', '_essays_INDEX.md'), 'utf8')
  expect(uncounted).not.toMatch(/^diary\s*:/m)
  expect(await isCountedCollection(workspace, 'essays')).toBe(false)
})

test('the designated Diary root is excluded even when its own Collection is Counted', async () => {
  const diaryWorkspace = new Workspace(diaryRoot)
  await writeFile(join(diaryRoot, '2026-08-02.md'), '# Sunday 2 August 2026\n', 'utf8')
  await setCollectionCounted(diaryWorkspace, '', true)
  expect(await diaryCaptureRoot(diaryWorkspace, '2026-08-02.md', diaryRoot)).toBeNull()
})

test('Diary-root exclusion recognises canonical aliases of the same filesystem path', () => {
  const aliasedRoot = diaryRoot.startsWith('/private/var/') ? diaryRoot.replace('/private/var/', '/var/') : diaryRoot
  expect(isInsideDiaryRoot(aliasedRoot, join(diaryRoot, '2026-08-02.md'))).toBe(true)
})

test('Day Entry uses the local calendar date, strict aggregate keys, and never writes a title key', async () => {
  const when = new Date(2026, 7, 2, 0, 5)
  await appendDiarySession(diaryRoot, session({ startedAt: when.getTime() }))
  const content = await readFile(join(diaryRoot, '2026-08-02.md'), 'utf8')
  const frontmatter = parseFrontmatter(content)
  expect(frontmatter?.extra.words_written).toBe('25')
  expect(frontmatter?.extra.mins_spent).toBe('4')
  expect(content).not.toMatch(/^title:/m)
  expect(content).toContain('<!-- writeflex:recorded:start -->')
  expect(content).toContain('# Sunday 2 August 2026')
  expect(content).not.toContain('# Sunday, 2 August 2026')
  expect(content).toContain('00:05 · 4 min · +25 words · [[one]]')
  expect(content).not.toContain('`00:05')
  expect(content.match(/<!-- writeflex:recorded:meta /g)).toHaveLength(1)
  expect(content).not.toContain('<!-- writeflex:session:')
})

test('recorded Piece links use the first heading and a filename fallback', async () => {
  await write('essays/one.md', '# The visible title\n\nBody.\n')
  await write('essays/fallback.md', 'Body without a heading.\n')
  await appendDiarySession(diaryRoot, session({ pieces: ['essays/one.md', 'essays/fallback.md'] }), { sourceWorkspace: workspace })
  const content = await readFile(join(diaryRoot, '2026-08-02.md'), 'utf8')
  expect(content).toContain('[[The visible title]], [[fallback]]')
})

test('a live Diary Workspace owns the instrumentation write for watcher deduplication', async () => {
  const diaryWorkspace = new Workspace(diaryRoot)
  const name = await appendDiarySession(diaryRoot, session(), { diaryWorkspace })
  expect(name).toBe('2026-08-02.md')
  expect(diaryWorkspace.wasRecentlyWrittenByApp('2026-08-02.md')).toBe(true)
})

test('a hostile Day Entry reports each refusal and automatically retries after repair', async () => {
  const path = join(diaryRoot, '2026-08-02.md')
  await writeFile(path, '---\n words_written : 1\n---\n\n# Sunday 2 August 2026\n', 'utf8')
  const first = await persistDiarySession(diaryRoot, session())
  expect(first.error).toMatch(/2026-08-02\.md.*line 2/)
  expect((await persistDiarySession(diaryRoot, session({ netWords: 30 }))).error).toMatch(/2026-08-02/)
  await writeFile(path, '# Repaired day\n')
  expect(await persistDiarySession(diaryRoot, session({ netWords: 35 }))).toEqual({ name: '2026-08-02.md' })
})

test('Aggregate maintenance sums the latest checkpoint for each session', async () => {
  await appendDiarySession(diaryRoot, session())
  await appendDiarySession(diaryRoot, session({ minutes: 7, netWords: 40 }))
  await appendDiarySession(diaryRoot, session({ id: 'session-2', startedAt: new Date(2026, 7, 2, 11, 30).getTime(), minutes: 3, netWords: -5 }))
  const content = await readFile(join(diaryRoot, '2026-08-02.md'), 'utf8')
  const frontmatter = parseFrontmatter(content)
  expect(frontmatter?.extra.words_written).toBe('35')
  expect(frontmatter?.extra.mins_spent).toBe('10')
  expect(content.match(/<!-- writeflex:recorded:meta /g)).toHaveLength(1)
})

test('checkpoint row rewrites preserve CRLF day-file endings', async () => {
  const path = join(diaryRoot, '2026-08-02.md')
  await writeFile(path, '# Sunday 2 August 2026\r\n\r\nWriter prose.\r\n', 'utf8')
  await appendDiarySession(diaryRoot, session())
  await appendDiarySession(diaryRoot, session({ minutes: 7, netWords: 40 }))
  const content = await readFile(path, 'utf8')
  expect(content.replaceAll('\r\n', '')).not.toContain('\n')
  expect(content).toContain('09:12 · 7 min · +40 words · [[one]]\r\n')
})

test('an edit-free zero session never creates a Day Entry', async () => {
  const name = await appendDiarySession(diaryRoot, session({ netWords: 0 }))
  expect(name).toBeNull()
  expect(existsSync(join(diaryRoot, '2026-08-02.md'))).toBe(false)
})

test('Incremental append preserves writer prose before, inside-adjacent to, and after the recorded block', async () => {
  await appendDiarySession(diaryRoot, session())
  const path = join(diaryRoot, '2026-08-02.md')
  const generated = await readFile(path, 'utf8')
  const edited = `${generated
    .replace('---\n\n#', '---\n\nWriter before.\n\n#')
    .replace('\nrecorded\n', '\nrecorded\nWriter inside-adjacent.\n')
    .replace(/(09:12 · 4 min · \+25 words · \[\[one\]\])/, '$1 Writer note inside the machine block.') }\nWriter after.\n`
  await writeFile(path, edited, 'utf8')
  await appendDiarySession(diaryRoot, session({ minutes: 8, netWords: 50 }))
  const content = await readFile(path, 'utf8')
  expect(content).toContain('Writer before.')
  expect(content).toContain('Writer inside-adjacent.')
  expect(content).toContain('Writer note inside the machine block.')
  expect(content).toContain('Writer after.')
})

test('A checkpoint is a valid crash floor and loses at most later tail activity', async () => {
  await appendDiarySession(diaryRoot, session({ minutes: 1, netWords: 3 }))
  // Simulated kill: no later checkpoint call arrives.
  const content = await readFile(join(diaryRoot, '2026-08-02.md'), 'utf8')
  expect(parseFrontmatter(content)?.extra.words_written).toBe('3')
  expect(content).toContain('<!-- writeflex:recorded:end -->')
  expect(content.trim().length).toBeGreaterThan(0)
})

test('capture gating returns no target for an unmarked Collection or an undesignated Diary', async () => {
  await write('essays/one.md', '# One\n')
  expect(await diaryCaptureRoot(workspace, 'essays/one.md', diaryRoot)).toBeNull()
  await setCollectionCounted(workspace, 'essays', true)
  expect(await diaryCaptureRoot(workspace, 'essays/one.md', null)).toBeNull()
  expect(await diaryCaptureRoot(workspace, 'essays/one.md', diaryRoot)).toBe(diaryRoot)
})

test('capture gating caches the Counted decision until Collection invalidation', async () => {
  await write('essays/one.md', '# One\n')
  await setCollectionCounted(workspace, 'essays', true)
  let walks = 0
  const original = workspace.listFiles.bind(workspace)
  workspace.listFiles = async () => { walks += 1; return original() }
  expect(await diaryCaptureRoot(workspace, 'essays/one.md', diaryRoot)).toBe(diaryRoot)
  expect(await diaryCaptureRoot(workspace, 'essays/one.md', diaryRoot)).toBe(diaryRoot)
  expect(walks).toBe(1)
  invalidateCountedCollectionCache(root)
  expect(await diaryCaptureRoot(workspace, 'essays/one.md', diaryRoot)).toBe(diaryRoot)
  expect(walks).toBe(2)
})

test('a diary folder inside a Collection another owner holds is not created or written; the refusal is reported once like any other', async () => {
  const inside = join(root, 'diary')
  pauseCollectionWrites(root, 'Saving is paused for this test.')
  try {
    expect(await persistDiarySession(inside, session())).toEqual({ name: null, error: 'Saving is paused for this test.' })
    expect(existsSync(inside)).toBe(false)
  } finally {
    resumeCollectionWrites(root)
  }
  expect(await persistDiarySession(inside, session())).toEqual({ name: '2026-08-02.md' })
  expect(existsSync(join(inside, '2026-08-02.md'))).toBe(true)
})

for (const damage of ['missing', 'malformed', 'partial'] as const) {
  test(`surviving recorded rows rebuild totals after ${damage} metadata; later sessions persist`, async () => {
    await appendDiarySession(diaryRoot, session())
    await appendDiarySession(diaryRoot, session({ id: 'second', netWords: 10 }))
    const path = join(diaryRoot, '2026-08-02.md')
    const original = await readFile(path, 'utf8')
    const damaged = original.replace(/<!-- writeflex:recorded:meta .* -->/, damage === 'missing' ? '' : damage === 'malformed' ? '<!-- writeflex:recorded:meta [{broken -->' : '<!-- writeflex:recorded:meta [] -->')
    await writeFile(path, damaged + '\nWriter reflection.\n')
    await appendDiarySession(diaryRoot, session({ id: 'third', netWords: -5, startedAt: new Date(2026, 7, 2, 10, 0).getTime() }))
    const result = await readFile(path, 'utf8')
    expect(parseFrontmatter(result)?.extra.words_written).toBe('30')
    expect(parseFrontmatter(result)?.extra.mins_spent).toBe('12')
    expect(result).toContain('Writer reflection.')
    expect(result).toContain('-5 words')
  })
}

test('an incomplete recorded block refuses without changing a byte', async () => {
  const path = join(diaryRoot, '2026-08-02.md')
  const content = '# Reflection\n<!-- writeflex:recorded:start -->\n09:12 · 4 min · +25 words · [[one]]\n'
  await writeFile(path, content)
  await expect(appendDiarySession(diaryRoot, session())).rejects.toThrow('incomplete')
  expect(await readFile(path, 'utf8')).toBe(content)
})

test('invalid exported session numbers never create a day file', async () => {
  for (const input of [{ startedAt: NaN }, { startedAt: Infinity }, { minutes: NaN }, { netWords: NaN }]) {
    await expect(appendDiarySession(diaryRoot, session(input))).rejects.toThrow('Invalid Diary')
  }
  expect(await new Workspace(diaryRoot).listFiles()).toHaveLength(0)
})

test('a zero-net edited session persists its minutes', async () => {
  await appendDiarySession(diaryRoot, session({ netWords: 0, edited: true }))
  expect(parseFrontmatter(await readFile(join(diaryRoot, '2026-08-02.md'), 'utf8'))?.extra.mins_spent).toBe('4')
})

test('a damaged marker cannot make the current checkpoint count its surviving row twice', async () => {
  await appendDiarySession(diaryRoot, session())
  const path = join(diaryRoot, '2026-08-02.md')
  const damaged = (await readFile(path, 'utf8')).replace(/<!-- writeflex:recorded:meta .* -->/, '')
  await writeFile(path, damaged)
  await expect(appendDiarySession(diaryRoot, session({ netWords: 40 }))).rejects.toThrow('Cannot identify')
  expect(await readFile(path, 'utf8')).toBe(damaged)
})

test('an unreadable block cannot replace existing totals with a zero-net checkpoint', async () => {
  const path = join(diaryRoot, '2026-08-02.md')
  const damaged = '---\nwords_written: 40\nmins_spent: 10\n---\n<!-- writeflex:recorded:start -->\nrecorded\n09:12 · damaged row\n<!-- writeflex:recorded:end -->\n'
  await writeFile(path, damaged)
  await expect(appendDiarySession(diaryRoot, session({ netWords: 0, edited: true }))).rejects.toThrow('no readable recorded rows')
  expect(await readFile(path, 'utf8')).toBe(damaged)
})

test('recovery by another window cannot let a later old checkpoint duplicate a recovered sitting', async () => {
  await appendDiarySession(diaryRoot, session())
  const path = join(diaryRoot, '2026-08-02.md')
  await writeFile(path, (await readFile(path, 'utf8')).replace(/<!-- writeflex:recorded:meta .* -->/, ''))
  await appendDiarySession(diaryRoot, session({ id: 'other-window', startedAt: new Date(2026, 7, 2, 10, 0).getTime(), netWords: 10 }))
  const recovered = await readFile(path, 'utf8')
  await expect(appendDiarySession(diaryRoot, session({ netWords: 40 }))).rejects.toThrow('Cannot identify')
  expect(await readFile(path, 'utf8')).toBe(recovered)
})

test('missing aggregates do not permit a zero derived from an unreadable recorded block', async () => {
  const path = join(diaryRoot, '2026-08-02.md')
  const damaged = '# Day\n<!-- writeflex:recorded:start -->\nrecorded\n09:12 · damaged row\n<!-- writeflex:recorded:end -->\n'
  await writeFile(path, damaged)
  await expect(appendDiarySession(diaryRoot, session({ netWords: 0, edited: true }))).rejects.toThrow('no readable recorded rows')
  expect(await readFile(path, 'utf8')).toBe(damaged)
})
