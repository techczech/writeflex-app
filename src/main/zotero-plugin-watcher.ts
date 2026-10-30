/**
 * Send what is waiting once Zotero, with the WriteFlex plugin, can take it (ADR-0047).
 *
 * Highlights are sent at once when they are saved, and when he presses Sync now. This covers the rest:
 * while anything is waiting, the main process pings the plugin every ~10 seconds (one local GET), and
 * drains as soon as it answers.
 *
 * ```
 * nothing waiting ──▶ no timer at all
 * waiting ──▶ every 10 s: does the plugin answer? ── no ──▶ look again
 *                                                  └ yes, and it did not before ──▶ drain at once
 *                                                  └ yes, as before ──▶ drain if a minute has passed
 * ```
 *
 * **At once on the edge, then at most once a minute.** A row Zotero asked to retry ("Zotero is saving
 * this highlight") is picked up within a minute, without a request every ten seconds for as long as
 * WriteFlex runs. The ping is a trigger, not a gate: the drain pings again and refuses on its own.
 */
export const ZOTERO_PLUGIN_POLL_MS = 10_000
export const ZOTERO_PLUGIN_REDRAIN_MS = 60_000

export type WatcherClock = {
  setTimeout(callback: () => void, milliseconds: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

export type ZoteroPluginWatcherOptions = {
  /** True while the outbox holds anything a drain could write. Read before every look. */
  hasPending: () => boolean
  /** Does the plugin answer? A throw counts as no. */
  isReachable: () => Promise<boolean>
  /** Send everything waiting. Its own failures are its business; a throw here is swallowed. */
  drain: () => Promise<void>
  intervalMs?: number
  redrainMs?: number
  clock?: WatcherClock
}

export type ZoteroPluginWatcher = {
  /**
   * Something may now be waiting: start looking if not already. After a drain run elsewhere, pass
   * whether it reached the plugin, so the watcher neither repeats it nor misses the next edge.
   */
  poke(hint?: { reachable?: boolean }): void
  stop(): void
  /** True while a look is scheduled or running. */
  readonly polling: boolean
}

const systemClock: WatcherClock = {
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => {
    const handle = setTimeout(callback, milliseconds)
    // A pending look must never be the thing keeping the process alive at quit.
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  },
}

export function createZoteroPluginWatcher(options: ZoteroPluginWatcherOptions): ZoteroPluginWatcher {
  const clock = options.clock ?? systemClock
  const intervalMs = options.intervalMs ?? ZOTERO_PLUGIN_POLL_MS
  const redrainMs = options.redrainMs ?? ZOTERO_PLUGIN_REDRAIN_MS
  let timer: unknown = null
  let looking = false
  let stopped = false
  /** What the last look (or drain) found: null = not known since the queue last emptied. */
  let lastReachable: boolean | null = null
  let lastDrainAt = Number.NEGATIVE_INFINITY

  const schedule = (): void => {
    if (stopped || timer !== null || looking) return
    timer = clock.setTimeout(() => {
      timer = null
      void look()
    }, intervalMs)
  }

  const look = async (): Promise<void> => {
    if (stopped) return
    if (!options.hasPending()) {
      lastReachable = null
      return
    }
    looking = true
    try {
      let reachable: boolean
      try {
        reachable = await options.isReachable()
      } catch {
        reachable = false
      }
      if (stopped) return
      const due = reachable && (lastReachable !== true || clock.now() - lastDrainAt >= redrainMs)
      lastReachable = reachable
      if (due) {
        lastDrainAt = clock.now()
        try {
          await options.drain()
        } catch {
          // The drain records and reports its own failures; the watcher only decides when.
        }
      }
    } finally {
      looking = false
    }
    if (stopped) return
    if (options.hasPending()) schedule()
    else lastReachable = null
  }

  return {
    poke(hint) {
      if (stopped) return
      if (hint?.reachable !== undefined && !looking) {
        lastReachable = hint.reachable
        if (hint.reachable) lastDrainAt = clock.now()
      }
      if (options.hasPending()) schedule()
    },
    get polling() {
      return timer !== null || looking
    },
    stop() {
      stopped = true
      if (timer !== null) clock.clearTimeout(timer)
      timer = null
    },
  }
}
