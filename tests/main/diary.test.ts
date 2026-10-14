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
  resumeDiaryDayFile,
  type DiarySessionRecord,
} from '../../src/main/diary'
import { parseFrontmatter } from '../../src/main/frontmatter'

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

test('a hostile Day Entry pauses after one visible refusal and can be resumed by an app edit', async () => {
  const path = join(diaryRoot, '2026-08-02.md')
  await writeFile(path, '---\n words_written : 1\n---\n\n# Sunday 2 August 2026\n', 'utf8')
  const first = await persistDiarySession(diaryRoot, session())
  expect(first.error).toMatch(/2026-08-02\.md.*line 2/)
  expect((await persistDiarySession(diaryRoot, session({ netWords: 30 }))).error).toBeUndefined()
  resumeDiaryDayFile(path)
  expect((await persistDiarySession(diaryRoot, session({ netWords: 35 }))).error).toBeUndefined()
  expect(await readFile(path, 'utf8')).toContain(' words_written : 1')
})

test('Aggregate maintenance sums the latest checkpoint for each session', async () => {
  await appendDiarySession(diaryRoot, session())
  await appendDiarySession(diaryRoot, session({ minutes: 7, netWords: 40 }))
  await appendDiarySession(diaryRoot, session({ id: 'session-2', startedAt: new Date(2026, 7, 2, 11, 30).getTime(), minutes: 3, netWords: -5 }))
  const content = await readFile(join(diaryRoot, '2026-08-02.md'), 'utf8')
  const frontmatter = parseFrontmatter(content)
  expect(frontmatter?.extra.words_written).toBe('40')
  expect(frontmatter?.extra.mins_spent).toBe('7')
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

test('a non-positive session never creates a Day Entry', async () => {
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
