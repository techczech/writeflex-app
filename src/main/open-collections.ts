/**
 * The Collections this app has open, on THIS computer. Nothing more.
 *
 * WriteFlex has no Collection lock. Each Mac opens, edits and saves its own replica of a synced
 * Collection whether or not another Mac (or another copy of the app) has it open, and whether or not
 * sync has caught up. Nothing in the Collection, and nothing synced, ever stops, pauses or delays this
 * app's writes, and nothing asks the user to close the Collection elsewhere. Concurrent edits are
 * caught where they land: the save fingerprint and outside-change checks, durable versions, and
 * reconciliation of what sync brings in. The contract, and why the earlier owner lock was removed, is
 * docs/plans/2026-11-03-sync-replicas-and-duplicate-reconciliation.md.
 *
 * Opening a Collection here does three local things:
 * - settles version-history moves an earlier session left half done (version-moves.ts);
 * - retries Folio declarations that could not be written before (folio-declaration.ts);
 * - makes the Collection's REPLY KEY in this app's own application-data folder, with a record of this
 *   process beside it (reply-key.ts). The command line on this computer uses that to pass a write to
 *   this app as a request, and to verify the reply. Closing the Collection removes both.
 *
 * Electron-free, so it can be tested without a window.
 */
import { retryFolioDeclarations } from './folio-declaration'
import { settleVersionMoves } from './version-moves'
import { createReplyKey, removeReplyKey, writeAppPresence } from './reply-key'

export type OpenCollectionsDiagnostic = (event: string, details: Record<string, unknown>) => unknown

export type OpenCollectionsOptions = {
  /** Where this app keeps its reply keys (reply-key.ts): a folder in its own application-data folder. */
  keyFolder?: string
  diagnostic?: OpenCollectionsDiagnostic
}

export class OpenCollections {
  /** Root -> windows relying on it. A reopen can overlap the previous window's delayed close. */
  readonly #open = new Map<string, number>()
  readonly #queues = new Map<string, Promise<unknown>>()
  readonly #keyFolder: string | undefined
  readonly #diagnostic: OpenCollectionsDiagnostic

  constructor(options: OpenCollectionsOptions = {}) {
    this.#keyFolder = options.keyFolder
    this.#diagnostic = options.diagnostic ?? (() => {})
  }

  /** Note that a window here has `root` (canonical) open. Never waits for, or refuses because of, anyone else. */
  open(root: string): Promise<void> {
    return this.#serialise(root, async () => {
      const count = this.#open.get(root) ?? 0
      this.#open.set(root, count + 1)
      if (count === 0) {
        this.#settleMoves(root, true)
        if (this.#keyFolder) {
          await createReplyKey(this.#keyFolder, root).catch((error) => this.#failed('reply-key', root, error))
          await writeAppPresence(this.#keyFolder, root).catch((error) => this.#failed('app-presence', root, error))
        }
      }
      await retryFolioDeclarations(root)
    })
  }

  /** One window fewer on `root`; the reply key goes with the last. Safe for a root that was never opened. */
  close(root: string, options: { all?: boolean } = {}): Promise<void> {
    return this.#serialise(root, async () => {
      const count = this.#open.get(root)
      if (count === undefined) return
      if (count > 1 && !options.all) {
        this.#open.set(root, count - 1)
        return
      }
      this.#open.delete(root)
      if (this.#keyFolder) await removeReplyKey(this.#keyFolder, root)
    })
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#open.keys()].map((root) => this.close(root, { all: true })))
  }

  /** True while a window here has `root` open. Says nothing about any other process or computer. */
  isOpen(root: string): boolean {
    return this.#open.has(root)
  }

  #settleMoves(root: string, cancelUnmoved: boolean): void {
    try { settleVersionMoves(root, cancelUnmoved) } catch (error) {
      this.#failed('version-history-settle', root, error)
      console.error('WriteFlex could not settle version-history moves; the next save or history read will retry.', { root, error })
    }
  }

  #failed(step: string, root: string, error: unknown): void {
    this.#diagnostic(`open-collections.${step}-failed`, { root, message: error instanceof Error ? error.message : String(error) })
  }

  /** One open or close per root at a time, in call order: a reopen queues behind the close. */
  #serialise<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.#queues.get(root) ?? Promise.resolve()).then(operation, operation)
    const settled = result.catch(() => {})
    this.#queues.set(root, settled)
    void settled.then(() => { if (this.#queues.get(root) === settled) this.#queues.delete(root) })
    return result
  }
}
