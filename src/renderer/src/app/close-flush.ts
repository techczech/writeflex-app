/**
 * A closing window's flush: write every unsaved buffer, and go on until none is left.
 *
 * One pass is not enough. A write reads its buffer when it starts and can take a while; what is typed
 * during it leaves the document unsaved although the write succeeded. So "no write failed" does not
 * mean "everything is on disk": the passes repeat until the unsaved set is empty, and `clean` says
 * whether it was at the moment this returned (quit-and-window-close-spec.md, review round 1, finding 1).
 */

/** Passes before the flush gives up on someone who keeps typing through every save. */
export const CLOSE_FLUSH_MAX_PASSES = 5

export type CloseFlushPorts = {
  /** The documents that are unsaved now. */
  unsaved(): string[]
  /** Write one document's current buffer; false when the write failed. */
  save(path: string): Promise<boolean>
}

export type CloseFlushResult = {
  /** Every path written, each once, in the order first written. */
  flushed: string[]
  /** Writes that failed in the pass that stopped the flush. */
  failed: number
  /** Nothing was unsaved when the flush returned. False after a failed write or when the passes ran out. */
  clean: boolean
}

export async function flushUntilClean(ports: CloseFlushPorts, maxPasses = CLOSE_FLUSH_MAX_PASSES): Promise<CloseFlushResult> {
  const flushed = new Set<string>()
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const paths = ports.unsaved()
    if (paths.length === 0) break
    let failed = 0
    for (const path of paths) {
      flushed.add(path)
      if (!(await ports.save(path))) failed += 1
    }
    if (failed > 0) return { flushed: [...flushed], failed, clean: false }
  }
  return { flushed: [...flushed], failed: 0, clean: ports.unsaved().length === 0 }
}
