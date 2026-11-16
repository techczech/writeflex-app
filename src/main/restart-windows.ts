// Updating in place (ADR-0054, update-engine.ts commit): an update's restart closes every window by the window's own
// close route first (the close controller: the renderer writes every document, and a write that fails keeps the
// window open), and only then may the native install be called, with no window open. No Electron here.

/**
 * Closes every window with `close` (true once it has closed, false when it was kept open). Resolves false as soon as
 * one window is kept open (or its close cannot start), and true once every window has closed.
 */
export function closeEveryWindow<W>(windows: readonly W[], close: (window: W) => Promise<boolean>): Promise<boolean> {
  if (windows.length === 0) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let left = windows.length
    for (const window of windows) {
      let closing: Promise<boolean>
      try { closing = Promise.resolve(close(window)) } catch { closing = Promise.resolve(false) }
      closing.then((closed) => {
        if (!closed) resolve(false)
        else if (--left === 0) resolve(true)
      }, () => resolve(false))
    }
  })
}

/** One window's close for a restart: its outcome, and the way to call it off (false when it is already going). */
export interface RecallableClose {
  closed: Promise<boolean>
  abandon(): boolean
}

/** The engine's side of one commit (update-engine.ts RestartClose): liveness, and where to leave the call-off. */
export interface RestartCloseTicket {
  live(): boolean
  onCallOff(callOff: () => void): void
}

export interface RestartClosePorts {
  /** Starts closing every open window now, each by its own close route; one recallable close per window. */
  closeEach(): readonly RecallableClose[]
  /** The closed windows' work (agent disposals), bounded by the caller. */
  finishWork(): Promise<void>
  /** The backup helper's restart side, once it exists: stop it last (as a quit does), and start it again. */
  backup(): { stop(): Promise<boolean>; resume(): void } | null
  windowCount(): number
  openWindow(): void
  /** The person asked WriteFlex to quit (before-quit): recovery then does nothing, now or deferred. */
  quitting?(): boolean
  log?(message: string): void
}

/**
 * The app's side of an update's commit (ADR-0054): close every window, wait for their work, stop the backup helper
 * last, and recover when the restart is called off. The attempt's liveness is read before every step after the
 * windows have closed, so an ended attempt never stops the helper. On call-off every close that can still be
 * recalled is abandoned (that window stays open). `recover()` is idempotent: it starts the helper again if this
 * commit stopped it (after a stop still under way has settled) and opens a window if none is left. The engine calls
 * it when the attempt ends and again once `close()`'s promise has settled; that promise, once called off, settles
 * only after every window's close has settled, so a window that was already going is counted.
 */
export function createRestartClose(ports: RestartClosePorts) {
  /** This commit stopped (or is stopping) the helper and nothing has started it again. */
  let stopped = false
  /** A stop under way: recovery waits for it, or the helper would be started and then stopped. */
  let stopping = false
  let recoverAfterStop = false
  /** A recovery skipped because a quit was under way; a quit can still be called off (a save failed), and then it runs. */
  let recoverWhenQuitCancelled = false

  function recover(): void {
    // A quit the person asked for wins: no backup start and no new window, also for a recovery deferred behind a stop.
    // The quit is only intent until it happens, so the recovery is kept for quitCancelled().
    if (ports.quitting?.() === true) { recoverAfterStop = false; recoverWhenQuitCancelled = true; return }
    if (stopping) recoverAfterStop = true
    else if (stopped) {
      stopped = false
      try { ports.backup()?.resume() } catch (error) { ports.log?.(`backup could not start again: ${String((error as Error)?.message ?? error)}`) }
    }
    if (ports.windowCount() === 0) ports.openWindow()
  }

  async function stopBackup(): Promise<boolean> {
    const backup = ports.backup()
    if (!backup) return true
    stopped = true
    stopping = true
    try { return await backup.stop() } catch { return false } finally {
      stopping = false
      if (recoverAfterStop) { recoverAfterStop = false; recover() }
    }
  }

  async function close(ticket: RestartCloseTicket): Promise<boolean> {
    let calledOff = false
    let attempts: readonly RecallableClose[] = []
    /** The closes that have settled (closed or kept): nothing to call off there. */
    const settled = new Set<RecallableClose>()
    const abandonUnsettled = (): void => {
      for (const attempt of attempts) {
        if (settled.has(attempt)) continue
        try { attempt.abandon() } catch { /* already gone */ }
      }
    }
    ticket.onCallOff(() => { calledOff = true; abandonUnsettled() })
    if (calledOff) return false
    attempts = ports.closeEach()
    // Marked before anything else waits on them, so a call-off that follows a settled close never reaches it.
    for (const attempt of attempts) attempt.closed.then(() => { settled.add(attempt) }, () => { settled.add(attempt) })
    // Called off between registering and starting (synchronously, by the engine): abandon what just started.
    if (!ticket.live()) { calledOff = true; abandonUnsettled() }
    const everyClosed = await closeEveryWindow(attempts, (attempt) => attempt.closed)
    const gone = (): boolean => calledOff || !ticket.live()
    if (gone()) {
      // What could not be called off settles first: the engine recovers once this promise does.
      await Promise.all(attempts.map((attempt) => attempt.closed.catch(() => false)))
      return false
    }
    if (!everyClosed) return false
    await ports.finishWork()
    if (gone()) return false
    return stopBackup()
  }

  /** The quit was called off (a close guard kept a window): run the recovery it held back, if any. */
  function quitCancelled(): void {
    if (!recoverWhenQuitCancelled) return
    recoverWhenQuitCancelled = false
    recover()
  }

  /** A backup start that finished during a quit was stopped again (index.ts resume fence): start it if the quit is called off. */
  function backupStoppedForQuit(): void {
    stopped = true
    recoverWhenQuitCancelled = true
  }

  return { close, recover, quitCancelled, backupStoppedForQuit }
}
