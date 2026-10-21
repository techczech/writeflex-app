/**
 * One owner per Collection (command-line specification, section 4): `.writeflex/owner.lock` names the
 * single process allowed to write the Collection's documents and stores. The app holds it while a
 * window is open on the Collection; the command line holds it for one operation.
 *
 * No Electron import: the command line loads this module in Node mode. Whether an owner is still
 * there is judged in owner-lock-liveness.ts; this file owns the lock file itself.
 *
 * File discipline, because Collections live in synced folders (a cloud-sync service):
 * - The lock file never exists half-written. A new lock is written whole to a temporary name and
 *   hard-linked to `owner.lock` (the link fails if a lock exists, which is what makes two takers
 *   exclusive); a heartbeat is written whole to a temporary name and renamed over it. Nothing is
 *   truncated or appended in place.
 * - `.writeflex` is used only while it is an ordinary folder at its own place (`privateFolder`): a
 *   link or a file standing there is refused before every lock operation, reads included, so nothing
 *   of the lock's is read or written through it. The check and the call after it name the folder by
 *   path, so a swap made between the two is not seen (Node cannot act relative to an open folder).
 * - A stale lock is removed only by the process holding `owner.lock.recover`, and only after moving
 *   it aside and confirming the moved file is the one judged stale. An abandoned recovery claim is
 *   replaced the same way: moved aside, confirmed to be the claim judged abandoned, then removed.
 *   Anything moved aside that is NOT the file judged is put back if it can be, and otherwise left
 *   where it was moved (`owner.lock.stale.<id>`, `owner.lock.recover.stale.<id>`): never removed.
 * - One holder's refreshes and its release run one at a time, in call order. A release therefore
 *   waits for a refresh already in flight, and a refresh that starts after the release does nothing.
 * - Sync conflict copies (`owner (conflicted copy).lock`, `owner-Other.lock`) are never read as the
 *   lock and never deleted; they are reported. Looking for them lists at most `MAX_ENTRIES_LISTED`
 *   entries of `.writeflex`, whatever it holds, and logs `owner-lock.listing-cut` when there were more.
 */
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { FolderNotUsableError, entriesUpTo, privateFolder } from './cli/request-files'
import { MAX_ENTRIES_LISTED } from './cli/review-format'
import {
  fileAge, judge, localProcess, parseOwnerLockRecord, resolveOwnerLockEnv, stampAge, OWNER_LOCK_STALE_MS,
  type FileTimes, type Observed, type OwnerKind, type OwnerLockEnv, type OwnerLockRecord, type OwnerLockStaleReason, type ResolvedOwnerLockEnv,
} from './owner-lock-liveness'

/** Thrown by every lock operation when `.writeflex` is a link or a file, or lies outside the Collection. */
export { FolderNotUsableError as OwnerLockFolderError }

export { OWNER_LOCK_HEARTBEAT_HARD_LIMIT_MS, OWNER_LOCK_STALE_MS } from './owner-lock-liveness'
export type { OwnerKind, OwnerLockEnv, OwnerLockEvent, OwnerLockRecord, OwnerLockStaleReason } from './owner-lock-liveness'

export const OWNER_LOCK_DIR = '.writeflex'
export const OWNER_LOCK_FILE = 'owner.lock'
/** How often a holder rewrites its heartbeat. */
export const OWNER_LOCK_HEARTBEAT_MS = 20_000

const POLL_MS = 100
/** Recovery takes milliseconds; a recovery claim older than this was left by a crash. */
const RECOVERY_CLAIM_STALE_MS = 30_000
const MAX_LOCK_BYTES = 4096
const MISSING_DIR_RETRIES = 5

export type OwnerLockStatus =
  /** Nobody holds the Collection. */
  | { state: 'free'; conflictCopies: string[] }
  /** A live owner. `owner` is null when the file is too new to judge and cannot be read yet. */
  | { state: 'held'; owner: OwnerLockRecord | null; conflictCopies: string[] }
  /** Left behind: the next `acquireOwnerLock` takes it over. */
  | { state: 'recoverable'; owner: OwnerLockRecord | null; reason: OwnerLockStaleReason; conflictCopies: string[] }

export type OwnerLock = {
  readonly root: string
  readonly record: OwnerLockRecord
  /** Set when this acquisition took over a lock left behind. */
  readonly recovered: { reason: OwnerLockStaleReason; previous: OwnerLockRecord | null } | null
  /** Sync conflict copies of the lock file seen at acquisition (ignored, reported). */
  readonly conflictCopies: string[]
  /** @internal */ readonly env: ResolvedOwnerLockEnv
  /** @internal */ readonly createdDir: boolean
}

export type AcquireOptions = OwnerLockEnv & {
  kind: OwnerKind
  /** How long to wait for a live owner to release. Default 0: fail at once. */
  waitMs?: number
}

/**
 * A holder whose heartbeat is old must take the recovery claim before it rewrites its lock, and a
 * live recoverer held the claim throughout. Nothing was lost: the lock on disk is still the holder's.
 */
export class OwnerLockContendedError extends Error {
  constructor(readonly root: string) {
    super(`The owner lock for ${root} could not be rewritten: another process is holding its recovery claim.`)
    this.name = 'OwnerLockContendedError'
  }
}

/**
 * Who a lock record names, in plain words with its process number, so the writer can find it:
 * "another WriteFlex window (process number 4242)", "the writeflex command (process number 4242)",
 * or "a program with process number 4242" for a kind this build does not know. What the record says
 * is a claim: a planted record can name any process (owner-lock-liveness.ts).
 */
export function ownerInPlainWords(owner: Pick<OwnerLockRecord, 'kind' | 'pid'>): string {
  const kind = owner.kind as string
  return kind === 'app' ? `another WriteFlex window (process number ${owner.pid})`
    : kind === 'command-line' ? `the writeflex command (process number ${owner.pid})`
      : `a program with process number ${owner.pid}`
}

export class OwnerLockBusyError extends Error {
  constructor(readonly root: string, readonly owner: OwnerLockRecord | null, readonly waitedMs: number) {
    super(owner
      ? `The Collection at ${root} is held by ${ownerInPlainWords(owner)} on ${owner.host}.`
      : `The Collection at ${root} is held by another program (its owner record cannot be read yet).`)
    this.name = 'OwnerLockBusyError'
  }
}

type Env = ResolvedOwnerLockEnv

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

export function ownerLockPath(root: string): string {
  return join(root, OWNER_LOCK_DIR, OWNER_LOCK_FILE)
}

/**
 * `.writeflex` as the lock may use it: an ordinary folder whose real location is inside the
 * Collection. Throws `OwnerLockFolderError` for anything else standing there. With `create`, a
 * missing folder is made (not recursively: a root that does not exist is an error, never something
 * to create) and then judged like one that was there.
 */
async function lockFolder(root: string, create: boolean): Promise<{ exists: boolean; created: boolean }> {
  if (await privateFolder(root, OWNER_LOCK_DIR, false)) return { exists: true, created: false }
  if (!create) return { exists: false, created: false }
  let created = false
  try { await mkdir(join(root, OWNER_LOCK_DIR)); created = true } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error
  }
  return { exists: (await privateFolder(root, OWNER_LOCK_DIR, false)) !== null, created }
}

async function observe(path: string): Promise<Observed> {
  try {
    const stat = await lstat(path)
    const times: FileTimes = { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
    const unreadable: Observed = { kind: 'unreadable', ino: stat.ino, ...times }
    if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return unreadable
    const record = parseOwnerLockRecord(await readFile(path, 'utf8'))
    return record ? { kind: 'record', record, ...times } : unreadable
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' }
    throw error
  }
}

function sameObservation(a: Observed, b: Observed): boolean {
  if (a.kind === 'record' && b.kind === 'record') return a.record.token === b.record.token && a.record.heartbeatAt === b.record.heartbeatAt
  if (a.kind === 'unreadable' && b.kind === 'unreadable') return a.ino === b.ino && a.mtimeMs === b.mtimeMs
  return false
}

async function writeWhole(path: string, text: string): Promise<void> {
  const handle = await open(path, 'wx')
  try { await handle.writeFile(text, 'utf8') } finally { await handle.close() }
}

const temporaryName = (path: string, env: Env): string => `${path}.${env.pid}.${randomUUID()}.tmp`

/** Create `path` holding `text` only if nothing is there. The file appears complete or not at all. */
async function createExclusive(path: string, text: string, env: Env): Promise<boolean> {
  const temporary = temporaryName(path, env)
  await writeWhole(temporary, text)
  try {
    await link(temporary, path)
    return true
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EEXIST') return false
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(code ?? '')) throw error
    // A volume without hard links: exclusive create, then one write. Readers treat the moment the
    // file is empty as a live owner (see judge), so exclusivity holds.
    try {
      await writeWhole(path, text)
      return true
    } catch (fallbackError) {
      if (errorCode(fallbackError) === 'EEXIST') return false
      throw fallbackError
    }
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

async function replaceWhole(path: string, text: string, env: Env): Promise<void> {
  const temporary = temporaryName(path, env)
  await writeWhole(temporary, text)
  try {
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

type Claim = { pid: number; host: string; token: string; at: number; processStartedAt: number | null }

/** A claim file's holder, when the file says enough to judge one; null for anything else. */
function parseClaim(text: string): Claim | null {
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!Number.isInteger(v.pid) || typeof v.host !== 'string' || typeof v.token !== 'string' || typeof v.at !== 'number') return null
  const processStartedAt = typeof v.processStartedAt === 'number' && Number.isFinite(v.processStartedAt) ? v.processStartedAt : null
  return { pid: v.pid as number, host: v.host, token: v.token, at: v.at, processStartedAt }
}

/** A claim file as found: what it says (null when it cannot be read as text) and which file it is. */
type ClaimSeen = { text: string | null; ino: number } & FileTimes

async function seeClaim(path: string): Promise<ClaimSeen | null> {
  try {
    const stat = await lstat(path)
    const text = stat.isFile() && stat.size <= MAX_LOCK_BYTES ? await readFile(path, 'utf8').catch(() => null) : null
    return { text, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
  } catch {
    return null
  }
}

/** The same file with the same words. Not `ctimeMs`: moving a file changes it. */
const sameClaim = (a: ClaimSeen, b: ClaimSeen): boolean => a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.text === b.text

/**
 * The recovery claim serialises everyone who wants to remove or rewrite a lock that looks stale. A
 * claim already there is taken over only when its holder is gone, judged as the lock itself is
 * (owner-lock-liveness.ts): on this host by process id and start time, so a live recoverer that has
 * stalled mid-recovery is not walked over; by age for a claim from another host, one that cannot be
 * read, or one that nothing ties to a process of this user's.
 *
 * An abandoned claim is never unlinked where it stands: between judging it and removing it another
 * contender may have replaced it with its own live claim. It is moved aside, and removed only when
 * the file that moved is the one that was judged; anything else is put back and this contender
 * stands down.
 *
 * THE PUT-BACK CAN FAIL, AND THEN THE ASIDE IS LEFT ON DISK, NEVER UNLINKED. While a live claim is
 * aside, a third contender can create its own at the claim's path, and the put-back (a hard link,
 * which never replaces) is refused. The claim that was aside belongs to a contender that is still
 * recovering; removing it would delete another process's live claim. Left aside as
 * `owner.lock.recover.stale.<id>`, it means nothing to the next contender: every contender reads and
 * judges only `owner.lock.recover`, so the left-behind file neither blocks nor grants a recovery. Its
 * owner's release finds another token at the claim's path and removes nothing; the file stays as
 * litter. Both its owner and the third contender then believe they hold a claim, and both may go on
 * to recover; `recoverStale`'s own move-aside, identity check and exclusive create still let at most
 * one of them write `owner.lock`.
 *
 * @internal Exported for the claim-race tests only.
 */
export async function takeRecoveryClaim(lockPath: string, env: Env): Promise<(() => Promise<void>) | null> {
  const claimPath = `${lockPath}.recover`
  const claim: Claim = { pid: env.pid, host: env.host, token: randomUUID(), at: env.now(), processStartedAt: await env.processStartedAt(env.pid) }
  const release = async (): Promise<void> => {
    const now = await seeClaim(claimPath)
    if (now?.text != null && parseClaim(now.text)?.token === claim.token) await unlink(claimPath).catch(() => {})
  }
  if (await createExclusive(claimPath, JSON.stringify(claim), env)) return release
  const seen = await seeClaim(claimPath)
  if (!seen) return null // released meanwhile; the caller polls again
  const current = seen.text === null ? null : parseClaim(seen.text)
  const byAge = (): boolean => (current ? stampAge(current.at, seen, env).age : fileAge(seen, env)) > RECOVERY_CLAIM_STALE_MS
  let abandoned: boolean
  if (!current || current.host.toLowerCase() !== env.host.toLowerCase()) abandoned = byAge()
  else {
    const holder = await localProcess(current.pid, current.processStartedAt, env)
    abandoned = holder === 'gone' || (holder === 'unknown' && byAge())
  }
  if (!abandoned) return null
  await env.afterClaimJudged?.()
  const aside = `${claimPath}.stale.${randomUUID()}`
  try { await rename(claimPath, aside) } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
  await env.afterClaimMovedAside?.()
  const moved = await seeClaim(aside)
  if (!moved || !sameClaim(moved, seen)) {
    // What moved is not the claim judged abandoned: another contender's live claim. Put it back if
    // the path is still free; otherwise leave it aside (see above).
    await putBack(aside, claimPath)
    return null
  }
  await unlink(aside).catch(() => {})
  return (await createExclusive(claimPath, JSON.stringify(claim), env)) ? release : null
}

/**
 * Put a file that was moved aside by mistake back at `path`. The link never replaces what stands at
 * `path`; only once it has succeeded is the aside name removed. When it fails the aside is left on
 * disk: it is someone's live claim or lock, and removing it is never this contender's to do.
 */
async function putBack(aside: string, path: string): Promise<void> {
  try { await link(aside, path) } catch { return }
  await unlink(aside).catch(() => {})
}

/**
 * Replace the stale lock that was `observed` with `record`. False when anything changed meanwhile.
 * `lostTo` is called when this process did remove the stale lock but another took the freed path
 * before it could write its own: the recovery happened and must still be logged.
 */
async function recoverStale(lockPath: string, observed: Observed, record: OwnerLockRecord, env: Env, lostTo: (heldBy: OwnerLockRecord | null) => void): Promise<boolean> {
  const releaseClaim = await takeRecoveryClaim(lockPath, env)
  if (!releaseClaim) return false
  try {
    if (!sameObservation(await observe(lockPath), observed)) return false
    const aside = `${lockPath}.stale.${randomUUID()}`
    try { await rename(lockPath, aside) } catch (error) {
      if (errorCode(error) === 'ENOENT') return false
      throw error
    }
    if (!sameObservation(await observe(aside), observed)) {
      // What moved is not the lock judged stale: a new owner arrived. Put its lock back if the path
      // is still free. If another lock stands there now, the moved one is left aside, never removed:
      // its holder's next heartbeat finds another token at `owner.lock` and stops writing (`lost`).
      await putBack(aside, lockPath)
      return false
    }
    await unlink(aside).catch(() => {})
    await env.beforeRecoveryWrite?.()
    if (await createExclusive(lockPath, JSON.stringify(record), env)) return true
    const now = await observe(lockPath).catch(() => null)
    lostTo(now?.kind === 'record' ? now.record : null)
    return false
  } finally {
    await releaseClaim()
  }
}

/** Conflict copies among at most `MAX_ENTRIES_LISTED` entries of `.writeflex`; `cut` when there were more. */
async function findConflictCopies(root: string): Promise<{ files: string[]; cut: boolean }> {
  try {
    const { entries, more } = await entriesUpTo(join(root, OWNER_LOCK_DIR), MAX_ENTRIES_LISTED)
    const files = entries.map((entry) => entry.name)
      .filter((name) => name !== OWNER_LOCK_FILE && /^owner.+\.lock$/i.test(name))
      .sort()
    return { files, cut: more }
  } catch {
    return { files: [], cut: false }
  }
}

async function reportConflictCopies(root: string, env: Env): Promise<string[]> {
  const { files, cut } = await findConflictCopies(root)
  if (cut) env.log?.({ event: 'owner-lock.listing-cut', root, limit: MAX_ENTRIES_LISTED })
  if (files.length > 0) env.log?.({ event: 'owner-lock.conflict-copies', root, files })
  return files
}

/** Who owns the Collection at `root`, and whether that owner is live. Writes nothing. */
export async function inspectOwnerLock(root: string, env: OwnerLockEnv = {}): Promise<OwnerLockStatus> {
  const resolved = resolveOwnerLockEnv(env)
  if (!(await lockFolder(root, false)).exists) return { state: 'free', conflictCopies: [] }
  const conflictCopies = await reportConflictCopies(root, resolved)
  const observed = await observe(ownerLockPath(root))
  if (observed.kind === 'missing') return { state: 'free', conflictCopies }
  const owner = observed.kind === 'record' ? observed.record : null
  const judgement = await judge(observed, resolved)
  return judgement.live
    ? { state: 'held', owner, conflictCopies }
    : { state: 'recoverable', owner, reason: judgement.reason, conflictCopies }
}

/**
 * Take the Collection. Succeeds when nobody holds it or the holder left it behind (the takeover is
 * logged and reported on the result). Waits up to `waitMs` for a live owner, then throws
 * `OwnerLockBusyError` naming it. Throws `OwnerLockFolderError`, having written nothing, when
 * `.writeflex` is not an ordinary folder inside the Collection.
 */
export async function acquireOwnerLock(root: string, options: AcquireOptions): Promise<OwnerLock> {
  const env = resolveOwnerLockEnv(options)
  const lockPath = ownerLockPath(root)
  const startedAt = env.now()
  const deadline = Date.now() + (options.waitMs ?? 0)
  const waitStarted = Date.now()
  const record: OwnerLockRecord = {
    version: 1, pid: env.pid, kind: options.kind, host: env.host, startedAt, heartbeatAt: startedAt,
    processStartedAt: await env.processStartedAt(env.pid), token: randomUUID(),
  }
  let createdDir = false
  let missingDirRetries = 0
  let failedRecoveries = 0
  let vanished = 0
  const held = async (recovered: OwnerLock['recovered']): Promise<OwnerLock> => {
    if (recovered) env.log?.({ event: 'owner-lock.recovered', root, reason: recovered.reason, previous: recovered.previous, by: record })
    return { root, record, recovered, conflictCopies: await reportConflictCopies(root, env), env, createdDir }
  }
  for (;;) {
    try {
      const folder = await lockFolder(root, true)
      if (folder.created) createdDir = true
      if (!folder.exists) {
        // Removed again by a releasing owner; a folder that keeps vanishing is not waited on for ever.
        if (++missingDirRetries > MISSING_DIR_RETRIES) throw new FolderNotUsableError(`${OWNER_LOCK_DIR} keeps disappearing, so it is not used.`)
        continue
      }
      if (await createExclusive(lockPath, JSON.stringify(record), env)) return await held(null)
      const observed = await observe(lockPath)
      if (observed.kind === 'missing') {
        // Taken and released between the two calls: try at once. A path that keeps doing so past
        // the wait is somebody's, and is not spun on without end.
        if (Date.now() < deadline || ++vanished <= MISSING_DIR_RETRIES) continue
        throw new OwnerLockBusyError(root, null, Date.now() - waitStarted)
      }
      const judgement = await judge(observed, env)
      const previous = observed.kind === 'record' ? observed.record : null
      if (!judgement.live) {
        const lostTo = (heldBy: OwnerLockRecord | null): void => {
          env.log?.({ event: 'owner-lock.recovered-for-other', root, reason: judgement.reason, previous, heldBy })
        }
        if (await recoverStale(lockPath, observed, record, env, lostTo)) return await held({ reason: judgement.reason, previous })
        failedRecoveries += 1 // another process is recovering, or the lock changed; look again
      }
      if ((judgement.live || failedRecoveries >= 3) && Date.now() >= deadline) {
        throw new OwnerLockBusyError(root, previous, Date.now() - waitStarted)
      }
    } catch (error) {
      // `.writeflex` vanished between mkdir and the write: a releasing owner removed it. Start over.
      if (errorCode(error) !== 'ENOENT' || ++missingDirRetries > MISSING_DIR_RETRIES) throw error
      if (!(await lstat(root).catch(() => null))) throw error
      continue
    }
    await sleep(POLL_MS)
  }
}

/**
 * Run `action` on the lock file only while it is still this holder's. A holder whose own heartbeat
 * is past half the stale limit may be racing a recovery, so it must hold the recovery claim first.
 */
async function whileOwn<T>(lock: OwnerLock, action: (current: OwnerLockRecord) => Promise<T>): Promise<T | 'not-own' | 'missing' | 'contended'> {
  const lockPath = ownerLockPath(lock.root)
  const read = async (): Promise<OwnerLockRecord | 'not-own' | 'missing'> => {
    const observed = await observe(lockPath)
    if (observed.kind === 'missing') return 'missing'
    return observed.kind === 'record' && observed.record.token === lock.record.token ? observed.record : 'not-own'
  }
  if (!(await lockFolder(lock.root, false)).exists) return 'missing'
  const current = await read()
  if (typeof current === 'string') return current
  if (lock.env.now() - current.heartbeatAt <= lock.env.staleMs / 2) return action(current)
  let releaseClaim: (() => Promise<void>) | null = null
  for (let attempt = 0; attempt < 20 && !releaseClaim; attempt++) {
    releaseClaim = await takeRecoveryClaim(lockPath, lock.env)
    if (!releaseClaim) await sleep(POLL_MS)
  }
  // The lock on disk is still this holder's; it just cannot be touched while another holds the claim.
  if (!releaseClaim) return 'contended'
  try {
    const again = await read()
    return typeof again === 'string' ? again : await action(again)
  } finally {
    await releaseClaim()
  }
}

/** Each holder's refreshes and release, one after another in call order. */
const chains = new WeakMap<OwnerLock, Promise<unknown>>()
/** Holders that have given the Collection up: nothing of theirs is written again. */
const released = new WeakSet<OwnerLock>()

function inTurn<T>(lock: OwnerLock, work: () => Promise<T>): Promise<T> {
  const result = (chains.get(lock) ?? Promise.resolve()).then(work, work)
  chains.set(lock, result.catch(() => {}))
  return result
}

/**
 * Rewrite the heartbeat. `lost` means another owner now holds the Collection and this holder must
 * stop writing. A lock file that has merely disappeared (deleted by hand or by a sync client) is put
 * back, since nobody else took it. Throws `OwnerLockContendedError` when the lock is still this
 * holder's but could not be rewritten this time; the holder keeps the Collection and tries again.
 * Throws `OwnerLockFolderError`, having written nothing, when `.writeflex` is no longer an ordinary
 * folder inside the Collection.
 *
 * Runs in turn with this holder's other refreshes and its release. After the release it writes
 * nothing and answers `lost`.
 */
export function refreshOwnerLock(lock: OwnerLock): Promise<'refreshed' | 'lost'> {
  return inTurn(lock, async () => (released.has(lock) ? 'lost' : refreshInTurn(lock)))
}

async function refreshInTurn(lock: OwnerLock): Promise<'refreshed' | 'lost'> {
  const lockPath = ownerLockPath(lock.root)
  const next = (): OwnerLockRecord => ({ ...lock.record, heartbeatAt: lock.env.now() })
  const outcome = await whileOwn(lock, async () => {
    await lock.env.beforeHeartbeatWrite?.()
    await replaceWhole(lockPath, JSON.stringify(next()), lock.env)
    return 'refreshed' as const
  })
  if (outcome === 'refreshed') return outcome
  if (outcome === 'contended') throw new OwnerLockContendedError(lock.root)
  if (outcome === 'missing') {
    const restored = next()
    if ((await lockFolder(lock.root, true)).exists && await createExclusive(lockPath, JSON.stringify(restored), lock.env)) {
      lock.env.log?.({ event: 'owner-lock.restored', root: lock.root, by: restored })
      return 'refreshed'
    }
  }
  lock.env.log?.({ event: 'owner-lock.lost', root: lock.root, token: lock.record.token })
  return 'lost'
}

/**
 * Give the Collection up. Removes the lock file only if it is still this holder's; safe to repeat.
 * Waits first for a refresh of this holder's that is in flight, so that no heartbeat of a released
 * holder is ever written over the next owner's lock.
 */
export function releaseOwnerLock(lock: OwnerLock): Promise<void> {
  return inTurn(lock, async () => {
    if (released.has(lock)) return
    let outcome: Awaited<ReturnType<typeof whileOwn<void>>>
    try {
      outcome = await whileOwn(lock, async () => { await unlink(ownerLockPath(lock.root)).catch(() => {}) })
    } catch (error) {
      // `.writeflex` is a link or a file now: nothing of this holder's can be reached through it.
      if (!(error instanceof FolderNotUsableError)) throw error
      released.add(lock)
      return
    }
    // Still this holder's on disk and not removable this time (the recovery claim is another's): the
    // holder may refresh or release again.
    if (outcome === 'contended') return
    released.add(lock)
    // Leave no marker folder behind in a folder that had none: `.writeflex` decides which folder a
    // file's Collection is (root-resolution.ts). rmdir refuses a folder with anything in it.
    if (lock.createdDir) await rmdir(join(lock.root, OWNER_LOCK_DIR)).catch(() => {})
  })
}

/** Hold the Collection for one operation: acquire, keep the heartbeat going, always release. */
export async function withOwnerLock<T>(root: string, options: AcquireOptions, operation: (lock: OwnerLock) => Promise<T>): Promise<T> {
  const lock = await acquireOwnerLock(root, options)
  const heartbeat = setInterval(() => { void refreshOwnerLock(lock).catch(() => {}) }, OWNER_LOCK_HEARTBEAT_MS)
  heartbeat.unref()
  try {
    return await operation(lock)
  } finally {
    clearInterval(heartbeat)
    // In turn behind a heartbeat the timer has already started; see releaseOwnerLock.
    await releaseOwnerLock(lock)
  }
}
