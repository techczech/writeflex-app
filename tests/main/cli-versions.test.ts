import { test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { spawn } from 'node:child_process'
import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceAgent } from '../../src/main/agent'
import { ChangeStore, type NewChange } from '../../src/main/changes'
import { inspectOwnerLock, ownerLockPath, type OwnerLockRecord } from '../../src/main/owner-lock'
import { saveNamedVersion } from '../../src/main/save-version'
import { compareVersionRange } from '../../src/main/version-compare'
import { readVersionContent, restoreVersionContent } from '../../src/main/version-content'
import { humanAuthorForWorkspace, VersionStore, type Version } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'
import { writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'
import { appVersionSaver, inboxNames, openAsApp } from '../helpers/request-app'

// Ticket 07: save and compare versions from the command line. The write-gate items carried from
// ticket 09 are in collection-write-gate-sites.test.ts.
let fx: WriteFixture
let appData: string
let aside: string
const agents: WorkspaceAgent[] = []
const gitEnv = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM }

// The version author is read with `git config`; keep that away from the real home folder's settings.
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
  appData = await mkdtemp(join(tmpdir(), 'wf-cli-versions-data-'))
  aside = realpathSync(await mkdtemp(join(tmpdir(), 'wf-cli-versions-aside-')))
})
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.dispose()
  await fx.dispose()
  await rm(appData, { recursive: true, force: true })
  await rm(aside, { recursive: true, force: true })
})

// Bytes a careless write would change: a byte-order mark, Windows line ends, no final newline.
const FIRST = '﻿# Žluťoučký kůň\r\n\r\nFirst text, as sent.\r\nNo final newline'
const SECOND = '# Žluťoučký kůň\n\nSecond text, rewritten.\n'
const lines = async (rel: string): Promise<Array<Record<string, unknown>>> =>
  (existsSync(join(fx.root, rel)) ? await fx.read(rel) : '').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
const stores = async (target: WriteFixture = fx): Promise<Record<string, string>> =>
  Object.fromEntries(Object.entries(await target.snapshot()).filter(([path]) => path.startsWith('.bridle/') || path === '.writeflex/versions.jsonl' || path === '.writeflex/changes.jsonl'))
const lockFree = async (): Promise<boolean> => !existsSync(ownerLockPath(fx.root)) && (await inspectOwnerLock(fx.root)).state === 'free'

/** The Collection opened as the app opens it: its one Workspace, its stores, and a real agent over Bridle. */
async function openedByTheApp(target: WriteFixture = fx): Promise<{ workspace: Workspace; versions: VersionStore; changes: ChangeStore; agent: WorkspaceAgent }> {
  const workspace = new Workspace(target.root)
  const changes = new ChangeStore(workspace)
  const agent = await WorkspaceAgent.create({ workspace, appDataDir: appData, changes, onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {} })
  agents.push(agent)
  return { workspace, versions: new VersionStore(workspace), changes, agent }
}
const save = async (path: string, name: string, extra: string[] = []): Promise<Version> => {
  const result = await fx.cli(['save-version', path, '--name', name, ...extra])
  expect(result.json.error?.message ?? '').toBe('')
  expect(result.code).toBe(0)
  expect(result.json).not.toHaveProperty('via')
  expect(result.json.result).toMatchObject({ path, undo: null })
  return result.json.result!.version as Version
}

test('a version saved with the app closed is listed by the app, and its text is restorable byte for byte', async () => {
  await fx.write('talks/horse.md', FIRST)
  const first = await save('talks/horse.md', '  As sent  ', ['--note', 'Before the rewrite.'])
  expect(first).toMatchObject({ path: 'talks/horse.md', name: 'As sent', note: 'Before the rewrite.', author: await humanAuthorForWorkspace(fx.root) })
  expect(await lockFree()).toBe(true)
  await fx.write('talks/horse.md', SECOND)
  const second = await save('talks/horse.md', 'Rewritten')
  // The command line lists them itself, newest first.
  expect(((await fx.cli(['versions', 'talks/horse.md'])).json.result!.versions as Version[]).map((version) => version.id)).toEqual([second.id, first.id])

  const app = await openedByTheApp()
  expect(await app.versions.list({ path: 'talks/horse.md' })).toEqual([second, first])
  expect((await readVersionContent(app.versions, app.agent, { id: first.id }))?.content).toBe(FIRST)
  expect((await readVersionContent(app.versions, app.agent, { id: second.id }))?.content).toBe(SECOND)
  // The app's own Compare reads them, and its own restore puts the first one back exactly.
  const compared = await compareVersionRange(app.versions, app.changes, app.agent, app.workspace, { path: 'talks/horse.md', fromId: first.id, toId: second.id })
  expect(compared).toMatchObject({ fromContent: FIRST, toContent: SECOND, direction: 'forward' })
  expect((await fx.bytes('talks/horse.md')).equals(Buffer.from(SECOND))).toBe(true)
  // The restore says which version the buffer was based on (save fix): the one on disk.
  await restoreVersionContent(app.versions, app.agent, app.workspace, { id: first.id, basis: { kind: 'disk', text: SECOND } })
  expect((await fx.bytes('talks/horse.md')).equals(Buffer.from(FIRST))).toBe(true)
})

test('the command line writes the records the app writes: the stores\' format is the app\'s own', async () => {
  const twin = await writeFixture()
  try {
    await fx.write('notes.md', SECOND)
    await twin.write('notes.md', SECOND)
    const before = await stores()
    await save('notes.md', 'Named', ['--note', 'A note.'])
    const app = await openedByTheApp(twin)
    await saveNamedVersion({ path: 'notes.md', name: 'Named', note: 'A note.', changeIds: [], changes: app.changes, versions: app.versions, agent: app.agent, author: { name: 'App Writer' } })

    // Field for field the same; only identities, times, the absolute path and the author's name differ.
    const VARIES = new Set(['id', 'ts', 'sessionId', 'snapshotId', 'versionId', 'file', 'author'])
    const shape = (record: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, VARIES.has(key) ? typeof value : value]))
    const read = async (target: WriteFixture, rel: string): Promise<Array<Record<string, unknown>>> => (await target.read(rel)).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    const mine = { history: await read(fx, '.bridle/journal.jsonl'), versions: await read(fx, '.writeflex/versions.jsonl') }
    const apps = { history: await read(twin, '.bridle/journal.jsonl'), versions: await read(twin, '.writeflex/versions.jsonl') }
    expect(mine.history.map(shape)).toEqual(apps.history.map(shape))
    expect(mine.versions.map(shape)).toEqual(apps.versions.map(shape))
    expect(mine.history.slice(1)).toMatchObject([
      { kind: 'restore-point', label: 'version: notes.md', sessionId: 'writeflex-command-line' },
      { kind: 'snapshot', file: join(fx.root, 'notes.md'), capability: 'change.save-version', origin: 'host', hash: createHash('sha256').update(SECOND).digest('hex') },
    ])
    expect(mine.versions[1]).toMatchObject({ versionId: mine.history[1].id, snapshotId: mine.history[2].id })
    // Append only: what was there before is still there, byte for byte, with the new lines after it.
    const after = await stores()
    expect(after['.writeflex/changes.jsonl']).toBe(before['.writeflex/changes.jsonl'])
    for (const rel of ['.bridle/journal.jsonl', '.writeflex/versions.jsonl']) {
      expect(Buffer.from(after[rel], 'base64').toString('utf8').startsWith(Buffer.from(before[rel], 'base64').toString('utf8')), rel).toBe(true)
    }
    // One object, named by the hash of the text and holding exactly it; the same file the app wrote.
    expect(Object.keys(after).filter((path) => path.startsWith('.bridle/objects/'))).toEqual([`.bridle/objects/${mine.history[2].hash as string}`])
    expect(after[`.bridle/objects/${mine.history[2].hash as string}`]).toBe(Buffer.from(SECOND).toString('base64'))
    expect((await stores(twin))[`.bridle/objects/${mine.history[2].hash as string}`]).toBe(Buffer.from(SECOND).toString('base64'))
  } finally {
    await twin.dispose()
  }
})

test('while the app owns the Collection a save is one request, carried out by the app; the command line writes no store', async () => {
  const agentSide = await openedByTheApp()
  const reached: string[] = []
  const app = await openAsApp(fx, { saveVersion: appVersionSaver(agentSide.workspace, (path) => agentSide.agent.snapshotReviewVersion(path)) })
  // The direct route announces every write through this seam; with the app there it must never run.
  const seams = { beforeWrite: async (path: string) => { reached.push(path) } }
  try {
    // Nobody answers: the only thing on disk is the request, and no store has changed.
    const before = await fx.snapshot({ journal: true })
    const sent = await fx.cli(['save-version', 'notes.md', '--name', 'Asked for'], { write: { seams, request: { waitMs: 40, pollMs: 10 } } })
    expect(sent.code).toBe(3)
    expect(sent.json).toMatchObject({ ok: true, via: 'app', result: {} })
    const after = await fx.snapshot({ journal: true })
    const added = Object.keys(after).filter((path) => !(path in before))
    expect(added).toEqual([`.writeflex/inbox/${sent.json.result!.request as string}.json`])
    expect(Object.fromEntries(Object.entries(after).filter(([path]) => path !== added[0]))).toEqual(before)
    expect(JSON.parse(await fx.read(added[0]))).toEqual({ version: 1, id: sent.json.result!.request, operation: 'save-version', args: { path: 'notes.md', name: 'Asked for' } })
    await rm(join(fx.root, added[0]))

    // The app answers: the version is in the app's stores, saved by the app.
    const stop = app.answering()
    try {
      const saved = await fx.cli(['save-version', 'notes.md', '--name', 'Carried out', '--note', 'By the app.'], { write: { seams } })
      expect(saved.json.error?.message ?? '').toBe('')
      expect(saved.json).toMatchObject({ ok: true, via: 'app', result: { path: 'notes.md', version: { name: 'Carried out', note: 'By the app.', author: { name: 'App Writer' } } } })
      const version = saved.json.result!.version as Version
      expect(await agentSide.versions.list({ path: 'notes.md' })).toEqual([version])
      expect((await readVersionContent(agentSide.versions, agentSide.agent, { id: version.id }))?.content).toBe(await fx.read('notes.md'))
      // The snapshot was taken under the app's agent session, not the command line's.
      expect((await lines('.bridle/journal.jsonl')).map((entry) => entry.sessionId)).not.toContain('writeflex-command-line')
    } finally {
      await stop()
    }
    expect(reached).toEqual([])
    expect(await inboxNames(fx)).toEqual([])
    expect((await inspectOwnerLock(fx.root)).owner?.kind).toBe('app')
  } finally {
    await app.close()
  }
})

test('a request can ask only for a document path, a name and a note; anything else is refused and nothing is saved', async () => {
  const app = await openAsApp(fx)
  await mkdir(join(fx.root, '.hidden'))
  await writeFile(join(fx.root, '.hidden', 'secret.md'), 'secret\n')
  const stop = app.answering()
  try {
    const before = await stores()
    for (const argv of [
      ['save-version', '.writeflex/changes.jsonl', '--name', 'x'], ['save-version', '.hidden/secret.md', '--name', 'x'],
      ['save-version', '../outside.md', '--name', 'x'], ['save-version', 'missing.md', '--name', 'x'], ['save-version', 'notes.md', '--name', '   '],
    ]) {
      const refused = await fx.cli(argv)
      expect(refused.code, argv.join(' ')).not.toBe(0)
      expect(refused.json.ok, argv.join(' ')).toBe(false)
    }
    expect(await stores()).toEqual(before)
  } finally {
    await stop()
    await app.close()
  }
})

test('no save proceeds once the owner lock is lost: nothing is written to either store', async () => {
  const before = await fx.snapshot({ journal: true })
  const planted: OwnerLockRecord = { version: 1, pid: process.pid, kind: 'app', host: hostname(), startedAt: Date.now(), heartbeatAt: Date.now(), processStartedAt: null, token: 'planted' }
  const result = await fx.cli(['save-version', 'notes.md', '--name', 'Too late'], {
    write: { seams: { beforeWrite: async () => { await writeFile(ownerLockPath(fx.root), JSON.stringify(planted)) } } },
  })
  expect(result.code).toBe(1)
  expect(result.json.error).toMatchObject({ code: 'owner-lock-lost' })
  expect(result.json.error!.message).toContain('WriteFlex or another program took over this Collection')
  expect(await fx.snapshot({ journal: true })).toEqual(before)
  expect((JSON.parse(await readFile(ownerLockPath(fx.root), 'utf8')) as OwnerLockRecord).token).toBe('planted')
  await rm(ownerLockPath(fx.root))
})

test('while one process is saving a version under the lock, a second process cannot write the stores; it saves after', async () => {
  const before = await stores()
  let entered!: () => void
  let release!: () => void
  const inside = new Promise<void>((resolve) => { entered = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  // This process takes the lock and stops just before it writes.
  const mine = fx.cli(['save-version', 'notes.md', '--name', 'First in'], { write: { seams: { beforeWrite: async () => { entered(); await held } } } })
  await inside
  expect((await inspectOwnerLock(fx.root)).owner).toMatchObject({ kind: 'command-line', pid: process.pid })

  // A second real process asks for the same thing.
  const child = spawn(process.execPath, [join(import.meta.dir, '..', 'fixtures', 'cli-version-child.ts'), fx.root, 'talks/york.md', 'Second in'], {
    stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  let printed = ''
  child.stdout!.on('data', (chunk: Buffer) => { printed += chunk.toString('utf8') })
  const exited = new Promise<number | null>((resolve) => { child.on('close', resolve) })
  const said = (): string[] => printed.split('\n').filter(Boolean)
  for (const until = Date.now() + 15_000; !said().includes('started') && Date.now() < until;) await new Promise((done) => { setTimeout(done, 20) })
  expect(said()).toContain('started')
  // It has had time to write, and has written nothing and not finished: it waits for the lock.
  await new Promise((done) => { setTimeout(done, 700) })
  expect(said()).toEqual(['started'])
  expect(await stores()).toEqual(before)

  release()
  const first = await mine
  expect(first.json.error?.message ?? '').toBe('')
  expect(await exited).toBe(0)
  const second = JSON.parse(said()[1]) as { ok: boolean; result: { version: Version } }
  expect(said()[2]).toBe('exit 0')
  expect(second.ok).toBe(true)
  // Each save's lines are whole and in turn: nothing of the second is among the first's.
  const history = (await lines('.bridle/journal.jsonl')).slice(1)
  expect(history.map((entry) => entry.kind)).toEqual(['restore-point', 'snapshot', 'restore-point', 'snapshot'])
  expect(history.map((entry) => entry.label ?? entry.file)).toEqual(['version: notes.md', join(fx.root, 'notes.md'), 'version: talks/york.md', join(fx.root, 'talks/york.md')])
  expect((await lines('.writeflex/versions.jsonl')).slice(1).map((version) => version.name)).toEqual(['First in', 'Second in'])
  expect(await lockFree()).toBe(true)
}, 30_000)

test('a document with Changes the app would settle into the version is refused, with their number; proposals still pending do not stop it', async () => {
  const ledger = new ChangeStore(new Workspace(fx.root))
  const change: NewChange = { path: 'notes.md', provenance: 'agent', editClass: 'content', summary: 'Reworded', oldText: 'See', newText: 'Look at', isCorrection: false }
  await writeFile(join(fx.root, '.writeflex', 'changes.jsonl'), '')
  await ledger.add(change) // pending review: left pending by the app's save too
  await ledger.add({ ...change, path: 'talks/york.md', status: 'accepted' }) // another document's
  await save('notes.md', 'Nothing to settle')

  await ledger.add({ ...change, summary: 'Accepted in the app', status: 'accepted' })
  await ledger.add({ ...change, summary: 'The writer\'s own', provenance: 'writer' })
  await ledger.add({ ...change, summary: 'A copy-edit', editClass: 'copy' })
  await ledger.add({ ...change, summary: 'Already in a version', status: 'accepted', snapshotId: 'bv_old', versionId: 'bv_old' })
  const before = await fx.snapshot({ journal: true })
  const refused = await fx.cli(['save-version', 'notes.md', '--name', 'Unsettled'])
  expect(refused.code).toBe(1)
  expect(refused.json.error).toMatchObject({ code: 'version-unsettled' })
  expect(refused.json.error!.message).toContain('notes.md has 3 changes')
  // The code says what the agent does next; no test pins the sentence that used to stand for it.
  expect(refused.json).toMatchObject({ outcome: 'needs-writer' })
  expect(await fx.snapshot({ journal: true })).toEqual(before)
  expect(await lockFree()).toBe(true)
})

test('compare-versions returns what the app\'s Compare returns for the same two versions, and writes nothing', async () => {
  await fx.write('talks/horse.md', FIRST)
  const first = await save('talks/horse.md', 'As sent')
  await fx.write('talks/horse.md', SECOND)
  const second = await save('talks/horse.md', 'Rewritten')
  await fx.write('talks/horse.md', `${SECOND}\nA line since.\n`)

  const before = await fx.snapshot({ journal: true })
  const pairs = [[first.id, second.id], [second.id, first.id], [first.id, 'working'], [second.versionId!, 'working']]
  const mine = []
  for (const [from, to] of pairs) {
    const result = await fx.cli(['compare-versions', 'talks/horse.md', from, to])
    expect(result.json.error?.message ?? '').toBe('')
    expect(result.json).not.toHaveProperty('via')
    mine.push(result.json.result)
  }
  // A difference against the text on disk is stamped with the time of asking; nothing else varies.
  const timeless = (result: unknown, pair: string[]): unknown => (pair.includes('working')
    ? { ...(result as object), changes: (result as { changes: Array<Record<string, unknown>> }).changes.map(({ ts: _ts, ...rest }) => rest) }
    : result)
  // With one id, the other side is the text on disk now.
  expect(timeless((await fx.cli(['compare-versions', 'talks/horse.md', first.id])).json.result, pairs[2])).toEqual(timeless(mine[2], pairs[2]))
  expect(await fx.snapshot({ journal: true })).toEqual(before)
  expect(existsSync(ownerLockPath(fx.root))).toBe(false)

  const app = await openedByTheApp()
  const author = await humanAuthorForWorkspace(fx.root)
  for (const [index, [fromId, toId]] of pairs.entries()) {
    const apps = await compareVersionRange(app.versions, app.changes, app.agent, app.workspace, { path: 'talks/horse.md', fromId, toId }, author)
    expect(timeless(mine[index], [fromId, toId]), `${fromId} -> ${toId}`).toEqual(timeless(JSON.parse(JSON.stringify(apps)), [fromId, toId]))
  }
  expect(mine[0]).toMatchObject({ fromContent: FIRST, toContent: SECOND, direction: 'forward' })
  expect((mine[0] as { changes: unknown[] }).changes.length).toBeGreaterThan(0)

  // An id that is not a version of this document is refused in the comparison's own words.
  const unknown = await fx.cli(['compare-versions', 'talks/horse.md', 'v_nope', second.id])
  expect(unknown.json.error).toMatchObject({ code: 'failed', message: 'No version with id v_nope.' })
})

test('comparing in a Collection that has no history store leaves it without one', async () => {
  await rm(join(fx.root, '.bridle'), { recursive: true })
  const before = await fx.snapshot({ journal: true })
  const same = await fx.cli(['compare-versions', 'notes.md', 'working', 'working'])
  expect(same.json.result).toMatchObject({ direction: 'same', changes: [] })
  expect(await fx.snapshot({ journal: true })).toEqual(before)
  expect(existsSync(join(fx.root, '.bridle'))).toBe(false)
})

test('a history store that is not an ordinary folder of ordinary files is never written or read through', async () => {
  const text = await fx.read('notes.md')
  const object = createHash('sha256').update(text).digest('hex')
  const refusedWith = async (phrase: string): Promise<void> => {
    const before = await fx.snapshot({ journal: true })
    const result = await fx.cli(['save-version', 'notes.md', '--name', 'Planted'])
    expect(result.code, phrase).toBe(1)
    expect(result.json.error!.message, phrase).toContain(phrase)
    expect(await fx.snapshot({ journal: true }), phrase).toEqual(before)
    expect(await readdir(aside), phrase).toEqual(['kept.txt'])
    expect(await readFile(join(aside, 'kept.txt'), 'utf8'), phrase).toBe('kept\n')
  }
  await writeFile(join(aside, 'kept.txt'), 'kept\n')

  // The objects folder holds a link, under the name this text would be stored as, to a file outside.
  await mkdir(join(fx.root, '.bridle', 'objects'))
  await symlink(join(aside, 'written-through.txt'), join(fx.root, '.bridle', 'objects', object))
  await refusedWith('is not an ordinary file')
  await rm(join(fx.root, '.bridle', 'objects', object))
  // An object that does not hold the text it is named for would become the version's text.
  await writeFile(join(fx.root, '.bridle', 'objects', object), 'not the document\n')
  await refusedWith('does not hold the text it is named for')
  await rm(join(fx.root, '.bridle', 'objects', object))
  // The history journal is a second name of a file outside the Collection.
  await rm(join(fx.root, '.bridle', 'journal.jsonl'))
  await link(join(aside, 'kept.txt'), join(fx.root, '.bridle', 'journal.jsonl'))
  await refusedWith('also known by another name')
  await rm(join(fx.root, '.bridle', 'journal.jsonl'))
  // The version journal is a link.
  await rename(join(fx.root, '.writeflex', 'versions.jsonl'), join(fx.root, '.writeflex', 'versions-real.jsonl'))
  await symlink(join(aside, 'kept.txt'), join(fx.root, '.writeflex', 'versions.jsonl'))
  await refusedWith('is not an ordinary file')
  await rm(join(fx.root, '.writeflex', 'versions.jsonl'))
  await rename(join(fx.root, '.writeflex', 'versions-real.jsonl'), join(fx.root, '.writeflex', 'versions.jsonl'))
  // The whole history folder is a link to a folder outside.
  await rm(join(fx.root, '.bridle'), { recursive: true })
  await symlink(aside, join(fx.root, '.bridle'))
  await refusedWith('is not an ordinary folder')
  await rm(join(fx.root, '.bridle'))

  // Reading: a journal entry that names a path instead of an object reads nothing.
  await mkdir(join(fx.root, '.bridle', 'objects'), { recursive: true })
  await writeFile(join(fx.root, '.bridle', 'journal.jsonl'), `${JSON.stringify({ kind: 'snapshot', id: 's1', ts: 1, sessionId: 'x', file: join(fx.root, 'notes.md'), hash: '../../../kept-elsewhere' })}\n`)
  await writeFile(join(fx.root, '.writeflex', 'versions.jsonl'), `${JSON.stringify({ id: 'v_planted', path: 'notes.md', name: 'Planted', author: { name: 'x' }, ts: 1, snapshotId: 's1', versionId: 'bv1' })}\n`)
  const compared = await fx.cli(['compare-versions', 'notes.md', 'v_planted'])
  expect(compared.code).toBe(1)
  expect(compared.json.error!.message).toContain('not one of the history store\'s own objects')
})
