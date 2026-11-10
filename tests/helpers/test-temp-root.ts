import { createE2ERunIdentity, finishE2ERun, RUN_ID, RUN_ROOT, type RunIdentity } from './test-run-claims'
import { mkdtempSync, readdirSync, rmSync, statSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One scratch root per test run. `startTestTempRoot()` creates `<realtmp>/wf-run-XXXXXX` and points
 * TMPDIR/TEMP/TMP at it, so every os.tmpdir()-based mkdtemp, spawned child and Electron launch lands
 * inside it. E2E mode instead owns a physical six-character /private/tmp sibling, outside runner cleanup.
 * E2E deletion requires all durable worker claims released; unknown ownership retains the root.
 * Unit roots keep their existing cleanup behaviour. Cleanup also warns when something with one of
 * this app's prefixes still appeared in the REAL temp dir (a bypass of TMPDIR). Warn only: another
 * session may be running the same suite at the same time.
 */
const APP_PREFIXES = ['writeflex-', 'wf-', '.public-stage']
const KEYS = ['TMPDIR', 'TEMP', 'TMP'] as const

export interface TestTempRoot {
  root: string
  realTmp: string
  identity?: RunIdentity
  startedAt: number
  /** Names already in the real temp dir at start, so the guard only looks at newcomers. */
  before: Set<string>
}

export function startTestTempRoot(options: { e2e?: boolean } = {}): TestTempRoot {
  // App boundaries canonicalise workspace roots. Export the same physical spelling to
  // every fixture and child, even when the host TMPDIR goes through /var or another alias.
  const realTmp = options.e2e ? '/private/tmp' : realpathSync(tmpdir())
  const startedAt = Date.now()
  let before = new Set<string>()
  try { before = new Set(readdirSync(realTmp)) } catch { /* unreadable: guard compares against nothing */ }
  const identity = options.e2e ? createE2ERunIdentity() : undefined
  const root = identity?.root ?? mkdtempSync(join(realTmp, 'wf-run-'))
  if (identity) { process.env[RUN_ROOT] = root; process.env[RUN_ID] = identity.id }
  for (const key of KEYS) process.env[key] = root
  return { root, realTmp, startedAt, before, identity }
}

export function finishTestTempRoot(run: TestTempRoot): string[] {
  const removalStarted = performance.now()
  try {
    if (run.identity) {
      if (run.root !== run.identity.root) throw new Error(`WriteFlex test root retained: ${run.root}; run identity mismatch`)
      finishE2ERun(run.identity, () => rmSync(run.root, { recursive: true, force: true }))
    } else {
      if (!/[/\\]wf-run-[^/\\]+$/.test(run.root)) throw new Error(`WriteFlex test root retained: ${run.root}; missing run identity`)
      rmSync(run.root, { recursive: true, force: true })
    }
  } finally { console.info(`[test-temp] run-root removal: ${Math.round(performance.now() - removalStarted)} ms`) }
  const scanStarted = performance.now()
  let stray: string[] = []
  try {
    stray = readdirSync(run.realTmp)
      .filter((name) => !run.before.has(name))
      .filter((name) => APP_PREFIXES.some((prefix) => name.startsWith(prefix)))
      .filter((name) => name !== run.root.slice(run.realTmp.length).replace(/^\/+/, ''))
      .map((name) => join(run.realTmp, name))
      .filter((path) => {
        try { return statSync(path).mtimeMs >= run.startedAt } catch { return false }
      })
  } catch { /* real temp dir unreadable: nothing to report */ }
  finally { console.info(`[test-temp] real-temp scan: ${Math.round(performance.now() - scanStarted)} ms`) }
  if (stray.length > 0) {
    console.warn(
      `[test-temp] ${stray.length} entr${stray.length === 1 ? 'y' : 'ies'} with this app's prefixes appeared in ${run.realTmp} during the run ` +
        `(created outside TMPDIR; other sessions may also be running). First: ${stray.slice(0, 5).join(', ')}`,
    )
  }
  return stray
}
