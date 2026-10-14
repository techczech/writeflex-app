// No IPC listener in the main process answers a frame that is not its window's top frame
// (interactive-widgets-in-documents, ticket 02; ported from TalkWeaver `src/main/ipc-main-frame-only.ts`
// at 6ec8102f). The WriteFlex window's preload runs in its top frame only: no window sets the web
// preference that would run a preload in subframes (a unit test fails if that preference is named
// anywhere in src/main), and no window has a <webview>. So today a subframe has no IPC at all, and a
// call a same-origin child frame makes through `parent.writeflex` reaches main as the top frame (the
// function runs in the top frame's preload context). This guard does not close that path; a widget's
// opaque origin does. It holds if a later change gives a subframe IPC.
//
// One guard for the whole app, not one check per handler: `applyMainFrameOnly(ipcMain)` replaces
// `handle`, `handleOnce`, `on` and `once` on the ipcMain object itself, so every module that registers
// on it is covered. It must run before the first registration; a listener registered earlier is not
// wrapped.
//
// The rule: a listener runs only when `event.senderFrame` is non-null AND is `event.sender.mainFrame`.
// Otherwise `handle` / `handleOnce` reject the call and `on` / `once` drop the message, each with one
// log line. A refused call does not use up a `handleOnce` or a `once` registration. A message whose
// frame has gone by the time main reads it (null `senderFrame` after the frame navigated or was
// destroyed) is refused too.

type Listener = (event: any, ...args: any[]) => any

/** The part of Electron's `ipcMain` this guard replaces (and a test fakes). */
export interface IpcMainLike {
  handle(channel: string, listener: Listener): void
  handleOnce(channel: string, listener: Listener): void
  removeHandler(channel: string): void
  on(channel: string, listener: Listener): unknown
  once(channel: string, listener: Listener): unknown
  removeListener(channel: string, listener: Listener): unknown
  off?(channel: string, listener: Listener): unknown
}

export type SenderFrameVerdict = 'main-frame' | 'subframe' | 'no-frame'

/** Which frame sent this IPC event. Anything that cannot be read counts as not the top frame. */
export function senderFrameVerdict(event: unknown): SenderFrameVerdict {
  let frame: unknown
  let main: unknown
  try {
    frame = (event as { senderFrame?: unknown } | null)?.senderFrame
    main = (event as { sender?: { mainFrame?: unknown } } | null)?.sender?.mainFrame
  } catch { return 'no-frame' }
  if (frame === null || frame === undefined) return 'no-frame'
  if (main === null || main === undefined) return 'no-frame'
  return frame === main ? 'main-frame' : 'subframe'
}

const APPLIED = Symbol.for('writeflex.ipcMainFrameOnly')

function describeSender(event: unknown): string {
  try {
    const sender = (event as { sender?: { id?: unknown; getURL?: () => string } } | null)?.sender
    const url = typeof sender?.getURL === 'function' ? String(sender.getURL()).slice(0, 120) : ''
    return `window ${String(sender?.id ?? '?')}${url ? ` (${url})` : ''}`
  } catch { return 'an unknown window' }
}

/**
 * Replaces the four registration methods of `ipc` with guarded ones. Idempotent. Returns `ipc`.
 * `removeListener` / `off` keep working with the listener that was passed to `on` / `once`.
 */
export function applyMainFrameOnly<T extends IpcMainLike>(ipc: T, opts: { log?: (message: string) => void } = {}): T {
  const marked = ipc as T & { [APPLIED]?: true }
  if (marked[APPLIED]) return ipc
  const log = opts.log ?? console.warn
  const handle = ipc.handle.bind(ipc)
  const on = ipc.on.bind(ipc)
  const removeListener = ipc.removeListener.bind(ipc)
  const off = typeof ipc.off === 'function' ? ipc.off.bind(ipc) : removeListener

  const refuse = (kind: 'call' | 'message', channel: string, event: unknown, verdict: SenderFrameVerdict): string => {
    const why = verdict === 'subframe' ? 'a frame that is not the window\'s top frame' : 'a frame that is gone or unknown'
    const line = `[ipc] refused ${kind} on ${channel} from ${why} in ${describeSender(event)}`
    try { log(line) } catch { /* logging never changes the answer */ }
    return line
  }

  const wrapped = new Map<string, Map<Listener, Listener[]>>()
  const remember = (channel: string, listener: Listener, wrapper: Listener): void => {
    let byListener = wrapped.get(channel)
    if (!byListener) { byListener = new Map(); wrapped.set(channel, byListener) }
    const list = byListener.get(listener)
    if (list) list.push(wrapper); else byListener.set(listener, [wrapper])
  }
  const forget = (channel: string, listener: Listener, wrapper?: Listener): Listener | undefined => {
    const byListener = wrapped.get(channel)
    const list = byListener?.get(listener)
    if (!byListener || !list || !list.length) return undefined
    const index = wrapper ? list.indexOf(wrapper) : list.length - 1
    if (index < 0) return undefined
    const [found] = list.splice(index, 1)
    if (!list.length) byListener.delete(listener)
    if (!byListener.size) wrapped.delete(channel)
    return found
  }

  ipc.handle = (channel: string, listener: Listener): void => {
    handle(channel, (event: unknown, ...args: unknown[]) => {
      const verdict = senderFrameVerdict(event)
      if (verdict !== 'main-frame') throw new Error(refuse('call', channel, event, verdict))
      return listener(event, ...args)
    })
  }
  ipc.handleOnce = (channel: string, listener: Listener): void => {
    handle(channel, (event: unknown, ...args: unknown[]) => {
      const verdict = senderFrameVerdict(event)
      if (verdict !== 'main-frame') throw new Error(refuse('call', channel, event, verdict))
      ipc.removeHandler(channel)
      return listener(event, ...args)
    })
  }
  ipc.on = (channel: string, listener: Listener): unknown => {
    const wrapper: Listener = (event, ...args) => {
      const verdict = senderFrameVerdict(event)
      if (verdict !== 'main-frame') { refuse('message', channel, event, verdict); return }
      return listener(event, ...args)
    }
    remember(channel, listener, wrapper)
    on(channel, wrapper)
    return ipc
  }
  ipc.once = (channel: string, listener: Listener): unknown => {
    const wrapper: Listener = (event, ...args) => {
      const verdict = senderFrameVerdict(event)
      if (verdict !== 'main-frame') { refuse('message', channel, event, verdict); return }
      forget(channel, listener, wrapper)
      removeListener(channel, wrapper)
      return listener(event, ...args)
    }
    remember(channel, listener, wrapper)
    on(channel, wrapper)
    return ipc
  }
  ipc.removeListener = (channel: string, listener: Listener): unknown => {
    removeListener(channel, forget(channel, listener) ?? listener)
    return ipc
  }
  if (typeof ipc.off === 'function') {
    ipc.off = (channel: string, listener: Listener): unknown => {
      off(channel, forget(channel, listener) ?? listener)
      return ipc
    }
  }
  marked[APPLIED] = true
  return ipc
}
