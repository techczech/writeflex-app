import { invalidateFolioDeclarations, watchFolioDeclarations } from './folio-declaration'
import { lstatSync, watch, type FSWatcher } from 'node:fs'
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

/**
 * What a file looks like on disk, as far as the own-write rule needs: its device and inode (a rename keeps
 * both), its size and its modification time to the nanosecond. Taken from the staged file's own handle, or by
 * `fstat` of the temporary file, before the rename that gives it its name (spec-folio-room § 6.6 D-WATCH-1).
 */
export type FileIdentity = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }

/** The state an own write leaves at its path: that file, or nothing there (a delete, the old name of a move). */
export type OwnWriteExpectation = FileIdentity | 'absent'

/** The identity of `stats` (taken with `{ bigint: true }`). */
export function fileIdentityOf(stats: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }): FileIdentity {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs }
}

/** Looks at an absolute path without following a link (`lstatSync` with `bigint`); throws as lstat does. */
export type LookAt = (absolute: string) => { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }

const lookAtDisk: LookAt = (absolute) => lstatSync(absolute, { bigint: true })

const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs

/**
 * Short-lived record of the state each WriteFlex write left at its path, shared by every write route in
 * Workspace (D-WATCH-1). An event for a path is the app's own only while the path, looked at now, still
 * holds exactly the state the write left (or nothing, for `'absent'`), within `OWN_WRITE_DEDUPE_MS`. Any
 * other state, a look that fails, or a write that recorded no state, and the event is delivered: there is
 * no rule by time alone.
 */
export class OwnWriteTracker {
  readonly #paths = new Map<string, { at: number; expected: OwnWriteExpectation | null }>()

  /** `locate` turns a workspace-relative path into the absolute one to look at; `lookAt` is the look. */
  constructor(private readonly locate: (path: string) => string, private readonly lookAt: LookAt = lookAtDisk) {}

  /** Records the state the write leaves at `path`. Without `expected` the path is recorded with no state,
   *  which suppresses nothing: whatever the write leaves there is delivered. */
  record(path: string, expected?: OwnWriteExpectation, at = Date.now()): void {
    this.#paths.set(normaliseWatchPath(path), { at, expected: expected ?? null })
  }

  isRecent(path: string, at = Date.now()): boolean {
    const key = normaliseWatchPath(path)
    const written = this.#paths.get(key)
    if (written === undefined) return false
    if (at - written.at > OWN_WRITE_DEDUPE_MS) {
      this.#paths.delete(key)
      return false
    }
    const { expected } = written
    if (expected === null) return false
    let now: FileIdentity | 'absent'
    try {
      now = fileIdentityOf(this.lookAt(this.locate(key)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') return false
      now = 'absent'
    }
    if (expected === 'absent' || now === 'absent') return expected === now
    return sameIdentity(expected, now)
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
  const releaseDeclarations = watchFolioDeclarations(workspace.root)
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const flush = (): void => {
    timer = null
    if (disposed || pending.size === 0) return
    const paths = [...pending].filter(path => !workspace.wasRecentlyWrittenByApp(path)).sort((a, b) => a.localeCompare(b))
    pending.clear()
    if (paths.length) onChanged(paths)
  }

  return {
    take: (filename) => {
      if (disposed || !filename) return
      const path = normaliseWatchPath(String(filename))
      // Hidden Folio sidecars matter; app journals do not invalidate declarations.
      invalidateFolioDeclarations(workspace.root, path)
      if (isIgnoredWorkspaceWatchPath(path) || workspace.wasRecentlyWrittenByApp(path)) return
      pending.add(path)
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, debounceMs)
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      releaseDeclarations()
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
  let router: WatchRouter | null = null
  let disposed = false
  let retried = false
  let watcher: FSWatcher | null = null

  const start = (): void => {
    const nextRouter = createWatchRouter(workspace, onChanged, debounceMs)
    let next: FSWatcher
    try {
      next = watch(workspace.root, { recursive: true, encoding: 'utf8' }, (_event, filename) => {
        if (!disposed && filename) nextRouter.take(String(filename))
      })
    } catch (error) { nextRouter.dispose(); throw error }
    router = nextRouter
    watcher = next
    next.on('error', (error) => {
      if (disposed || watcher !== next) return
      console.warn('The Collection watcher failed; releasing its cache so Folio reads check disk.', error)
      nextRouter.dispose()
      router = null
      watcher = null
      next.close()
      if (retried) {
        console.warn('The replacement Collection watcher failed; no further recreation will be attempted. Folio reads will check disk; outside changes will not reach the file tree.')
        return
      }
      retried = true
      console.warn('Attempting to recreate the Collection watcher once.')
      try { start() }
      catch (restartError) {
        console.warn('The Collection watcher could not be recreated. Folio reads will check disk; outside changes will not reach the file tree.', restartError)
      }
    })
  }
  start()

  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      router?.dispose()
      router = null
      watcher?.close()
      watcher = null
    },
  }
}
