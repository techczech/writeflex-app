/**
 * A second real process for tests/main/owner-lock.test.ts and collection-ownership.test.ts.
 *   race <root> <startAtEpochMs> <holdMs> [until]  take the lock at a shared instant; prints acquired | busy.
 *                                          With `until` (a path), the winner holds until that file exists, not for <holdMs>.
 *   hold <root> <holdMs> [until]           take it, print held, keep it, release, print released.
 *                                          With `until` (a path), it holds until that file exists, not for <holdMs>.
 *   hang <root>                            take it, print held, never release (the test kills -9)
 *   claim <root> <ageMs>                   hold the recovery claim, written <ageMs> ago, print claimed, stay alive
 */
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { acquireOwnerLock, ownerLockPath, releaseOwnerLock, OwnerLockBusyError } from '../../src/main/owner-lock'
import { readProcessStartTime } from '../../src/main/owner-lock-liveness'

const [mode, root, first, second, third] = process.argv.slice(2)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })
const say = (line: string): void => { process.stdout.write(`${line}\n`) }

if (mode === 'race') {
  while (Date.now() < Number(first)) { /* spin: every racer starts in the same millisecond */ }
  try {
    const lock = await acquireOwnerLock(root, { kind: 'command-line' })
    say(lock.recovered ? 'acquired recovered' : 'acquired')
    if (third) while (!existsSync(third)) await sleep(5)
    else await sleep(Number(second))
    await releaseOwnerLock(lock)
  } catch (error) {
    if (!(error instanceof OwnerLockBusyError)) throw error
    say('busy')
  }
} else if (mode === 'hold') {
  const lock = await acquireOwnerLock(root, { kind: 'command-line' })
  say('held')
  if (second) while (!existsSync(second)) await sleep(5)
  else await sleep(Number(first))
  await releaseOwnerLock(lock)
  say('released')
} else if (mode === 'hang') {
  await acquireOwnerLock(root, { kind: 'command-line' })
  say('held')
  await sleep(600_000)
} else if (mode === 'claim') {
  // The claim as a recoverer writes it, held by a process that then stalls mid-recovery.
  await writeFile(`${ownerLockPath(root)}.recover`, JSON.stringify({
    pid: process.pid, host: hostname(), token: 'child-claim', at: Date.now() - Number(first), processStartedAt: await readProcessStartTime(process.pid),
  }))
  say('claimed')
  await sleep(600_000)
} else {
  throw new Error(`unknown mode ${mode}`)
}
