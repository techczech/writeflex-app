/**
 * Run an external program and wait for it NO LONGER THAN A LIMIT. A program that never answers (a
 * stalled `git`, a Trash mover waiting on a permission prompt) would otherwise hold whatever its
 * caller holds, which for the command line is the Collection's owner lock. When the limit passes the
 * child is killed, its streams are destroyed and every listener removed, so nothing keeps the caller
 * or the process waiting; the result says `timed-out`. The pattern is the one the owner lock uses to
 * read a process's start time (owner-lock-liveness.ts). Electron-free.
 */
import { spawn } from 'node:child_process'

export type BoundedRun =
  | { kind: 'exited'; code: number | null; stdout: string; stderr: string }
  /** The limit passed: the child was sent SIGKILL and is no longer listened to. `pid` is the child's, when it had one. */
  | { kind: 'timed-out'; pid: number | undefined }
  /** The program could not be started. */
  | { kind: 'not-started'; message: string }

export type BoundedOptions = {
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  /** Each of standard output and standard error is kept up to this many characters. Default 64 KiB. */
  maxOutput?: number
  /** @internal Test seam: the limit passes when this settles, in place of the clock. */
  expired?: () => Promise<void>
}

export function runBounded(command: string, args: string[], options: BoundedOptions): Promise<BoundedRun> {
  const max = options.maxOutput ?? 64 * 1024
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { ...(options.env ? { env: options.env } : {}), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ kind: 'not-started', message: error instanceof Error ? error.message : String(error) })
      return
    }
    const settle = (result: BoundedRun): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      for (const stream of [child.stdout, child.stderr]) {
        stream?.removeAllListeners()
        stream?.destroy()
      }
      child.removeAllListeners()
      child.on('error', () => {}) // a late spawn or kill error must not become an uncaught exception
      resolve(result)
    }
    const giveUp = (): void => {
      if (settled) return
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      child.unref()
      settle({ kind: 'timed-out', pid: child.pid })
    }
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < max) stdout += chunk.toString('utf8').slice(0, max - stdout.length) })
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < max) stderr += chunk.toString('utf8').slice(0, max - stderr.length) })
    child.on('error', (error) => settle({ kind: 'not-started', message: error.message }))
    child.on('close', (code) => settle({ kind: 'exited', code, stdout, stderr }))
    if (options.expired) void options.expired().then(giveUp, giveUp)
    else timer = setTimeout(giveUp, options.timeoutMs)
  })
}
