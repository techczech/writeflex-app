import { watch, type FSWatcher } from 'node:fs'
import { isAbsolute, posix } from 'node:path'

export const OWN_WRITE_DEDUPE_MS = 5_000
export const WATCH_BURST_DEBOUNCE_MS = 220

function normaliseWatchPath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/'))
}

/** Short-lived record of paths WriteFlex itself changed, shared by every write route in Workspace. */
export class OwnWriteTracker {
  readonly #paths = new Map<string, number>()

  record(path: string, at = Date.now()): void {
    this.#paths.set(normaliseWatchPath(path), at)
  }

  isRecent(path: string, at = Date.now()): boolean {
    const key = normaliseWatchPath(path)
    const writtenAt = this.#paths.get(key)
    if (writtenAt === undefined) return false
    if (at - writtenAt <= OWN_WRITE_DEDUPE_MS) return true
    this.#paths.delete(key)
    return false
  }
}

/** Keep watcher noise aligned with Workspace.#walk: hidden/internal/build folders never surface. */
export function isIgnoredWorkspaceWatchPath(path: string): boolean {
  if (!path || isAbsolute(path)) return true
  const normalised = normaliseWatchPath(path)
  if (normalised === '.' || normalised === '..' || normalised.startsWith('../')) return true
  const segments = normalised.split('/')
  if (segments.some((segment) => segment.startsWith('.'))) return true
  if (segments.some((segment) => ['node_modules', 'out', 'release'].includes(segment))) return true
  return normalised.endsWith('.tmp')
}

export type WatchableWorkspace = {
  root: string
  wasRecentlyWrittenByApp: (path: string, at?: number) => boolean
}

export type WorkspaceWatcher = { dispose: () => void }

/** Native macOS recursive watcher. Bursts collapse into one sorted workspace-relative path payload. */
export function createWorkspaceWatcher(
  workspace: WatchableWorkspace,
  onChanged: (paths: string[]) => void,
  debounceMs = WATCH_BURST_DEBOUNCE_MS,
): WorkspaceWatcher {
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const flush = (): void => {
    timer = null
    if (disposed || pending.size === 0) return
    const paths = [...pending].sort((a, b) => a.localeCompare(b))
    pending.clear()
    onChanged(paths)
  }

  const watcher: FSWatcher = watch(
    workspace.root,
    { recursive: true, encoding: 'utf8' },
    (_event, filename) => {
      if (disposed || !filename) return
      const path = normaliseWatchPath(String(filename))
      if (isIgnoredWorkspaceWatchPath(path) || workspace.wasRecentlyWrittenByApp(path)) return
      pending.add(path)
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, debounceMs)
    },
  )

  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
      pending.clear()
      watcher.close()
    },
  }
}
