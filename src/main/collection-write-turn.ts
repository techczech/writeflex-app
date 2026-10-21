/**
 * One write turn per Collection, for every writer inside this process: the editor's saves, an
 * accepted Change from its read to its commit, a capability's write, a request carried out for the
 * command line, a snapshot restore. Turns run one after another, in the order they were asked for.
 *
 * It is a promise chain and one rule. `run(work)` puts `work` at the end of the chain and resolves
 * with its result; work that fails does not break the chain. The rule: `run` called by code that is
 * running inside the turn NOW EXECUTING runs its work at once, as part of that turn. Whether it is
 * inside is read from the async context at every call (the live turn object, compared by identity
 * with the one executing), so work a turn started and left running after it ended is inside nothing
 * and waits like anyone else. There are no paths, no keys, no order to break and nothing to time out.
 *
 * It orders writers in THIS process only. What another program or file sync writes is caught at the
 * save, by the content check in guarded-document-write.ts.
 *
 * Two things a caller must not do: hold a turn across something that waits on a person, a model or
 * the network (every save of the Collection waits behind it); or, inside a turn, await work that was
 * started outside it and itself asks for the turn (that work is queued behind the turn awaiting it).
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export class CollectionWriteTurn {
  /** The turn the running code belongs to, if any: a fresh object per turn, never reused. */
  readonly #context = new AsyncLocalStorage<object>()
  #tail: Promise<void> = Promise.resolve()
  /** The turn executing now; null between turns. */
  #current: object | null = null
  #waiting = 0

  /** How many turns are asked for and not yet started. @internal For tests: a handshake in place of a pause. */
  get waiting(): number {
    return this.#waiting
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    const mine = this.#context.getStore()
    if (mine !== undefined && mine === this.#current) {
      try { return work() } catch (error) { return Promise.reject(error) }
    }
    const turn = {}
    this.#waiting += 1
    const result = this.#tail.then(async () => {
      this.#waiting -= 1
      this.#current = turn
      try {
        return await this.#context.run(turn, work)
      } finally {
        this.#current = null
      }
    })
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }
}
