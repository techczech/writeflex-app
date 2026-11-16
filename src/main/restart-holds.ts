// Updating in place (ADR-0054 "What differs" 1): work in the main process that a restart now would cut short. Each
// piece of work holds its kind while it runs; the update engine reads `restartHeld` synchronously, before the hand-over
// to Squirrel.Mac and again in the same turn as the native quit (src/main/update-engine.ts, quitIfPermitted). No
// Electron, no app imports: the modules that do the work (agent.ts, the export handlers) count themselves here.

export type RestartHoldKind = 'agent' | 'exporting' | 'backup'

const counts = new Map<RestartHoldKind, number>()

/** Holds `kind` until the returned release is called (once; later calls do nothing). */
export function holdRestart(kind: RestartHoldKind): () => void {
  counts.set(kind, (counts.get(kind) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (counts.get(kind) ?? 1) - 1
    if (left > 0) counts.set(kind, left)
    else counts.delete(kind)
  }
}

/** Runs `work` holding `kind` until it settles, whether it resolves, rejects or throws. */
export async function duringRestartHold<T>(kind: RestartHoldKind, work: () => Promise<T> | T): Promise<T> {
  const release = holdRestart(kind)
  try { return await work() } finally { release() }
}

/** Whether any work of `kind` is running now. */
export const restartHeld = (kind: RestartHoldKind): boolean => (counts.get(kind) ?? 0) > 0
