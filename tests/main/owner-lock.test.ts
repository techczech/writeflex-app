import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireOwnerLock, inspectOwnerLock, refreshOwnerLock, releaseOwnerLock, withOwnerLock,
  ownerLockPath, OwnerLockBusyError, OwnerLockContendedError, OWNER_LOCK_HEARTBEAT_MS, OWNER_LOCK_STALE_MS,
  type OwnerLockEvent, type OwnerLockRecord,
} from '../../src/main/owner-lock'
import { isIgnoredWorkspaceWatchPath } from '../../src/main/workspace-watcher'
import { crashedOwner, lockChild, raceFor } from '../helpers/owner-lock-child'

const roots: string[] = []
async function collection(withMarker = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wf-owner-lock-'))
  roots.push(root)
  if (withMarker) await mkdir(join(root, '.writeflex'))
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const onDisk = async (root: string): Promise<OwnerLockRecord> => JSON.parse(await readFile(ownerLockPath(root), 'utf8')) as OwnerLockRecord
const lockFiles = async (root: string): Promise<string[]> => (await readdir(join(root, '.writeflex'))).sort()
async function plant(root: string, overrides: Partial<OwnerLockRecord>): Promise<OwnerLockRecord> {
  const record: OwnerLockRecord = {
    version: 1, pid: process.pid, kind: 'app', host: hostname(), startedAt: Date.now(), heartbeatAt: Date.now(), processStartedAt: null, token: 'planted', ...overrides,
  }
  await writeFile(ownerLockPath(root), JSON.stringify(record))
  return record
}
/** A process id that is certainly not running: a child that has already exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, '-e', ''])
  await child.exited
  return child.pid
}

test('the stated bounds: a heartbeat every 20 seconds, recoverable after 2 minutes without one', () => {
  expect(OWNER_LOCK_HEARTBEAT_MS).toBe(20_000)
  expect(OWNER_LOCK_STALE_MS).toBe(120_000)
  expect(OWNER_LOCK_STALE_MS / OWNER_LOCK_HEARTBEAT_MS).toBeGreaterThanOrEqual(6)
})

test('the lock records process id, kind, host, both timestamps and a random token', async () => {
  const root = await collection()
  const before = Date.now()
  const lock = await acquireOwnerLock(root, { kind: 'command-line' })
  const record = await onDisk(root)
  expect(record).toEqual(lock.record)
  expect(record.pid).toBe(process.pid)
  expect(record.kind).toBe('command-line')
  expect(record.host).toBe(hostname())
  expect(record.startedAt).toBeGreaterThanOrEqual(before)
  expect(record.heartbeatAt).toBe(record.startedAt)
  expect(record.token).toMatch(/^[0-9a-f-]{36}$/)
  const second = await collection()
  const other = await acquireOwnerLock(second, { kind: 'app' })
  expect(other.record.token).not.toBe(record.token)
  expect(await inspectOwnerLock(root)).toEqual({ state: 'held', owner: record, conflictCopies: [] })
  await releaseOwnerLock(lock)
  await releaseOwnerLock(other)
  expect(await inspectOwnerLock(root)).toEqual({ state: 'free', conflictCopies: [] })
})

test('two real processes racing for a free Collection: exactly one acquires, every round', async () => {
  for (let round = 0; round < 8; round++) {
    const root = await collection(round % 2 === 0)
    expect(await raceFor(root, 4)).toEqual(['acquired', 'busy', 'busy', 'busy'])
    expect(existsSync(ownerLockPath(root))).toBe(false)
  }
}, 60_000)

test('a second process is refused while the first holds, is told who holds it, and gets it after a wait', async () => {
  const root = await collection()
  // The holder keeps the lock until the test lets it go, not for a fixed time.
  const until = join(root, 'holder-may-release')
  const holder = lockChild('hold', root, 0, until)
  await holder.said('held')
  const status = await inspectOwnerLock(root)
  expect(status.state).toBe('held')
  expect(status.state === 'held' && status.owner).toMatchObject({ pid: holder.pid, kind: 'command-line', host: hostname() })

  const refused = await acquireOwnerLock(root, { kind: 'app' }).catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(OwnerLockBusyError)
  expect((refused as OwnerLockBusyError).owner?.pid).toBe(holder.pid)

  // Waiting: the holder is let go only once this acquisition has met its live lock (it asks whether
  // the holder's process is there), so the wait is certain and its length does not matter.
  let judged = 0
  const lock = await acquireOwnerLock(root, { kind: 'app', waitMs: 600_000, pidIsAlive: (pid) => {
    if (pid === holder.pid && judged++ === 0) void writeFile(until, '')
    try { process.kill(pid, 0); return true } catch { return false }
  } })
  expect(judged).toBeGreaterThan(0)
  expect(lock.recovered).toBeNull()
  expect((await holder.finished).lines).toEqual(['held', 'released'])
  expect((await onDisk(root)).pid).toBe(process.pid)
  await releaseOwnerLock(lock)
}, 20_000)

test('a lock left by a killed process is recoverable, the takeover is logged, and nothing else is left behind', async () => {
  const root = await collection()
  const pid = await crashedOwner(root)
  const left = await onDisk(root)
  expect(left.pid).toBe(pid)
  expect(await inspectOwnerLock(root)).toEqual({ state: 'recoverable', owner: left, reason: 'process-gone', conflictCopies: [] })

  const events: OwnerLockEvent[] = []
  const lock = await acquireOwnerLock(root, { kind: 'app', log: (event) => events.push(event) })
  expect(lock.recovered).toEqual({ reason: 'process-gone', previous: left })
  expect(events).toEqual([{ event: 'owner-lock.recovered', root, reason: 'process-gone', previous: left, by: lock.record }])
  expect(await onDisk(root)).toEqual(lock.record)
  expect(await lockFiles(root)).toEqual(['owner.lock'])
  await releaseOwnerLock(lock)
}, 20_000)

test('several processes recovering the same abandoned lock: exactly one takes it', async () => {
  for (let round = 0; round < 5; round++) {
    const root = await collection()
    await crashedOwner(root)
    const lines = await raceFor(root, 4)
    // Exactly one holder, every round. It is normally the racer that removed the abandoned lock; a
    // racer whose first attempt lands in the instant between that removal and the remover's own
    // write takes a free Collection instead, and the remover is then refused like the rest.
    expect(lines.filter((line) => line.startsWith('acquired'))).toHaveLength(1)
    expect(lines.filter((line) => line === 'busy')).toHaveLength(3)
    expect(await lockFiles(root)).toEqual([])
  }
}, 60_000)

const TEN_MINUTES_ON = { now: () => Date.now() + 10 * 60_000 }
/** This process's start time as the lock records it. */
async function ownStartTime(): Promise<number> {
  const lock = await acquireOwnerLock(await collection(), { kind: 'command-line' })
  await releaseOwnerLock(lock)
  expect(typeof lock.record.processStartedAt).toBe('number')
  return lock.record.processStartedAt as number
}

test('two processes: an owner that stops heartbeating but stays alive keeps its lock; killed outright, it loses it', async () => {
  const root = await collection()
  // `hang` takes the lock and never writes another heartbeat, as an app does while the machine sleeps.
  const child = lockChild('hang', root)
  let held: OwnerLockRecord
  try {
    await child.said('held')
    held = await onDisk(root)
    expect(held.pid).toBe(child.pid)
    // Ten minutes later by this process's clock: five times the stale limit, no heartbeat since.
    expect(await inspectOwnerLock(root, TEN_MINUTES_ON)).toEqual({ state: 'held', owner: held, conflictCopies: [] })
    const refused = await acquireOwnerLock(root, { kind: 'command-line', ...TEN_MINUTES_ON }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(OwnerLockBusyError)
    expect(await onDisk(root)).toEqual(held)
  } finally {
    child.process.kill('SIGKILL')
    await child.finished
  }
  expect(await inspectOwnerLock(root, TEN_MINUTES_ON)).toMatchObject({ state: 'recoverable', reason: 'process-gone' })
  const lock = await acquireOwnerLock(root, { kind: 'command-line' })
  expect(lock.recovered).toEqual({ reason: 'process-gone', previous: held })
  await releaseOwnerLock(lock)
}, 20_000)

test('on this host a live process with the recorded start time holds the lock with a heartbeat far past the stale limit (up to a day)', async () => {
  const root = await collection()
  const processStartedAt = await ownStartTime()
  const old = await plant(root, { processStartedAt, heartbeatAt: Date.now() - 50 * OWNER_LOCK_STALE_MS })
  expect(await inspectOwnerLock(root)).toEqual({ state: 'held', owner: old, conflictCopies: [] })
  expect(await acquireOwnerLock(root, { kind: 'command-line' }).catch((error: unknown) => error)).toBeInstanceOf(OwnerLockBusyError)
})

test('a live process id with a different start time is a reused id: the lock is recoverable', async () => {
  const root = await collection()
  const processStartedAt = await ownStartTime()
  // The id is alive (it is this process), but the lock was written by an earlier process that had it.
  const reused = await plant(root, { processStartedAt: processStartedAt - 3_600_000 })
  expect(await inspectOwnerLock(root)).toMatchObject({ state: 'recoverable', reason: 'process-gone' })
  const lock = await acquireOwnerLock(root, { kind: 'command-line' })
  expect(lock.recovered).toEqual({ reason: 'process-gone', previous: reused })
  expect(lock.record.processStartedAt).toBe(processStartedAt)
  await releaseOwnerLock(lock)
})

test('when a start time cannot be read or was not recorded, a live process id is held only while its heartbeat is fresh', async () => {
  const root = await collection()
  const processStartedAt = await ownStartTime()
  const expired = Date.now() - OWNER_LOCK_STALE_MS - 1_000
  // Recorded, but this machine cannot read process start times now.
  await plant(root, { processStartedAt })
  expect((await inspectOwnerLock(root, { processStartedAt: async () => null })).state).toBe('held')
  await plant(root, { processStartedAt, heartbeatAt: expired })
  expect(await inspectOwnerLock(root, { processStartedAt: async () => null })).toMatchObject({ state: 'recoverable', reason: 'heartbeat-expired' })
  // Not recorded (the holder could not read its own).
  await plant(root, { processStartedAt: null })
  expect((await inspectOwnerLock(root)).state).toBe('held')
  await plant(root, { processStartedAt: null, heartbeatAt: expired })
  expect(await inspectOwnerLock(root)).toMatchObject({ state: 'recoverable', reason: 'heartbeat-expired' })
  const { processStartedAt: _omitted, ...withoutStartTime } = await plant(root, {})
  await writeFile(ownerLockPath(root), JSON.stringify(withoutStartTime))
  expect(await inspectOwnerLock(root)).toMatchObject({ state: 'held', owner: { processStartedAt: null } })
  // A holder that cannot read its own start time records null rather than a guess.
  const second = await collection()
  const lock = await acquireOwnerLock(second, { kind: 'app', processStartedAt: async () => null })
  expect((await onDisk(second)).processStartedAt).toBeNull()
  await releaseOwnerLock(lock)
})

test('a lock from another host is never judged by process id, only by heartbeat age', async () => {
  const root = await collection()
  const gone = await deadPid()
  await plant(root, { host: 'some-other-mac', pid: gone })
  expect((await inspectOwnerLock(root)).state).toBe('held')
  expect(await acquireOwnerLock(root, { kind: 'app' }).catch((error: unknown) => error)).toBeInstanceOf(OwnerLockBusyError)

  await plant(root, { host: 'some-other-mac', pid: process.pid, heartbeatAt: Date.now() - OWNER_LOCK_STALE_MS - 1 })
  expect(await inspectOwnerLock(root)).toMatchObject({ state: 'recoverable', reason: 'heartbeat-expired' })

  // The same dead process id on THIS host is recoverable at once.
  await plant(root, { pid: gone })
  expect(await inspectOwnerLock(root)).toMatchObject({ state: 'recoverable', reason: 'process-gone' })
})

test('refresh moves the heartbeat and keeps the token; only the holder can refresh or release', async () => {
  const root = await collection()
  let clock = 1_000_000
  const lock = await acquireOwnerLock(root, { kind: 'app', now: () => clock })
  clock += 20_000
  expect(await refreshOwnerLock(lock)).toBe('refreshed')
  expect(await onDisk(root)).toEqual({ ...lock.record, heartbeatAt: 1_020_000 })

  // Another machine sharing the folder takes over after this holder's heartbeat expired. (On this
  // host a live holder keeps its lock whatever its heartbeat's age.)
  clock += OWNER_LOCK_STALE_MS + 1
  const events: OwnerLockEvent[] = []
  const thief = await acquireOwnerLock(root, { kind: 'command-line', host: 'some-other-mac', now: () => clock, log: (event) => events.push(event) })
  expect(thief.recovered?.reason).toBe('heartbeat-expired')
  expect(await refreshOwnerLock(lock)).toBe('lost')
  await releaseOwnerLock(lock)
  expect(await onDisk(root)).toEqual(thief.record)
  await releaseOwnerLock(thief)
  expect(existsSync(ownerLockPath(root))).toBe(false)
  await releaseOwnerLock(thief) // repeating is harmless
})

test('a lock file that merely disappeared is put back by the holder on refresh; a taken one is lost', async () => {
  const root = await collection()
  const events: OwnerLockEvent[] = []
  const lock = await acquireOwnerLock(root, { kind: 'app', log: (event) => events.push(event) })
  await rm(ownerLockPath(root))
  expect(await refreshOwnerLock(lock)).toBe('refreshed')
  expect((await onDisk(root)).token).toBe(lock.record.token)
  expect(events.map((event) => event.event)).toEqual(['owner-lock.restored'])
  await releaseOwnerLock(lock)
})

test('the lock file is always whole: a reader never sees a partial file through 150 heartbeats, and no temporary file remains', async () => {
  const root = await collection()
  const lock = await acquireOwnerLock(root, { kind: 'app' })
  let reading = true
  let reads = 0
  const partial: string[] = []
  const reader = (async () => {
    while (reading) {
      const text = await readFile(ownerLockPath(root), 'utf8').catch(() => 'MISSING')
      reads += 1
      try { if ((JSON.parse(text) as OwnerLockRecord).token !== lock.record.token) partial.push(text) } catch { partial.push(text) }
    }
  })()
  for (let beat = 0; beat < 150; beat++) expect(await refreshOwnerLock(lock)).toBe('refreshed')
  reading = false
  await reader
  expect(reads).toBeGreaterThan(50)
  expect(partial).toEqual([])
  expect(await lockFiles(root)).toEqual(['owner.lock'])
  await releaseOwnerLock(lock)
  expect(await lockFiles(root)).toEqual([])
})

test('sync conflict copies of the lock are ignored and reported, never read as the lock or deleted', async () => {
  const root = await collection()
  const copies = ['owner (conflicted copy).lock', "owner (Ada's conflicted copy 2026-10-07).lock", 'owner-Other.lock']
  for (const name of copies) {
    await writeFile(join(root, '.writeflex', name), JSON.stringify({ version: 1, pid: process.pid, kind: 'app', host: hostname(), startedAt: Date.now(), heartbeatAt: Date.now(), token: 'copy' }))
  }
  await writeFile(join(root, '.writeflex', 'changes.jsonl'), '')
  const sorted = [...copies].sort()
  expect(await inspectOwnerLock(root)).toEqual({ state: 'free', conflictCopies: sorted })

  const events: OwnerLockEvent[] = []
  const lock = await acquireOwnerLock(root, { kind: 'app', log: (event) => events.push(event) })
  expect(lock.conflictCopies).toEqual(sorted)
  expect(events).toEqual([{ event: 'owner-lock.conflict-copies', root, files: sorted }])
  await releaseOwnerLock(lock)
  expect(await lockFiles(root)).toEqual([...sorted, 'changes.jsonl'].sort())
})

test('an unreadable lock file counts as a live owner while new, and is recovered once past the limit', async () => {
  const root = await collection()
  await writeFile(ownerLockPath(root), '')
  expect(await inspectOwnerLock(root)).toEqual({ state: 'held', owner: null, conflictCopies: [] })
  const refused = await acquireOwnerLock(root, { kind: 'app' }).catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(OwnerLockBusyError)
  expect((refused as OwnerLockBusyError).owner).toBeNull()

  const old = new Date(Date.now() - OWNER_LOCK_STALE_MS - 5_000)
  await utimes(ownerLockPath(root), old, old)
  expect(await inspectOwnerLock(root)).toMatchObject({ state: 'recoverable', owner: null, reason: 'unreadable' })
  const lock = await acquireOwnerLock(root, { kind: 'app' })
  expect(lock.recovered).toEqual({ reason: 'unreadable', previous: null })
  await releaseOwnerLock(lock)
})

test('a recovery claim left by a crashed recoverer does not block the next recovery', async () => {
  const root = await collection()
  await plant(root, { pid: await deadPid() })
  await writeFile(`${ownerLockPath(root)}.recover`, JSON.stringify({ pid: await deadPid(), host: hostname(), token: 'x', at: Date.now() }))
  const lock = await acquireOwnerLock(root, { kind: 'app', waitMs: 2_000 })
  expect(lock.recovered?.reason).toBe('process-gone')
  expect(await lockFiles(root)).toEqual(['owner.lock'])
  await releaseOwnerLock(lock)
})

const claimPath = (root: string): string => `${ownerLockPath(root)}.recover`

test('two processes: a recovery claim held by a live process is not taken by age; once that process is gone it is', async () => {
  const root = await collection()
  const stale = await plant(root, { pid: await deadPid() })
  // The claim is ten minutes old, twenty times the old age limit, and its holder is still running.
  const child = lockChild('claim', root, 10 * 60_000)
  try {
    await child.said('claimed')
    const refused = await acquireOwnerLock(root, { kind: 'command-line' }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(OwnerLockBusyError)
    expect(await onDisk(root)).toEqual(stale)
    expect(JSON.parse(await readFile(claimPath(root), 'utf8'))).toMatchObject({ pid: child.pid, token: 'child-claim' })
  } finally {
    child.process.kill('SIGKILL')
    await child.finished
  }
  const lock = await acquireOwnerLock(root, { kind: 'command-line' })
  expect(lock.recovered).toEqual({ reason: 'process-gone', previous: stale })
  expect(await lockFiles(root)).toEqual(['owner.lock'])
  await releaseOwnerLock(lock)
}, 20_000)

test('a recovery claim is judged like the lock: process id and start time on this host; age for another host, an unreadable claim, or one nothing ties to a live process', async () => {
  const processStartedAt = await ownStartTime()
  // One fixed clock for every judgement: a claim stamped "now" is exactly 0 old however long the test takes.
  const NOW = Date.now()
  const old = NOW - 10 * 60_000
  const AT_NOW = { now: () => NOW }
  const TEN_MINUTES_LATER = { now: () => NOW + 10 * 60_000 }
  const attempt = async (claim: unknown, env: { now?: () => number } = AT_NOW): Promise<'recovered' | 'busy'> => {
    const root = await collection()
    await plant(root, { pid: await deadPid() })
    await writeFile(claimPath(root), typeof claim === 'string' ? claim : JSON.stringify(claim))
    try {
      await releaseOwnerLock(await acquireOwnerLock(root, { kind: 'command-line', ...env }))
      return 'recovered'
    } catch (error) {
      if (!(error instanceof OwnerLockBusyError)) throw error
      return 'busy'
    }
  }
  const here = { pid: process.pid, host: hostname(), token: 'x' }
  // This host, alive, same process: held however old.
  expect(await attempt({ ...here, at: old, processStartedAt })).toBe('busy')
  // Alive, start time not recorded: nothing ties the claim to that process, so its age decides.
  expect(await attempt({ ...here, at: NOW })).toBe('busy')
  expect(await attempt({ ...here, at: old })).toBe('recovered')
  // Process 1 is always running and is nobody's recoverer.
  expect(await attempt({ ...here, pid: 1, at: NOW })).toBe('busy')
  expect(await attempt({ ...here, pid: 1, at: old })).toBe('recovered')
  // The id was reused by another program: the claimant is gone.
  expect(await attempt({ ...here, at: NOW, processStartedAt: processStartedAt - 3_600_000 })).toBe('recovered')
  // Another host: only age can be judged.
  expect(await attempt({ ...here, host: 'some-other-mac', at: NOW })).toBe('busy')
  expect(await attempt({ ...here, host: 'some-other-mac', at: old })).toBe('recovered')
  // A time far in the future is not believed: the age of the file decides.
  const farFuture = NOW + 365 * 24 * 3_600_000
  expect(await attempt({ ...here, host: 'some-other-mac', at: farFuture })).toBe('busy')
  expect(await attempt({ ...here, host: 'some-other-mac', at: farFuture }, TEN_MINUTES_LATER)).toBe('recovered')
  // Unreadable: age of the file, so a fresh one holds and one seen much later does not.
  expect(await attempt('not json')).toBe('busy')
  expect(await attempt('not json', TEN_MINUTES_LATER)).toBe('recovered')
}, 30_000)

test('a recoverer that loses the freed path to a third process logs the recovery and who holds the Collection now', async () => {
  const root = await collection()
  const stale = await plant(root, { pid: await deadPid() })
  const events: OwnerLockEvent[] = []
  let third: Awaited<ReturnType<typeof acquireOwnerLock>> | null = null
  // The seam runs in the instant after the stale lock is removed and before the recoverer writes its own.
  const refused = await acquireOwnerLock(root, {
    kind: 'command-line', log: (event) => events.push(event),
    beforeRecoveryWrite: async () => { third = await acquireOwnerLock(root, { kind: 'app' }) },
  }).catch((error: unknown) => error)
  expect(third!.recovered).toBeNull() // the third process saw a free Collection and logs nothing itself
  expect(refused).toBeInstanceOf(OwnerLockBusyError)
  expect((refused as OwnerLockBusyError).owner).toEqual(third!.record)
  expect(events).toEqual([{ event: 'owner-lock.recovered-for-other', root, reason: 'process-gone', previous: stale, heldBy: third!.record }])
  expect(await onDisk(root)).toEqual(third!.record)
  expect(await lockFiles(root)).toEqual(['owner.lock'])
  await releaseOwnerLock(third!)
})

test('a holder that cannot get the recovery claim does not report its own lock lost', async () => {
  const root = await collection()
  let clock = Date.now()
  const events: OwnerLockEvent[] = []
  const lock = await acquireOwnerLock(root, { kind: 'app', now: () => clock, log: (event) => events.push(event) })
  // Past half the stale limit (as after sleep), the holder must take the claim before it rewrites;
  // a live recoverer is holding it.
  clock += OWNER_LOCK_STALE_MS
  await writeFile(claimPath(root), JSON.stringify({ pid: process.pid, host: hostname(), token: 'someone-else', at: Date.now(), processStartedAt: await ownStartTime() }))
  expect(await refreshOwnerLock(lock).catch((error: unknown) => error)).toBeInstanceOf(OwnerLockContendedError)
  expect(events).toEqual([])
  expect((await onDisk(root)).token).toBe(lock.record.token)
  await releaseOwnerLock(lock) // cannot be given up either, and says nothing
  expect((await onDisk(root)).token).toBe(lock.record.token)
  await rm(claimPath(root))
  expect(await refreshOwnerLock(lock)).toBe('refreshed')
  await releaseOwnerLock(lock)
  expect(existsSync(ownerLockPath(root))).toBe(false)
}, 20_000)

test('withOwnerLock holds for the operation and releases when it throws', async () => {
  const root = await collection()
  const value = await withOwnerLock(root, { kind: 'command-line' }, async (lock) => {
    expect((await inspectOwnerLock(root)).state).toBe('held')
    expect((await onDisk(root)).token).toBe(lock.record.token)
    return 7
  })
  expect(value).toBe(7)
  expect((await inspectOwnerLock(root)).state).toBe('free')
  await expect(withOwnerLock(root, { kind: 'command-line' }, async () => { throw new Error('operation failed') })).rejects.toThrow('operation failed')
  expect((await inspectOwnerLock(root)).state).toBe('free')
})

test('a folder with no .writeflex gets none left behind; an existing one is kept; a missing root is an error', async () => {
  const bare = await collection(false)
  const lock = await acquireOwnerLock(bare, { kind: 'app' })
  expect(existsSync(ownerLockPath(bare))).toBe(true)
  await releaseOwnerLock(lock)
  expect(existsSync(join(bare, '.writeflex'))).toBe(false)

  const marked = await collection()
  await releaseOwnerLock(await acquireOwnerLock(marked, { kind: 'app' }))
  expect(existsSync(join(marked, '.writeflex'))).toBe(true)

  const missing = join(bare, 'not-there')
  await expect(acquireOwnerLock(missing, { kind: 'app' })).rejects.toMatchObject({ code: 'ENOENT' })
  expect(existsSync(missing)).toBe(false)
})

test('the workspace watcher ignores the lock, its temporary files and conflict copies, so heartbeats cause no reloads', () => {
  for (const path of ['.writeflex/owner.lock', '.writeflex/owner.lock.123.abc.tmp', '.writeflex/owner.lock.recover', '.writeflex/owner (conflicted copy).lock']) {
    expect(isIgnoredWorkspaceWatchPath(path)).toBe(true)
  }
})
