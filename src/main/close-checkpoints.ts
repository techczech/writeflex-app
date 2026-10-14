/**
 * The checkpoints a closing window owes (ADR-0013 tier 2, and ADR-0031's one Initial version per
 * document). They used to be awaited by the renderer, one IPC call per open tab, before the window was
 * allowed to close; a window with many tabs took seconds to go. The text is already on disk by then
 * (the renderer's flush), so they now run in main, after the window has been let go, as best-effort
 * work with a time limit of their own.
 *
 * Electron-free: the caller supplies what one checkpoint does.
 */

/** How long a closing window's checkpoints may go on STARTING documents. Shorter than will-quit's
 *  1500 ms cleanup bound, so a quit rarely cuts a run off: the run stops itself and says how much it
 *  left undone. The checkpoint in flight at the limit is finished, not abandoned. */
export const CLOSE_CHECKPOINT_BUDGET_MS = 1000
/** More paths than any window has tabs; a longer list from the renderer is cut here. */
export const CLOSE_CHECKPOINT_MAX_PATHS = 500

export type CloseCheckpointPorts = {
  /** Resolve what every path needs (the window's agent, the author) once; the result checkpoints one path. */
  prepare(): Promise<(path: string) => Promise<void>>
  record(event: string, details: Record<string, unknown>): void
  now(): number
  setTimer?(run: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

export type CloseCheckpointRun = {
  /** Settles when no checkpoint of this run is in flight and none will start: every path is done, or
   *  the budget is spent (or `stop()` was called) AND the checkpoint that was running then has finished.
   *  This is what quit tracking and the agent's disposal wait on. Never rejects. */
  done: Promise<void>
  /** Start no further path. `done` settles once the checkpoint in flight, if any, has finished. */
  stop(): void
}

/** The renderer's list, read strictly: relative path strings, each once, in the order sent. */
export function parseCloseCheckpointPaths(input: unknown, isAllowed: (path: string) => boolean): string[] {
  if (!input || typeof input !== 'object') return []
  const list = (input as { checkpoint?: unknown }).checkpoint
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  for (const path of list) {
    if (seen.size >= CLOSE_CHECKPOINT_MAX_PATHS) break
    if (typeof path !== 'string' || path === '' || seen.has(path)) continue
    try { if (!isAllowed(path)) continue } catch { continue }
    seen.add(path)
  }
  return [...seen]
}

/**
 * Checkpoint `paths` one after another, in order (the caller puts the changed documents first). A path
 * that fails is skipped. When the budget is spent no further path is started; the one in progress is
 * finished, and the run is over only then. A checkpoint is a snapshot-store write and a journal append
 * made with the window's agent: the run stays in quit tracking, and holds the agent's disposal back,
 * until that write has settled. `dropped` in `close.checkpoints.settled` counts the paths that were not
 * checkpointed (never started, or failed); `elapsedMs` above the budget is the wait for the last one.
 */
export function startCloseCheckpoints(paths: string[], ports: CloseCheckpointPorts, budgetMs = CLOSE_CHECKPOINT_BUDGET_MS): CloseCheckpointRun {
  const setTimer = ports.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer = ports.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const startedAt = ports.now()
  let finished = 0
  /** The budget is spent or the run was stopped: no further path starts. */
  let stopped = false
  const timer = setTimer(() => { stopped = true }, budgetMs)
  const done = (async () => {
    try {
      const checkpoint = await ports.prepare()
      for (const path of paths) {
        if (stopped) break
        try {
          await checkpoint(path)
          finished += 1
        } catch { /* one document's checkpoint failed: the others are still owed */ }
      }
    } catch { /* no agent for this window: nothing can be checkpointed */ }
    stopped = true
    try {
      clearTimer(timer)
      ports.record('close.checkpoints.settled', { count: paths.length, elapsedMs: ports.now() - startedAt, dropped: paths.length - finished })
    } catch { /* a diagnostic that failed changes nothing */ }
  })()
  return { done, stop: () => { stopped = true } }
}
