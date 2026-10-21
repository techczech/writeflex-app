/**
 * The owner lock's local faults (review parcel P2): a release against a refresh in flight, records
 * nothing ties to a live process of this user's, heartbeats from the future, a `.writeflex` that is
 * not a real folder, two contenders for one abandoned recovery claim, and a `ps` that never answers.
 * Every interleaving here is stepped through a seam; nothing waits on a clock.
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireOwnerLock, inspectOwnerLock, refreshOwnerLock, releaseOwnerLock, takeRecoveryClaim, withOwnerLock,
  ownerLockPath, OwnerLockBusyError, OwnerLockFolderError, OWNER_LOCK_STALE_MS, type OwnerLockEvent, type OwnerLockRecord,
} from '../../src/main/owner-lock'
import { MAX_ENTRIES_LISTED } from '../../src/main/cli/review-format'
import { readProcessStartTime, resolveOwnerLockEnv, type ProcessTableSeams } from '../../src/main/owner-lock-liveness'

const roots: string[] = []
async function folder(prefix = 'wf-owner-lock-faults-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}
async function collection(): Promise<string> {
  const root = await folder()
  await mkdir(join(root, '.writeflex'))
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const onDisk = async (root: string): Promise<OwnerLockRecord> => JSON.parse(await readFile(ownerLockPath(root), 'utf8')) as OwnerLockRecord
const lockFiles = async (root: string): Promise<string[]> => (await readdir(join(root, '.writeflex'))).sort()
const claimPath = (root: string): string => `${ownerLockPath(root)}.recover`
const caught = (work: Promise<unknown>): Promise<unknown> => work.then(() => 'did not throw', (error: unknown) => error)
async function plant(root: string, overrides: Partial<OwnerLockRecord>): Promise<OwnerLockRecord> {
  const record: OwnerLockRecord = {
    version: 1, pid: process.pid, kind: 'app', host: hostname(), startedAt: Date.now(), heartbeatAt: Date.now(), processStartedAt: null, token: 'planted', ...overrides,
  }
  await writeFile(ownerLockPath(root), JSON.stringify(record))
  return record
}
/** A step the test opens by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {}
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 5) })
const pidRuns = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}
/** This process's start time as the lock records it. */
async function ownStartTime(): Promise<number> {
  const started = await readProcessStartTime(process.pid)
  expect(typeof started).toBe('number')
  return started as number
}
const LATER = { now: () => Date.now() + OWNER_LOCK_STALE_MS + 1_000 }
const YEAR_MS = 365 * 24 * 3_600_000

test('a release waits for the holder\'s refresh in flight: a released holder\'s heartbeat never lands on the next owner\'s lock, or anywhere', async () => {
  const root = await collection()
  const reached = gate()
  const go = gate()
  let stepping = false
  // The seam runs after A has read its own record and before it writes the next one.
  const a = await acquireOwnerLock(root, { kind: 'command-line', beforeHeartbeatWrite: async () => {
    if (!stepping) return
    reached.open()
    await go.promise
  } })
  stepping = true
  const refreshing = refreshOwnerLock(a)
  await reached.promise
  stepping = false
  const releasing = releaseOwnerLock(a)
  // The Collection is still A's while its refresh is in flight: B is refused, not let in underneath it.
  expect(await caught(acquireOwnerLock(root, { kind: 'command-line' }))).toBeInstanceOf(OwnerLockBusyError)
  go.open()
  expect(await refreshing).toBe('refreshed')
  await releasing
  // Released: a heartbeat of A's that starts now writes nothing and does not put the lock back.
  expect(await refreshOwnerLock(a)).toBe('lost')
  expect(existsSync(ownerLockPath(root))).toBe(false)

  const b = await acquireOwnerLock(root, { kind: 'command-line' })
  expect(b.recovered).toBeNull()
  expect(await refreshOwnerLock(a)).toBe('lost')
  await releaseOwnerLock(a)
  expect(await onDisk(root)).toEqual(b.record)
  expect(await lockFiles(root)).toEqual(['owner.lock'])
  await releaseOwnerLock(b)
})

test('on this host a record nothing ties to a live process of this user\'s is judged by its heartbeat: held while fresh, recoverable after the limit', async () => {
  const started = await ownStartTime()
  const cases: Array<{ name: string; record: Partial<OwnerLockRecord>; env?: Parameters<typeof inspectOwnerLock>[1] }> = [
    { name: 'process 1, no start time', record: { pid: 1 } },
    { name: 'process 1 with a start time written in', record: { pid: 1, processStartedAt: started } },
    { name: 'process 0', record: { pid: 0 } },
    { name: 'a live process, start time not recorded', record: { pid: process.pid } },
    { name: 'a live process whose start time cannot be read now', record: { pid: process.pid, processStartedAt: started }, env: { processStartedAt: async () => null } },
    { name: 'a process of another user', record: { pid: 4242, processStartedAt: started }, env: { pidIsAlive: () => 'other-user', processStartedAt: async () => started } },
  ]
  for (const { name, record, env } of cases) {
    const root = await collection()
    const planted = await plant(root, record)
    expect(await inspectOwnerLock(root, env), name).toEqual({ state: 'held', owner: planted, conflictCopies: [] })
    expect(await caught(acquireOwnerLock(root, { kind: 'command-line', ...env })), name).toBeInstanceOf(OwnerLockBusyError)
    expect(await inspectOwnerLock(root, { ...env, ...LATER }), name).toMatchObject({ state: 'recoverable', reason: 'heartbeat-expired' })
    const lock = await acquireOwnerLock(root, { kind: 'command-line', ...env, ...LATER })
    expect(lock.recovered, name).toEqual({ reason: 'heartbeat-expired', previous: planted })
    await releaseOwnerLock(lock)
  }
})

test('a heartbeat more than five minutes in the future is not believed: the record is judged by the age of its file', async () => {
  for (const host of [hostname(), 'some-other-mac']) {
    const root = await collection()
    const planted = await plant(root, { host, pid: 1, heartbeatAt: Date.now() + YEAR_MS })
    // A file just written may be a sync client's: it gets the full limit.
    expect((await inspectOwnerLock(root)).state, host).toBe('held')
    expect(await inspectOwnerLock(root, LATER), host).toMatchObject({ state: 'recoverable', reason: 'unreadable' })
    // A modification time set into the future as well does not help: the file is aged by when the system saw it change.
    const future = new Date(Date.now() + YEAR_MS)
    await utimes(ownerLockPath(root), future, future)
    expect((await inspectOwnerLock(root)).state, host).toBe('held')
    expect(await inspectOwnerLock(root, LATER), host).toMatchObject({ state: 'recoverable', reason: 'unreadable' })
    const lock = await acquireOwnerLock(root, { kind: 'command-line', ...LATER })
    expect(lock.recovered, host).toEqual({ reason: 'unreadable', previous: planted })
    await releaseOwnerLock(lock)
  }
  // Within five minutes it is a clock that runs a little ahead: believed, and it expires in its turn.
  const root = await collection()
  await plant(root, { host: 'some-other-mac', heartbeatAt: Date.now() + 4 * 60_000 })
  expect((await inspectOwnerLock(root, LATER)).state).toBe('held')
  expect(await inspectOwnerLock(root, { now: () => Date.now() + 4 * 60_000 + OWNER_LOCK_STALE_MS + 1_000 })).toMatchObject({ state: 'recoverable', reason: 'heartbeat-expired' })
})

test('a .writeflex that is a link or a file is refused by every lock operation, and nothing is read or written through it', async () => {
  const root = await folder()
  const outside = await folder('wf-owner-lock-outside-')
  await symlink(outside, join(root, '.writeflex'))
  for (const attempt of [
    () => acquireOwnerLock(root, { kind: 'app' }),
    () => acquireOwnerLock(root, { kind: 'command-line', waitMs: 200 }),
    () => withOwnerLock(root, { kind: 'command-line' }, async () => 'ran'),
    () => inspectOwnerLock(root),
  ]) expect(await caught(attempt())).toBeInstanceOf(OwnerLockFolderError)
  expect(await readdir(outside)).toEqual([])
  // A lock planted where the link points is not read as this Collection's.
  await writeFile(join(outside, 'owner.lock'), JSON.stringify({ version: 1, pid: process.pid, kind: 'app', host: hostname(), startedAt: 0, heartbeatAt: Date.now(), processStartedAt: null, token: 'outside' }))
  expect(await caught(inspectOwnerLock(root))).toBeInstanceOf(OwnerLockFolderError)
  expect(await readdir(outside)).toEqual(['owner.lock'])

  const blocked = await folder()
  await writeFile(join(blocked, '.writeflex'), 'a file, not a folder')
  expect(await caught(acquireOwnerLock(blocked, { kind: 'app' }))).toBeInstanceOf(OwnerLockFolderError)
  expect(await caught(inspectOwnerLock(blocked))).toBeInstanceOf(OwnerLockFolderError)
  expect(await readFile(join(blocked, '.writeflex'), 'utf8')).toBe('a file, not a folder')
  expect(await readdir(blocked)).toEqual(['.writeflex'])
})

test('a .writeflex swapped for a link while the lock is held: the heartbeat and the release write nothing through it', async () => {
  const root = await collection()
  const outside = await folder('wf-owner-lock-outside-')
  const lock = await acquireOwnerLock(root, { kind: 'app' })
  await rename(join(root, '.writeflex'), join(root, 'moved-aside'))
  await symlink(outside, join(root, '.writeflex'))
  expect(await caught(refreshOwnerLock(lock))).toBeInstanceOf(OwnerLockFolderError)
  await releaseOwnerLock(lock)
  expect(await readdir(outside)).toEqual([])
  expect(await readdir(join(root, 'moved-aside'))).toEqual(['owner.lock'])
})

test('two contenders for one abandoned recovery claim: the one that judged it first does not remove the other\'s live claim', async () => {
  const root = await collection()
  const gone = Bun.spawn([process.execPath, '-e', ''])
  await gone.exited
  await writeFile(claimPath(root), JSON.stringify({ pid: gone.pid, host: hostname(), token: 'abandoned', at: Date.now() }))
  let second: (() => Promise<void>) | null | undefined
  // The first contender has read the abandoned claim and judged it. Before it removes anything, the
  // second contender does the whole of the same thing and holds the claim.
  const first = await takeRecoveryClaim(ownerLockPath(root), resolveOwnerLockEnv({
    afterClaimJudged: async () => { second = await takeRecoveryClaim(ownerLockPath(root), resolveOwnerLockEnv({})) },
  }))
  expect(second).toBeInstanceOf(Function)
  expect(first).toBeNull()
  const standing = JSON.parse(await readFile(claimPath(root), 'utf8')) as { pid: number; token: string }
  expect(standing.pid).toBe(process.pid)
  expect(standing.token).not.toBe('abandoned')
  expect(await lockFiles(root)).toEqual(['owner.lock.recover']) // nothing left aside
  await second!()
  expect(await lockFiles(root)).toEqual([])
})

/** Plant a recovery claim held by a process that has exited: abandoned, and taken over by the next recoverer. */
async function abandonedClaim(root: string): Promise<void> {
  const gone = Bun.spawn([process.execPath, '-e', ''])
  await gone.exited
  await writeFile(claimPath(root), JSON.stringify({ pid: gone.pid, host: hostname(), token: 'abandoned', at: Date.now() }))
}
type ClaimOnDisk = { token: string }
const claimAt = async (path: string): Promise<ClaimOnDisk> => JSON.parse(await readFile(path, 'utf8')) as ClaimOnDisk
const asides = async (root: string): Promise<string[]> => (await lockFiles(root)).filter((name) => name.startsWith('owner.lock.recover.stale.'))

test('three contenders for one abandoned recovery claim (the reviewer\'s schedule): the claim A moved aside and could not put back is kept on disk, never removed', async () => {
  const root = await collection()
  await abandonedClaim(root)
  let b: (() => Promise<void>) | null | undefined
  let c: (() => Promise<void>) | null | undefined
  let bToken: string | undefined
  // 1. A judges the abandoned claim.
  const a = await takeRecoveryClaim(ownerLockPath(root), resolveOwnerLockEnv({
    // 2. Before A moves anything, B judges the same claim, replaces it and holds a live claim of its own.
    afterClaimJudged: async () => {
      b = await takeRecoveryClaim(ownerLockPath(root), resolveOwnerLockEnv({}))
      bToken = (await claimAt(claimPath(root))).token
    },
    // 3. A has moved B's claim aside. 4. While the claim's path is empty, C creates its own claim there.
    afterClaimMovedAside: async () => { c = await takeRecoveryClaim(ownerLockPath(root), resolveOwnerLockEnv({})) },
  }))
  // 5. A sees that what it moved is not the claim it judged, and cannot put it back: C's stands there.
  expect(a).toBeNull()
  expect(b).toBeInstanceOf(Function)
  expect(c).toBeInstanceOf(Function)
  // 6. B's claim is not removed: it is left aside, whole, with B's token in it.
  const left = await asides(root)
  expect(left).toHaveLength(1)
  expect((await claimAt(join(root, '.writeflex', left[0]))).token).toBe(bToken!)
  // Exactly one claim stands at the claim's path, and it is C's.
  const standing = (await claimAt(claimPath(root))).token
  expect(standing).not.toBe(bToken!)
  expect(standing).not.toBe('abandoned')
  // B's release removes nothing of C's; C's release removes C's claim; the aside stays as litter.
  await b!()
  expect((await claimAt(claimPath(root))).token).toBe(standing)
  await c!()
  expect(existsSync(claimPath(root))).toBe(false)
  expect(await lockFiles(root)).toEqual(left)
})

test('three contenders recovering one stale lock through that schedule: exactly one lock, at most one claim at its path, and the moved-aside claim kept', async () => {
  const root = await collection()
  const gone = Bun.spawn([process.execPath, '-e', ''])
  await gone.exited
  await plant(root, { pid: gone.pid })
  await abandonedClaim(root)
  const bPaused = gate()
  const bGo = gate()
  let b: Promise<Awaited<ReturnType<typeof acquireOwnerLock>>> | undefined
  let bToken: string | undefined
  let c: (() => Promise<void>) | null | undefined
  let claimsAtPath: string[] = []
  // A judges the abandoned claim; B then takes it over, removes the stale lock and stops before
  // writing its own, still holding its claim. A moves B's claim aside; C claims the empty path; B
  // then writes its lock and finishes; A finds its put-back refused.
  const refused = await caught(acquireOwnerLock(root, {
    kind: 'app',
    afterClaimJudged: async () => {
      b = acquireOwnerLock(root, { kind: 'command-line', beforeRecoveryWrite: async () => { bPaused.open(); await bGo.promise } })
      await bPaused.promise
      bToken = (await claimAt(claimPath(root))).token
    },
    afterClaimMovedAside: async () => {
      c = await takeRecoveryClaim(ownerLockPath(root), resolveOwnerLockEnv({}))
      bGo.open()
      await b
      claimsAtPath = [(await claimAt(claimPath(root))).token]
    },
  }))
  const bLock = await b!
  expect(refused).toBeInstanceOf(OwnerLockBusyError)
  expect((refused as OwnerLockBusyError).owner).toEqual(bLock.record)
  expect(c).toBeInstanceOf(Function)
  // Exactly one lock, B's; one claim at the claim's path, C's; B's claim kept aside, not removed.
  expect(await onDisk(root)).toEqual(bLock.record)
  expect(claimsAtPath).toHaveLength(1)
  expect(claimsAtPath[0]).not.toBe(bToken!)
  const left = await asides(root)
  expect(left).toHaveLength(1)
  expect((await claimAt(join(root, '.writeflex', left[0]))).token).toBe(bToken!)
  await c!()
  await releaseOwnerLock(bLock)
  expect(await lockFiles(root)).toEqual(left)
})

test('a planted record naming this process with its true start time: held while its heartbeat is ten minutes old, recoverable once it is 25 hours old', async () => {
  const processStartedAt = await ownStartTime()
  const root = await collection()
  const fresh = await plant(root, { processStartedAt, heartbeatAt: Date.now() - 10 * 60_000 })
  expect(await inspectOwnerLock(root)).toEqual({ state: 'held', owner: fresh, conflictCopies: [] })
  const refused = await caught(acquireOwnerLock(root, { kind: 'command-line' }))
  expect(refused).toBeInstanceOf(OwnerLockBusyError)
  expect(await onDisk(root)).toEqual(fresh)

  const ancient = await plant(root, { processStartedAt, heartbeatAt: Date.now() - 25 * 3_600_000 })
  expect(await inspectOwnerLock(root)).toEqual({ state: 'recoverable', owner: ancient, reason: 'heartbeat-expired', conflictCopies: [] })
  const lock = await acquireOwnerLock(root, { kind: 'command-line' })
  expect(lock.recovered).toEqual({ reason: 'heartbeat-expired', previous: ancient })
  await releaseOwnerLock(lock)
})

test('the busy error names the holder\'s process number and kind in plain words', () => {
  const record: OwnerLockRecord = { version: 1, pid: 4242, kind: 'app', host: 'Studio', startedAt: 0, heartbeatAt: 0, processStartedAt: null, token: 't' }
  expect(new OwnerLockBusyError('/c', record, 0).message).toBe('The Collection at /c is held by another WriteFlex window (process number 4242) on Studio.')
  expect(new OwnerLockBusyError('/c', { ...record, kind: 'command-line' }, 0).message).toBe('The Collection at /c is held by the writeflex command (process number 4242) on Studio.')
  expect(new OwnerLockBusyError('/c', { ...record, kind: 'something-else' as never }, 0).message).toBe('The Collection at /c is held by a program with process number 4242 on Studio.')
  expect(new OwnerLockBusyError('/c', null, 0).message).toBe('The Collection at /c is held by another program (its owner record cannot be read yet).')
})

test('acquisition lists at most the shared limit of .writeflex entries for conflict copies, and says when the listing was cut', async () => {
  const root = await collection()
  const dir = join(root, '.writeflex')
  const names = Array.from({ length: 10_000 }, (_, index) => `owner-copy-${index}.lock`)
  for (let from = 0; from < names.length; from += 250) await Promise.all(names.slice(from, from + 250).map((name) => writeFile(join(dir, name), '{}')))
  const events: OwnerLockEvent[] = []
  const lock = await acquireOwnerLock(root, { kind: 'app', log: (event) => events.push(event) })
  expect(lock.conflictCopies.length).toBeLessThanOrEqual(MAX_ENTRIES_LISTED)
  expect(lock.conflictCopies.length).toBeGreaterThanOrEqual(MAX_ENTRIES_LISTED - 1) // owner.lock itself may be among those listed
  expect(events.filter((event) => event.event === 'owner-lock.listing-cut')).toEqual([{ event: 'owner-lock.listing-cut', root, limit: MAX_ENTRIES_LISTED }])
  const inspected = await inspectOwnerLock(root)
  expect(inspected.conflictCopies.length).toBeLessThanOrEqual(MAX_ENTRIES_LISTED)
  await releaseOwnerLock(lock)
}, 30_000)

/** A stand-in for `ps` that ignores SIGTERM and never answers; it says it is running by writing its process id to `ready`. */
function deafProcessTable(ready: string): ProcessTableSeams {
  const script = `process.on('SIGTERM', () => {}); const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(`${ready}.part`)}, String(process.pid)); fs.renameSync(${JSON.stringify(`${ready}.part`)}, ${JSON.stringify(ready)}); setInterval(() => {}, 1000)`
  return {
    command: process.execPath,
    args: ['-e', script],
    // The wait is over as soon as the stand-in is up and deaf: a handshake, not a margin.
    expired: async () => { while (!existsSync(ready)) await tick() },
  }
}

test('the wait for a process start time is bounded whatever ps does: a ps that ignores SIGTERM is killed and the answer is "unknown"', async () => {
  const dir = await folder('wf-owner-lock-ps-')
  const ready = join(dir, 'ready')
  expect(await readProcessStartTime(process.pid, deafProcessTable(ready))).toBeNull()
  const standIn = Number(readFileSync(ready, 'utf8'))
  expect(standIn).toBeGreaterThan(1)
  while (pidRuns(standIn)) await tick() // killed, not left running

  // "Did not answer in time" is judged exactly as "unknown": by the heartbeat.
  const started = await ownStartTime()
  const root = await collection()
  let asked = 0
  const env = { processStartedAt: (pid: number) => readProcessStartTime(pid, deafProcessTable(join(dir, `ready-${++asked}`))) }
  await plant(root, { processStartedAt: started })
  expect((await inspectOwnerLock(root, env)).state).toBe('held')
  await plant(root, { processStartedAt: started, heartbeatAt: Date.now() - OWNER_LOCK_STALE_MS - 1_000 })
  expect(await inspectOwnerLock(root, env)).toMatchObject({ state: 'recoverable', reason: 'heartbeat-expired' })
  expect(asked).toBe(2)
}, 30_000)

test('ps itself still answers: this process has a start time, a process that is not running has none', async () => {
  expect(Math.abs((await ownStartTime()) - Date.now())).toBeLessThan(7 * 24 * 3_600_000)
  const gone = Bun.spawn([process.execPath, '-e', ''])
  await gone.exited
  expect(await readProcessStartTime(gone.pid)).toBeNull()
  expect(await readProcessStartTime(process.pid, { command: join(tmpdir(), 'no-such-ps-here') })).toBeNull()
}, 20_000)
