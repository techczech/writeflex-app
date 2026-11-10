/**
 * The installed `writeflex` shim: WriteFlex's face on the one marker-guarded installer the built-in agent skill
 * also uses (agent-skill/shim.ts). There is one shim, one script text and one write path; connecting an agent
 * and the Settings button both end there. This module keeps the names the rest of WriteFlex and its tests know
 * (`generateShim(bundleId)`, `installShim({ bundleId })`) and fixes WriteFlex's facts: the command is `writeflex`,
 * and it runs the app's own binary in Node mode on the bundled command-line entry (`ELECTRON_RUN_AS_NODE=1`).
 * No Electron dependency; the Settings button reaches this through one IPC handler.
 *
 * Which copy runs, since several bundles can carry the identifier (preview builds in Documents, a copy in
 * Downloads): one in /Applications, else one in ~/Applications; both are looked in directly, so this works with
 * Spotlight off. A copy anywhere else is used only when Spotlight knows exactly one and neither Applications
 * folder has any, and is then named on standard error. Wherever the choice falls, more than one copy there is
 * refused and listed (exit 126) rather than guessed at. `writeflex --which-app` (that argument alone) prints the
 * chosen bundle and runs nothing. Nothing the script runs is looked up on `PATH`: every program is named by its
 * absolute path. The script text itself is generated in agent-skill/shim.ts.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAppVariant } from '../app-variant'
import { AGENT_SKILL_IDENTITY, BETA_BUNDLE_ID, STABLE_BUNDLE_ID } from '../../shared/agent-skill-identity'
import { WHICH_APP_FLAG, generateShim as generateSpecShim, installShim as installSpecShim, shimMarker, type ShimLookup, type ShimSpec } from '../agent-skill/shim'

export { STABLE_BUNDLE_ID, BETA_BUNDLE_ID, WHICH_APP_FLAG }
export type { ShimLookup }

const specFor = (bundleId: string): ShimSpec => ({ ...AGENT_SKILL_IDENTITY.cli, bundleId })

/** Second line of every shim we write; an existing file without it is not ours to replace. */
export const SHIM_MARKER = shimMarker(specFor(STABLE_BUNDLE_ID))

export function bundleIdentifierFor(packageMetadata: unknown): string {
  return resolveAppVariant(packageMetadata).versionLabelSuffix === ' beta' ? BETA_BUNDLE_ID : STABLE_BUNDLE_ID
}

/** The script text. `bundleId` is the only app identity in it; no install path appears. */
export function generateShim(bundleId: string, lookup: ShimLookup = {}): string {
  return generateSpecShim(specFor(bundleId), lookup)
}

export type InstallResult =
  | { ok: true; path: string; changed: boolean; onPath: boolean; message: string }
  | { ok: false; message: string }

/**
 * Write the shim to `<dir>/writeflex` (default `~/.local/bin`, which needs no administrator rights).
 * Installing again is harmless: identical content is left untouched and reported as already installed;
 * an older shim of ours is replaced; a file or link of that name that is not ours is never overwritten, and the
 * command is never written through a link.
 */
export async function installShim(opts: { bundleId: string; dir?: string; pathEnv?: string }): Promise<InstallResult> {
  const home = homedir()
  const row = await installSpecShim({ spec: specFor(opts.bundleId), home, platform: process.platform, pathEnv: opts.pathEnv ?? process.env.PATH ?? '', ...(opts.dir ? { dir: opts.dir } : {}) })
  if (row.state !== 'installed') return { ok: false, message: row.message }
  return { ok: true, path: row.path ?? join(opts.dir ?? join(home, '.local', 'bin'), 'writeflex'), changed: !/already installed/.test(row.message), onPath: row.onPath, message: row.message }
}
