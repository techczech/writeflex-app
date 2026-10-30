import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One scratch root per test run. `startTestTempRoot()` creates `<realtmp>/wf-run-XXXXXX` and points
 * TMPDIR/TEMP/TMP at it, so every os.tmpdir()-based mkdtemp, spawned child and Electron launch lands
 * inside it. `finishTestTempRoot()` removes it (also on failure) and warns when something with one of
 * this app's prefixes still appeared in the REAL temp dir (a bypass of TMPDIR). Warn only: another
 * session may be running the same suite at the same time.
 */
const APP_PREFIXES = ['writeflex-', 'wf-', '.public-stage']
const KEYS = ['TMPDIR', 'TEMP', 'TMP'] as const

export interface TestTempRoot {
  root: string
  realTmp: string
  startedAt: number
  /** Names already in the real temp dir at start, so the guard only looks at newcomers. */
  before: Set<string>
}

export function startTestTempRoot(): TestTempRoot {
  const realTmp = tmpdir()
  const startedAt = Date.now()
  let before = new Set<string>()
  try { before = new Set(readdirSync(realTmp)) } catch { /* unreadable: guard compares against nothing */ }
  const root = mkdtempSync(join(realTmp, 'wf-run-'))
  for (const key of KEYS) process.env[key] = root
  return { root, realTmp, startedAt, before }
}

export function finishTestTempRoot(run: TestTempRoot): string[] {
  const removalStarted = performance.now()
  try { rmSync(run.root, { recursive: true, force: true }) }
  finally { console.info(`[test-temp] run-root removal: ${Math.round(performance.now() - removalStarted)} ms`) }
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
