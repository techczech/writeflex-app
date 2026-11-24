/**
 * Folder watches that share one native watch per Collection root (macOS).
 *
 * Why: on macOS every `fs.watch` of a folder, recursive or not, is a path in the ONE FSEvents stream
 * that libuv keeps per process. Closing such a watch while any other is open makes libuv stop that
 * stream and start a new one for the paths left, and the closing thread waits for it on a semaphore.
 * Starting a stream is a round trip to fseventsd: 0.1–1.3 s each on a loaded Mac (measured at load
 * ~40). A window held four or five folder watches (the document watcher, the vault file's two, the
 * request inbox, any widget folders) and the app-wide sharing-signals watch stays open, so closing a
 * window blocked the main process for 2–9 s, after the window had gone and before quit could start
 * (close checkpoints, agent disposal and the Git sync send all waited behind it).
 *
 * Here a folder watch under a root that is already watched (or under `anchor`) is served from that
 * root's one native recursive watch. The native watch is closed with its last user, so a window's close
 * costs one stream restart, not five.
 *
 * What a user hears is what a native watch of its own folder would have reported, by NAME: names
 * relative to the folder, only direct entries unless `recursive`, and the folder itself by its own
 * name. Event TYPES may differ for an event on the watched folder itself (libuv drops the rename flag
 * for a folder's own watch, so it says 'change' where the root's watch says 'rename'); no caller reads
 * the type. One case cannot be told apart from the root's watch: libuv names an event on the ROOT
 * itself by the root's own name, the same name an entry of the root with that name gets. So a folder
 * whose path below the root is exactly the root's own name (`Book/Book`) gets a native watch of its own.
 *
 * Errors are as `fs.watch` gives them: a native watch's error ends it for every user sharing it, each
 * user's `error` listeners are told, and a user with none gets it thrown (unhandled), as an `FSWatcher`
 * with no listener would. A later watch of the root makes a new native watch.
 *
 * A path that is not a folder (macOS watches files with kqueue, not FSEvents) and every other platform
 * get a plain native watch.
 */
import { realpathSync, statSync, watch as nodeWatch } from 'node:fs'
import { basename } from 'node:path'

export type FolderWatchListener = (eventType: string, filename: string | null) => void

/** The part of `FSWatcher` WriteFlex's watchers use. */
export type FolderWatch = {
  close(): void
  on(event: 'error', listener: (error: Error) => void): FolderWatch
}

type NativeWatch = {
  close(): void
  on(event: 'error', listener: (error: Error) => void): unknown
}

export type SharedFolderWatchPorts = {
  /** A native recursive watch of a folder; `fs.watch` in the app. */
  watch(path: string, listener: FolderWatchListener): NativeWatch
  /** Plain `fs.watch` for whatever is not shared (files; other platforms). */
  plain(path: string, recursive: boolean, listener: FolderWatchListener): FolderWatch
  /** The real path (as libuv reports it); throws as `fs.watch` would for a missing path. */
  realpath(path: string): string
  isDirectory(realPath: string): boolean
  shares: boolean
}

type Subscriber = {
  rel: string
  recursive: boolean
  listener: FolderWatchListener
  errorListeners: Array<(error: Error) => void>
  closed: boolean
}

type Shared = { native: NativeWatch; subscribers: Set<Subscriber> }

/** Is `ancestor` the folder `path` or one above it (both real paths)? */
function contains(ancestor: string, path: string): boolean {
  if (ancestor === path) return true
  return path.startsWith(ancestor.endsWith('/') ? ancestor : `${ancestor}/`)
}

function relativeTo(ancestor: string, path: string): string {
  if (ancestor === path) return ''
  return path.slice(ancestor.endsWith('/') ? ancestor.length : ancestor.length + 1)
}

/** Can a watch of `key` serve a user of `real` without confusing the two (see the file comment)? */
function canServe(key: string, real: string): boolean {
  return contains(key, real) && relativeTo(key, real) !== basename(key)
}

/** What a native watch of `sub`'s folder would have reported for an event the root's watch reported as `filename`. */
function nameFor(sub: Subscriber, filename: string): string | null {
  let name: string
  if (sub.rel === '') name = filename
  else if (filename === sub.rel) name = basename(sub.rel) // the folder itself, as libuv names it
  else if (filename.startsWith(`${sub.rel}/`)) name = filename.slice(sub.rel.length + 1)
  else return null
  if (!sub.recursive && name.includes('/')) return null
  return name
}

function call(run: () => void): void {
  // One user's fault must not stop the others hearing the event; it still surfaces as it would have.
  try { run() } catch (error) { queueMicrotask(() => { throw error }) }
}

export function createSharedFolderWatches(ports: SharedFolderWatchPorts) {
  const shared = new Map<string, Shared>()

  const drop = (key: string, entry: Shared): void => {
    if (shared.get(key) === entry) shared.delete(key)
    try { entry.native.close() } catch { /* already gone */ }
  }

  const open = (key: string): Shared => {
    const entry: Shared = { native: null as unknown as NativeWatch, subscribers: new Set() }
    entry.native = ports.watch(key, (eventType, filename) => {
      for (const sub of [...entry.subscribers]) {
        if (sub.closed) continue
        if (filename === null) { call(() => sub.listener(eventType, null)); continue }
        const name = nameFor(sub, filename)
        if (name !== null) call(() => sub.listener(eventType, name))
      }
    })
    // The native watch is gone for everyone sharing it: each hears the error as its own watch would
    // have told it (thrown, when it has no listener), and a later watch of the root makes a new one.
    entry.native.on('error', (error: Error) => {
      const subscribers = [...entry.subscribers]
      entry.subscribers.clear()
      drop(key, entry)
      for (const sub of subscribers) {
        if (sub.closed) continue
        sub.closed = true
        if (sub.errorListeners.length === 0) queueMicrotask(() => { throw error })
        for (const listener of sub.errorListeners) call(() => listener(error))
      }
    })
    shared.set(key, entry)
    return entry
  }

  return {
    /**
     * Watch the folder `path` as `fs.watch(path, { recursive })` would. `anchor`: the Collection root
     * it lies in; when no watch above the folder is open yet, the shared one is made at the anchor, so
     * the root's other watches can join it whatever order they start in.
     */
    watch(path: string, options: { recursive?: boolean; anchor?: string }, listener: FolderWatchListener): FolderWatch {
      const recursive = options.recursive === true
      if (!ports.shares) return ports.plain(path, recursive, listener)
      const real = ports.realpath(path)
      if (!ports.isDirectory(real)) return ports.plain(path, recursive, listener)
      let key: string | undefined
      for (const candidate of shared.keys()) {
        if (canServe(candidate, real) && (key === undefined || candidate.length < key.length)) key = candidate
      }
      if (key === undefined && options.anchor !== undefined) {
        try {
          const anchor = ports.realpath(options.anchor)
          if (canServe(anchor, real) && ports.isDirectory(anchor)) key = anchor
        } catch { /* no anchor folder: watch the folder itself */ }
      }
      key ??= real
      const entry = shared.get(key) ?? open(key)
      const sub: Subscriber = { rel: relativeTo(key, real), recursive, listener, errorListeners: [], closed: false }
      entry.subscribers.add(sub)
      const handle: FolderWatch = {
        close: () => {
          if (sub.closed) return
          sub.closed = true
          entry.subscribers.delete(sub)
          if (entry.subscribers.size === 0) drop(key, entry)
        },
        on: (_event, errorListener) => { sub.errorListeners.push(errorListener); return handle },
      }
      return handle
    },
    /** How many native watches are open (tests). */
    get nativeCount() { return shared.size },
  }
}

const appWatches = createSharedFolderWatches({
  watch: (path, listener) => nodeWatch(path, { recursive: true, encoding: 'utf8' }, (eventType, filename) => listener(eventType, filename ?? null)),
  plain: (path, recursive, listener) => nodeWatch(path, { recursive, encoding: 'utf8' }, (eventType, filename) => listener(eventType, filename ?? null)) as unknown as FolderWatch,
  realpath: (path) => realpathSync.native(path),
  isDirectory: (path) => statSync(path).isDirectory(),
  shares: process.platform === 'darwin',
})

/** `fs.watch` for a folder, sharing one native watch per Collection root on macOS (see the file comment). */
export function watchFolder(path: string, options: { recursive?: boolean; anchor?: string }, listener: FolderWatchListener): FolderWatch {
  return appWatches.watch(path, options, listener)
}
