/**
 * The window's side of the widget channel (interactive-widgets-in-documents, ticket 02). One channel
 * per window owns the record of every live widget frame in it. Ported from TalkWeaver
 * `embed-channel.js` at 6ec8102f, without mirroring and slide stepping.
 *
 * What it guarantees, whatever a frame sends:
 *   - a frame is known by `event.source` only; a message from a window with no record is ignored;
 *   - a message counts only with the token of the CURRENT activation of its frame; `deactivate` drops
 *     the record, so a late message finds nothing;
 *   - `ready` is answered with `hello` at most 8 times per activation;
 *   - `ready` is answered with `hello` once per mount (a widget that replaces its document gets no second
 *     token); nothing a frame sends grants it anything (engagement is the window's own cover press);
 *   - fewer than 5 key messages a second from one frame are passed on, and Escape only while the window's
 *     focused element is that frame; Escape can only end an engagement;
 *   - `height` reports (token needed) are passed on up to 20 a second from one frame;
 */
import { widgetHelloMessage, widgetLimits, widgetTokenFromBytes, widgetValidateFrameMessage } from '../../../shared/widget-protocol'

type WidgetRecord = {
  frame: HTMLIFrameElement
  window: Window
  token: string
  hellos: number
  ready: boolean
  messageTimes: number[]
  heightTimes: number[]
}

export type WidgetChannelOptions = {
  window: Window
  /** Escape, from the frame that holds the window's focus. */
  onEscape: (frame: HTMLIFrameElement) => void
  /** The page's content height, as its agent reports it (whole pixels, within the protocol's limits). */
  onHeight?: (frame: HTMLIFrameElement, height: number) => void
  now?: () => number
  randomBytes?: (count: number) => ArrayLike<number>
}

export type WidgetChannel = {
  activate(frame: HTMLIFrameElement): boolean
  deactivate(frame: HTMLIFrameElement): boolean
  status(frame: Element | null): { ready: boolean } | null
  handleMessage(event: MessageEvent): void
  dispose(): void
}

export function createWidgetChannel(options: WidgetChannelOptions): WidgetChannel {
  const host = options.window
  const now = options.now ?? (() => host.performance.now())
  const randomBytes = options.randomBytes ?? ((count: number) => host.crypto.getRandomValues(new Uint8Array(count)))
  const records = new Map<Window, WidgetRecord>()

  function find(frame: Element | null): WidgetRecord | null {
    if (!frame) return null
    for (const record of records.values()) if (record.frame === frame) return record
    return null
  }

  function withinRate(record: WidgetRecord, at: number): boolean {
    const times = record.messageTimes
    while (times.length > 0 && at - times[0] >= widgetLimits.messageRateWindowMs) times.shift()
    const recent = times.length
    times.push(at)
    if (times.length > widgetLimits.messageRateMax) times.shift()
    return recent < widgetLimits.messageRateMax
  }

  function handleMessage(event: MessageEvent): void {
    const source = event?.source as Window | null
    if (!source) return
    const record = records.get(source)
    if (!record) return
    const message = widgetValidateFrameMessage(event.data)
    if (!message) return
    if (message.k === 'ready') {
      if (record.hellos >= widgetLimits.helloMax) return
      record.hellos += 1
      // The target cannot be an origin: a sandboxed frame's origin is opaque.
      try { record.window.postMessage(widgetHelloMessage(record.token), '*') } catch { return }
      record.ready = true
      return
    }
    if (message.t !== record.token) return
    if (message.k === 'height') {
      const at = now()
      const times = record.heightTimes
      while (times.length > 0 && at - times[0] >= widgetLimits.messageRateWindowMs) times.shift()
      if (times.length >= widgetLimits.heightRateMax) return
      times.push(at)
      try { options.onHeight?.(record.frame, message.h) } catch { /* the caller's affair */ }
      return
    }
    if (!withinRate(record, now())) return
    if (message.k === 'key') {
      if (host.document.activeElement !== record.frame) return
      try { options.onEscape(record.frame) } catch { /* the caller's affair */ }
    }
  }

  /** Start an activation of `frame`: a new token and record. Call it BEFORE the frame is given its
   *  document, so the agent's `ready` finds the record. False when the frame has no window. */
  function activate(frame: HTMLIFrameElement): boolean {
    deactivate(frame)
    const target = frame.contentWindow
    if (!target) return false
    let token: string
    try { token = widgetTokenFromBytes(randomBytes(widgetLimits.tokenBytes)) } catch { return false }
    records.set(target, { frame, window: target, token, hellos: 0, ready: false, messageTimes: [], heightTimes: [] })
    return true
  }

  function deactivate(frame: HTMLIFrameElement): boolean {
    const record = find(frame)
    if (!record) return false
    records.delete(record.window)
    return true
  }

  function status(frame: Element | null): { ready: boolean } | null {
    const record = find(frame)
    return record ? { ready: record.ready } : null
  }

  const listener = (event: MessageEvent): void => handleMessage(event)
  host.addEventListener('message', listener)

  return {
    activate,
    deactivate,
    status,
    handleMessage,
    dispose() {
      records.clear()
      host.removeEventListener('message', listener)
    },
  }
}
