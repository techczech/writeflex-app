type IpcLike = {
  on: (channel: string, listener: (event: unknown, payload: unknown) => void) => unknown
  removeListener: (channel: string, listener: (event: unknown, payload: unknown) => void) => unknown
}

/**
 * Fan many React effects through one underlying IpcRenderer listener. Each returned cleanup is
 * idempotent; the Electron listener is removed when the final subscriber leaves.
 */
export function multiplexIpcChannel<T>(ipc: IpcLike, channel: string): (fn: (payload: T) => void) => () => void {
  const subscribers = new Set<(payload: T) => void>()
  const listener = (_event: unknown, payload: unknown): void => {
    for (const subscriber of subscribers) subscriber(payload as T)
  }
  let listening = false

  return (fn) => {
    subscribers.add(fn)
    if (!listening) {
      ipc.on(channel, listener)
      listening = true
    }
    let active = true
    return () => {
      if (!active) return
      active = false
      subscribers.delete(fn)
      if (listening && subscribers.size === 0) {
        ipc.removeListener(channel, listener)
        listening = false
      }
    }
  }
}


let turnBackRequestId = 0

/** The renderer arms Undo only after all of this conversion's change pushes have arrived. */
export async function invokeTurnBackAfterNotifications(
  ipc: IpcLike & { invoke: (channel: string, input: { dir: string; requestId: number }) => Promise<boolean | string> },
  dir: string,
): Promise<boolean | string> {
  const requestId = ++turnBackRequestId
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  const listener = (_event: unknown, payload: unknown) => { if (payload === requestId) finish() }
  ipc.on('folio:turn-back-finished', listener)
  try {
    const changed = await ipc.invoke('folio:turn-back', { dir, requestId })
    if (changed) await finished
    return changed
  } finally {
    ipc.removeListener('folio:turn-back-finished', listener)
  }
}
