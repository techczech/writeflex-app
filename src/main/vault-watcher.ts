/**
 * Watches one Collection root's `.writeflex/vault.json` for changes made outside this app (file sync or
 * git bringing another Mac's edit), on its own: it does not depend on the document watcher, so it works
 * when Settings turns `workspace.watchExternalChanges` off.
 *
 * Two non-recursive native watches: the root itself, so that a `.writeflex` folder appearing, vanishing
 * or being replaced re-attaches the second; and the `.writeflex` folder, where only the name
 * `vault.json` counts (the app's own temporary files and other store files are ignored). Every touch is
 * passed to `onTouched` through a debounce with a maximum wait, so a steady stream of events still
 * notifies at least once a second. The store compares bytes itself, so the app's own writes are not
 * filtered here.
 *
 * Names are matched as the root's volume compares them (Unicode-normalised; case-folded on a volume
 * that ignores case, so `VAULT.JSON` from a sync tool counts). A watch that fails (its `error` event,
 * or a watch that cannot be made on a folder that is there) is closed and attached again after 1 s,
 * 5 s, 30 s and then every 30 s, until the watcher is disposed; each re-attach makes the store look.
 */
import { lstatSync, watch as nativeWatch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

export const VAULT_NOTICE_DEBOUNCE_MS = 220
/** The longest a pending vault notice waits, counted from the first touch of a burst. */
export const VAULT_NOTICE_MAX_WAIT_MS = 1_000

export type BoundedDebounce = { touch: () => void; dispose: () => void }

/**
 * Calls `fn` once `waitMs` have passed without a touch, but never later than `maxWaitMs` after the
 * first touch since the last call: a stream of touches cannot postpone it for ever.
 */
export function boundedDebounce(fn: () => void, waitMs: number, maxWaitMs: number, now: () => number = Date.now): BoundedDebounce {
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstAt = 0
  let disposed = false
  const fire = (): void => {
    timer = null
    if (!disposed) fn()
  }
  return {
    touch: () => {
      if (disposed) return
      const at = now()
      if (timer === null) firstAt = at
      else clearTimeout(timer)
      timer = setTimeout(fire, Math.max(0, Math.min(waitMs, firstAt + maxWaitMs - at)))
    },
    dispose: () => {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

export type VaultFileWatch = { dispose: () => void }

/** The native watch, injectable for tests: `(path, listener) => watcher`, non-recursive. */
export type WatchFunction = (path: string, listener: (filename: string | null) => void) => Pick<FSWatcher, 'close' | 'on'>

const defaultWatch: WatchFunction = (path, listener) =>
  nativeWatch(path, { encoding: 'utf8' }, (_event, filename) => listener(filename === null ? null : String(filename)))

export const VAULT_FOLDER_NAME = '.writeflex'
export const VAULT_FILE_NAME = 'vault.json'

/** How long a failed watch waits before it is attached again: 1 s, 5 s, 30 s, then every 30 s. */
export const VAULT_WATCH_RETRY_MS: readonly number[] = [1_000, 5_000, 30_000]

/**
 * Whether an event's `filename` is `expected` as the volume compares names: Unicode-normalised always,
 * and case-folded when the volume ignores case. While the volume's answer is still being probed, names
 * are folded (the wider match: a spurious touch only makes the store look at the bytes once more).
 */
function nameMatcher(ignoresCase: boolean | Promise<boolean> | undefined): (filename: string, expected: string) => boolean {
  let fold = ignoresCase === true || ignoresCase instanceof Promise
  if (ignoresCase instanceof Promise) void ignoresCase.then((answer) => { fold = answer }, () => { fold = false })
  return (filename, expected) => {
    const name = filename.normalize('NFC')
    return fold ? name.toLowerCase().normalize('NFC') === expected : name === expected
  }
}

/**
 * Re-attaches a failed watch after a bounded backoff (`delays`, the last repeated). The count restarts
 * once a re-attached watch has lived for the longest delay without failing.
 */
function backoff(delays: readonly number[], retry: () => void): { failed: () => void; attached: () => void; dispose: () => void } {
  let attempt = 0
  let attachedAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  const longest = Math.max(...delays)
  return {
    failed: () => {
      if (disposed || timer) return
      if (attachedAt && Date.now() - attachedAt >= longest) {
        attempt = 0
        // The healthy-period reset is consumed once; only a successful attach sets `attachedAt` again.
        attachedAt = 0
      }
      const delay = delays[Math.min(attempt, delays.length - 1)]!
      attempt += 1
      timer = setTimeout(() => {
        timer = null
        if (!disposed) retry()
      }, delay)
    },
    attached: () => {
      attachedAt = Date.now()
    },
    dispose: () => {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}

/** Start watching `root`'s vault file; `onTouched` runs (debounced, bounded) when it may have changed. */
export function watchVaultFile(
  root: string,
  onTouched: () => void,
  options: {
    debounceMs?: number
    maxWaitMs?: number
    watch?: WatchFunction
    /** Does the root's volume ignore case in names (the vault store's probe)? Exact names when not given. */
    ignoresCase?: boolean | Promise<boolean>
    /** Backoff before a failed watch is attached again; the last value repeats. */
    retryDelaysMs?: readonly number[]
  } = {},
): VaultFileWatch {
  const watch = options.watch ?? defaultWatch
  const debounce = boundedDebounce(onTouched, options.debounceMs ?? VAULT_NOTICE_DEBOUNCE_MS, options.maxWaitMs ?? VAULT_NOTICE_MAX_WAIT_MS)
  const matches = nameMatcher(options.ignoresCase)
  const delays = options.retryDelaysMs?.length ? options.retryDelaysMs : VAULT_WATCH_RETRY_MS
  let disposed = false
  let folderWatch: Pick<FSWatcher, 'close' | 'on'> | null = null
  /** Identity of the folder `folderWatch` is attached to, so an unchanged folder is not re-attached. */
  let folderId: string | null = null
  let rootWatch: Pick<FSWatcher, 'close' | 'on'> | null = null

  const close = (watcher: Pick<FSWatcher, 'close'> | null): void => {
    try {
      watcher?.close()
    } catch {
      // Already gone with its folder.
    }
  }
  const detachFolder = (): void => {
    close(folderWatch)
    folderWatch = null
    folderId = null
  }
  // After a failed watch is attached again, the store looks once: a change may have landed meanwhile.
  const folderRetry = backoff(delays, () => {
    attachFolder()
    debounce.touch()
  })
  const rootRetry = backoff(delays, () => {
    attachRoot()
    attachFolder()
    debounce.touch()
  })

  /** (Re)attach to the `.writeflex` folder now standing in the root, unless already attached to that
   *  very folder; quietly nothing when there is none (or it is not a real folder). */
  const attachFolder = (): void => {
    if (disposed) return
    const entry = (() => {
      try {
        return lstatSync(join(root, VAULT_FOLDER_NAME))
      } catch {
        return null
      }
    })()
    const id = entry?.isDirectory() ? `${entry.dev}:${entry.ino}` : null
    if (folderWatch && id === folderId) return
    detachFolder()
    if (id === null) return
    try {
      const watcher = watch(join(root, VAULT_FOLDER_NAME), (filename) => {
        if (filename === null || matches(filename, VAULT_FILE_NAME)) debounce.touch()
      })
      watcher.on('error', () => {
        if (folderWatch !== watcher) return
        detachFolder()
        folderRetry.failed()
      })
      folderWatch = watcher
      folderId = id
      folderRetry.attached()
    } catch {
      folderWatch = null
      folderId = null
      folderRetry.failed()
    }
  }

  /** (Re)attach the watch on the root itself, which notices `.writeflex` appearing or being replaced. */
  const attachRoot = (): void => {
    if (disposed || rootWatch) return
    try {
      const watcher = watch(root, (filename) => {
        if (filename !== null && !matches(filename, VAULT_FOLDER_NAME)) return
        attachFolder()
        debounce.touch()
      })
      watcher.on('error', () => {
        if (rootWatch !== watcher) return
        close(watcher)
        rootWatch = null
        rootRetry.failed()
      })
      rootWatch = watcher
      rootRetry.attached()
    } catch {
      rootWatch = null
      rootRetry.failed()
    }
  }

  attachRoot()
  attachFolder()

  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      debounce.dispose()
      folderRetry.dispose()
      rootRetry.dispose()
      detachFolder()
      close(rootWatch)
      rootWatch = null
    },
  }
}
