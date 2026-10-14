/**
 * One writer at a time per Folio. Every Plan write (plan.ts), every running-order change from the Outline
 * (folio-running-order.ts) and a whole running-order proposal (plan-proposal.ts) runs inside `withPlanLock`
 * for its workspace root and Folio folder, so the read, the checks and the write of one request cannot
 * interleave with another request's in this process. The folder is keyed by its one spelling (folio-dir.ts):
 * `guide`, `guide/`, `x/../guide` and, on a volume that ignores case, `Guide` are one lock.
 *
 * The lock is a promise chain per key: a request waits for the one before it, whether that one finished
 * or threw, and releases in `finally`, so a throw never leaves the Folio locked. It is re-entrant along
 * one async call chain (AsyncLocalStorage): a caller that holds the lock and calls a Plan write, which
 * asks for the same lock, runs straight through instead of waiting for itself. A holder must await its
 * nested writes one after another; two started at once inside one hold are not serialised against each
 * other.
 *
 * It does not stop another process (a sync client, a second app) from writing the files; the byte
 * comparisons before each write in plan.ts remain the guard against that.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { folioKey } from './folio-dir'
import { invalidateFolioOrderFacts } from './folio-order-cache'

const tails = new Map<string, Promise<void>>()
const held = new AsyncLocalStorage<ReadonlySet<string>>()

/** One key per Folio, however its folder or the workspace root is spelled (folio-dir.ts). */
const keyOf = (root: string, dir: string): string => {
  const key = folioKey(root, dir)
  return `${key.root}\u0000${key.dir}`
}

export async function withPlanLock<T>(ws: { root: string }, dir: string, run: () => Promise<T>): Promise<T> {
  const key = keyOf(ws.root, dir)
  const mine = held.getStore()
  if (mine?.has(key)) return run()

  const before = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>((resolve) => { release = resolve })
  tails.set(key, tail)
  await before
  try {
    return await held.run(new Set([...(mine ?? []), key]), run)
  } finally {
    // Whatever this hold wrote, the Outline's kept answer about this Folio's order is no longer trusted.
    invalidateFolioOrderFacts(ws.root, dir)
    if (tails.get(key) === tail) tails.delete(key)
    release()
  }
}

/** Whether a write is under way or waiting for this Folio (for tests and diagnostics). */
export function planLockBusy(ws: { root: string }, dir: string): boolean {
  return tails.has(keyOf(ws.root, dir))
}
