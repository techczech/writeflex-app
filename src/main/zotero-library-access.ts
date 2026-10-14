/**
 * Single-writer discipline over the user's Zotero library, inside our own process (ADR-0031, "the same
 * defect through a second door").
 *
 * ```
 * read  read  read      ─── concurrent, never waiting on each other
 *                  drain ── exclusive: no ReadFlex read is in flight while the gate probes the lock
 *       read  read       ─── resume
 * ```
 *
 * **Why a gate rather than a weaker probe.** The write path refuses when it cannot take an exclusive
 * lock, and that refusal is the strongest signal Zotero has the library — so it does not get relaxed
 * and it does not get taught to recognise us, because a lock carries no pid to recognise. The only
 * remaining move is to stop contending with ourselves, which is what this does.
 *
 * **Reads are not serialised against each other.** A gate that made the Shelf wait behind painting
 * would be a worse outcome than the refusal it prevents. Reads are admitted together; only a drain is
 * exclusive, and only for as long as it holds the library. The queue is FIFO, so a waiting drain also
 * stops the next read jumping ahead of it — without that, a steady stream of repaints could keep a
 * drain waiting indefinitely.
 *
 * **Nesting a read inside a drain throws rather than waits.** That is the one shape that could
 * deadlock: the drain holds exclusivity, the nested read waits for it to end, and it never does.
 * Detecting it turns a hang into an immediate, named error — a hang is the strictly worse failure, and
 * the whole point of this file is not to trade a rare false refusal for one.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** Set for the duration of a drain, across its awaits, so a nested read can be caught rather than hang. */
const drainContext = new AsyncLocalStorage<true>()

export type ZoteroLibraryAccess = {
  /** Run a read of `zotero.sqlite`. Concurrent with other reads; waits behind a drain. */
  read<T>(read: () => T | Promise<T>): Promise<T>
  /** Run the outbox drain. Exclusive: no read of ours overlaps it, and neither does another drain. */
  drain<T>(drain: () => T | Promise<T>): Promise<T>
}

export const NESTED_ZOTERO_READ_MESSAGE =
  'A Zotero read was started inside the Zotero drain. That would wait for the drain that is waiting for it, so it is refused instead of hanging.'

type Waiter = { kind: 'read' | 'drain'; admit: () => void }

export function createZoteroLibraryAccess(): ZoteroLibraryAccess {
  const queue: Waiter[] = []
  let reads = 0
  let draining = false

  /** Admit whatever the head of the queue allows. Reads bunch; a drain waits for an empty library. */
  function pump(): void {
    while (queue.length > 0) {
      const next = queue[0]!
      if (next.kind === 'read') {
        if (draining) return
        queue.shift()
        reads += 1
        next.admit()
        continue
      }
      if (draining || reads > 0) return
      queue.shift()
      draining = true
      next.admit()
      return
    }
  }

  const enter = (kind: Waiter['kind']): Promise<void> =>
    new Promise<void>((resolve) => {
      queue.push({ admit: resolve, kind })
      pump()
    })

  return {
    async read(read) {
      // Checked before queueing, so the caller gets the error instead of joining a queue that
      // cannot advance.
      if (drainContext.getStore()) throw new Error(NESTED_ZOTERO_READ_MESSAGE)
      await enter('read')
      try {
        return await read()
      } finally {
        reads -= 1
        pump()
      }
    },
    async drain(drain) {
      if (drainContext.getStore()) throw new Error(NESTED_ZOTERO_READ_MESSAGE)
      await enter('drain')
      try {
        return await drainContext.run(true, async () => await drain())
      } finally {
        draining = false
        pump()
      }
    },
  }
}
