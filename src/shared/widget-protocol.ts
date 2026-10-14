/**
 * The messages between a widget's frame and the WriteFlex window (interactive-widgets-in-documents,
 * ticket 02). Ported from TalkWeaver `embed-protocol.js` at 6ec8102f, keeping its validation rules and
 * dropping everything the deck needed for mirroring and slide stepping.
 *
 *   { wf: "writeflex-widget", v: 1, k: "<kind>", …fields of that kind }
 *
 *   ready   agent → window  no fields, no token
 *   hello   window → agent  t (sent once per mount: a second `ready` gets nothing)
 *   key     agent → window  t, key ("Escape" only): it can only end an engagement
 *   height  agent → window  t, h: the page's content height in whole pixels, 40 to 20000
 *
 * Nothing a widget sends grants it anything (security round 3). Engagement comes only from the writer's
 * press on the cover the window lays over the widget, heard by the window itself (widget-frame.ts); the
 * former `press` and `focus` messages are gone. What is left of the token: it keeps a late or foreign
 * message from being taken for the current mount's Escape or height report. Neither can grant anything,
 * so a widget that learns its own token gains nothing.

 * A message is trusted for one thing: it describes an event inside the frame it came from. The window
 * takes the frame from its own record of `event.source`; no message names a frame.
 */

export const WIDGET_MESSAGE_TAG = 'writeflex-widget'
export const WIDGET_MESSAGE_VERSION = 1

export const widgetLimits = Object.freeze({
  tokenBytes: 16,
  tokenLength: 32,
  /** `ready` messages answered per activation: one. A widget that replaces its document gets no second hello. */
  helloMax: 1,
  /** Fewer than this many key messages from one frame within the window. */
  messageRateMax: 5,
  messageRateWindowMs: 1000,
  /** `height` reports accepted per second from one frame (the agent sends about ten at most). */
  heightRateMax: 20,
  /** The content heights that count, in pixels. */
  heightMin: 40,
  heightMax: 20000,
})

export type WidgetFrameMessage =
  | { k: 'ready' }
  | { k: 'key'; t: string; key: 'Escape' }
  | { k: 'height'; t: string; h: number }

/** Read the own data properties of a plain object, each exactly once and without running a getter.
 *  Null when the value is not a plain object, has a key outside `allowed` or has an accessor. */
export function widgetPlainFields(value: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return null
  const keys = Reflect.ownKeys(value)
  if (keys.length > allowed.length) return null
  const out: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) return null
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null
    out[key] = descriptor.value
  }
  return out
}

export function widgetIsToken(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== widgetLimits.tokenLength) return false
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i)
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false
  }
  return true
}

/** 16 random bytes as the token string. Throws on anything else: there is no weaker fallback. */
export function widgetTokenFromBytes(bytes: ArrayLike<number> | null | undefined): string {
  if (!bytes || bytes.length !== widgetLimits.tokenBytes) throw new Error(`widget: token needs ${widgetLimits.tokenBytes} random bytes`)
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i]
    if (typeof byte !== 'number' || byte < 0 || byte > 255 || Math.floor(byte) !== byte) throw new Error('widget: token bytes must be bytes')
    out += (byte < 16 ? '0' : '') + byte.toString(16)
  }
  return out
}

/**
 * Validate a message received from a frame. Returns a new object built only from validated fields, or
 * null: anything that is not a plain object, an unknown kind, a missing or extra key, a wrong type, an
 * accessor, a Proxy (where `structuredClone` exists), or anything that throws while being read.
 */
export function widgetValidateFrameMessage(message: unknown): WidgetFrameMessage | null {
  try {
    const head = widgetPlainFields(message, ['wf', 'v', 'k', 't', 'key', 'h'])
    if (!head || head.wf !== WIDGET_MESSAGE_TAG || head.v !== WIDGET_MESSAGE_VERSION) return null
    let out: WidgetFrameMessage | null = null
    if (head.k === 'ready') {
      if (widgetPlainFields(message, ['wf', 'v', 'k'])) out = { k: head.k }
    } else if (head.k === 'key') {
      const fields = widgetPlainFields(message, ['wf', 'v', 'k', 't', 'key'])
      if (fields && Object.keys(fields).length === 5 && widgetIsToken(fields.t) && fields.key === 'Escape') out = { k: 'key', t: fields.t, key: 'Escape' }
    } else if (head.k === 'height') {
      const fields = widgetPlainFields(message, ['wf', 'v', 'k', 't', 'h'])
      if (fields && Object.keys(fields).length === 5 && widgetIsToken(fields.t) && typeof fields.h === 'number' && Number.isInteger(fields.h)
        && fields.h >= widgetLimits.heightMin && fields.h <= widgetLimits.heightMax) out = { k: 'height', t: fields.t, h: fields.h }
    }
    if (!out) return null
    if (typeof structuredClone === 'function') structuredClone(message)
    return out
  } catch {
    return null
  }
}

export function widgetHelloMessage(token: string): { wf: string; v: number; k: 'hello'; t: string } {
  if (!widgetIsToken(token)) throw new Error('widget: not a token')
  return { wf: WIDGET_MESSAGE_TAG, v: WIDGET_MESSAGE_VERSION, k: 'hello', t: token }
}
