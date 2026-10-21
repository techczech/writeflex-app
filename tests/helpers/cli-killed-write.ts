import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { WriteFixture } from './cli-write-fixture'

/** How long a child may take to reach its write step. It normally takes a fifth of a second; this is the test's own limit, not the runner's. */
export const CHILD_DEADLINE_MS = 30_000
/** The runner's limit for a test with children: beyond every child's own deadline, so the deadline is what speaks. */
export const withChildren = (count: number): number => count * CHILD_DEADLINE_MS + 30_000

/**
 * Kills a command-line write at a chosen write step, in a child process (tests/fixtures/cli-killed-write.ts).
 * `stopAt` is the write step to stop at, or `mark-undone`: an undo stopped after its last change to the
 * Collection, before its entry is marked undone. `endAll` ends any child a failed test left running;
 * call it before the fixture's folders are removed.
 */
export function childKiller(): { killedAt: (f: WriteFixture, stopAt: number | 'mark-undone', argv: string[]) => Promise<void>; endAll: () => Promise<void> } {
  const children = new Set<ChildProcess>()
  /**
   * Waits for `stopped`, for the child to end, or for the deadline, whichever comes first; in every
   * case the child is killed (SIGKILL) and has gone before this returns. A child that ended or ran out
   * of time fails the test with all it said.
   */
  const killedAt = async (f: WriteFixture, stopAt: number | 'mark-undone', argv: string[]): Promise<void> => {
    const child = spawn(process.execPath, [join(import.meta.dir, '..', 'fixtures', 'cli-killed-write.ts'), f.root, f.appData, String(stopAt), ...argv], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let said = ''
    let errors = ''
    const gone = new Promise<void>((resolve) => { child.once('close', () => { children.delete(child); resolve() }) })
    const told = (): string => `It said:\n${said}${errors ? `\nOn standard error:\n${errors}` : ''}`
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`The child did not reach ${stopAt} of "${argv.join(' ')}" within ${CHILD_DEADLINE_MS} ms. ${told()}`)), CHILD_DEADLINE_MS)
        child.stdout.on('data', (chunk: Buffer) => {
          said += chunk.toString('utf8')
          if (said.includes('\nstopped\n')) { clearTimeout(deadline); resolve() }
        })
        child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8') })
        child.once('error', (error) => { clearTimeout(deadline); reject(error) })
        void gone.then(() => { clearTimeout(deadline); reject(new Error(`The child ended before ${stopAt} of "${argv.join(' ')}". ${told()}`)) })
      })
    } finally {
      child.kill('SIGKILL')
      await gone
    }
  }
  const endAll = async (): Promise<void> => {
    await Promise.all([...children].map((child) => new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done()
      child.once('close', () => done())
      child.kill('SIGKILL')
    })))
    children.clear()
  }
  return { killedAt, endAll }
}
