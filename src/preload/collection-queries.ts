import type { IpcRenderer, IpcRendererEvent } from 'electron'
import type { QueryResult } from '../main/query-engine'
import type { CollectionQueryInvalidation } from './index'

type QueryIpc = Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>
type Subscriber = (change: CollectionQueryInvalidation) => void

export function createCollectionQueryBridge(ipc: QueryIpc) {
  const channel = 'collection:query-changed'
  const currentFlights = new Map<string, Promise<QueryResult>>()
  const subscribers = new Set<Subscriber>()
  let pendingCount = 0
  let listening = false
  let invokeCount = 0

  const onInvalidation = (_event: IpcRendererEvent, change: CollectionQueryInvalidation): void => {
    // A subscriber may query synchronously from this event. It must start in a fresh generation.
    currentFlights.clear()
    for (const subscriber of subscribers) subscriber(change)
  }

  function syncListener(): void {
    const needed = pendingCount > 0 || subscribers.size > 0
    if (needed === listening) return
    if (needed) ipc.on(channel, onInvalidation)
    else ipc.removeListener(channel, onInvalidation)
    listening = needed
  }

  return {
    query(dir: string, source: string): Promise<QueryResult> {
      const key = JSON.stringify([dir, source])
      const existing = currentFlights.get(key)
      if (existing) return existing

      invokeCount += 1
      const pending = ipc.invoke('collection:query', { dir, source }) as Promise<QueryResult>
      currentFlights.set(key, pending)
      pendingCount += 1
      syncListener()

      const settled = (): void => {
        if (currentFlights.get(key) === pending) currentFlights.delete(key)
        pendingCount -= 1
        syncListener()
      }
      void pending.then(settled, settled)
      return pending
    },
    onChanged(subscriber: Subscriber): () => void {
      subscribers.add(subscriber)
      syncListener()
      let active = true
      return () => {
        if (!active) return
        active = false
        subscribers.delete(subscriber)
        syncListener()
      }
    },
    count: () => invokeCount,
    resetCount: () => { invokeCount = 0 },
  }
}
