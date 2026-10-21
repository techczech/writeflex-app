/**
 * The version journal gains lines only through the checked append (checked-store-append.ts): no
 * line follows a link at `.writeflex/versions.jsonl` or lands in a file with a second name.
 *
 * Seams: `VersionStore` over a real Workspace on a temporary Collection, and for the inbox route the
 * command line answered by the app's side without a window (`openAsApp`), as the created-by tests do.
 */
import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { link, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendStoreLine } from '../../src/main/checked-store-append'
import { parseVersionLine, VersionStore, versionsJournalPath } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'
import { writeFixture, type CliRun, type WriteFixture } from '../helpers/cli-write-fixture'
import { openAsApp, type AppSide } from '../helpers/request-app'

const JOURNAL = versionsJournalPath()
const VICTIM = '# Victim\n\nThe writer\'s own text.\n'
const author = { name: 'App Writer' }
const record = (path = 'a.md'): { path: string; name: string; author: typeof author; snapshotId: string; versionId: string } =>
  ({ path, name: 'A version', author, snapshotId: 's_1', versionId: 'bv_1' })

let fx: WriteFixture
let outside: string
let app: AppSide | null
const gitEnv = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM }

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})
afterAll(() => {
  if (gitEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = gitEnv.global
  if (gitEnv.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = gitEnv.system
})
beforeEach(async () => {
  fx = await writeFixture()
  outside = await mkdtemp(join(tmpdir(), 'wf-journal-outside-'))
  app = null
  // The fixture's placeholder journal is taken away: each test plants what stands at the name.
  await rm(join(fx.root, JOURNAL), { force: true })
})
afterEach(async () => {
  await app?.close()
  await fx.dispose()
  await rm(outside, { recursive: true, force: true })
})

const store = (): VersionStore => new VersionStore(new Workspace(fx.root))
const journalAbs = (): string => join(fx.root, JOURNAL)
const refusal = (why: RegExp): RegExp => new RegExp(`^WriteFlex did not record this version: \\.writeflex/versions\\.jsonl ${why.source}`)
const NOT_ORDINARY = /is not an ordinary file/
const TWO_NAMES = /is also known by another name somewhere on this disk/

test('a link planted at versions.jsonl to ../victim.md: a create requested while the app owns the Collection writes no line into the victim, lists no version and says the history record was not written', async () => {
  await fx.write('victim.md', VICTIM)
  await symlink('../victim.md', journalAbs())
  app = await openAsApp(fx)
  const stop = app.answering()
  let run: CliRun
  try {
    run = await fx.cli(['create', 'a.md', '--content', '# A\n', '--source', 'claude-code'], { write: { request: { waitMs: 20_000, pollMs: 5 } } })
  } finally {
    await stop()
  }
  expect(run.json.error?.message ?? '').toBe('')
  expect(run.json).toMatchObject({ via: 'app', outcome: 'done' })
  const result = run.json.result!
  expect(await fx.read('victim.md')).toBe(VICTIM)
  expect(await readlink(journalAbs())).toBe('../victim.md')
  // Both or neither: no history record, so no frontmatter line either.
  expect(result.createdBy).toMatchObject({ label: 'Claude Code', frontmatter: false, history: null })
  expect((result.createdBy as { note: string }).note).toContain('WriteFlex did not record this version: .writeflex/versions.jsonl is not an ordinary file')
  expect(await fx.read('a.md')).toBe('# A\n')
  expect(await store().list({ path: 'a.md' })).toEqual([])
}, 60_000)

test('a link planted at versions.jsonl to a file outside the Collection: append and the first version are refused and the file is unchanged', async () => {
  const target = join(outside, 'elsewhere.txt')
  await writeFile(target, 'outside\n')
  await symlink(target, journalAbs())
  await expect(store().append(record())).rejects.toThrow(refusal(NOT_ORDINARY))
  // The first version reads the journal before it appends, and that read already refuses a name that leads outside.
  await expect(store().appendFirstForPath('a.md', async () => ({ name: 'Initial version', author, snapshotId: 's', versionId: 'v' }))).rejects.toThrow()
  expect(await readFile(target, 'utf8')).toBe('outside\n')
})

test('a dangling link planted at versions.jsonl, to a new name inside the Collection or outside it: refused, and nothing is created at its target', async () => {
  for (const target of ['../new.md', join(outside, 'made.txt')]) {
    await rm(journalAbs(), { force: true })
    await symlink(target, journalAbs())
    await expect(store().append(record())).rejects.toThrow(refusal(NOT_ORDINARY))
  }
  expect(existsSync(join(fx.root, 'new.md'))).toBe(false)
  expect(existsSync(join(outside, 'made.txt'))).toBe(false)
  expect((await lstat(journalAbs())).isSymbolicLink()).toBe(true)
})

test('a planted hard link (versions.jsonl is a second name of a document, or of a file outside): append and rename are refused and neither file changes', async () => {
  await fx.write('victim.md', VICTIM)
  await link(join(fx.root, 'victim.md'), journalAbs())
  await expect(store().append(record())).rejects.toThrow(refusal(TWO_NAMES))
  expect(await fx.read('victim.md')).toBe(VICTIM)

  // An ordinary journal with one version, then given a second name outside: rename is refused too.
  await rm(journalAbs())
  const saved = await store().append(record())
  const before = await readFile(journalAbs(), 'utf8')
  await link(journalAbs(), join(outside, 'alias.jsonl'))
  await expect(store().rename(saved.id, 'Renamed')).rejects.toThrow(/^WriteFlex did not rename this version: \.writeflex\/versions\.jsonl is also known by another name/)
  expect(await readFile(journalAbs(), 'utf8')).toBe(before)
})

test('a .writeflex folder that is a link, a folder or a pipe at versions.jsonl: refused, and nothing is made in the link\'s target', async () => {
  await mkdir(journalAbs())
  await expect(store().append(record())).rejects.toThrow(refusal(NOT_ORDINARY))
  await rm(journalAbs(), { recursive: true })
  execFileSync('/usr/bin/mkfifo', [journalAbs()])
  await expect(store().append(record())).rejects.toThrow(refusal(NOT_ORDINARY))
  await rm(journalAbs())

  await rm(join(fx.root, '.writeflex'), { recursive: true })
  await symlink(outside, join(fx.root, '.writeflex'))
  await expect(appendStoreLine(fx.root, JOURNAL, 'line\n')).rejects.toThrow(/^\.writeflex\/versions\.jsonl is not inside the Collection's own \.writeflex folder/)
  expect(existsSync(join(outside, 'versions.jsonl'))).toBe(false)
})

test('versions.jsonl absent: the first append creates it as an ordinary file of one name; twenty first appends racing in one process all land, one line each', async () => {
  const first = await store().append(record())
  const info = await lstat(journalAbs())
  expect(info.isFile()).toBe(true)
  expect(info.nlink).toBe(1)
  expect((await readFile(journalAbs(), 'utf8')).trim().split('\n').map((line) => parseVersionLine(line)?.id)).toEqual([first.id])

  // Twenty stores, so twenty queues: their opens interleave. The losers of the exclusive create append to the winner's file.
  await rm(journalAbs())
  const saved = await Promise.all(Array.from({ length: 20 }, (_, i) => store().append(record(`d${i}.md`))))
  const lines = (await readFile(journalAbs(), 'utf8')).split('\n').filter((line) => line !== '')
  expect(lines).toHaveLength(20)
  expect(lines.map((line) => parseVersionLine(line)?.id).sort()).toEqual(saved.map((v) => v.id).sort())
})

test('an ordinary journal: append, the first version for a path once, and rename behave as before', async () => {
  const versions = store()
  const named = await versions.append(record('a.md'))
  const build = async (): Promise<{ name: string; author: typeof author; snapshotId: string; versionId: string }> => ({ name: 'Initial version', author, snapshotId: 's_2', versionId: 'bv_2' })
  const initial = await versions.appendFirstForPath('b.md', build)
  expect(initial).toMatchObject({ path: 'b.md', name: 'Initial version' })
  expect(await versions.appendFirstForPath('b.md', build)).toBeNull()
  const renamed = await versions.rename(named.id, '  Second draft ')
  expect(renamed).toMatchObject({ id: named.id, name: 'Second draft', ts: named.ts })
  expect((await versions.list()).map((v) => [v.path, v.name]).sort()).toEqual([['a.md', 'Second draft'], ['b.md', 'Initial version']])
  expect((await readFile(journalAbs(), 'utf8')).split('\n').filter(Boolean)).toHaveLength(3)
})
