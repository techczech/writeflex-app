import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import type { IpcMainInvokeEvent } from 'electron'
import type { ReadingRoomDocument } from '@readflex/sidecar'
import { readerRegistry, type ReaderOwner } from './reading-room-policy'

type Context = { owner: ReaderOwner; draftPath: string | null; unboundDocument: ReadingRoomDocument | null; selection: string; live: boolean }
type Invocation = { context: Context; epoch: number }
export class ReadingRoomContexts {
  #owners = new Map<number, Context>()
  #observed = new Set<number>()
  #scope = new AsyncLocalStorage<Invocation>()
  #context(event: IpcMainInvokeEvent): Context {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed()) throw new Error('Reader operations require the owning main frame.')
    const frame = event.senderFrame, top = `${frame.processId}:${frame.routingId}`, id = event.sender.id
    let context = this.#owners.get(id)
    if (context && context.owner.top !== top) { this.invalidate(id); context = undefined }
    if (!context) {
      context = { owner: { id, top, epoch: 1, origin: frame.origin }, draftPath: null, unboundDocument: null, selection: randomBytes(16).toString('hex'), live: true }
      this.#owners.set(id, context)
    }
    if (!this.#observed.has(id)) {
      this.#observed.add(id)
      event.sender.on('did-start-navigation', (_event, _url, inPlace, main) => { if (main && !inPlace) this.invalidate(id) })
      event.sender.on('render-process-gone', () => this.invalidate(id))
      event.sender.once('destroyed', () => { this.invalidate(id); this.#observed.delete(id) })
    }
    return context
  }
  run<T>(event: IpcMainInvokeEvent, operation: () => T): T {
    const context = this.#context(event)
    return this.#scope.run({ context, epoch: context.owner.epoch }, operation)
  }
  current(): Context {
    const call = this.#scope.getStore()
    if (!call || !call.context.live || call.epoch !== call.context.owner.epoch) throw new Error('The reader document selection is stale.')
    return call.context
  }
  /** Completion of an admitted write survives selection changes, never owner invalidation. */
  admitCompletion(): () => void {
    const context = this.current()
    const { id, top, origin } = context.owner
    return () => {
      if (!context.live || this.#owners.get(id) !== context
        || context.owner.top !== top || context.owner.origin !== origin) {
        throw new Error('The reader owner is no longer live.')
      }
    }
  }
  check(): void { this.current() }
  checkIfBound(): void { if (this.#scope.getStore()) this.check() }
  select(draftPath: string | null, replace = false): void {
    const context = this.current()
    if (replace || context.draftPath !== draftPath) {
      context.draftPath = draftPath; context.owner.epoch += 1
      context.selection = randomBytes(16).toString('hex')
      this.#scope.getStore()!.epoch = context.owner.epoch
    }
  }
  invalidate(id: number): void {
    const context = this.#owners.get(id)
    if (context) { context.live = false; context.owner.epoch += 1; this.#owners.delete(id) }
    readerRegistry.revokeOwner(id)
  }
}
