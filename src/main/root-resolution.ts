import { dirname, join, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'

export const LIBRARY_MARKER_DIR = '.writeflex'

/**
 * Canonicalise a path for identity comparison: resolve to absolute, then realpath (symlinks and,
 * on APFS, stored case). Window dedup MUST compare physical roots — the Snapshot Store is
 * single-writer (Bridle ADR-0008), and `/tmp/notes` vs `/private/tmp/notes` binding two windows to
 * one physical folder would corrupt its journal. Falls back to the resolved path when realpath
 * throws (path vanished or not yet created).
 */
export function normaliseRoot(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

export class WorkspaceRootError extends Error {
  constructor(filePath: string) {
    super(`Cannot open ${filePath}: files directly in the home folder have no Workspace root. Move the file into a folder first.`)
    this.name = 'WorkspaceRootError'
  }
}

/** ADR-0007: nearest marker by precedence Library > .bridle > .git > parent; stop at ~; never resolve to ~. */
export function resolveWorkspaceRoot(filePath: string, opts?: { home?: string }): string {
  const home = opts?.home ?? homedir()
  const start = dirname(filePath)
  if (start === home) throw new WorkspaceRootError(filePath)
  let nearestLibrary: string | null = null
  let nearestBridle: string | null = null
  let nearestGit: string | null = null
  let dir = start
  while (dir !== home && dirname(dir) !== dir) {
    if (!nearestLibrary && existsSync(join(dir, LIBRARY_MARKER_DIR))) nearestLibrary = dir
    if (!nearestBridle && existsSync(join(dir, '.bridle'))) nearestBridle = dir
    if (!nearestGit && existsSync(join(dir, '.git'))) nearestGit = dir
    dir = dirname(dir)
  }
  return nearestLibrary ?? nearestBridle ?? nearestGit ?? start
}
