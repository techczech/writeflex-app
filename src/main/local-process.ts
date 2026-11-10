/**
 * Processes on THIS computer: whether a process id still names the process that recorded it, judged
 * by the process table (`ps`) and nothing synced. Used by the command line to tell whether the
 * WriteFlex app that left a reply key in its own application-data folder is still running
 * (reply-key.ts `appPresence`), and by backup receipts.
 *
 * Nothing here decides who may write a Collection. WriteFlex has no cross-process or cross-computer
 * Collection lock (docs/plans/2026-11-03-sync-replicas-and-duplicate-reconciliation.md).
 *
 * Electron-free and dependency-free.
 */
import { spawn } from 'node:child_process'

/** `ps` reports whole seconds; the slack also absorbs a clock step between the two readings. */
const START_TIME_SLACK_MS = 2_000
const PS_TIMEOUT_MS = 2_000

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code

/** True when `pid` runs and is this user's; `other-user` when it runs as someone else; false when gone. */
export function pidIsAlive(pid: number): boolean | 'other-user' {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (errorCode(error) === 'ESRCH' || errorCode(error) === 'EINVAL') return false
    // EPERM: the process exists and belongs to someone else.
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
 * unparseable.
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
export function processStartedAt(pid: number): Promise<number | null> {
  if (pid !== process.pid) return readProcessStartTime(pid)
  if (ownStartTime) return ownStartTime
  const asked = readProcessStartTime(pid)
  ownStartTime = asked
  // An answer that could not be read is not kept: the next caller asks again.
  void asked.then((value) => { if (value === null && ownStartTime === asked) ownStartTime = null })
  return asked
}

export type LocalProcessSeams = {
  pidIsAlive?: (pid: number) => boolean | 'other-user'
  processStartedAt?: (pid: number) => Promise<number | null>
}

/**
 * Whether process `pid` ON THIS COMPUTER is the one that recorded `recordedStart`: `there` when it is
 * alive, this user's, and started when the record says; `gone` when no such process runs or the id
 * now belongs to a process started at another time; `unknown` when neither can be shown.
 */
export async function localProcess(pid: number, recordedStart: number | null, seams: LocalProcessSeams = {}): Promise<'there' | 'gone' | 'unknown'> {
  if (!Number.isInteger(pid) || pid <= 1) return 'unknown'
  const alive = (seams.pidIsAlive ?? pidIsAlive)(pid)
  if (alive === false) return 'gone'
  if (alive !== true || recordedStart === null) return 'unknown'
  const actual = await (seams.processStartedAt ?? processStartedAt)(pid)
  if (actual === null) return 'unknown'
  return Math.abs(actual - recordedStart) <= START_TIME_SLACK_MS ? 'there' : 'gone'
}
