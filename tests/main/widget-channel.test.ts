// The window's side of the widget channel (security round 3): one hello per mount, and nothing a frame
// sends grants it anything (no press, no focus).
import { expect, test } from 'bun:test'
import { createWidgetChannel } from '../../src/renderer/src/widgets/widget-channel'

function fakes() {
  const posted: unknown[] = []
  const frameWindow = { postMessage: (message: unknown) => posted.push(message) } as unknown as Window
  const frame = { contentWindow: frameWindow } as unknown as HTMLIFrameElement
  const host = {
    performance: { now: () => 0 },
    crypto: { getRandomValues: (a: Uint8Array) => a.fill(7) },
    document: { activeElement: frame },
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window
  const escapes: unknown[] = []
  const channel = createWidgetChannel({ window: host, onEscape: (f) => escapes.push(f) })
  channel.activate(frame)
  const send = (data: unknown) => channel.handleMessage({ source: frameWindow, data } as MessageEvent)
  return { posted, send, escapes, channel, frame }
}
const T = '07070707070707070707070707070707'
const base = { wf: 'writeflex-widget', v: 1 }

test('one hello per mount: a widget that asks again (a replaced document) gets no second token', () => {
  const { posted, send } = fakes()
  send({ ...base, k: 'ready' })
  send({ ...base, k: 'ready' })
  send({ ...base, k: 'ready' })
  expect(posted).toEqual([{ ...base, k: 'hello', t: T }])
})

test('a press or focus message, with or without the token, does nothing; Escape is the only key, and it only disengages', () => {
  const { posted, send, escapes, frame } = fakes()
  send({ ...base, k: 'ready' })
  send({ ...base, k: 'press', t: T })
  send({ ...base, k: 'focus' })
  expect(posted.length).toBe(1)
  expect(escapes).toEqual([])
  send({ ...base, k: 'key', t: T, key: 'Escape' })
  expect(escapes).toEqual([frame])
})
