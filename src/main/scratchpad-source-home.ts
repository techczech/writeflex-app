/**
 * Where the two optional source apps keep their own data on this Mac (ticket 05), and the one
 * test-only override. Production reads the real home folder. A hidden e2e run
 * (`WRITEFLEX_E2E=1`) may point discovery at a synthetic home through
 * `WRITEFLEX_E2E_SOURCE_HOME`, whose layout mirrors the real one
 * (`Library/Application Support/TalkWeaver/…`, `SlideWell/well/…`), so a test that turns a
 * switch on can never touch the person's real TalkWeaver config, vaults, SlideWell catalogue
 * or socket. The override is ignored outside e2e, and `HOME` is never repurposed.
 */
import { homedir } from 'node:os'

/** The home folder source discovery reads under. Exported for the e2e privacy assertion. */
export function scratchpadSourceHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WRITEFLEX_E2E === '1') {
    if (!env.WRITEFLEX_E2E_SOURCE_HOME || env.WRITEFLEX_E2E_SOURCE_HOME === homedir()) {
      throw new Error('WriteFlex e2e source discovery requires an explicit synthetic source home')
    }
    return env.WRITEFLEX_E2E_SOURCE_HOME
  }
  return homedir()
}

/** Whether discovery is currently pinned to the synthetic e2e home (never true in production). */
export function scratchpadSourceHomeIsSynthetic(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WRITEFLEX_E2E === '1' && typeof env.WRITEFLEX_E2E_SOURCE_HOME === 'string' && env.WRITEFLEX_E2E_SOURCE_HOME !== ''
}
