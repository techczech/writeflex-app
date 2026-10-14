/**
 * No keystroke reaches a widget the writer has not engaged (interactive-widgets-in-documents, ticket 02,
 * security fix round). A widget can take the keyboard focus by itself (focus() at load, in a loop); the
 * window's focus guard takes it back, but only after the fact, and a key typed in between went to the
 * widget: a widget could read what the writer types.
 *
 * Closed where the key is routed. Every keystroke passes `before-input-event` before Chromium delivers it,
 * and `webContents.focusedFrame` is the frame it would be delivered to. When that frame is a widget's
 * (an opaque origin, inside the window) and no widget is engaged, the key is held back (preventDefault:
 * the widget never sees it, nor the character it would make), the window is asked to take the keyboard
 * back, and the held keys are then sent again, in order, to whatever now has the focus (the editor). Keys
 * typed while keys are held wait behind them, so the order is the writer's. If the window cannot take
 * the keyboard back, the held keys are dropped, never delivered to the widget.
 *
 * Whether a widget is engaged is told by the window's top frame (`widget:keyboard-owner`); a widget has no
 * IPC (ipc-main-frame-only.ts). The ask to take the keyboard back is a DOM event dispatched in the top
 * frame's own world, which a widget's frame cannot dispatch there.
 *
 * Authorisation (security round 3). Nothing a widget sends grants it the keyboard. The writer engages a
 * widget by pressing the cover the top frame lays over it (widget-frame.ts): a trusted press the top frame
 * hears itself. Main believes a claim of such a press only if it saw a real left mouse press moments
 * before (`before-mouse-event`, which no page can cause) and the top frame heard that same press (it
 * reports how long ago; the two elapsed times must agree). A press inside any frame (a widget's, the
 * Reading Room's) is never heard by the top frame, so it can never back an engagement. Each real press
 * backs one engagement. The claim names the frame by the random name the top frame gave it when it made
 * it; main learnt that name with the frame's tree node when the frame was created (frame-created, before
 * any of the widget's script ran), and grants the keys to that frame alone, never to whichever frame
 * happens to have the focus. A claim by keyboard (the app's own call) names the frame the same way.
 *
 * Fails closed (round 2). No widget is engaged until the top frame says so and main has checked it; the
 * engagement ends with a top-level navigation or reload, a renderer crash, and the window; a frame whose
 * properties cannot be read counts as a widget; an error in the gate holds the key unless the top frame
 * has the focus.
 */

import { WIDGET_RECLAIM_EVENT } from '../shared/widget-keyboard-event'
export { WIDGET_RECLAIM_EVENT }

export type KeyModifier = 'shift' | 'control' | 'alt' | 'meta'
export type HeldKey = { type: 'keyDown' | 'keyUp'; key: string; shift: boolean; control: boolean; alt: boolean; meta: boolean }

/** A frame as main can see it; `node` (the frame tree node) stays the same across the frame's documents. */
type FrameRef = { origin: string; processId: number; routingId: number; node?: number }
/** The focused frame: none, one main could read, or one it could not (counted as a widget's). */
type FrameLike = FrameRef | 'unreadable' | null

/** What the top frame says: the widget frame named `frame` engaged by a press on its cover (with how long
 *  ago the top frame heard that press), by the keyboard (the app's own call), or none. */
export type OwnerClaim =
  | { engaged: false }
  | { engaged: true; how: 'press'; frame: string; sinceParentPressMs: number }
  | { engaged: true; how: 'keyboard'; frame: string }

export type KeyboardGateHost = {
  focusedFrame(): FrameLike
  mainFrame(): FrameLike
  /** Dispatch the reclaim event in the top frame; resolves when the window's handler has run. */
  reclaim(): Promise<void>
  send(event: { type: 'keyDown' | 'keyUp' | 'char'; keyCode: string; modifiers: KeyModifier[] }): void
  wait(ms: number): Promise<void>
  onDropped?(count: number): void
  /** The app shell's own origin ('file://' in a build): its frames (the Reading Room's) are not gated. */
  shellOrigin(): string
  now(): number
  /** The window's widget frame (a child of the top frame, opaque origin) with tthe account holder's name, or null. */
  findWidgetFrame(name: string): FrameRef | null
  /** Told of each key the gate holds back from a widget, once, when it is first held. */
  onHeld?(input: HeldKey): void
  /** What main does itself with a held key, or null (every key but ⌘Q). Such a key is never sent again:
   *  main acts on it in its turn, after the keys held before it have gone to the document. */
  actsOn?(input: HeldKey): (() => void) | null
  /** Start listening in the top frame for the marker key (`DELIVERY_MARKER`). Resolves, once the
   *  listener is in place, to a wait that is true when the top frame has had the marker. Without this
   *  port main acts on its own keys without waiting for the keys sent before them. */
  watchMarker?(): Promise<() => Promise<boolean>>
}

/**
 * The marker: a key main sends behind the keys it sends again, on the same input path, to learn that the
 * document has had them. Input events reach a page in the order sent and one at a time, so when the top
 * frame sees the marker every key before it has been handled there (and the editor has taken its text
 * in). A key-down, because Chromium drops key-ups and characters that follow a held key-down; F24,
 * because no keyboard has one and nothing is bound to it. The top frame's listener stops it there.
 */
export const DELIVERY_MARKER = { type: 'keyDown', keyCode: 'F24', modifiers: [] as KeyModifier[] } as const
/** How long a held key of main's own (⌘Q) waits for the keys held before it, counted from the moment it
 *  is held: taking the keyboard back, sending those keys again and the marker's return all fall inside
 *  it. Then main acts anyway. A widget that keeps taking the keyboard back, or a top frame too busy to
 *  give it back, can cost the keys held before ⌘Q; neither can keep the app from quitting. */
export const DELIVERY_WAIT_MS = 1000

/** How long after a real press a claim of engagement by press is believed. */
export const PRESS_WINDOW_MS = 1500
/** How far the top frame's and main's elapsed times for the same press may differ (IPC delay). */
export const PRESS_SLACK_MS = 250

const NAMED: Record<string, string> = {
  ' ': 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', Escape: 'Escape',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
}

/** The accelerator key code `sendInputEvent` takes for a key as `before-input-event` reports it; null for
 *  a key that cannot be sent again (a dead key, a modifier on its own, an unidentified key). */
export function keyCodeFor(key: string): string | null {
  if (NAMED[key]) return NAMED[key]
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key
  if (Array.from(key).length === 1) return key
  return null
}

function modifiersOf(input: HeldKey): KeyModifier[] {
  return [input.shift && 'shift', input.control && 'control', input.alt && 'alt', input.meta && 'meta'].filter(Boolean) as KeyModifier[]
}

/**
 * ⌘Q on a Mac, and nothing else: the one held key main acts on itself (it quits, as the app menu's Quit
 * does). A held key cannot reach the menu, so without this the app could not be quit from the keyboard
 * while a widget's frame had the focus. Every other held key is sent on to the document as before.
 */
export function isQuitKey(input: HeldKey, platform: string): boolean {
  return platform === 'darwin' && input.type === 'keyDown' && input.meta && !input.control && !input.alt && !input.shift && input.key.toLowerCase() === 'q'
}

/** A key that makes text when typed without control, alt or meta. */
function makesText(input: HeldKey): boolean {
  return !input.control && !input.alt && !input.meta && (Array.from(input.key).length === 1)
}

export type KeyboardGate = {
  /** Call from `before-input-event`. True: the caller must preventDefault. */
  onInput(input: { type: string; key: string; shift: boolean; control: boolean; alt: boolean; meta: boolean; isComposing?: boolean }): boolean
  /** Call from `before-mouse-event` for every left mouse press. */
  onMouseDown(): void
  /** The top frame's claim, as it stood when it arrived (`at`); true when main accepts it. A refused claim
   *  leaves no widget engaged. */
  claimOwner(claim: OwnerClaim, at?: number): boolean
  /** Navigation, reload, crash: no widget is engaged and held keys are dropped. */
  reset(): void
  readonly held: number
  readonly engaged: boolean
}

export function createKeyboardGate(host: KeyboardGateHost, options: { attempts?: number; retryMs?: number } = {}): KeyboardGate {
  const attempts = options.attempts ?? 20
  const retryMs = options.retryMs ?? 10
  let engaged = false
  // The frame the engagement was granted to (found by the name the top frame gave it).
  let ownerFrame: FrameRef | null = null
  let lastPress: number | null = null
  const queue: HeldKey[] = []
  // Keys sent again and not yet seen coming back through before-input-event.
  const replaying: HeldKey[] = []
  let reclaiming = false
  // Held keys main acts on itself (⌘Q), with what it does, until it has done it.
  const actions = new Map<HeldKey, () => void>()
  // Every held key that is main's own, acted on yet or not: never sent again.
  const own = new WeakSet<HeldKey>()
  // Keys have been sent again and the top frame is not yet known to have had them.
  let undelivered = false
  // The marker is on its way: the next F24 key-down on the input path is main's own.
  let expectingMarker = false
  // Counts resets: work that waited across one belongs to a document that is gone.
  let generation = 0

  const sameFrame = (a: FrameRef, b: FrameRef): boolean => (a.node !== undefined && b.node !== undefined ? a.node === b.node : a.processId === b.processId && a.routingId === b.routingId)
  function isTop(frame: FrameLike): boolean {
    if (!frame || frame === 'unreadable') return false
    const top = host.mainFrame()
    return Boolean(top && top !== 'unreadable' && sameFrame(frame, top))
  }
  /** Whether a key now would be delivered to a widget that may not have it. */
  function intoWidget(): boolean {
    const focused = host.focusedFrame()
    if (!focused) return false
    if (focused === 'unreadable') return true
    if (isTop(focused)) return false
    const shell = host.shellOrigin()
    if (focused.origin !== 'null' && shell && focused.origin === shell) return false // the app's own frames
    if (!engaged || !ownerFrame) return true
    return !sameFrame(focused, ownerFrame)
  }

  const same = (a: HeldKey, b: HeldKey): boolean => a.type === b.type && a.key === b.key && a.shift === b.shift && a.control === b.control && a.alt === b.alt && a.meta === b.meta

  function resend(input: HeldKey): void {
    const keyCode = keyCodeFor(input.key)
    // A key that cannot be sent again (a dead key: no accelerator code exists for it, and the accent it
    // starts is the system input method's state, which a synthetic event cannot recreate) is dropped,
    // never delivered to the widget it was bound for, and counted.
    if (!keyCode) { if (input.type === 'keyDown') host.onDropped?.(1); return }
    replaying.push(input)
    undelivered = true
    host.send({ type: input.type, keyCode, modifiers: modifiersOf(input) })
    // The character goes right behind its key. If the key is held again on its way (a widget took the
    // keyboard again), Chromium drops the character with it: a held key suppresses the char and keyup
    // events that follow it until the next keydown.
    if (input.type === 'keyDown' && makesText(input)) host.send({ type: 'char', keyCode, modifiers: modifiersOf(input) })
  }

  async function reclaimThenFlush(): Promise<void> {
    if (reclaiming) return
    reclaiming = true
    try {
      for (let attempt = 0; attempt < attempts && queue.length > 0; attempt += 1) {
        try { await host.reclaim() } catch { /* the window is gone or busy: try again */ }
        if (!intoWidget()) {
          const held = queue.splice(0)
          const mine = generation
          for (let index = 0; index < held.length; index += 1) {
            const input = held[index]
            if (!own.has(input)) { resend(input); continue }
            if (!actions.has(input)) continue // acted on already: its bound ran out while it waited here
            // A key of main's own (⌘Q): the keys sent before it reach the document first.
            await delivered()
            if (generation !== mine) {
              // The document was replaced while main waited: the keys still held went with it.
              const lost = held.slice(index).filter((later) => later.type === 'keyDown').length
              if (lost > 0) host.onDropped?.(lost)
              return
            }
            act(input)
          }
          return
        }
        await host.wait(retryMs)
      }
      if (queue.length > 0) {
        // The window could not take the keyboard back: the keys are dropped, never given to the widget.
        // A key of main's own gives the widget nothing, so main still acts on it.
        const abandoned = queue.splice(0)
        for (const input of abandoned) act(input)
        const dropped = abandoned.filter((input) => !own.has(input)).length
        if (dropped > 0) host.onDropped?.(dropped)
      }
    } finally {
      reclaiming = false
      if (queue.length > 0) void reclaimThenFlush()
    }
  }

  /**
   * Resolves when the top frame has had every key sent again so far, or after DELIVERY_WAIT_MS. Main
   * sends the marker behind those keys and the top frame reports seeing it. While main waits, keys the
   * writer types are held in the queue as usual (a flush is in progress), so their order is kept.
   */
  async function delivered(): Promise<void> {
    if (!undelivered || !host.watchMarker) return
    const mine = generation
    let waiting = true
    const reached = (async (): Promise<boolean> => {
      const seen = await host.watchMarker!()
      if (!waiting || generation !== mine) return false // too late: main has moved on, no marker is sent
      expectingMarker = true
      host.send(DELIVERY_MARKER)
      return (await seen()) === true
    })().catch(() => false)
    const ok = await Promise.race([reached, host.wait(DELIVERY_WAIT_MS).then(() => false, () => false)])
    waiting = false
    expectingMarker = false
    if (ok && generation === mine && replaying.length === 0) undelivered = false
  }

  /** Run what main does with a held key of its own. An error there loses that key, and no other. */
  function act(input: HeldKey): boolean {
    const action = actions.get(input)
    if (!action) return false
    actions.delete(input)
    try { action() } catch { /* main's own handler failed */ }
    return true
  }

  /** Hold a key back from the widget: it waits to be sent again, or for main to act on it in its turn. */
  function hold(input: HeldKey, isReplay: boolean): true {
    if (!isReplay) {
      try { host.onHeld?.(input) } catch { /* a diagnostic that failed changes nothing */ }
      let action: (() => void) | null = null
      try { action = host.actsOn?.(input) ?? null } catch { action = null }
      if (action) {
        actions.set(input, action)
        own.add(input)
        // Nothing held before it, and nothing sent again that the document may not have had yet: main
        // acts now. Otherwise it keeps its place in the queue.
        if (queue.length === 0 && replaying.length === 0 && !reclaiming && !(undelivered && host.watchMarker)) { act(input); return true }
        // It waits its turn for DELIVERY_WAIT_MS at most, counted from here. Everything between this
        // moment and its turn is inside that bound, an attempt to take the keyboard back that never
        // returns included. A reset in the meantime cleared the action, and nothing happens.
        void host.wait(DELIVERY_WAIT_MS).then(() => { act(input) }, () => { act(input) })
      }
    }
    if (isReplay) queue.unshift(input); else queue.push(input)
    void reclaimThenFlush()
    return true
  }

  return {
    get held() { return queue.length },
    get engaged() { return engaged },
    onMouseDown() { lastPress = host.now() },
    claimOwner(claim, at = host.now()) {
      if (!claim || claim.engaged !== true) { engaged = false; ownerFrame = null; return true }
      const frame = host.findWidgetFrame(claim.frame)
      if (!frame) { engaged = false; ownerFrame = null; return false }
      if (claim.how === 'press') {
        const sinceReal = lastPress === null ? Infinity : at - lastPress
        // The real press main saw is the press the top frame heard: the two elapsed times agree.
        const same = sinceReal <= PRESS_WINDOW_MS && Math.abs(sinceReal - claim.sinceParentPressMs) <= PRESS_SLACK_MS
        if (!same) { engaged = false; ownerFrame = null; return false }
        lastPress = null // one press, one engagement
      } else if (claim.how !== 'keyboard') { engaged = false; ownerFrame = null; return false }
      engaged = true
      ownerFrame = frame
      return true
    },
    reset() {
      engaged = false
      ownerFrame = null
      lastPress = null
      const dropped = queue.splice(0).length
      replaying.splice(0)
      actions.clear()
      generation += 1
      undelivered = false
      expectingMarker = false
      if (dropped > 0) host.onDropped?.(dropped)
    },
    onInput(raw) {
      if (raw.type !== 'keyDown' && raw.type !== 'keyUp') return false
      const input: HeldKey = { type: raw.type, key: raw.key, shift: raw.shift, control: raw.control, alt: raw.alt, meta: raw.meta }
      // Main's own marker: it goes to the top frame, where the listener stops it, and to nothing else.
      // If a widget has taken the keyboard again it is dropped (never delivered, never sent again).
      if (expectingMarker && raw.type === 'keyDown' && raw.key === DELIVERY_MARKER.keyCode && !raw.shift && !raw.control && !raw.alt && !raw.meta) return intoWidget()
      const isReplay = replaying.length > 0 && same(replaying[0], input)
      if (isReplay) replaying.shift()
      else if (queue.length > 0 || replaying.length > 0 || reclaiming) {
        // Behind keys still held or on their way again: wait, so the order stays the writer's.
        if (queue.length > 0 || reclaiming) return hold(input, false)
      }
      if (intoWidget()) return hold(input, isReplay)
      return false
    },
  }
}

// ── One gate per window ─────────────────────────────────────────────────────────────────────────────

const gates = new Map<number, KeyboardGate & { findWidgetFrame(name: string): FrameRef | null }>()

type WebFrameLike = { origin: string; name: string; processId: number; routingId: number; frameTreeNodeId: number; parent: WebFrameLike | null; frames: WebFrameLike[]; executeJavaScript(code: string): Promise<unknown> }
type WindowContentsLike = {
  id: number
  focusedFrame: WebFrameLike | null
  mainFrame: WebFrameLike
  isDestroyed(): boolean
  sendInputEvent(event: { type: 'keyDown' | 'keyUp' | 'char'; keyCode: string; modifiers: KeyModifier[] }): void
  on(event: 'before-input-event', listener: (event: { preventDefault(): void }, input: { type: string; key: string; shift: boolean; control: boolean; alt: boolean; meta: boolean }) => void): unknown
  on(event: 'before-mouse-event', listener: (event: unknown, mouse: { type: string; x: number; y: number; button?: string }) => void): unknown
  on(event: 'did-start-navigation', listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void): unknown
  on(event: 'render-process-gone', listener: () => void): unknown
  on(event: 'frame-created', listener: (event: unknown, details: { frame: WebFrameLike | null }) => void): unknown
  once(event: 'destroyed', listener: () => void): unknown
}

const frameOf = (read: () => WebFrameLike | null): FrameLike => {
  try {
    const frame = read()
    return frame ? { origin: frame.origin, processId: frame.processId, routingId: frame.routingId, node: frame.frameTreeNodeId } : null
  } catch {
    return 'unreadable'
  }
}

/** Ask the gate about one key; an error in the gate holds the key unless the top frame has the focus. */
export function guardInput(decide: () => boolean, contents: { focusedFrame: unknown; mainFrame: unknown }, event: { preventDefault(): void }): void {
  try {
    if (decide()) event.preventDefault()
  } catch {
    try {
      const focused = contents.focusedFrame
      if (focused && focused !== contents.mainFrame) event.preventDefault()
    } catch { event.preventDefault() }
  }
}

// Run in the top frame's own world (a widget's frame cannot reach it). The first puts a one-shot
// listener for the marker ahead of the page's own key handling and keeps its outcome; the second reads
// that outcome. Trusted events only: a script cannot make one, and widget content is in another frame.
const MARKER_SLOT = '__writeflexHeldKeysMarker'
const MARKER_LISTEN_SCRIPT = `(() => {
  let settle
  const seen = new Promise((resolve) => { settle = resolve })
  const finish = (value) => { window.removeEventListener('keydown', onKey, true); clearTimeout(timer); settle(value) }
  const onKey = (event) => {
    if (!event.isTrusted || event.key !== ${JSON.stringify(DELIVERY_MARKER.keyCode)}) return
    event.preventDefault()
    event.stopImmediatePropagation()
    finish(true)
  }
  const timer = setTimeout(() => finish(false), ${DELIVERY_WAIT_MS})
  window.addEventListener('keydown', onKey, true)
  window[${JSON.stringify(MARKER_SLOT)}] = seen
  return true
})()`
const MARKER_SEEN_SCRIPT = `Promise.resolve(window[${JSON.stringify(MARKER_SLOT)}]).then((value) => value === true)`

/** Put the gate on a window's web contents. */
export function attachKeyboardGate(contents: WindowContentsLike, shellURL: string, onDropped?: (count: number) => void, hooks: Pick<KeyboardGateHost, 'onHeld' | 'actsOn'> = {}): KeyboardGate {
  let shellOrigin = ''
  try { const url = new URL(shellURL); shellOrigin = url.protocol === 'file:' ? 'file://' : url.origin } catch { shellOrigin = '' }
  // The name the top frame gave each widget frame, as it stood when the frame was created (before any
  // script of the widget ran: a widget may rename itself later, and Chromium does not carry a later change
  // of the iframe's name attribute to the frame), kept with the frame's tree node, which stays the same
  // across the frame's documents. First seen wins; only a direct child of the top frame counts.
  const widgetNodes = new Map<string, number>()
  contents.on('frame-created', (_event, details) => {
    try {
      const frame = details.frame
      if (!frame || !frame.parent || frame.parent.frameTreeNodeId !== contents.mainFrame.frameTreeNodeId) return
      if (!/^wf-widget-[0-9a-f]{32}$/.test(frame.name) || widgetNodes.has(frame.name)) return
      if (widgetNodes.size > 4096) widgetNodes.clear()
      widgetNodes.set(frame.name, frame.frameTreeNodeId)
    } catch { /* a frame already gone */ }
  })
  const host: KeyboardGateHost = {
    focusedFrame: () => (contents.isDestroyed() ? null : frameOf(() => contents.focusedFrame)),
    mainFrame: () => (contents.isDestroyed() ? null : frameOf(() => contents.mainFrame)),
    reclaim: async () => {
      if (contents.isDestroyed()) return
      await contents.mainFrame.executeJavaScript(`window.dispatchEvent(new Event(${JSON.stringify(WIDGET_RECLAIM_EVENT)})); true`)
    },
    send: (event) => { if (!contents.isDestroyed()) contents.sendInputEvent(event) },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    watchMarker: async () => {
      if (contents.isDestroyed()) throw new Error('The window has gone.')
      await contents.mainFrame.executeJavaScript(MARKER_LISTEN_SCRIPT)
      return async () => (contents.isDestroyed() ? false : (await contents.mainFrame.executeJavaScript(MARKER_SEEN_SCRIPT)) === true)
    },
    onDropped,
    onHeld: hooks.onHeld,
    actsOn: hooks.actsOn,
    shellOrigin: () => shellOrigin,
    now: () => Date.now(),
    findWidgetFrame: (name) => {
      if (contents.isDestroyed() || typeof name !== 'string') return null
      const node = widgetNodes.get(name)
      if (node === undefined) return null
      try {
        const found = contents.mainFrame.frames.find((frame) => frame.frameTreeNodeId === node)
        if (!found || found.origin !== 'null') return null
        return { origin: found.origin, processId: found.processId, routingId: found.routingId, node }
      } catch {
        return null
      }
    },
  }
  const gate = createKeyboardGate(host)
  const id = contents.id
  gates.set(id, Object.assign(gate, { findWidgetFrame: host.findWidgetFrame }))
  contents.on('before-input-event', (event, input) => guardInput(() => gate.onInput(input), contents, event))
  contents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseDown' && (mouse.button === undefined || mouse.button === 'left')) gate.onMouseDown()
  })
  // The engagement belongs to the document that claimed it: a new top-level document, or a renderer
  // that has gone, has engaged nothing.
  contents.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument) gate.reset() })
  contents.on('render-process-gone', () => gate.reset())
  contents.once('destroyed', () => { gate.reset(); gates.delete(id) })
  return gate
}

/** Read the top frame's claim strictly; anything malformed is "no widget engaged". */
export function parseOwnerClaim(input: unknown): OwnerClaim {
  if (!input || typeof input !== 'object') return { engaged: false }
  const claim = input as Record<string, unknown>
  if (claim.engaged !== true || typeof claim.frame !== 'string' || claim.frame.length === 0 || claim.frame.length > 64) return { engaged: false }
  if (claim.how === 'keyboard') return { engaged: true, how: 'keyboard', frame: claim.frame }
  if (claim.how !== 'press') return { engaged: false }
  const since = claim.sinceParentPressMs
  if (typeof since !== 'number' || !Number.isFinite(since) || since < 0) return { engaged: false }
  return { engaged: true, how: 'press', frame: claim.frame, sinceParentPressMs: since }
}

/**
 * The top frame's claim about the window's widgets. True when accepted; a window without a gate accepts
 * nothing. The top frame names the frame at the moment of engagement (it sets a fresh name on it), and the
 * new name reaches main a moment later: the claim waits for it, briefly, timed from when it arrived.
 */
export async function claimWidgetKeyboardOwner(webContentsId: number, input: unknown, wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<boolean> {
  const entry = gates.get(webContentsId)
  if (!entry) return false
  const claim = parseOwnerClaim(input)
  const at = Date.now()
  if (claim.engaged) {
    for (let attempt = 0; attempt < 30 && !entry.findWidgetFrame(claim.frame); attempt += 1) await wait(10)
  }
  return entry.claimOwner(claim, at)
}
