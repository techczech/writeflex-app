/**
 * Widget files the workspace watcher does not see (interactive-widgets-in-documents, security round 3,
 * S2). The workspace watcher ignores hidden and build folders (`.widgets/`, `out/`: workspace-watcher.ts),
 * but a widget may live there and run. Such a widget file gets a watch of its own: its folder, not
 * recursive, filtered to the file's name (an editor that saves by replacing the file is still seen), one
 * per file and window however many blocks show it, removed when the last block showing it goes or the
 * window closes. A change is reported on the same channel as the workspace watcher's, with the path as
 * the block names it.
 */
import { dirname, basename, isAbsolute, join, posix, relative, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import { isIgnoredWorkspaceWatchPath } from './workspace-watcher'

export type FolderWatch = { close(): void }
/** After a watch fails, how long until it is made again; after the last, the watch is given up. */
export const WIDGET_WATCH_RETRY_MS: readonly number[] = [1_000, 5_000, 30_000]
export type WidgetWatchDeps = {
  /** Watch one folder (not recursive); `listener` gets the changed entry's name; `failed` is told if the
   *  watch stops (it then reports nothing more). */
  watchFolder(folder: string, listener: (name: string) => void, failed: (error: Error) => void): FolderWatch
  /** Report changed workspace-relative paths to one window. */
  notify(windowId: number, paths: string[]): void
  debounceMs?: number
  retryDelaysMs?: readonly number[]
}

/** The workspace-relative path an embed line names, written as the block writes it; null when it leaves the root. */
export function widgetLexicalPath(documentPath: string, rawPath: string): string | null {
  const raw = rawPath.trim()
  if (!raw || isAbsolute(raw) || /^(?:[a-z][a-z0-9+.-]+:|\/\/)/i.test(raw)) return null
  const joined = posix.normalize(posix.join(posix.dirname(documentPath.replaceAll('\\', '/')), raw.replaceAll('\\', '/')))
  if (joined === '..' || joined.startsWith('../') || joined.startsWith('/') || joined === '.') return null
  return joined
}

/** Where the watch sits: the real folder, the real name the folder's events carry, and the real path from the root. */
export type WidgetWatchTarget = { folder: string; name: string; relativePath: string }

function insideRoot(realRoot: string, realPath: string): boolean {
  return realPath === realRoot || realPath.startsWith(realRoot + sep)
}

/** The real location of the file a block names. Symlinks in the folders or the file are followed; the file's real
 *  parent folder must sit inside the real workspace root, or there is no target. A file that does not exist yet
 *  keeps the name as typed, inside its real folder. The real name follows the on-disk case (macOS), which is the
 *  name the folder watch reports. */
export async function resolveWidgetWatchTarget(root: string, path: string): Promise<WidgetWatchTarget | null> {
  let realRoot: string
  let realFolder: string
  try {
    realRoot = await realpath(root)
    realFolder = await realpath(join(root, dirname(path)))
  } catch {
    return null // the folder does not exist (yet)
  }
  if (!insideRoot(realRoot, realFolder)) return null
  let realFile: string | null = null
  try { realFile = await realpath(join(root, path)) } catch { realFile = null }
  if (realFile !== null) {
    const folder = dirname(realFile)
    if (!insideRoot(realRoot, folder)) return null
    return { folder, name: basename(realFile), relativePath: relative(realRoot, realFile).split(sep).join('/') }
  }
  const name = basename(path)
  return { folder: realFolder, name, relativePath: relative(realRoot, join(realFolder, name)).split(sep).join('/') }
}

export function createWidgetWatches(deps: WidgetWatchDeps) {
  const debounceMs = deps.debounceMs ?? 150
  const delays = deps.retryDelaysMs ?? WIDGET_WATCH_RETRY_MS
  type Watch = {
    count: number
    handle: FolderWatch | null
    timer: ReturnType<typeof setTimeout> | null
    /** Making the watch again after it failed; `failures` counts failures since the last event. */
    retry: ReturnType<typeof setTimeout> | null
    failures: number
  }
  const watches = new Map<string, Watch>() // `${windowId}\0${path}`

  const changed = (key: string, entry: Watch, windowId: number, path: string): void => {
    if (watches.get(key) !== entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => { entry.timer = null; deps.notify(windowId, [path]) }, debounceMs)
  }
  /** Make the folder watch for `entry`; throws when the folder cannot be watched. If it fails later, it is
   *  made again (after 1 s, 5 s, 30 s), so the widgets already showing go on being refreshed; the file is
   *  then reported changed once, for any edit made meanwhile. After the last attempt the entry goes, and
   *  the next block that shows the widget starts afresh. */
  const attach = (key: string, entry: Watch, windowId: number, path: string, target: WidgetWatchTarget): void => {
    let handle: FolderWatch | null = null
    handle = deps.watchFolder(target.folder, (name) => {
      if (name !== target.name || entry.handle !== handle) return
      entry.failures = 0
      changed(key, entry, windowId, path)
    }, () => {
      if (watches.get(key) !== entry || entry.handle !== handle) return
      entry.handle = null
      try { handle?.close() } catch { /* already gone */ }
      const delay = delays[entry.failures]
      entry.failures += 1
      if (delay === undefined) { drop(key, entry); return }
      entry.retry = setTimeout(() => {
        entry.retry = null
        if (watches.get(key) !== entry) return
        try { attach(key, entry, windowId, path, target) } catch { drop(key, entry); return }
        changed(key, entry, windowId, path)
      }, delay)
    })
    entry.handle = handle
  }
  const drop = (key: string, entry: Watch): void => {
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.retry) clearTimeout(entry.retry)
    try { entry.handle?.close() } catch { /* already gone */ }
    entry.handle = null
    if (watches.get(key) === entry) watches.delete(key)
  }

  return {
    /** Start (or count one more user of) the watch of `path` for this window, when the workspace watcher
     *  ignores it, as typed or as really located (`target`, from resolveWidgetWatchTarget). Returns whether a
     *  watch of its own is in place. The change is reported under `path`, the path the block names. */
    watch(windowId: number, path: string, target: WidgetWatchTarget): boolean {
      if (!isIgnoredWorkspaceWatchPath(path) && !isIgnoredWorkspaceWatchPath(target.relativePath)) return false
      const key = `${windowId}\u0000${path}`
      const existing = watches.get(key)
      if (existing) { existing.count += 1; return true }
      const entry: Watch = { count: 1, handle: null, timer: null, retry: null, failures: 0 }
      watches.set(key, entry)
      try {
        attach(key, entry, windowId, path, target)
      } catch {
        watches.delete(key)
        return false // the folder does not exist (yet): nothing to watch
      }
      return true
    },
    /** One user fewer; the watch goes with the last. */
    unwatch(windowId: number, path: string): void {
      const key = `${windowId}\u0000${path}`
      const entry = watches.get(key)
      if (!entry) return
      entry.count -= 1
      if (entry.count > 0) return
      drop(key, entry)
    },
    /** A window closed: every watch of its goes. */
    disposeWindow(windowId: number): void {
      for (const [key, entry] of [...watches]) {
        if (!key.startsWith(`${windowId}\u0000`)) continue
        drop(key, entry)
      }
    },
    get size() { return watches.size },
  }
}
