/**
 * Keeps a RequestExecutor answering while a Collection is open: the thin wiring between the running
 * app and request-executor.ts. It looks at the inbox when the folder changes and, because a folder
 * watch on a synced disk can miss an arrival, also every two seconds. It does not depend on the
 * "watch for outside changes" setting, which governs documents, not requests.
 *
 * WHAT IT REMEMBERS IS KEPT TO A COUNT. An ignored file or a failure is told once, not at every look;
 * the names already told are kept in a `ToldOnce`, which holds at most MAX_NAMES_REMEMBERED of them
 * and forgets the oldest first. A folder filled with stray names therefore costs the watch that many
 * names of memory and no more; a name forgotten is simply told again if it is still there.
 *
 * The executor is bound to one Collection for its life (it holds that Collection's Workspace and
 * stores, given when it was made). Disposing the watch disposes the executor with it.
 */
import { watch, type FSWatcher } from 'node:fs'
import { rememberUpTo } from './cli/request-files'
import { MAX_ENTRIES_LISTED, MAX_NAMES_REMEMBERED } from './cli/review-format'
import type { DrainResult, RequestExecutor } from './request-executor'

export const INBOX_POLL_MS = 2000

/** `dispose` ends the watch AND the executor; it resolves once no request is being carried out. */
export type RequestInboxWatch = { dispose: () => Promise<void> }

const pendingDisposals = new Set<Promise<void>>()

/**
 * Resolves once every disposed executor has finished the request it was carrying out. A closing
 * window cannot await; whoever releases the Collection's owner lock waits for this first, so the
 * last write of a request in flight (and the putting back of what it wrote) lands under the lock.
 */
export async function waitForRequestDisposals(): Promise<void> {
  while (pendingDisposals.size > 0) await Promise.allSettled([...pendingDisposals])
}

export type RequestInboxWatchOptions = {
  pollMs?: number
  /** Told what each look at the inbox handled or ignored, any failure to look at all, and (`cut`) a
   *  folder that holds more entries than one look lists. */
  report?: (event: 'handled' | 'ignored' | 'failed' | 'cut', details: Record<string, unknown>) => void
}

/** Which things were already told, kept to at most `max` of them: the oldest is forgotten first. */
export class ToldOnce {
  readonly #told = new Set<string>()

  constructor(private readonly max: number = MAX_NAMES_REMEMBERED) {}

  get size(): number {
    return this.#told.size
  }

  /** True the first time `key` is seen (and again once it has been forgotten). */
  first(key: string): boolean {
    if (this.#told.has(key)) return false
    rememberUpTo(this.#told, key, this.max)
    return true
  }
}

export function watchRequestInbox(executor: RequestExecutor, options: RequestInboxWatchOptions = {}): RequestInboxWatch {
  let disposed = false
  let watcher: FSWatcher | null = null
  let running = false
  let again = false
  /** Ignored files and failures already told, so a file that stays is reported once. */
  const told = new ToldOnce()
  const tellOnce = (key: string, event: 'ignored' | 'failed' | 'cut', details: Record<string, unknown>): void => {
    if (told.first(key)) options.report?.(event, details)
  }
  const tell = (result: DrainResult): void => {
    for (const handled of result.handled) options.report?.('handled', { root: executor.root, ...handled })
    for (const ignored of result.ignored) tellOnce(`ignored:${ignored.name}`, 'ignored', { root: executor.root, ...ignored })
    if (result.cut) tellOnce(`cut:${result.cut.join(',')}`, 'cut', { root: executor.root, folders: result.cut, entriesListed: MAX_ENTRIES_LISTED })
    // Shown-first requests that could not be added to the review ledger in this look: they are still in the inbox.
    // Once per look, not once per request: `failed` is the first failure and the counts say how many.
    const review = result.review
    if (review?.failed && review.repliesNotWritten > 0) options.report?.('failed', { root: executor.root, message: review.failed, repliesNotWritten: review.repliesNotWritten })
    else if (review?.failed) tellOnce(`failed:review:${review.failed}`, 'failed', { root: executor.root, message: review.failed, left: review.left })
  }
  const look = (): void => {
    if (disposed) return
    if (running) { again = true; return }
    running = true
    void executor.drain().then(tell, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      tellOnce(`failed:${message}`, 'failed', { root: executor.root, message })
    }).finally(() => {
      running = false
      if (again) { again = false; look() }
    })
  }
  void executor.inbox().then((inbox) => {
    if (disposed) return
    try {
      watcher = watch(inbox, () => look())
      watcher.on('error', () => { watcher?.close(); watcher = null }) // the poll below carries on
    } catch { /* no folder watch here: the poll below carries on */ }
  }, () => { /* reported by the first look */ })
  const timer = setInterval(look, options.pollMs ?? INBOX_POLL_MS)
  timer.unref()
  look()
  return {
    dispose: () => {
      disposed = true
      clearInterval(timer)
      watcher?.close()
      watcher = null
      const settled = executor.dispose()
      pendingDisposals.add(settled)
      void settled.then(() => { pendingDisposals.delete(settled) })
      return settled
    },
  }
}
