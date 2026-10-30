import { afterAll } from 'bun:test'
import { finishTestTempRoot, startTestTempRoot } from '../helpers/test-temp-root'

// bunfig [test] preload: one scratch root for the whole `bun test` process.
// `process.on('exit')` does not fire reliably under bun test, so the removal runs in a preload-level
// afterAll (after the last test file, failures included); the exit hook stays as a second chance.
const run = startTestTempRoot()
let done = false
const finish = (): void => {
  if (done) return
  done = true
  const start = performance.now()
  try { finishTestTempRoot(run) }
  finally { console.info(`[test-temp] run-root cleanup: ${Math.round(performance.now() - start)} ms`) }
}
afterAll(finish)
process.on('exit', finish)

// Bun.spawn / Bun.spawnSync without `env` hand the child the environment bun started with, not the
// TMPDIR set above, so probe children would create their folders in the real temp dir. Default to the live env.
type SpawnFn = (cmd: unknown, options?: Record<string, unknown>) => unknown
for (const name of ['spawn', 'spawnSync'] as const) {
  const original = Bun[name] as unknown as SpawnFn
  const wrapped: SpawnFn = (cmd, options) => {
    if (cmd && typeof cmd === 'object' && !Array.isArray(cmd)) {
      const o = cmd as Record<string, unknown>
      return original.call(Bun, { ...o, env: o.env ?? process.env }, options)
    }
    return original.call(Bun, cmd, { ...options, env: options?.env ?? process.env })
  }
  ;(Bun as unknown as Record<string, unknown>)[name] = wrapped
}
