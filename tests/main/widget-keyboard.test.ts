// No keystroke reaches a widget the writer has not engaged (src/main/widget-keyboard.ts; interactive
// widgets ticket 02, security fix rounds 1 and 2). The gate is driven here with a fake window: which
// frame has the focus, real presses, what reclaiming does, and what is sent again.
import { expect, test } from 'bun:test'
import { createKeyboardGate, DELIVERY_MARKER, DELIVERY_WAIT_MS, guardInput, isQuitKey, keyCodeFor, parseOwnerClaim, PRESS_SLACK_MS, PRESS_WINDOW_MS, type KeyboardGateHost } from '../../src/main/widget-keyboard'

type Frame = { origin: string; processId: number; routingId: number }
const TOP: Frame = { origin: 'file://', processId: 1, routingId: 1 }
const WIDGET: Frame = { origin: 'null', processId: 2, routingId: 7 }
const OTHER_WIDGET: Frame = { origin: 'null', processId: 3, routingId: 9 }
const READING_ROOM: Frame = { origin: 'file://', processId: 1, routingId: 4 }
const key = (k: string, type: 'keyDown' | 'keyUp' = 'keyDown', mods: Partial<{ shift: boolean; control: boolean; alt: boolean; meta: boolean }> = {}) =>
  ({ type, key: k, shift: false, control: false, alt: false, meta: false, ...mods })

function fakeWindow(options: { reclaimWorks?: boolean; reclaimNeverReturns?: boolean; markerPort?: boolean } = {}) {
  let focused: Frame | 'unreadable' | null = TOP
  let clock = 1000
  const sent: Array<{ type: string; keyCode: string; modifiers: string[] }> = []
  const delivered: string[] = []
  let reclaims = 0
  let dropped = 0
  let quits = 0
  const heldMeta: string[] = []
  // The top frame's listener for main's marker key, and the bound on main's wait for it.
  let markerSeen: ((seen: boolean) => void) | null = null
  let markers = 0
  // Every wait of DELIVERY_WAIT_MS that is running: the bound on a held ⌘Q, and the wait for the marker.
  const expireWaits: Array<() => void> = []
  let longWaits = 0
  const host: KeyboardGateHost = {
    ...(options.markerPort === false ? {} : {
      watchMarker: async () => {
        const seen = new Promise<boolean>((resolve) => { markerSeen = resolve })
        return () => seen
      },
    }),
    onHeld: (input) => { if (input.type === 'keyDown' && input.meta) heldMeta.push(input.key) },
    actsOn: (input) => (isQuitKey(input, 'darwin') ? () => { quits += 1; delivered.push('main:quit') } : null),
    focusedFrame: () => focused,
    mainFrame: () => TOP,
    reclaim: async () => {
      reclaims += 1
      if (options.reclaimNeverReturns) await new Promise<void>(() => {}) // the top frame is stuck: its script never answers
      if (options.reclaimWorks !== false) focused = TOP
    },
    send: (event) => { sent.push(event) },
    wait: (ms) => (ms >= DELIVERY_WAIT_MS ? new Promise<void>((resolve) => { longWaits += 1; expireWaits.push(resolve) }) : Promise.resolve()),
    onDropped: (count) => { dropped += count },
    shellOrigin: () => 'file://',
    now: () => clock,
    findWidgetFrame: (name) => (name === 'wf-widget-a' ? WIDGET : name === 'wf-widget-b' ? OTHER_WIDGET : null),
  }
  const gate = createKeyboardGate(host, { attempts: 3 })
  // As Chromium does: a held keydown suppresses the char and keyup events after it until the next keydown.
  let suppress = false
  const name = (): string => (focused === TOP ? 'top' : focused === READING_ROOM ? 'reading-room' : focused === OTHER_WIDGET ? 'other' : 'widget')
  const press = (input: ReturnType<typeof key>): void => {
    if (input.type === 'keyDown') suppress = false
    else if (suppress) return
    if (gate.onInput(input)) { if (input.type === 'keyDown') suppress = true; return }
    // The marker reaches the frame with the focus; the top frame's listener stops it and reports it.
    if (input.key === DELIVERY_MARKER.keyCode && markerSeen) {
      markers += 1
      if (focused === TOP) { markerSeen(true); markerSeen = null; return }
    }
    delivered.push(`${name()}:${input.type}:${input.key}`)
  }
  const replay = (): void => {
    while (sent.length > 0) {
      const event = sent.shift()!
      if (event.type === 'char') { if (!suppress) delivered.push(`${name()}:char:${event.keyCode}`); continue }
      const k = event.keyCode === 'Space' ? ' ' : event.keyCode
      press(key(k, event.type as 'keyDown' | 'keyUp', { shift: event.modifiers.includes('shift'), control: event.modifiers.includes('control'), alt: event.modifiers.includes('alt'), meta: event.modifiers.includes('meta') }))
    }
  }
  return {
    gate, press, replay, sent, delivered,
    setFocus: (frame: Frame | 'unreadable' | null) => { focused = frame },
    tick: (ms: number) => { clock += ms },
    get reclaims() { return reclaims }, get dropped() { return dropped },
    get quits() { return quits }, heldMeta,
    get markers() { return markers },
    expireDeliveryWait: () => { for (const expire of expireWaits.splice(0)) expire() },
    get longWaits() { return longWaits },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('keys to the top frame, and to the app’s own frames (the Reading Room), pass untouched', () => {
  const w = fakeWindow()
  w.press(key('a')); w.press(key('a', 'keyUp'))
  w.setFocus(READING_ROOM); w.press(key('b'))
  expect(w.delivered).toEqual(['top:keyDown:a', 'top:keyUp:a', 'reading-room:keyDown:b'])
})

test('a key bound for a widget that is not engaged is held, the keyboard taken back, and the key sent again to the editor', async () => {
  const w = fakeWindow()
  w.setFocus(WIDGET)
  w.press(key('a'))
  expect(w.delivered).toEqual([])
  await settle()
  expect(w.reclaims).toBe(1)
  w.replay()
  expect(w.delivered).toEqual(['top:keyDown:a', 'top:char:a'])
})

test('keys typed while keys are held wait behind them: the order is the writer’s', async () => {
  const w = fakeWindow()
  w.setFocus(WIDGET)
  w.press(key('a'))
  w.setFocus(TOP)
  w.press(key('b')); w.press(key(' '))
  await settle()
  w.replay()
  expect(w.delivered.filter((d) => d.includes('keyDown')).map((d) => d.split(':')[2])).toEqual(['a', 'b', ' '])
  expect(w.delivered.every((d) => d.startsWith('top:'))).toBe(true)
})

test('a sent-again key that finds a widget holding the keyboard again is held again, never delivered', async () => {
  const w = fakeWindow()
  w.setFocus(WIDGET)
  w.press(key('x'))
  await settle()
  w.setFocus(WIDGET)
  w.replay()
  expect(w.delivered).toEqual([])
  await settle()
  w.replay()
  expect(w.delivered).toEqual(['top:keyDown:x', 'top:char:x'])
})

test('when the keyboard cannot be taken back, the held keys are dropped, never delivered to the widget', async () => {
  const w = fakeWindow({ reclaimWorks: false })
  w.setFocus(WIDGET)
  w.press(key('a')); w.press(key('b'))
  for (let i = 0; i < 10; i += 1) await settle()
  expect(w.delivered).toEqual([])
  expect(w.dropped).toBe(2)
})

// ── Authorisation: who may say a widget is engaged ──────────────────────────────────────────────────

const cover = (sinceParentPressMs: number, frame = 'wf-widget-a') => ({ engaged: true as const, how: 'press' as const, frame, sinceParentPressMs })

test('a press claim is believed only for a real press the top frame heard itself (its cover), moments before', () => {
  const w = fakeWindow()
  expect(w.gate.claimOwner(cover(0))).toBe(false) // no real press at all
  // The writer presses the cover: main sees the press, the top frame hears it, the times agree.
  w.gate.onMouseDown()
  w.tick(12)
  expect(w.gate.claimOwner(cover(5))).toBe(true)
  expect(w.gate.engaged).toBe(true)
  // One press, one engagement.
  w.gate.claimOwner({ engaged: false })
  expect(w.gate.claimOwner(cover(5))).toBe(false)
  // Too long ago.
  w.gate.onMouseDown()
  w.tick(PRESS_WINDOW_MS + 1)
  expect(w.gate.claimOwner(cover(PRESS_WINDOW_MS))).toBe(false)
})

test('a press inside another frame (the Reading Room) never engages a widget: the top frame did not hear it', () => {
  const w = fakeWindow()
  // The top frame last heard a press of its own long ago; then the writer clicks inside the Reading Room.
  w.gate.onMouseDown()
  w.tick(10)
  expect(w.gate.claimOwner(cover(10 + PRESS_SLACK_MS + 2000))).toBe(false)
  expect(w.gate.engaged).toBe(false)
})

test('the claim names its frame: unknown names are refused, and the keys go to that frame only', async () => {
  const w = fakeWindow()
  w.gate.onMouseDown()
  expect(w.gate.claimOwner(cover(0, 'wf-widget-nope'))).toBe(false)
  w.gate.onMouseDown()
  expect(w.gate.claimOwner(cover(0, 'wf-widget-a'))).toBe(true)
  w.setFocus(WIDGET)
  w.press(key('ArrowRight'))
  expect(w.delivered).toEqual(['widget:keyDown:ArrowRight'])
  // Another widget that takes the focus gets nothing, even while one is engaged.
  w.setFocus(OTHER_WIDGET)
  w.press(key('s'))
  expect(w.delivered).toEqual(['widget:keyDown:ArrowRight'])
  // A keyboard claim (the app's own call) also names its frame.
  expect(w.gate.claimOwner({ engaged: true, how: 'keyboard', frame: 'wf-widget-nope' })).toBe(false)
  expect(w.gate.claimOwner({ engaged: true, how: 'keyboard', frame: 'wf-widget-b' })).toBe(true)
})

test('malformed claims are “no widget engaged”', () => {
  for (const input of [null, true, 'engaged', { engaged: 'true' }, { engaged: true }, { engaged: true, how: 'press', frame: 'wf-widget-a' }, { engaged: true, how: 'press', frame: 'wf-widget-a', sinceParentPressMs: -1 }, { engaged: true, how: 'press', frame: 'wf-widget-a', sinceParentPressMs: Number.NaN }, { engaged: true, how: 'press', sinceParentPressMs: 5 }, { engaged: true, how: 'keyboard' }, { engaged: true, how: 'magic', frame: 'wf-widget-a' }]) {
    expect(parseOwnerClaim(input), JSON.stringify(input)).toEqual({ engaged: false })
  }
  expect(parseOwnerClaim({ engaged: true, how: 'keyboard', frame: 'wf-widget-a' })).toEqual({ engaged: true, how: 'keyboard', frame: 'wf-widget-a' })
  expect(parseOwnerClaim({ engaged: true, how: 'press', frame: 'wf-widget-a', sinceParentPressMs: 9, extra: 1 })).toEqual({ engaged: true, how: 'press', frame: 'wf-widget-a', sinceParentPressMs: 9 })
})

test('before any claim, no widget is engaged; a refused claim leaves none engaged', () => {
  const w = fakeWindow()
  expect(w.gate.engaged).toBe(false)
  w.setFocus(WIDGET)
  w.press(key('a'))
  expect(w.delivered).toEqual([])
  w.gate.claimOwner(cover(0))
  expect(w.gate.engaged).toBe(false)
})

test('a navigation, reload or crash (reset) ends the engagement and drops held keys', async () => {
  const w = fakeWindow({ reclaimWorks: false })
  w.setFocus(WIDGET)
  w.gate.onMouseDown()
  expect(w.gate.claimOwner(cover(0))).toBe(true)
  w.gate.reset()
  expect(w.gate.engaged).toBe(false)
  w.press(key('a'))
  expect(w.delivered).toEqual([])
  w.gate.reset()
  expect(w.gate.held).toBe(0)
})

test('a dead key bound for a widget is never delivered to it: it cannot be sent again, so it is dropped and counted; the next key is sent again', async () => {
  const w = fakeWindow()
  w.setFocus(WIDGET)
  w.press(key('Dead'))
  w.press(key('e'))
  await settle()
  w.replay()
  expect(w.delivered.filter((d) => d.startsWith('widget:'))).toEqual([])
  expect(w.delivered).toEqual(['top:keyDown:e', 'top:char:e'])
  expect(w.dropped).toBe(1)
})

test('a focused frame main cannot read counts as a widget', () => {
  const w = fakeWindow()
  w.setFocus('unreadable')
  w.press(key('a'))
  expect(w.delivered).toEqual([])
})

test('an error in the gate holds the key unless the top frame has the focus', () => {
  const top = {}
  const widget = {}
  let prevented = 0
  const event = { preventDefault: () => { prevented += 1 } }
  const boom = () => { throw new Error('gate failed') }
  guardInput(boom, { focusedFrame: top, mainFrame: top }, event)
  expect(prevented).toBe(0)
  guardInput(boom, { focusedFrame: widget, mainFrame: top }, event)
  expect(prevented).toBe(1)
  guardInput(boom, { get focusedFrame(): unknown { throw new Error('gone') }, mainFrame: top }, event)
  expect(prevented).toBe(2)
})

test('key codes for sending a key again', () => {
  expect(keyCodeFor('a')).toBe('a')
  expect(keyCodeFor(' ')).toBe('Space')
  expect(keyCodeFor('ArrowLeft')).toBe('Left')
  expect(keyCodeFor('F5')).toBe('F5')
  expect(keyCodeFor('Shift')).toBeNull()
})

// ⌘Q while a widget's frame has the focus (quit-does-not-stall). A held key never reaches the menu, so
// main acts on that one key itself; the widget takes no part in it.
test('⌘Q bound for a widget that is not engaged: main quits, and the key is neither delivered nor sent again', async () => {
  const w = fakeWindow()
  w.setFocus(WIDGET)
  w.press(key('q', 'keyDown', { meta: true }))
  expect(w.quits).toBe(1)
  expect(w.gate.held).toBe(0)
  await settle()
  expect(w.sent).toEqual([])
  expect(w.delivered).toEqual(['main:quit'])
  expect(w.heldMeta).toEqual(['q'])
})

test('⌘Q behind held keys waits its turn: the keys typed before it have reached the document when main quits', async () => {
  const w = fakeWindow()
  w.setFocus(WIDGET)
  w.press(key('a')); w.press(key('b'))
  w.press(key('q', 'keyDown', { meta: true }))
  expect(w.quits).toBe(0)
  await settle()
  // Sent again, with main's marker behind them; nothing has been delivered yet, so main has not quit.
  expect(w.sent.filter((event) => event.type === 'keyDown').map((event) => event.keyCode)).toEqual(['a', 'b', DELIVERY_MARKER.keyCode])
  expect(w.delivered).toEqual([])
  expect(w.quits).toBe(0)
  w.replay()
  await settle()
  expect(w.quits).toBe(1)
  // The order the writer typed: both keys and their characters in the document, then the quit.
  expect(w.delivered).toEqual(['top:keyDown:a', 'top:char:a', 'top:keyDown:b', 'top:char:b', 'main:quit'])
  expect(w.markers).toBe(1)
})

test('⌘Q pressed after keys were sent again, before the document has had them, still waits for them', async () => {
  const w = fakeWindow()
  w.setFocus(WIDGET)
  w.press(key('a'))
  await settle() // 'a' has been sent again and not delivered
  w.setFocus(WIDGET) // the widget takes the keyboard again
  w.press(key('q', 'keyDown', { meta: true }))
  expect(w.quits).toBe(0)
  await settle()
  expect(w.quits).toBe(0)
  w.replay()
  await settle()
  expect(w.quits).toBe(1)
  expect(w.delivered).toEqual(['top:keyDown:a', 'top:char:a', 'main:quit'])
})

test('the wait for held keys is bounded: if the top frame never reports the marker, main quits anyway', async () => {
  const w = fakeWindow()
  w.setFocus(WIDGET)
  w.press(key('a'))
  w.press(key('q', 'keyDown', { meta: true }))
  await settle()
  expect(w.quits).toBe(0)
  w.expireDeliveryWait() // DELIVERY_WAIT_MS passed; nothing was replayed
  await settle()
  expect(w.quits).toBe(1)
})

test('the marker is main’s own: a widget that takes the keyboard back is not given it, and it is not sent again', async () => {
  const w = fakeWindow()
  w.setFocus(WIDGET)
  w.press(key('a'))
  w.press(key('q', 'keyDown', { meta: true }))
  await settle()
  w.setFocus(WIDGET) // before the keys sent again arrive
  w.replay()
  await settle()
  expect(w.delivered.filter((d) => d.startsWith('widget:'))).toEqual([])
  expect(w.sent.filter((event) => event.keyCode === DELIVERY_MARKER.keyCode)).toEqual([])
  expect(w.quits).toBe(0) // the keys before it did not arrive: main waits out its bound
  w.expireDeliveryWait()
  for (let i = 0; i < 5; i += 1) await settle()
  expect(w.quits).toBe(1)
  expect(w.delivered.filter((d) => d.startsWith('widget:'))).toEqual([])
})

test('an F24 key-down that is not main’s marker is an ordinary key', async () => {
  const w = fakeWindow()
  w.press(key('F24'))
  expect(w.delivered).toEqual(['top:keyDown:F24'])
  w.setFocus(WIDGET)
  w.press(key('F24'))
  expect(w.gate.held).toBe(1)
})

test('⌘Q is still acted on when the keyboard cannot be taken back; the other held keys are dropped', async () => {
  const w = fakeWindow({ reclaimWorks: false })
  w.setFocus(WIDGET)
  w.press(key('a'))
  w.press(key('q', 'keyDown', { meta: true }))
  for (let i = 0; i < 10; i += 1) await settle()
  expect(w.quits).toBe(1)
  expect(w.dropped).toBe(1)
  expect(w.delivered).toEqual(['main:quit'])
})

// Rule R-D (review round 2, finding 4): the bound runs from the moment ⌘Q is held, so it also covers
// an attempt to take the keyboard back that never returns.
test('⌘Q held while the top frame never gives the keyboard back: main quits when the bound runs out', async () => {
  const w = fakeWindow({ reclaimNeverReturns: true })
  w.setFocus(WIDGET)
  w.press(key('a'))
  w.press(key('q', 'keyDown', { meta: true }))
  for (let i = 0; i < 10; i += 1) await settle()
  expect(w.reclaims).toBe(1) // stuck in the first attempt
  expect(w.quits).toBe(0)
  expect(w.longWaits).toBe(1) // the bound was started when ⌘Q was held, not after the keyboard came back
  w.expireDeliveryWait() // DELIVERY_WAIT_MS after ⌘Q was held
  await settle()
  expect(w.quits).toBe(1)
  expect(w.delivered).toEqual(['main:quit']) // nothing reached the widget, and ⌘Q was not sent again
  expect(w.sent).toEqual([])
})

test('a ⌘Q acted on by its bound is not acted on again, nor sent again, if the keyboard comes back later', async () => {
  const w = fakeWindow()
  w.setFocus(WIDGET)
  w.press(key('a'))
  w.press(key('q', 'keyDown', { meta: true }))
  await settle() // "a" was sent again; main waits for the marker
  w.expireDeliveryWait() // both the bound and the marker wait run out
  for (let i = 0; i < 5; i += 1) await settle()
  w.replay()
  for (let i = 0; i < 5; i += 1) await settle()
  expect(w.quits).toBe(1)
  expect(w.sent.filter((event) => event.keyCode.toLowerCase() === 'q')).toEqual([])
  expect(w.delivered.filter((d) => d.endsWith(':q'))).toEqual([])
})

test('a reset before the bound runs out: the ⌘Q held for the old document is not acted on', async () => {
  const w = fakeWindow({ reclaimNeverReturns: true })
  w.setFocus(WIDGET)
  w.press(key('a'))
  w.press(key('q', 'keyDown', { meta: true }))
  await settle()
  w.gate.reset()
  w.expireDeliveryWait()
  await settle()
  expect(w.quits).toBe(0)
})

test('only ⌘Q on a Mac is main’s own: every other held Meta key is sent again as before', async () => {
  const w = fakeWindow()
  w.setFocus(WIDGET)
  w.press(key('w', 'keyDown', { meta: true }))
  w.press(key('q', 'keyDown', { meta: true, shift: true }))
  await settle()
  expect(w.quits).toBe(0)
  expect(w.sent.map((event) => `${event.keyCode}+${event.modifiers.join('+')}`)).toEqual(['w+meta', 'q+shift+meta'])
  expect(w.heldMeta).toEqual(['w', 'q'])
  expect(isQuitKey(key('q', 'keyDown', { meta: true }), 'darwin')).toBe(true)
  expect(isQuitKey(key('Q', 'keyDown', { meta: true }), 'darwin')).toBe(true)
  expect(isQuitKey(key('q', 'keyUp', { meta: true }), 'darwin')).toBe(false)
  expect(isQuitKey(key('q', 'keyDown', { meta: true, alt: true }), 'darwin')).toBe(false)
  expect(isQuitKey(key('q', 'keyDown', { control: true }), 'darwin')).toBe(false)
  expect(isQuitKey(key('q', 'keyDown', { meta: true }), 'win32')).toBe(false)
})

test('⌘Q with the top frame or an engaged widget focused is not held: the gate leaves it to the menu', () => {
  const w = fakeWindow()
  w.press(key('q', 'keyDown', { meta: true }))
  expect(w.quits).toBe(0)
  expect(w.delivered).toEqual(['top:keyDown:q'])
})
