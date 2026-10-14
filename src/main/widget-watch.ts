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
export type WidgetWatchDeps = {
  /** Watch one folder (not recursive); `listener` gets the changed entry's name. */
  watchFolder(folder: string, listener: (name: string) => void): FolderWatch
  /** Report changed workspace-relative paths to one window. */
  notify(windowId: number, paths: string[]): void
  debounceMs?: number
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
  type Watch = { count: number; handle: FolderWatch; timer: ReturnType<typeof setTimeout> | null }
  const watches = new Map<string, Watch>() // `${windowId}\0${path}`

  return {
    /** Start (or count one more user of) the watch of `path` for this window, when the workspace watcher
     *  ignores it, as typed or as really located (`target`, from resolveWidgetWatchTarget). Returns whether a
     *  watch of its own is in place. The change is reported under `path`, the path the block names. */
    watch(windowId: number, path: string, target: WidgetWatchTarget): boolean {
      if (!isIgnoredWorkspaceWatchPath(path) && !isIgnoredWorkspaceWatchPath(target.relativePath)) return false
      const key = `${windowId}\u0000${path}`
      const existing = watches.get(key)
      if (existing) { existing.count += 1; return true }
      const { name } = target
      let handle: FolderWatch
      try {
        handle = deps.watchFolder(target.folder, (changed) => {
          if (changed !== name) return
          const entry = watches.get(key)
          if (!entry) return
          if (entry.timer) clearTimeout(entry.timer)
          entry.timer = setTimeout(() => { entry.timer = null; deps.notify(windowId, [path]) }, debounceMs)
        })
      } catch {
        return false // the folder does not exist (yet): nothing to watch
      }
      watches.set(key, { count: 1, handle, timer: null })
      return true
    },
    /** One user fewer; the watch goes with the last. */
    unwatch(windowId: number, path: string): void {
      const key = `${windowId}\u0000${path}`
      const entry = watches.get(key)
      if (!entry) return
      entry.count -= 1
      if (entry.count > 0) return
      if (entry.timer) clearTimeout(entry.timer)
      try { entry.handle.close() } catch { /* already gone */ }
      watches.delete(key)
    },
    /** A window closed: every watch of its goes. */
    disposeWindow(windowId: number): void {
      for (const [key, entry] of [...watches]) {
        if (!key.startsWith(`${windowId}\u0000`)) continue
        if (entry.timer) clearTimeout(entry.timer)
        try { entry.handle.close() } catch { /* already gone */ }
        watches.delete(key)
      }
    },
    get size() { return watches.size },
  }
}
