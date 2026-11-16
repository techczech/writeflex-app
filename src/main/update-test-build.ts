// The unpublished update-test flavour (ADR-0054 "Proof required before merge"; scripts/build-update-test.ts,
// docs/plans/2026-11-16-in-place-updates/proof-packaged-update.md). Only `electron.vite.update-test.config.ts` defines
// __WF_UPDATE_TEST__ as true; the production config defines it false, so the branches it guards are dead code in a
// production bundle. No environment variable or runtime switch turns it on. A bun test (no define at all) reads false.
//
// What the flavour changes, and only there: its own bundle identifier and name (electron-builder.update-test.cjs), so
// Squirrel.Mac's ShipIt job, the caches and the single-instance lock are never the published app's; it always runs as
// the hidden harness with its user data next to the bundle (bootstrap-core.ts enterUpdateTestHarness), also when
// Squirrel.Mac relaunches it; it never contacts writeflex.app; it reads the stand-in feed on 127.0.0.1
// (WRITEFLEX_UPDATE_TEST_FEED, update-notices-test-options.ts), a test restart hold (WRITEFLEX_UPDATE_TEST_HOLD_FILE)
// and a test kept window (WRITEFLEX_UPDATE_TEST_KEEP_WINDOW_FILE, windows.ts).
import { existsSync } from 'node:fs'

declare const __WF_UPDATE_TEST__: boolean | undefined

export const UPDATE_TEST_BUILD: boolean = typeof __WF_UPDATE_TEST__ === 'boolean' ? __WF_UPDATE_TEST__ : false

/** The update-test flavour's update download cache: `~/Library/Caches/writeflex-updatetest-updater`, never the published app's. */
export const UPDATE_TEST_CACHE_DIR_NAME = 'writeflex-updatetest-updater'

/** The test restart hold: the file WRITEFLEX_UPDATE_TEST_HOLD_FILE names exists. Read synchronously at the moment of
 *  asking, like every other blocker; counted as an export being written. Always false outside the flavour. */
export function updateTestHeld(env: Readonly<Record<string, string | undefined>> = process.env, isBuild: boolean = UPDATE_TEST_BUILD): boolean {
  if (!isBuild) return false
  const file = env.WRITEFLEX_UPDATE_TEST_HOLD_FILE
  return typeof file === 'string' && file !== '' && existsSync(file)
}

/** The test kept window: the file WRITEFLEX_UPDATE_TEST_KEEP_WINDOW_FILE names exists. While it does, every window's
 *  close reports what a failed write reports (windows.ts), so an update's close-first restart finds a window kept
 *  open (scenario f of the packaged proof). Read at each close. Always false outside the flavour. */
export function updateTestKeepsWindow(env: Readonly<Record<string, string | undefined>> = process.env, isBuild: boolean = UPDATE_TEST_BUILD): boolean {
  if (!isBuild) return false
  const file = env.WRITEFLEX_UPDATE_TEST_KEEP_WINDOW_FILE
  return typeof file === 'string' && file !== '' && existsSync(file)
}
