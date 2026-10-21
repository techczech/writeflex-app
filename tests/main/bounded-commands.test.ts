/**
 * Review parcel P6, driver addition 3: an external program the command line or the app waits for is
 * waited for no longer than a limit; then it is killed and no longer listened to. Seams:
 * `runBounded`, the Trash mover (`trashMover`) and the version author (`humanAuthorForWorkspace`),
 * each with `expired` standing for the clock, so that no test here depends on how long anything takes.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { chmod, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { runBounded } from '../../src/main/bounded-child'
import { CliError } from '../../src/main/cli/operation'
import { trashMover } from '../../src/main/cli/system-trash'
import { inspectOwnerLock } from '../../src/main/owner-lock'
import { humanAuthorForWorkspace } from '../../src/main/versions'
import { writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'

const TEST_MS = 60_000
let dir: string
let fx: WriteFixture
beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), 'wf-bounded-')))
  fx = await writeFixture()
})
afterEach(async () => {
  await fx.dispose()
  await rm(dir, { recursive: true, force: true })
})

/** A program that never answers, whatever it is given. */
const HANGS = { file: '/bin/sh', args: ['-c', 'exec /bin/sleep 600'] }
/** The limit, passed when the test says so. */
function limit(): { expired: () => Promise<void>; pass: () => void } {
  let pass = (): void => {}
  const reached = new Promise<void>((done) => { pass = done })
  return { expired: () => reached, pass }
}
/** A limit that never passes: the program is waited for until it answers, within the test's own limit, never against the clock. */
const NEVER = { expired: (): Promise<void> => new Promise<void>(() => {}) }
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}
const tick = (): Promise<void> => new Promise((done) => { setTimeout(done, 5) })

test('a program that answers is waited for and its output returned; one that cannot be started is said so', async () => {
  expect(await runBounded('/bin/echo', ['hello'], { timeoutMs: 600_000 })).toEqual({ kind: 'exited', code: 0, stdout: 'hello\n', stderr: '' })
  expect(await runBounded('/bin/sh', ['-c', 'echo no >&2; exit 3'], { timeoutMs: 600_000 })).toEqual({ kind: 'exited', code: 3, stdout: '', stderr: 'no\n' })
  expect((await runBounded(join(dir, 'not-there'), [], { timeoutMs: 600_000 })).kind).toBe('not-started')
  // Output is kept up to a length, not without end.
  const long = await runBounded('/bin/sh', ['-c', 'printf "%05000d" 0'], { timeoutMs: 600_000, maxOutput: 100 })
  expect(long.kind === 'exited' && long.stdout.length).toBe(100)
}, TEST_MS)

test('a program that never answers is killed when the limit passes, and the wait ends', async () => {
  const { expired, pass } = limit()
  const running = runBounded(HANGS.file, HANGS.args, { timeoutMs: 600_000, expired })
  pass()
  const result = await running
  expect(result.kind).toBe('timed-out')
  const pid = (result as { pid: number | undefined }).pid!
  expect(pid).toBeGreaterThan(1)
  // Killed, not left running: the test's own time limit is the only bound on this wait.
  while (alive(pid)) await tick()
  expect(alive(pid)).toBe(false)
}, TEST_MS)

test('a Trash mover that never answers is stopped; the refusal says the item is still in place, and promises nothing it cannot know', async () => {
  const file = join(dir, 'keep.md')
  await writeFile(file, 'kept\n')
  const stopped = limit()
  const waiting = trashMover({ command: HANGS, expired: stopped.expired, platform: 'darwin' })(file).then(() => null, (error: unknown) => error)
  stopped.pass()
  const refusal = await waiting
  expect(refusal).toBeInstanceOf(CliError)
  expect((refusal as CliError).code).toBe('refused')
  expect((refusal as Error).message).toBe(`${file} could not be moved to the Trash in time (the system did not answer within 20 seconds). It is still where it was. The move was stopped, so it will not happen later.`)
  expect(existsSync(file)).toBe(true)

  // Through Finder the request may outlive the wait: the refusal says so instead.
  const finder = limit()
  const asked = trashMover({ command: { ...HANGS, finishesLater: true }, expired: finder.expired, platform: 'darwin' })(file).then(() => null, (error: unknown) => error)
  finder.pass()
  const said = (await asked as Error).message
  expect(said).toContain('It is still where it was. Finder was asked and may still carry the move out')
  expect(said).not.toContain('will not happen later')
}, TEST_MS)

test('an item that was moved before the limit passed is reported as moved, though the mover never answered', async () => {
  const file = join(dir, 'goes.md')
  const trash = join(dir, 'trash-goes.md')
  await writeFile(file, 'gone\n')
  // Moves the item, then hangs. The limit passes once the item is seen to be gone.
  const mover = trashMover({
    command: { file: '/bin/sh', args: ['-c', '/bin/mv "$0" "$1"; exec /bin/sleep 600', file, trash] }, platform: 'darwin',
    expired: async () => { while (existsSync(file)) await tick() },
  })
  await mover(file)
  expect(existsSync(trash)).toBe(true)
}, TEST_MS)

test('a mover that fails says what the system said; the command line moves to the Trash on macOS only', async () => {
  const file = join(dir, 'stays.md')
  await writeFile(file, 'x')
  await expect(trashMover({ command: { file: '/bin/sh', args: ['-c', 'echo "not permitted" >&2; exit 1'] }, platform: 'darwin' })(file)).rejects.toThrow('not permitted')
  await expect(trashMover({ platform: 'linux' })(file)).rejects.toThrow('macOS only')
  expect(existsSync(file)).toBe(true)
}, TEST_MS)

test('writeflex trash with a mover that never answers refuses, leaves the document in place and gives the Collection up', async () => {
  const stopped = limit()
  const before = await fx.snapshot()
  let started = false
  const hanging = trashMover({ command: HANGS, expired: stopped.expired, platform: 'darwin' })
  const running = fx.cli(['trash', 'notes.md'], { write: { trash: async (absolute) => { started = true; stopped.pass(); return hanging(absolute) } } })
  const result = await running
  expect(started).toBe(true)
  expect(result.code).toBe(1)
  expect(result.json.error).toMatchObject({ code: 'refused' })
  expect(result.json.error!.message).toContain('could not be moved to the Trash in time')
  expect(result.json.error!.message).toContain('It is still where it was.')
  expect(await fx.snapshot()).toEqual(before)
  expect((await inspectOwnerLock(fx.root)).state).toBe('free')
  // And with a mover that works, the same command still does.
  expect((await fx.cli(['trash', 'notes.md'], { write: { trash: async (absolute) => { await rename(absolute, join(fx.trashed, 'notes.md')) } } })).json.ok).toBe(true)
}, TEST_MS)

test('a git that never answers does not hold a version save: the author falls back to this computer\'s user name', async () => {
  const hangs = join(dir, 'git-hangs')
  await writeFile(hangs, '#!/bin/sh\nexec /bin/sleep 600\n')
  await chmod(hangs, 0o755)
  const stopped = limit()
  const asking = humanAuthorForWorkspace(fx.root, { command: hangs, expired: stopped.expired })
  stopped.pass()
  expect(await asking).toEqual({ name: userInfo().username || 'Writer' })

  const answers = join(dir, 'git-answers')
  await writeFile(answers, '#!/bin/sh\ncase "$5" in user.name) echo "Ada Writer" ;; user.email) echo "ada@example.com" ;; esac\n')
  await chmod(answers, 0o755)
  // A freshly written program's first start can stall on this machine: it is waited for, not timed.
  expect(await humanAuthorForWorkspace(fx.root, { command: answers, ...NEVER })).toEqual({ name: 'Ada Writer', email: 'ada@example.com' })
  expect(await humanAuthorForWorkspace(fx.root, { command: join(dir, 'no-git-here'), ...NEVER })).toEqual({ name: userInfo().username || 'Writer' })
}, TEST_MS)
