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
