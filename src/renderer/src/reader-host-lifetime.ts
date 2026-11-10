import { withinReaderBound } from '../../shared/reading-room-channel'

/** One host's admitted operations and teardown. A replacement always owns another instance. */
export class ReaderHostLifetime {
  #stopping = false
  #closing: Promise<void> | null = null
  #operations = new Set<Promise<unknown>>()
  get stopping(): boolean { return this.#stopping }
  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#stopping) return Promise.reject(new Error('Reader is closed.'))
    const pending = operation()
    this.#operations.add(pending)
    void pending.finally(() => this.#operations.delete(pending)).catch(() => {})
    return pending
  }
  dispose(stop: () => void, teardown: () => Promise<void>): Promise<void> {
    if (this.#closing) return this.#closing
    this.#stopping = true
    stop()
    this.#closing = withinReaderBound((async () => {
      // Failed opens still settle before the final view enumeration; none can publish a late worker.
      await Promise.allSettled([...this.#operations])
      await teardown()
    })())
    return this.#closing
  }
}
