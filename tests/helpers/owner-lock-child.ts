import { spawn, type ChildProcess } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'owner-lock-child.ts')

export type LockChild = {
  process: ChildProcess
  pid: number
  /** Resolves once the child has printed `line`; rejects if it exits first. */
  said: (line: string) => Promise<void>
  /** Resolves once the child has printed anything at all, or has exited. */
  spoke: Promise<void>
  /** Everything the child printed, once it has exited. */
  finished: Promise<{ code: number | null; lines: string[] }>
}

/** Run the fixture as a separate OS process under the same runtime as the tests. */
export function lockChild(...args: Array<string | number>): LockChild {
  const child = spawn(process.execPath, [FIXTURE, ...args.map(String)], { stdio: ['ignore', 'pipe', 'inherit'] })
  let output = ''
  const waiters: Array<{ line: string; resolve: () => void; reject: (error: Error) => void }> = []
  const lines = (): string[] => output.split('\n').filter(Boolean)
  let hasSpoken = (): void => {}
  const spoke = new Promise<void>((resolve) => { hasSpoken = resolve })
  child.stdout!.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
    if (lines().length > 0) hasSpoken()
    for (const waiter of waiters.splice(0)) {
      if (lines().includes(waiter.line)) waiter.resolve()
      else waiters.push(waiter)
    }
  })
  const finished = new Promise<{ code: number | null; lines: string[] }>((resolve) => {
    child.on('close', (code) => {
      hasSpoken()
      for (const waiter of waiters.splice(0)) waiter.reject(new Error(`child exited before printing ${waiter.line}`))
      resolve({ code, lines: lines() })
    })
  })
  return {
    process: child,
    pid: child.pid!,
    spoke,
    said: (line) => lines().includes(line)
      ? Promise.resolve()
      : new Promise((resolve, reject) => { waiters.push({ line, resolve, reject }) }),
    finished,
  }
}

/** Start a child that takes the lock and is then killed without a chance to release it. */
export async function crashedOwner(root: string): Promise<number> {
  const child = lockChild('hang', root)
  await child.said('held')
  child.process.kill('SIGKILL')
  await child.finished
  return child.pid
}

/**
 * Start `count` racers for the Collection at `root` at one shared instant. Whichever takes it holds
 * it until every racer has said how it fared, so that a racer the machine starts late still meets a
 * held Collection: the count of holders does not depend on how fast processes start.
 */
export async function raceFor(root: string, count: number): Promise<string[]> {
  const until = join(root, 'racers-have-all-spoken')
  const startAt = Date.now() + 400
  const racers = Array.from({ length: count }, () => lockChild('race', root, startAt, 0, until))
  await Promise.all(racers.map((racer) => racer.spoke))
  await writeFile(until, '')
  const results = await Promise.all(racers.map((racer) => racer.finished))
  await rm(until, { force: true })
  if (results.some((result) => result.code !== 0)) throw new Error(`a racer failed: ${JSON.stringify(results)}`)
  return results.flatMap((result) => result.lines).sort()
}
