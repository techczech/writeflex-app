// The messages between a widget's frame and the window (interactive-widgets ticket 02), validated as
// TalkWeaver's embed-protocol validates them (6ec8102f).
import { expect, test } from 'bun:test'
import { widgetHelloMessage, widgetLimits, widgetIsToken, widgetTokenFromBytes, widgetValidateFrameMessage } from '../../src/shared/widget-protocol'

const T = '0123456789abcdef0123456789abcdef'
const base = { wf: 'writeflex-widget', v: 1 }

test('the kinds a frame may send, rebuilt from their validated fields: none of them grants anything', () => {
  expect(widgetValidateFrameMessage({ ...base, k: 'ready' })).toEqual({ k: 'ready' })
  expect(widgetValidateFrameMessage({ ...base, k: 'key', t: T, key: 'Escape' })).toEqual({ k: 'key', t: T, key: 'Escape' })
  const message = { ...base, k: 'key', t: T, key: 'Escape' }
  expect(widgetValidateFrameMessage(message)).not.toBe(message)
  // Security round 3: a widget can no longer report a press or the focus; one hello per mount.
  expect(widgetValidateFrameMessage({ ...base, k: 'press', t: T })).toBeNull()
  expect(widgetValidateFrameMessage({ ...base, k: 'focus' })).toBeNull()
  expect(widgetLimits.helloMax).toBe(1)
})

test('anything else is refused', () => {
  const refused: unknown[] = [
    null, 'ready', 42, [], { ...base },
    { ...base, k: 'hello', t: T }, // the window's kind, never accepted from a frame
    { ...base, k: 'engaged', t: T },
    { ...base, k: 'constructor' },
    { wf: 'other', v: 1, k: 'ready' },
    { ...base, v: 2, k: 'ready' },
    { ...base, k: 'ready', extra: 1 },
    { ...base, k: 'focus', t: T },
    { ...base, k: 'key', t: T, key: 'ArrowRight' },
    { ...base, k: 'key', t: T },
    { ...base, k: 'key', key: 'Escape' },
    { ...base, k: 'press', t: T.toUpperCase() },
    { ...base, k: 'press', t: T.slice(1) },
    { ...base, k: 'press' },
    Object.assign(Object.create({ evil: true }), { ...base, k: 'ready' }),
    new Proxy({ ...base, k: 'ready' }, {}),
  ]
  for (const message of refused) expect(widgetValidateFrameMessage(message), JSON.stringify(message)).toBeNull()
  // An accessor is never run.
  let ran = false
  const accessor = { ...base, get k() { ran = true; return 'ready' } }
  expect(widgetValidateFrameMessage(accessor)).toBeNull()
  expect(ran).toBe(false)
  // A symbol key is refused.
  expect(widgetValidateFrameMessage({ ...base, k: 'ready', [Symbol('x')]: 1 })).toBeNull()
})

test('tokens: 16 random bytes as lower-case hex, and nothing weaker', () => {
  const token = widgetTokenFromBytes(Array.from({ length: 16 }, (_, i) => i * 16 + 15))
  expect(widgetIsToken(token)).toBe(true)
  expect(token).toBe('0f1f2f3f4f5f6f7f8f9fafbfcfdfefff')
  expect(() => widgetTokenFromBytes([1, 2, 3])).toThrow()
  expect(() => widgetTokenFromBytes(null)).toThrow()
  expect(() => widgetTokenFromBytes(Array.from({ length: 16 }, () => 256))).toThrow()
  expect(widgetHelloMessage(T)).toEqual({ ...base, k: 'hello', t: T })
  expect(() => widgetHelloMessage('nope')).toThrow()
})

test('height: a token and a whole number of pixels from 40 to 20000, nothing else', () => {
  expect(widgetValidateFrameMessage({ ...base, k: 'height', t: T, h: 320 })).toEqual({ k: 'height', t: T, h: 320 })
  expect(widgetValidateFrameMessage({ ...base, k: 'height', t: T, h: 40 })).toEqual({ k: 'height', t: T, h: 40 })
  expect(widgetValidateFrameMessage({ ...base, k: 'height', t: T, h: 20000 })).toEqual({ k: 'height', t: T, h: 20000 })
  const refused: unknown[] = [
    { ...base, k: 'height', t: T, h: 39 },
    { ...base, k: 'height', t: T, h: 20001 },
    { ...base, k: 'height', t: T, h: 100.5 },
    { ...base, k: 'height', t: T, h: '100' },
    { ...base, k: 'height', t: T, h: Number.NaN },
    { ...base, k: 'height', t: T, h: Infinity },
    { ...base, k: 'height', t: T },
    { ...base, k: 'height', h: 100 },
    { ...base, k: 'height', t: T.slice(1), h: 100 },
    { ...base, k: 'height', t: T, h: 100, key: 'Escape' },
    { ...base, k: 'press', t: T, h: 100 },
    { ...base, k: 'ready', h: 100 },
  ]
  for (const message of refused) expect(widgetValidateFrameMessage(message), JSON.stringify(message)).toBeNull()
})
