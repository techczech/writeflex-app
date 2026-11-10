type DisposableReader = { dispose(): Promise<void> }

/** A failed or detached slot still belongs to this room until its teardown succeeds. */
export class ReaderDisposals {
  #pending = new Map<DisposableReader, Promise<void>>()

  dispose(client: DisposableReader): Promise<void> {
    const existing = this.#pending.get(client)
    if (existing) return existing
    const closing = client.dispose().then(() => { this.#pending.delete(client) })
    this.#pending.set(client, closing)
    return closing
  }

  async close(clients: ReadonlyArray<DisposableReader | null>): Promise<void> {
    for (const client of clients) if (client) this.dispose(client)
    // A refusal must not make the closer abandon other admitted teardowns.
    const results = await Promise.allSettled(this.#pending.values())
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}
