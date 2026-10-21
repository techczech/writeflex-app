import { watch, type FSWatcher } from 'node:fs'
import { isAbsolute, posix } from 'node:path'

export const OWN_WRITE_DEDUPE_MS = 5_000
export const WATCH_BURST_DEBOUNCE_MS = 220
/**
 * How long a path the watcher saw vanish is waited for before it counts as gone (sharing ticket 04:
 * a shared piece deleted outside WriteFlex). Several bursts long, so a move another program makes as
 * copy-then-delete, or delete-then-create, is seen whole.
 */
export const WATCH_SETTLE_MS = 2_000

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

/** Where the watcher's raw events go: document paths in sorted bursts. (The vault settings file has
 *  its own watcher, vault-watcher.ts, which runs whatever this setting says.) */
export type WatchRouter = { take: (filename: string) => void; dispose: () => void }

/**
 * The watcher's rule, apart from the native watch so it can be tested: ignored paths (every dot-path,
 * `.writeflex` included) are dropped, and every other path is collected into a burst for `onChanged`
 * unless the app wrote it itself.
 */
export function createWatchRouter(
  workspace: WatchableWorkspace,
  onChanged: (paths: string[]) => void,
  debounceMs = WATCH_BURST_DEBOUNCE_MS,
): WatchRouter {
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

  return {
    take: (filename) => {
      if (disposed || !filename) return
      const path = normaliseWatchPath(String(filename))
      if (isIgnoredWorkspaceWatchPath(path) || workspace.wasRecentlyWrittenByApp(path)) return
      pending.add(path)
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, debounceMs)
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
      pending.clear()
    },
  }
}

/** Native macOS recursive watcher. Bursts collapse into one sorted workspace-relative path payload. */
export function createWorkspaceWatcher(
  workspace: WatchableWorkspace,
  onChanged: (paths: string[]) => void,
  debounceMs = WATCH_BURST_DEBOUNCE_MS,
): WorkspaceWatcher {
  const router = createWatchRouter(workspace, onChanged, debounceMs)
  let disposed = false
  const watcher: FSWatcher = watch(
    workspace.root,
    { recursive: true, encoding: 'utf8' },
    (_event, filename) => {
      if (!disposed && filename) router.take(String(filename))
    },
  )

  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      router.dispose()
      watcher.close()
    },
  }
}
