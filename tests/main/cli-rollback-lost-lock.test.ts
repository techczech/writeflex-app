import { test, expect, beforeEach, afterEach } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_NAME } from '../../src/main/folio'
import { newRequestId } from '../../src/main/cli/request-format'
import { acquireOwnerLock, ownerLockPath, releaseOwnerLock, type OwnerLockRecord } from '../../src/main/owner-lock'
import { INTRO, MANIFEST, NOTES, YORK, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'
import { content, openAsApp, plantRequest, type AppSide } from '../helpers/request-app'

// Review parcel P7: putting back is a write like any other. Once the Collection is another owner's,
// nothing is written, putting back included; and a file is put back only if it holds exactly what the
// operation wrote to it. Both routes: the command line under its own lock, and the app for a request.
//
// The write steps of `move talks/york.md talks/york-2026.md`: 1 the folder, 2 the move, 3 to 5 the
// three repaired files (notes.md, talks/intro.md, the manifest). No test here waits on a clock: each
// acts at a write step it is told of.
let fx: WriteFixture
const children = new Set<ChildProcess>()
const apps: AppSide[] = []
beforeEach(async () => { fx = await writeFixture() })
afterEach(async () => {
  await Promise.all([...children].map((child) => new Promise<void>((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done()
    child.once('close', () => done())
    child.kill('SIGKILL')
  })))
  children.clear()
  for (const app of apps.splice(0)) await app.close().catch(() => {})
  await fx.dispose()
})

const MOVE = ['move', 'talks/york.md', 'talks/york-2026.md']
const THEIRS = '# Notes\n\nThe next owner wrote this while the command was stopped.\n'
const planted = (): OwnerLockRecord => ({ version: 1, pid: process.pid, kind: 'app', host: hostname(), startedAt: Date.now(), heartbeatAt: Date.now(), processStartedAt: null, token: 'planted' })
const intents = async (names: () => Promise<string[]>): Promise<string[]> => (await names()).filter((name) => name.endsWith('.intent.jsonl'))

test('the lock lost during a rename repair: the next owner\'s file is left, nothing is put back, and the change stays on record as interrupted', async () => {
  const seen: string[] = []
  const result = await fx.cli(MOVE, {
    write: { seams: { beforeWrite: async (path) => {
      seen.push(path)
      // The move is made and notes.md repaired. Before the second repair the lock changes hands,
      // and the new owner saves its own text into the file this command had just repaired.
      if (seen.length !== 4) return
      await writeFile(ownerLockPath(fx.root), JSON.stringify(planted()))
      await fx.write('notes.md', THEIRS)
    } } },
  })
  expect(seen.slice(0, 4)).toEqual(['talks', 'talks/york.md', 'notes.md', 'talks/intro.md'])
  expect(result.code).toBe(1)
  expect(result.json).toMatchObject({ ok: false, outcome: 'failed', error: { code: 'owner-lock-lost' } })
  const [intent] = await intents(fx.journalNames)
  const id = intent.replace('.intent.jsonl', '')
  expect(result.json.error!.message).toBe(
    'WriteFlex or another program took over this Collection partway through, so the command stopped. '
    + 'Already changed: talks/york.md was moved to talks/york-2026.md; notes.md was rewritten. '
    + 'Not changed: talks/intro.md, which it was about to write when it stopped, and whatever it would have changed after that. '
    + 'Nothing further was written, and nothing was put back. '
    + `The change is on record as interrupted (${id}): run "writeflex undo --list" to see it, and "writeflex undo ${id}" to put it back once the Collection is free.`,
  )
  // Nothing was written after the loss: the next owner's text stands, the move was not reversed, the
  // files not yet reached are untouched, and the lock is the next owner's still.
  expect(await fx.read('notes.md')).toBe(THEIRS)
  expect(existsSync(join(fx.root, 'talks/york.md'))).toBe(false)
  expect(await fx.read('talks/york-2026.md')).toBe(YORK)
  expect(await fx.read('talks/intro.md')).toBe(INTRO)
  expect(await fx.read(`talks/${MANIFEST_NAME}`)).toBe(MANIFEST)
  expect((JSON.parse(await readFile(ownerLockPath(fx.root), 'utf8')) as OwnerLockRecord).token).toBe('planted')
  expect((await readdir(join(fx.root, 'talks'))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  // The intent survived, in application data, and is what undo acts on once the Collection is free.
  expect(await intents(fx.journalNames)).toEqual([intent])
  await rm(ownerLockPath(fx.root))
  const list = await fx.cli(['undo', '--list'])
  expect(list.json.result!.changes).toMatchObject([{ id, interrupted: true, undone: false, by: 'command-line' }])
  // Undo then moves the path back and refuses, by name, the file the next owner wrote.
  const undo = await fx.cli(['undo', id])
  expect(undo.code).toBe(1)
  expect(undo.json.error!.message).toContain('notes.md has changed since the command line wrote it')
  expect(await fx.read('notes.md')).toBe(THEIRS)
  expect(await fx.read('talks/york.md')).toBe(YORK)
})

test('the lock lost before anything was written: refused with the same code, nothing changed, no intent left', async () => {
  const before = await fx.snapshot({ journal: true })
  const result = await fx.cli(MOVE, { write: { seams: { beforeWrite: async () => { await writeFile(ownerLockPath(fx.root), JSON.stringify(planted())) } } } })
  expect(result.code).toBe(1)
  expect(result.json.error).toEqual({ code: 'owner-lock-lost', message: 'WriteFlex or another program took over this Collection while the command was running, so it stopped.' })
  expect(await fx.snapshot({ journal: true })).toEqual(before)
  await rm(ownerLockPath(fx.root))
})

test('with the lock still held, a failed operation puts back only the files that hold what it wrote; one written since is left, named, and kept on record', async () => {
  const seen: string[] = []
  const result = await fx.cli(MOVE, {
    write: { seams: { beforeWrite: async (path) => {
      seen.push(path)
      // A program that does not ask for the lock (a sync client, an editor) saves into notes.md after
      // this command repaired it; then the command fails at its next file for an ordinary reason.
      if (seen.length === 4) await fx.write('notes.md', THEIRS)
      if (seen.length === 5) throw new Error('disk fault')
    } } },
  })
  expect(result.code).toBe(1)
  expect(result.json.error!.message).toContain('disk fault')
  expect(result.json.error!.message).toContain('Not everything could be put back: notes.md: it has changed since this operation wrote it, so it was left as it is.')
  expect(result.json.error!.message).toContain('writeflex undo --list')
  expect(await fx.read('notes.md')).toBe(THEIRS)
  // Everything that still held what the command wrote is back, and the path with it.
  expect(await fx.read('talks/intro.md')).toBe(INTRO)
  expect(await fx.read('talks/york.md')).toBe(YORK)
  expect(existsSync(join(fx.root, 'talks/york-2026.md'))).toBe(false)
  expect(await intents(fx.journalNames)).toHaveLength(1)
  expect(NOTES).not.toBe(THEIRS)
})

/** How long the child may take to reach its pause, and then to finish. The test's own limit, far beyond what either takes. */
const CHILD_DEADLINE_MS = 60_000

test('two processes, nobody killed: a command whose lock is taken over while it works stops, writes nothing more, and leaves the new owner\'s file alone', async () => {
  const child = spawn(process.execPath, [join(import.meta.dir, '..', 'fixtures', 'cli-paused-write.ts'), fx.root, fx.appData, '4', ...MOVE], { stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  let said = ''
  let errors = ''
  child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8') })
  const closed = new Promise<number | null>((resolve) => { child.once('close', (code) => { children.delete(child); resolve(code) }) })
  const watchers = new Set<() => void>()
  child.stdout.on('data', (chunk: Buffer) => { said += chunk.toString('utf8'); for (const look of [...watchers]) look() })
  /** Resolves when the child has printed a line starting with `line`; rejects if it ends first or runs out of time. */
  const told = (line: string): Promise<void> => new Promise((resolve, reject) => {
    const fail = (why: string): void => reject(new Error(`${why} It said:\n${said}${errors ? `\nOn standard error:\n${errors}` : ''}`))
    const deadline = setTimeout(() => { watchers.delete(look); fail(`The child did not say "${line}" within ${CHILD_DEADLINE_MS} ms.`) }, CHILD_DEADLINE_MS)
    const look = (): void => {
      if (!`\n${said}`.includes(`\n${line}`)) return
      clearTimeout(deadline)
      watchers.delete(look)
      resolve()
    }
    watchers.add(look)
    void closed.then(() => { look(); clearTimeout(deadline); fail(`The child ended before saying "${line}".`) })
    look()
  })
  await told('paused')
  // The command holds the lock and is alive. This process takes the Collection over the way another
  // Mac sharing the folder would after a long silence: by the heartbeat's age, on its own clock.
  const lock = await acquireOwnerLock(fx.root, { kind: 'app', host: 'another-mac', now: () => Date.now() + 10 * 60_000 })
  try {
    await fx.write('notes.md', THEIRS)
    child.stdin.write('go on\n')
    await told('finished ')
    expect(await closed).toBe(0) // the fixture itself ended in order; the command's own exit code is in what it said
    expect(said).toContain('\nfinished 1\n')
    const answer = JSON.parse(said.split('\n').find((line) => line.startsWith('said '))!.slice(5)) as { outcome: string; error: { code: string; message: string } }
    expect(answer).toMatchObject({ outcome: 'failed', error: { code: 'owner-lock-lost' } })
    expect(answer.error.message).toContain('Already changed: talks/york.md was moved to talks/york-2026.md; notes.md was rewritten.')
    expect(answer.error.message).toContain('Nothing further was written, and nothing was put back.')
    // No write step after the fourth was begun.
    expect(said.split('\n').filter((line) => line.startsWith('step '))).toHaveLength(4)
    expect(await fx.read('notes.md')).toBe(THEIRS)
    expect(await fx.read('talks/york-2026.md')).toBe(YORK)
    expect(await fx.read('talks/intro.md')).toBe(INTRO)
    // The lock on disk is still the new owner's: the command's release removed nothing.
    expect((JSON.parse(await readFile(ownerLockPath(fx.root), 'utf8')) as OwnerLockRecord).token).toBe(lock.record.token)
    expect(await intents(fx.journalNames)).toHaveLength(1)
  } finally {
    await releaseOwnerLock(lock)
  }
}, CHILD_DEADLINE_MS * 2 + 30_000)

test('the app carrying out a request when it stops holding the Collection: nothing more is written, nothing is put back, and the answer says so', async () => {
  const seen: string[] = []
  const app: AppSide = await openAsApp(fx, { seams: { write: { beforeWrite: async (path) => {
    seen.push(path)
    if (seen.length !== 4) return
    app.owns.value = false
    await fx.write('notes.md', THEIRS)
  } } } })
  apps.push(app)
  const id = await plantRequest(fx, 'move', { path: 'talks/york.md', to: 'talks/york-2026.md' }, { id: newRequestId() })
  const drained = await app.executor.drain()
  expect(drained.handled).toMatchObject([{ id, outcome: 'refused', operation: 'move' }])
  const reason = drained.handled[0].reason!
  expect(reason).toContain('WriteFlex stopped holding this Collection partway through this request')
  expect(reason).toContain('Already changed: talks/york.md was moved to talks/york-2026.md; notes.md was rewritten.')
  expect(reason).toContain('Nothing further was written, and nothing was put back.')
  expect(reason).toContain('writeflex undo --list')
  expect(JSON.parse(await readFile(join(fx.root, '.writeflex/outbox', `${id}.json`), 'utf8'))).toMatchObject({ outcome: 'refused', code: 'owner-lock-lost' })
  expect(await fx.read('notes.md')).toBe(THEIRS)
  expect(await fx.read('talks/york-2026.md')).toBe(YORK)
  expect(existsSync(join(fx.root, 'talks/york.md'))).toBe(false)
  expect(await fx.read('talks/intro.md')).toBe(INTRO)
  // On record in the app's own undo journal, as interrupted.
  expect(await intents(fx.appUndoNames)).toHaveLength(1)
})

test('an executor disposed midway still holds the lock: it puts back what holds exactly what it wrote, and leaves a file written since', async () => {
  const seen: string[] = []
  let disposed: Promise<void> | null = null
  const app: AppSide = await openAsApp(fx, { seams: { write: { beforeWrite: async (path) => {
    seen.push(path)
    if (seen.length === 4) await fx.write('notes.md', THEIRS)
    // Two files repaired, the first since written by someone else: now the window closes.
    if (seen.length === 5) disposed = app.executor.dispose()
  } } } })
  apps.push(app)
  const before = await content(fx)
  const id = await plantRequest(fx, 'move', { path: 'talks/york.md', to: 'talks/york-2026.md' }, { id: newRequestId() })
  const drained = await app.executor.drain()
  await disposed
  expect(drained.handled).toMatchObject([{ id, outcome: 'refused' }])
  expect(drained.handled[0].reason).toContain('Not everything could be put back: notes.md: it has changed since this operation wrote it, so it was left as it is.')
  expect(await content(fx)).toEqual({ ...before, 'notes.md': Buffer.from(THEIRS).toString('base64') })
  expect(await intents(fx.appUndoNames)).toHaveLength(1)
})
