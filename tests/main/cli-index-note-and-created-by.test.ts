/**
 * The writer's two decisions of 7 October (ticket 04, "Decided by the writer"):
 *  B1. `move-folder` renames the folder's Index Note with the folder: one operation, one journal
 *      entry, one undo, on the direct route and on the request route alike.
 *  B2. a document an agent creates says so in its frontmatter and in WriteFlex's history for the file.
 * Seams: the command (`runCli` over a fixture Collection), the app's side without a window
 * (`openAsApp`), and for the history the app's own listing and restore code over a real Workspace.
 */
import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceAgent } from '../../src/main/agent'
import { CREATED_BY_KEY } from '../../src/main/cli/agent-created-hook'
import type { JournalEntry } from '../../src/main/cli/journal'
import { ChangeStore } from '../../src/main/changes'
import { indexNotePath } from '../../src/main/folio'
import { parseFrontmatter } from '../../src/main/frontmatter'
import { inspectOwnerLock } from '../../src/main/owner-lock'
import { readVersionContent, restoreVersionContent } from '../../src/main/version-content'
import { VersionStore, type Version } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'
import { createdBy, writeFixture, type CliRun, type WriteFixture } from '../helpers/cli-write-fixture'
import { content, openAsApp, type AppSide } from '../helpers/request-app'

let fx: WriteFixture
let appData: string
let app: AppSide | null
const agents: WorkspaceAgent[] = []
const gitEnv = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM }

// A version's default author is read with `git config`; keep that away from the real home folder's settings.
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
  appData = await mkdtemp(join(tmpdir(), 'wf-cli-created-data-'))
  app = null
})
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.dispose()
  await app?.close()
  await fx.dispose()
  await rm(appData, { recursive: true, force: true })
})

/** Run a command while the app has the Collection open and answers requests. */
async function viaApp(argv: string[], env: Parameters<WriteFixture['cli']>[1] = {}): Promise<CliRun> {
  const stop = app!.answering()
  try {
    return await fx.cli(argv, { ...env, write: { request: { waitMs: 20_000, pollMs: 5 }, ...env.write } })
  } finally {
    await stop()
  }
}
const ok = (run: CliRun): Record<string, unknown> => {
  expect(run.json.error?.message ?? '').toBe('')
  expect(run.code).toBe(0)
  return run.json.result!
}

// --- B1: the Index Note travels with its folder ------------------------------------------------------

const INDEX = '---\ntitle: Talks\n---\n# Talks\n\n- [[york]]\n- [[intro]]\n'
const LINKING = '# Reading list\n\nStart at [[_talks_INDEX]], then [[_talks_INDEX|the talks index]].\n'
async function withIndexNote(): Promise<void> {
  await fx.write('talks/_talks_INDEX.md', INDEX)
  await fx.write('reading.md', LINKING)
  // The app's own rule names it: nothing here restates the pattern.
  expect(indexNotePath(new Workspace(fx.root), 'talks')).toBe('talks/_talks_INDEX.md')
}

for (const route of ['direct', 'request'] as const) {
  test(`${route} route: move-folder renames the Index Note with the folder, repairs links to it, and one undo restores every byte and path`, async () => {
    await withIndexNote()
    if (route === 'request') app = await openAsApp(fx)
    const run = route === 'request' ? viaApp : fx.cli
    const before = await content(fx)

    const moved = await run(['move-folder', 'talks', 'events'])
    const result = ok(moved)
    expect(moved.json).toMatchObject(route === 'request' ? { via: 'app' } : {})
    expect(result).toMatchObject({
      from: 'talks', to: 'events', indexNote: { from: 'talks/_talks_INDEX.md', to: 'events/_events_INDEX.md' },
      moved: [{ from: 'talks', to: 'events', kind: 'folder' }, { from: 'events/_talks_INDEX.md', to: 'events/_events_INDEX.md', kind: 'file' }],
    })
    expect(result.notices).toEqual([])
    expect(await fx.read('events/_events_INDEX.md')).toBe(INDEX)
    expect(existsSync(join(fx.root, 'events/_talks_INDEX.md'))).toBe(false)
    expect(existsSync(join(fx.root, 'talks'))).toBe(false)
    // Links to the Index Note are repaired as for any moved document.
    expect(await fx.read('reading.md')).toBe(LINKING.replaceAll('_talks_INDEX', '_events_INDEX'))
    expect(result.repaired).toContain('reading.md')

    // ONE journal entry holds both moves, in the journal of the route that made the change.
    const [own, other] = route === 'request' ? [fx.appUndoDir, await fx.journalNames()] : [fx.journalDir, await fx.appUndoNames()]
    const names = route === 'request' ? await fx.appUndoNames() : await fx.journalNames()
    expect(names).toHaveLength(1)
    expect(other).toEqual([])
    const entry = JSON.parse(await readFile(join(own, names[0]), 'utf8')) as JournalEntry
    expect(entry.moves.map(({ from, to, kind }) => ({ from, to, kind }))).toEqual(result.moved as never)
    expect(result.undo).toBe(entry.id)

    const undone = ok(await run(['undo']))
    expect(undone).toMatchObject({ undone: entry.id, moved: [{ from: 'events/_events_INDEX.md', to: 'events/_talks_INDEX.md' }, { from: 'events', to: 'talks' }] })
    expect(await content(fx)).toEqual(before)
  }, 60_000)

  test(`${route} route: a file already at the Index Note's new name refuses the whole move before anything changes, and says why`, async () => {
    await withIndexNote()
    await fx.write('talks/_events_INDEX.md', 'already here\n')
    if (route === 'request') app = await openAsApp(fx)
    const before = await content(fx)
    const refused = await (route === 'request' ? viaApp : fx.cli)(['move-folder', 'talks', 'events'])
    expect(refused.code).toBe(1)
    expect(refused.json.error).toMatchObject({ code: 'refused' })
    expect(refused.json.error!.message).toContain('talks was not moved: its Index Note talks/_talks_INDEX.md would be renamed to events/_events_INDEX.md with the folder, and the folder already holds a file of that name (talks/_events_INDEX.md). Nothing was changed.')
    expect(await content(fx)).toEqual(before)
    expect(await fx.journalNames()).toEqual([])
    expect(await fx.appUndoNames()).toEqual([])
  }, 60_000)
}

test('a folder with no Index Note, and a folder moved without a change of name, move as before; the old notice is gone', async () => {
  const plain = ok(await fx.cli(['move-folder', 'talks', 'events']))
  expect(plain).not.toHaveProperty('indexNote')
  expect(plain.moved).toEqual([{ from: 'talks', to: 'events', kind: 'folder' }])
  ok(await fx.cli(['undo']))

  // Moved into another folder: its own name is unchanged, so its Index Note keeps its name too.
  await withIndexNote()
  await fx.cli(['create-folder', 'archive'])
  const into = ok(await fx.cli(['move-folder', 'talks', 'archive']))
  expect(into).toMatchObject({ to: 'archive/talks', moved: [{ from: 'talks', to: 'archive/talks', kind: 'folder' }], notices: [] })
  expect(into).not.toHaveProperty('indexNote')
  expect(await fx.read('archive/talks/_talks_INDEX.md')).toBe(INDEX)
  expect(JSON.stringify(into)).not.toContain('still carries the folder\'s old name')

  // A note named for ANOTHER folder is not this folder's Index Note and is left alone.
  await fx.write('archive/talks/_other_INDEX.md', 'not ours\n')
  const renamed = ok(await fx.cli(['move-folder', 'archive/talks', 'archive/events']))
  expect(renamed.indexNote).toEqual({ from: 'archive/talks/_talks_INDEX.md', to: 'archive/events/_events_INDEX.md' })
  expect(await fx.read('archive/events/_other_INDEX.md')).toBe('not ours\n')
})

test('a folder renamed only in letter case renames its Index Note in letter case too, and undo puts both back', async () => {
  await withIndexNote()
  const before = await fx.snapshot()
  const result = ok(await fx.cli(['move-folder', 'talks', 'Talks']))
  expect(result.indexNote).toEqual({ from: 'talks/_talks_INDEX.md', to: 'Talks/_Talks_INDEX.md' })
  expect(Object.keys(await fx.snapshot())).toContain('Talks/_Talks_INDEX.md')
  ok(await fx.cli(['undo']))
  expect(await fx.snapshot()).toEqual(before)
})

// --- B2: a created document records who created it ---------------------------------------------------

/** The Collection opened as the app opens it: its stores and a real agent over Bridle, to list and restore versions with. */
async function openedByTheApp(): Promise<{ workspace: Workspace; versions: VersionStore; agent: WorkspaceAgent }> {
  const workspace = new Workspace(fx.root)
  const agent = await WorkspaceAgent.create({ workspace, appDataDir: appData, changes: new ChangeStore(workspace), onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {} })
  agents.push(agent)
  return { workspace, versions: new VersionStore(workspace), agent }
}

const SOURCES: Array<{ how: string; argv: string[]; environ?: Record<string, string>; label: string }> = [
  { how: 'the operation\'s own --source', argv: ['create', 'a.md', '--content', '# A\n', '--source', 'claude-code'], label: 'Claude Code' },
  { how: 'the global --source', argv: ['--source', 'codex', 'create', 'a.md', '--content', '# A\n'], label: 'Codex' },
  { how: 'WRITEFLEX_SOURCE', argv: ['create', 'a.md', '--content', '# A\n'], environ: { WRITEFLEX_SOURCE: 'claude-code' }, label: 'Claude Code' },
  { how: 'no source declared', argv: ['create', 'a.md', '--content', '# A\n'], label: 'Outside agent' },
  { how: 'a source not on the closed list', argv: ['create', 'a.md', '--content', '# A\n', '--source', 'WriteFlex Agent'], label: 'Outside agent' },
]

for (const route of ['direct', 'request'] as const) {
  for (const { how, argv, environ, label } of SOURCES) {
    test(`${route} route, ${how}: the document carries "created-by: ${label}" and its history a version "Created by ${label}"`, async () => {
      if (route === 'request') app = await openAsApp(fx)
      const created = await (route === 'request' ? viaApp : fx.cli)(argv, environ ? { environ } : {})
      const result = ok(created)
      expect(created.json).toMatchObject(route === 'request' ? { via: 'app' } : {})
      const text = createdBy('# A\n', label)
      expect(await fx.read('a.md')).toBe(text)
      expect(result.createdBy).toMatchObject({ label, frontmatter: true, history: { name: `Created by ${label}` } })
      expect(result.createdBy).not.toHaveProperty('note')
      expect(result.undo).toBeNull()

      // Listed by the app's own listing code, with the source as its author, and its text restorable.
      if (route === 'request') { await app!.close(); app = null }
      const opened = await openedByTheApp()
      const versions: Version[] = await opened.versions.list({ path: 'a.md' })
      expect(versions).toHaveLength(1)
      expect(versions[0]).toMatchObject({ path: 'a.md', name: `Created by ${label}`, author: { name: label } })
      expect(versions[0].id).toBe((result.createdBy as { history: { version: string } }).history.version)
      expect((await readVersionContent(opened.versions, opened.agent, { id: versions[0].id }))?.content).toBe(text)
      const rewritten = 'The writer rewrote it, and removed the line.\n'
      await writeFile(join(fx.root, 'a.md'), rewritten)
      // The restore says which version the buffer was based on (save fix): the writer's, on disk.
      await restoreVersionContent(opened.versions, opened.agent, opened.workspace, { id: versions[0].id, basis: { kind: 'disk', text: rewritten } })
      expect(await fx.read('a.md')).toBe(text)
      expect((await inspectOwnerLock(fx.root)).state).toBe('free')
    }, 60_000)
  }
}

test('text that comes with frontmatter gains the line inside its own block; text that already carries the key keeps its value', async () => {
  const titled = '---\ntitle: A talk\nstatus: draft\n---\n# A talk\n'
  ok(await fx.cli(['create', 'titled.md', '--source', 'codex', '--stdin'], { stdin: titled }))
  expect(await fx.read('titled.md')).toBe('---\ntitle: A talk\nstatus: draft\ncreated-by: Codex\n---\n# A talk\n')
  expect((await fx.read('titled.md')).match(/^---$/gm)).toHaveLength(2)
  expect(parseFrontmatter(await fx.read('titled.md'))).toMatchObject({ title: 'A talk', status: 'draft', extra: { [CREATED_BY_KEY]: 'Codex' } })

  // Windows line ends and a byte-order mark stay as they came.
  ok(await fx.cli(['create', 'windows.md', '--content', '﻿---\r\ntitle: W\r\n---\r\nBody\r\n', '--source', 'claude-code']))
  expect(await fx.read('windows.md')).toBe('﻿---\r\ntitle: W\r\ncreated-by: Claude Code\r\n---\r\nBody\r\n')

  // The writer's (or the caller's) own value is never replaced, and the history is recorded all the same.
  const own = '---\ncreated-by: Dominik, with help\n---\nMine.\n'
  const kept = ok(await fx.cli(['create', 'own.md', '--content', own, '--source', 'claude-code']))
  expect(await fx.read('own.md')).toBe(own)
  expect(kept.createdBy).toMatchObject({ frontmatter: true, history: { name: 'Created by Claude Code' } })
  expect((kept.createdBy as { note: string }).note).toContain('already carried created-by')

  // No content at all: the document is the line.
  ok(await fx.cli(['create', 'empty.md']))
  expect(await fx.read('empty.md')).toBe(createdBy(''))
})

test('a frontmatter block the app\'s writer will not edit: the document is created exactly as given, with neither record, and the result says so', async () => {
  const folded = '---\ntitle: >\n  A folded\n  title\n---\nBody.\n'
  const created = await fx.cli(['create', 'folded.md', '--content', folded, '--source', 'codex'])
  const result = ok(created)
  expect(await fx.read('folded.md')).toBe(folded)
  expect(result.createdBy).toMatchObject({ label: 'Codex', frontmatter: false, history: null })
  expect((result.createdBy as { note: string }).note).toContain('Not recorded as created by Codex, in the document or in its history')
  expect(await new VersionStore(new Workspace(fx.root)).list({ path: 'folded.md' })).toEqual([])
})

for (const route of ['direct', 'request'] as const) {
  test(`${route} route: when the history record cannot be written the document is still created, with exactly the text given, and the result says why`, async () => {
    // The history store's objects folder is not a folder: nothing can be saved into the history.
    await writeFile(join(fx.root, '.bridle/objects'), 'not a folder')
    if (route === 'request') app = await openAsApp(fx)
    const stores = async (): Promise<Record<string, string>> => Object.fromEntries(Object.entries(await fx.snapshot()).filter(([path]) => path.startsWith('.bridle/') || path === '.writeflex/versions.jsonl'))
    const before = await stores()
    const created = await (route === 'request' ? viaApp : fx.cli)(['create', 'kept.md', '--content', '# Kept\n', '--source', 'claude-code'])
    const result = ok(created)
    expect(created.json).toMatchObject({ outcome: 'done' })
    // Neither record: no version, and no line in the document.
    expect(await fx.read('kept.md')).toBe('# Kept\n')
    expect(result.createdBy).toMatchObject({ label: 'Claude Code', frontmatter: false, history: null })
    const note = (result.createdBy as { note: string }).note
    expect(note).toStartWith('Not recorded as created by Claude Code: the history record could not be written (')
    expect(note).toContain('so the created-by line was left out of the document too')
    expect(await stores()).toEqual(before)
    expect(await new VersionStore(new Workspace(fx.root)).list({ path: 'kept.md' })).toEqual([])
  }, 60_000)
}

test('duplicate and create-manifest are not creations by an agent: a copy is its source byte for byte, and neither saves a version', async () => {
  ok(await fx.cli(['create', 'a.md', '--content', '# A\n', '--source', 'claude-code']))
  const versions = async (): Promise<string[]> => (await new VersionStore(new Workspace(fx.root)).list()).map((version) => `${version.path}: ${version.name}`)
  expect(await versions()).toEqual(['a.md: Created by Claude Code'])
  ok(await fx.cli(['duplicate', 'talks/york.md']))
  expect(await fx.read('talks/york (copy).md')).toBe(await fx.read('talks/york.md'))
  ok(await fx.cli(['duplicate', 'a.md']))
  expect(await fx.read('a (copy).md')).toBe(await fx.read('a.md'))
  await fx.write('f/part.md', '# Part\n')
  ok(await fx.cli(['create-manifest', 'f']))
  expect(await versions()).toEqual(['a.md: Created by Claude Code'])
})

test('in plain text a create says what it recorded, under the fixed first line', async () => {
  let out = ''
  const { runCli } = await import('../../src/main/cli/run')
  const code = await runCli(['--root', fx.root, '--source', 'claude-code', 'create', 'said.md', '--content', 'x'], {
    cwd: tmpdir(), stdout: (t) => { out += t }, stderr: () => {}, environ: {},
    write: { keyFolders: [fx.keys], appDataFolders: [fx.appData, fx.otherAppData] },
  })
  expect(code).toBe(0)
  expect(out).toBe('Done:\nCreated said.md\nRecorded as created by Claude Code: the line "created-by: Claude Code" in its frontmatter, and the version "Created by Claude Code" in its history in WriteFlex.\n')
})
