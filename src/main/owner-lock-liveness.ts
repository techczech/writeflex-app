/**
 * Who a lock record names and whether that owner is still there: the owner lock's record, its
 * surroundings (clock, host, process table) and the liveness judgement. Split from owner-lock.ts,
 * which owns the file discipline. No Electron import.
 *
 * The judgement, for a record on THIS host:
 * - process gone                                   -> recoverable
 * - heartbeat older than 24 hours (`OWNER_LOCK_HEARTBEAT_HARD_LIMIT_MS`) -> recoverable, whatever
 *   process the record names, asked before the process table is. A record anyone can plant may name
 *   a long-lived program of this user's with its true start time; this bounds how long it can hold.
 *   A genuine WriteFlex asleep for more than a day loses the lock and, on waking, pauses as `lost`.
 * - process alive, start time matches the record   -> held while the heartbeat is under 24 hours old.
 *   A running app whose heartbeat is old has been asleep or stalled, not abandoned; taking its lock
 *   would put two writers on documents it holds unsaved.
 * - process alive, start time differs              -> recoverable: the id was reused by another program
 * - nothing ties the record to a process of this user's: no start time recorded, a start time that
 *   cannot be read now (`ps` failed or did not answer in time), a process of another user, or a
 *   process id of 1 or less -> judged by heartbeat age, as a record from another host is. A record
 *   anyone can plant (the lock file lies in a synced folder) is therefore never held for ever.
 * Heartbeat age also decides for a record from another host, where a process id means nothing. A
 * heartbeat more than five minutes in the future says nothing, so that record is judged as a lock
 * file that cannot be read is: by the file's own age. The recovery claim (`owner.lock.recover`) is
 * judged by the same rules, with its own age limit in place of the heartbeat's.
 */
import { spawn } from 'node:child_process'
import { hostname } from 'node:os'

/** A lock whose heartbeat is older than this is recoverable when only its heartbeat can be judged. */
export const OWNER_LOCK_STALE_MS = 120_000
/** A lock whose (believable) heartbeat is older than this is recoverable whatever process it names. */
export const OWNER_LOCK_HEARTBEAT_HARD_LIMIT_MS = 24 * 3_600_000
/** `ps` reports whole seconds; the slack also absorbs a clock step between the two readings. */
const START_TIME_SLACK_MS = 2_000
const PS_TIMEOUT_MS = 2_000
/** A heartbeat (or claim time) further ahead of this clock than this is not a time anyone wrote honestly. */
export const OWNER_LOCK_FUTURE_LIMIT_MS = 5 * 60_000

export type OwnerKind = 'app' | 'command-line'

export type OwnerLockRecord = {
  version: 1
  pid: number
  kind: OwnerKind
  host: string
  startedAt: number
  heartbeatAt: number
  /**
   * When the process `pid` started (epoch ms, from the process table), so a later reader can tell
   * this process from another that was given the same id. Null when the holder could not read it.
   */
  processStartedAt: number | null
  /** Random per acquisition: a holder proves a lock is its own before refreshing or releasing. */
  token: string
}

export type OwnerLockStaleReason = 'process-gone' | 'heartbeat-expired' | 'unreadable'

export type OwnerLockEvent =
  | { event: 'owner-lock.recovered'; root: string; reason: OwnerLockStaleReason; previous: OwnerLockRecord | null; by: OwnerLockRecord }
  /** This process removed the abandoned lock, and another took the freed path before it could write
   *  its own. `heldBy` is that owner (null when its record cannot be read yet). */
  | { event: 'owner-lock.recovered-for-other'; root: string; reason: OwnerLockStaleReason; previous: OwnerLockRecord | null; heldBy: OwnerLockRecord | null }
  | { event: 'owner-lock.conflict-copies'; root: string; files: string[] }
  /** `.writeflex` held more entries than one look lists: conflict copies past `limit` were not seen. */
  | { event: 'owner-lock.listing-cut'; root: string; limit: number }
  | { event: 'owner-lock.restored'; root: string; by: OwnerLockRecord }
  | { event: 'owner-lock.lost'; root: string; token: string }

/** Injectable surroundings; production callers pass `log` only. */
export type OwnerLockEnv = {
  now?: () => number
  pid?: number
  host?: string
  /** Whether process `pid` exists: true when it is this user's, 'other-user' when it exists and is not. */
  pidIsAlive?: (pid: number) => boolean | 'other-user'
  /** Start time of process `pid` in epoch ms, or null when it cannot be read. */
  processStartedAt?: (pid: number) => Promise<number | null>
  staleMs?: number
  log?: (event: OwnerLockEvent) => void
  /** @internal Test seam: runs after a recoverer has removed the stale lock, before it writes its own. */
  beforeRecoveryWrite?: () => Promise<void>
  /** @internal Test seam: runs in a refresh after the holder has read its own record, before it writes the next. */
  beforeHeartbeatWrite?: () => Promise<void>
  /** @internal Test seam: runs after a contender has judged a recovery claim abandoned, before it moves it aside. */
  afterClaimJudged?: () => Promise<void>
  /** @internal Test seam: runs after a contender has moved a recovery claim aside, before it checks what it moved. */
  afterClaimMovedAside?: () => Promise<void>
}

type Seams = 'log' | 'beforeRecoveryWrite' | 'beforeHeartbeatWrite' | 'afterClaimJudged' | 'afterClaimMovedAside'
export type ResolvedOwnerLockEnv = Required<Omit<OwnerLockEnv, Seams>> & Pick<OwnerLockEnv, Seams>

/** When a file was last written, twice over: `mtimeMs` can be set by any program, `ctimeMs` only by the system. */
export type FileTimes = { mtimeMs: number; ctimeMs: number }
/** What was found at the lock's path. */
export type Observed =
  | { kind: 'missing' }
  | ({ kind: 'record'; record: OwnerLockRecord } & FileTimes)
  | ({ kind: 'unreadable'; ino: number } & FileTimes)
export type Judgement = { live: true } | { live: false; reason: OwnerLockStaleReason }

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code

function pidIsAlive(pid: number): boolean | 'other-user' {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (errorCode(error) === 'ESRCH' || errorCode(error) === 'EINVAL') return false
    // EPERM: the process exists and belongs to someone else, so it is no owner this user started.
    return 'other-user'
  }
}

/** @internal Test seam for `readProcessStartTime`: a stand-in for `ps`, and the wait it is given. */
export type ProcessTableSeams = {
  command?: string
  args?: string[]
  /** Resolves when the wait for an answer is over. Default: a timer of two seconds. */
  expired?: () => Promise<void>
}

const MAX_PS_OUTPUT = 256

/**
 * A process's start time from the process table: `ps -o lstart= -p <pid>`, no native module. Run with
 * a fixed locale and UTC so the text parses the same whatever the user's settings are. Null (never a
 * guess) when ps is missing, fails, does not answer in time, has no such process or prints something
 * unparseable; `judge` then goes by the heartbeat.
 *
 * THE WAIT IS BOUNDED WHATEVER `ps` DOES. The answer is raced against this function's own timer.
 * When the timer wins, the child is sent SIGKILL (which it cannot ignore, as it can the SIGTERM a
 * child-process `timeout` sends), nothing of it is listened to any longer, and the result is null at
 * once: the caller never waits for the child to exit.
 */
export function readProcessStartTime(pid: number, seams: ProcessTableSeams = {}): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    let output = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(seams.command ?? '/bin/ps', seams.args ?? ['-o', 'lstart=', '-p', String(pid)], { env: { LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }
    const settle = (value: number | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      child.stdout?.removeAllListeners()
      child.stdout?.destroy()
      child.removeAllListeners()
      child.on('error', () => {}) // a late spawn or kill error must not become an uncaught exception
      resolve(value)
    }
    const giveUp = (): void => {
      if (settled) return
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      child.unref()
      settle(null)
    }
    child.stdout?.on('data', (chunk: Buffer) => { if (output.length < MAX_PS_OUTPUT) output += chunk.toString('utf8') })
    child.on('error', () => settle(null))
    child.on('close', (code) => {
      const text = code === 0 ? output.trim() : ''
      // "Wed Oct  7 09:15:02 2026"
      const parsed = /^\w{3} +\w{3} +\d{1,2} +\d{2}:\d{2}:\d{2} +\d{4}$/.test(text) ? Date.parse(`${text} UTC`) : Number.NaN
      settle(Number.isFinite(parsed) ? parsed : null)
    })
    if (seams.expired) void seams.expired().then(giveUp, giveUp)
    else timer = setTimeout(giveUp, PS_TIMEOUT_MS)
  })
}

/** A process's start time never changes, so this process's own is asked for until it is once known. */
let ownStartTime: Promise<number | null> | null = null
function processStartedAt(pid: number): Promise<number | null> {
  if (pid !== process.pid) return readProcessStartTime(pid)
  if (ownStartTime) return ownStartTime
  const asked = readProcessStartTime(pid)
  ownStartTime = asked
  // An answer that could not be read is not kept: the next caller asks again.
  void asked.then((value) => { if (value === null && ownStartTime === asked) ownStartTime = null })
  return asked
}

export function resolveOwnerLockEnv(env: OwnerLockEnv): ResolvedOwnerLockEnv {
  return {
    now: env.now ?? Date.now,
    pid: env.pid ?? process.pid,
    host: env.host ?? hostname(),
    pidIsAlive: env.pidIsAlive ?? pidIsAlive,
    processStartedAt: env.processStartedAt ?? processStartedAt,
    staleMs: env.staleMs ?? OWNER_LOCK_STALE_MS,
    log: env.log,
    beforeRecoveryWrite: env.beforeRecoveryWrite,
    beforeHeartbeatWrite: env.beforeHeartbeatWrite,
    afterClaimJudged: env.afterClaimJudged,
    afterClaimMovedAside: env.afterClaimMovedAside,
  }
}

export function parseOwnerLockRecord(text: string): OwnerLockRecord | null {
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (v.version !== 1 || !Number.isInteger(v.pid) || (v.kind !== 'app' && v.kind !== 'command-line')) return null
  if (typeof v.host !== 'string' || typeof v.token !== 'string' || v.token.length === 0) return null
  if (typeof v.startedAt !== 'number' || typeof v.heartbeatAt !== 'number') return null
  // Absent or malformed reads as "not recorded": the record is then judged by its heartbeat (see the header).
  const processStartedAt = typeof v.processStartedAt === 'number' && Number.isFinite(v.processStartedAt) ? v.processStartedAt : null
  return { version: 1, pid: v.pid as number, kind: v.kind, host: v.host, startedAt: v.startedAt, heartbeatAt: v.heartbeatAt, processStartedAt, token: v.token }
}

/**
 * How long ago a file at the lock's path was written. The earlier of the two times: a file whose
 * modification time has been set into the future is aged by the time the system last saw it change.
 */
export function fileAge(times: FileTimes, env: ResolvedOwnerLockEnv): number {
  return env.now() - Math.min(times.mtimeMs, times.ctimeMs)
}

/**
 * How long ago `stamp` (a heartbeat, or a claim's time) was written, by the stamp itself; by the
 * file's age when the stamp lies too far in the future to be one. `trusted` says which.
 */
export function stampAge(stamp: number, times: FileTimes, env: ResolvedOwnerLockEnv): { age: number; trusted: boolean } {
  return stamp - env.now() > OWNER_LOCK_FUTURE_LIMIT_MS ? { age: fileAge(times, env), trusted: false } : { age: env.now() - stamp, trusted: true }
}

/** Whether the owner that `observed` names is still there. The rule is in this file's header. */
export async function judge(observed: Exclude<Observed, { kind: 'missing' }>, env: ResolvedOwnerLockEnv): Promise<Judgement> {
  if (observed.kind === 'unreadable') {
    // A file a sync client is still materialising reads as empty; give it the full limit.
    return fileAge(observed, env) > env.staleMs ? { live: false, reason: 'unreadable' } : { live: true }
  }
  const { record } = observed
  const heartbeat = stampAge(record.heartbeatAt, observed, env)
  const byHeartbeat = (): Judgement => heartbeat.age > env.staleMs ? { live: false, reason: heartbeat.trusted ? 'heartbeat-expired' : 'unreadable' } : { live: true }
  if (!heartbeat.trusted || record.host.toLowerCase() !== env.host.toLowerCase()) return byHeartbeat()
  // Before the process table is asked: a day without a heartbeat is not a live owner, whoever it names.
  if (heartbeat.age > OWNER_LOCK_HEARTBEAT_HARD_LIMIT_MS) return { live: false, reason: 'heartbeat-expired' }
  const owner = await localProcess(record.pid, record.processStartedAt, env)
  return owner === 'there' ? { live: true } : owner === 'gone' ? { live: false, reason: 'process-gone' } : byHeartbeat()
}

/**
 * Whether process `pid` ON THIS HOST is the one that recorded `recordedStart`: `there` when it is
 * alive, this user's, and started when the record says; `gone` when no such process runs or the id
 * now belongs to a process started at another time; `unknown` when neither can be shown (no start
 * time recorded or readable now, another user's process, an id of 1 or less). The caller judges
 * `unknown` by age.
 */
export async function localProcess(pid: number, recordedStart: number | null, env: ResolvedOwnerLockEnv): Promise<'there' | 'gone' | 'unknown'> {
  if (!Number.isInteger(pid) || pid <= 1) return 'unknown'
  const alive = env.pidIsAlive(pid)
  if (alive === false) return 'gone'
  if (alive !== true || recordedStart === null) return 'unknown'
  const actual = await env.processStartedAt(pid)
  if (actual === null) return 'unknown'
  return Math.abs(actual - recordedStart) <= START_TIME_SLACK_MS ? 'there' : 'gone'
}
