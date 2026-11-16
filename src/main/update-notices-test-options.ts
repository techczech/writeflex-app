import type { CopySource } from '@app-patterns/updates'
import { UPDATE_TEST_BUILD } from './update-test-build'

export interface UpdateTestOptions {
  source: CopySource | null
  /** A stand-in feed on 127.0.0.1; its update files must be on the same address. */
  feedUrl: string | null
  /** The packaged update-test flavour: the stand-in feed, and the real Squirrel.Mac install (the proof on this Mac). */
  packagedProof: boolean
}

const NONE: UpdateTestOptions = { source: null, feedUrl: null, packagedProof: false }

function loopbackFeed(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? '')
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return url.href
  } catch { /* no stand-in */ }
  return null
}

/**
 * Unpackaged hidden tests (WRITEFLEX_E2E=1) and the packaged update-test flavour only. A production build (packaged,
 * `updateTestBuild` false: the flag is compiled in as false) ignores every override, so its feed is writeflex.app and
 * its update files only `https://github.com/techczech/writeflex-app/releases/download/…`.
 */
export function updateTestOptions(packaged: boolean, env: Record<string, string | undefined>, updateTestBuild: boolean = UPDATE_TEST_BUILD): UpdateTestOptions {
  if (packaged) {
    if (!updateTestBuild) return NONE
    return { source: null, feedUrl: loopbackFeed(env.WRITEFLEX_UPDATE_TEST_FEED), packagedProof: true }
  }
  if (env.WRITEFLEX_E2E !== '1') return NONE
  const source = env.WRITEFLEX_E2E_UPDATES_SOURCE
  return { source: source === 'website' || source === 'store' || source === 'preview' ? source : null, feedUrl: loopbackFeed(env.WRITEFLEX_E2E_UPDATES_FEED), packagedProof: false }
}
