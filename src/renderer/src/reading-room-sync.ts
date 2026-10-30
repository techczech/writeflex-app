export type OutboxSyncRunner = {
  runAutomatic: () => Promise<void>
  runLifecycle: () => Promise<void>
  runManual: () => Promise<void>
}

const AUTOMATIC_SYNC_INTERVAL_MS = 10_000

export function createOutboxSyncRunner<Result>(options: {
  readCounts: () => Promise<{ waiting: number; rejected: number }>
  drain: () => Promise<Result>
  onCounts: (counts: { waiting: number; rejected: number }) => void
  onResult: (result: Result) => void
  onDrainError: (error: unknown) => void
  onThrottledAttempt?: () => void
  now?: () => number
}): OutboxSyncRunner {
  let inFlight: Promise<void> | null = null
  let requiredQueue = Promise.resolve()
  let lastAutomaticAttempt = Number.NEGATIVE_INFINITY
  const now = options.now ?? Date.now

  const start = (throttledAttempt: boolean): Promise<void> => {
    if (throttledAttempt) options.onThrottledAttempt?.()

    const operation = (async () => {
      let counts: { waiting: number; rejected: number }
      try {
        counts = await options.readCounts()
      } catch {
        // The count is only an indicator. A failed refresh must never interrupt writing (ADR-0036).
        return
      }
      options.onCounts(counts)
      if (counts.waiting === 0) return
      try {
        options.onResult(await options.drain())
      } catch (error) {
        // A drain is an action the writer can take. Its failure must remain visible.
        options.onDrainError(error)
      }
    })().finally(() => {
      if (inFlight === operation) inFlight = null
    })

    inFlight = operation
    return operation
  }

  /**
   * Manual requests and Room/document lifecycle retries are both required work. Queue them behind
   * whatever is running rather than folding them into it: the outbox can change while an earlier
   * count read is in flight, so sharing that old reading would miss the new mark.
   */
  const queueRequired = (automatic: boolean): Promise<void> => {
    const requested = requiredQueue.then(async () => {
      if (inFlight) await inFlight
      if (automatic) lastAutomaticAttempt = now()
      // Lifecycle work refreshes the focus throttle but is not itself a focus-triggered attempt.
      await start(false)
    })
    requiredQueue = requested.catch(() => {})
    return requested
  }

  return {
    runAutomatic(): Promise<void> {
      // `ps` and `lsof` remain synchronous on Electron's main thread by design. The real
      // BrowserWindow-focus trigger plus this interval keep those accepted probes off the
      // reader-to-draft focus path; do not remove the interval without replacing that protection.
      const attemptAt = now()
      if (attemptAt - lastAutomaticAttempt < AUTOMATIC_SYNC_INTERVAL_MS) {
        return Promise.resolve()
      }
      if (inFlight) return inFlight
      lastAutomaticAttempt = attemptAt
      return start(true)
    },
    runLifecycle(): Promise<void> {
      // Opening the Room or a paper is a promised retry, not focus noise. It must run even when the
      // preceding lifecycle check happened less than ten seconds ago.
      return queueRequired(true)
    },
    runManual(): Promise<void> {
      // A pressed control is never throttled or folded into an existing attempt. Queue it behind
      // the current work so drains stay single-flight while every explicit request still runs.
      return queueRequired(false)
    },
  }
}

/**
 * What to flash when a drain answers (ADR-0036, second amendment), or nothing. Success is announced
 * only for rows actually written; a queue that emptied because its last rows were refused says that
 * instead, because an emptied queue is not the same as a written one.
 */
export function outboxResultAnnouncement(
  wasWaiting: number,
  result: { waiting: number; written?: number; refusedNow?: number; keptLocal?: { created: boolean } },
): string | null {
  if (wasWaiting <= 0 || result.waiting !== 0 || result.keptLocal?.created) return null
  const refused = result.refusedNow ?? 0
  if (refused > 0) {
    return refused === 1
      ? '1 change could not be written to Zotero. It is kept here with the reason.'
      : `${refused} changes could not be written to Zotero. They are kept here with the reason.`
  }
  return (result.written ?? 0) > 0 ? 'New highlights synced to Zotero.' : null
}
