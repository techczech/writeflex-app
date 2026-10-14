/**
 * A sealed frame that runs a widget and gives the keyboard back (interactive-widgets-in-documents,
 * ticket 02). The one way the renderer runs a widget:
 *
 *   const widget = mountWidgetFrame({ container, html, title, returnFocus })
 *   widget.engage()      // the writer chose the widget by keyboard: it gets the keyboard
 *   widget.disengage()   // hand the keyboard back to the document at its cursor
 *   widget.dispose()     // remove the frame; the last one out removes every listener and timer
 *
 * The frame: `sandbox="allow-scripts allow-forms"` (never allow-same-origin; guarded by a throw),
 * `credentialless`, `referrerpolicy="no-referrer"`, and the page's text, with the policy, referrer,
 * base and agent lead in front, given by `srcdoc` (an opaque origin), and a random `name` by which main
 * knows the frame when it grants it the keyboard. Nothing else is ever set on it.
 *
 * Engagement (security round 3): nothing the widget sends grants it anything. Over every widget that is
 * not engaged the window lays a transparent cover of its own (TalkWeaver's pattern). The writer's press
 * on the cover, a trusted press this window hears itself, engages the widget: the cover goes, the widget
 * is focused, and main is told (it checks the press against the real press it saw, and grants the keys
 * to this frame only). The press itself goes no further: the first click on a widget only engages it.
 * Ending the engagement brings the cover back.
 *
 * Focus (widget-focus.ts): a frame that is not engaged never holds the window's focus. Escape inside it
 * (forwarded by the agent; it can only end an engagement) disengages it and calls `returnFocus`, which
 * puts the keyboard back in the editor at the cursor. A press anywhere in the window outside the frame,
 * or the focus moving to anything else in the window, disengages it; that press puts the focus where it
 * lands.
 *
 * One runtime per window (the channel, the focus guard and a few listeners) is shared by every widget
 * in it, made by the first mount and removed with the last dispose.
 */
import { assertWidgetSandbox, widgetFrameAttributes, withWidgetLead } from '../../../shared/widget-document'
import { createWidgetChannel, type WidgetChannel } from './widget-channel'
import { createWidgetFocusGuard, type WidgetFocusGuard } from './widget-focus'
import { WIDGET_RECLAIM_EVENT } from '../../../shared/widget-keyboard-event'

export type WidgetFrameOptions = {
  /** Where the frame goes (appended). */
  container: HTMLElement
  /** The widget's HTML text, as main read it. The lead is added here. */
  html: string
  /** The frame's accessible name. */
  title: string
  /** Put the keyboard back in the document at its cursor (the editor's own focus()). */
  returnFocus: () => void
  onEngagedChange?: (engaged: boolean) => void
  /** The page reported its content height (whole pixels, 40 to 20000), on load and when it changes. */
  onHeight?: (height: number) => void
  /** The widget kept taking the keyboard and was stopped (its frame emptied). `engage()` runs it again. */
  onStopped?: () => void
}

export type WidgetFrame = {
  readonly frame: HTMLIFrameElement
  readonly engaged: boolean
  readonly stopped: boolean
  engage(): void
  disengage(): void
  dispose(): void
}

type Entry = {
  frame: HTMLIFrameElement
  /** The window's own layer over the frame while it is not engaged. */
  cover: HTMLDivElement
  /** The frame's name, random, set before the frame exists: main learns it with the frame when the frame is
   *  created, and finds the frame by it when it grants it the keyboard (whatever name the widget takes later). */
  name: string
  document: string
  options: WidgetFrameOptions
  engaged: boolean
  stopped: boolean
  disposed: boolean
}

type Runtime = {
  channel: WidgetChannel
  guard: WidgetFocusGuard
  entries: Set<Entry>
  /** When this document last heard a trusted pointer press of its own (performance.now()), or null. */
  lastParentPress: number | null
  dispose(): void
}

const runtimes = new WeakMap<Window, Runtime>()

/** TEST-ONLY: the e2e gate set switches the window's focus rule off (widget-e2e-mount.ts) to show that the
 *  main-process key gate alone keeps keys from a widget that holds the keyboard. Never set in the app. */
let focusRuleOn = true
export function setWidgetFocusRuleForTest(on: boolean): void { focusRuleOn = on }

function entryFor(runtime: Runtime, frame: Element | null): Entry | null {
  if (!frame) return null
  for (const entry of runtime.entries) if (entry.frame === frame) return entry
  return null
}

function setEngaged(runtime: Runtime, entry: Entry, engaged: boolean, how: { focus?: boolean; returnFocus?: boolean; via?: 'press' | 'keyboard' } = {}): void {
  if (entry.disposed) return
  const changed = entry.engaged !== engaged
  entry.engaged = engaged
  entry.frame.dataset.widgetEngaged = engaged ? 'true' : 'false'
  entry.cover.hidden = engaged
  if (engaged && how.focus) { try { entry.frame.focus({ preventScroll: true }) } catch { /* ignore */ } }
  if (!engaged) {
    const doc = entry.frame.ownerDocument
    if (how.returnFocus && doc.activeElement === entry.frame) {
      try { entry.frame.blur() } catch { /* ignore */ }
      try { entry.options.returnFocus() } catch { /* the caller's affair */ }
    } else if (how.returnFocus) {
      try { entry.options.returnFocus() } catch { /* the caller's affair */ }
    }
    runtime.guard.check()
  }
  if (changed) {
    tellKeyboardOwner(entry.frame.ownerDocument.defaultView, runtime, how.via ?? 'keyboard')
    try { entry.options.onEngagedChange?.(engaged) } catch { /* the caller's affair */ }
  }
}

function freshFrameName(win: Window | null): string {
  const bytes = (win ?? window).crypto.getRandomValues(new Uint8Array(16))
  return `wf-widget-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

type OwnerClaim = { engaged: false } | { engaged: true; how: 'press'; frame: string; sinceParentPressMs: number } | { engaged: true; how: 'keyboard'; frame: string }

/**
 * Main holds back keys meant for a widget frame unless one is engaged (src/main/widget-keyboard.ts). The
 * claim names the frame (its random name) and, for a press on the cover, how long ago this document heard
 * that press: main believes it only if the real press it saw is that same press, one this document heard.
 * A refused engagement is ended here at once (the keyboard goes back to the document).
 */
function tellKeyboardOwner(win: Window | null, runtime: Runtime, via: 'press' | 'keyboard'): void {
  const owner = [...runtime.entries].find((entry) => entry.engaged)
  const bridge = (win as (Window & { writeflex?: { setWidgetKeyboardOwner?: (claim: OwnerClaim) => Promise<{ accepted?: boolean } | void> } }) | null)?.writeflex
  if (typeof bridge?.setWidgetKeyboardOwner !== 'function') return
  let claim: OwnerClaim = { engaged: false }
  if (owner) {
    const since = runtime.lastParentPress === null ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.round((win?.performance.now() ?? 0) - runtime.lastParentPress))
    claim = via === 'press' ? { engaged: true, how: 'press', frame: owner.name, sinceParentPressMs: since } : { engaged: true, how: 'keyboard', frame: owner.name }
  }
  void bridge.setWidgetKeyboardOwner(claim).then((answer) => {
    if (owner && answer && answer.accepted === false && owner.engaged && !owner.disposed) setEngaged(runtime, owner, false, { returnFocus: true })
  }).catch(() => {})
}

/** Give the frame its document under a fresh activation. */
function load(runtime: Runtime, entry: Entry): void {
  assertWidgetSandbox(entry.frame.getAttribute('sandbox'))
  if (!runtime.channel.activate(entry.frame)) throw new Error('widget-frame: the frame has no window to activate')
  entry.stopped = false
  entry.frame.dataset.widgetState = 'running'
  entry.frame.srcdoc = entry.document
  runtime.guard.watch()
}

/** Empty the frame: the widget stops running. The focus is moved off it first. */
function unload(runtime: Runtime, entry: Entry): void {
  runtime.guard.release(entry.frame)
  runtime.channel.deactivate(entry.frame)
  entry.frame.removeAttribute('srcdoc')
}

function runtimeFor(win: Window): Runtime {
  const existing = runtimes.get(win)
  if (existing) return existing
  const doc = win.document
  const entries = new Set<Entry>()
  // Assigned before any listener below can run.
  let runtime: Runtime

  const channel = createWidgetChannel({
    window: win,
    onEscape: (frame) => {
      const entry = entryFor(runtime, frame)
      if (entry && entry.engaged) setEngaged(runtime, entry, false, { returnFocus: true })
    },
    onHeight: (frame, height) => {
      const entry = entryFor(runtime, frame)
      if (entry && !entry.stopped) { try { entry.options.onHeight?.(height) } catch { /* the caller's affair */ } }
    },
  })

  const guard = createWidgetFocusGuard({
    window: win,
    enabled: () => focusRuleOn,
    status: (frame) => {
      const entry = entryFor(runtime, frame)
      return entry && !entry.stopped ? { engaged: entry.engaged } : null
    },
    livePresent: () => [...entries].some((entry) => !entry.stopped),
    inUse: () => [...entries].some((entry) => entry.engaged),
    onStopped: () => {
      for (const entry of entries) {
        if (entry.engaged || entry.stopped) continue
        unload(runtime, entry)
        entry.stopped = true
        entry.frame.dataset.widgetState = 'stopped'
        try { entry.options.onStopped?.() } catch { /* the caller's affair */ }
      }
    },
  })

  // A press in this document is outside every frame (a press inside a frame is not heard here).
  const onPointerDown = (event: PointerEvent): void => {
    if (!event.isTrusted) return
    runtime.lastParentPress = win.performance.now()
    for (const entry of entries) if (entry.engaged) setEngaged(runtime, entry, false)
  }
  // The focus arriving on anything else in the window ends an engagement.
  const onFocusIn = (event: FocusEvent): void => {
    for (const entry of entries) if (entry.engaged && event.target !== entry.frame) setEngaged(runtime, entry, false)
  }
  // Main asks for the keyboard back when it held keys meant for a widget (widget-keyboard.ts).
  // The window's own record of the focus cannot be trusted here (it can name the editor while a widget
  // holds the keyboard): each widget frame is given the focus and has it taken away, which moves the
  // browser's focus to this document whatever the record said, and the keyboard goes back to the editor.
  const onReclaim = (): void => {
    if ([...entries].some((entry) => entry.engaged)) return
    for (const entry of entries) {
      try { entry.frame.focus({ preventScroll: true }) } catch { /* ignore */ }
      try { entry.frame.blur() } catch { /* ignore */ }
    }
    const first = entries.values().next().value as Entry | undefined
    try { first?.options.returnFocus() } catch { /* the caller's affair */ }
    guard.check()
  }
  win.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('focusin', onFocusIn, true)
  win.addEventListener(WIDGET_RECLAIM_EVENT, onReclaim)

  runtime = {
    channel,
    guard,
    entries,
    lastParentPress: null,
    dispose() {
      guard.dispose()
      channel.dispose()
      win.removeEventListener('pointerdown', onPointerDown, true)
      win.removeEventListener(WIDGET_RECLAIM_EVENT, onReclaim)
      doc.removeEventListener('focusin', onFocusIn, true)
      runtimes.delete(win)
    },
  }
  runtimes.set(win, runtime)
  return runtime
}

/** Mount a widget in `container`. Throws if the frame cannot be sealed. */
export function mountWidgetFrame(options: WidgetFrameOptions): WidgetFrame {
  const doc = options.container.ownerDocument
  const win = doc.defaultView
  if (!win) throw new Error('widget-frame: the container is not in a window')
  const frame = doc.createElement('iframe')
  // Every attribute before the frame is in the document or has a document of its own.
  for (const [name, value] of widgetFrameAttributes()) frame.setAttribute(name, value)
  assertWidgetSandbox(frame.getAttribute('sandbox'))
  frame.title = options.title
  frame.className = 'wf-widget-frame'
  frame.dataset.widgetEngaged = 'false'
  frame.tabIndex = -1
  const name = freshFrameName(win)
  frame.name = name
  // The cover: the window's own layer over the frame while it is not engaged. Its press, heard here,
  // is the only way in. It shows a pointer; it holds no text (the caption bar says what the block is).
  const cover = doc.createElement('div')
  cover.className = 'wf-widget-cover'
  cover.dataset.testid = 'widget-cover'
  cover.setAttribute('aria-hidden', 'true')
  cover.style.cssText = 'position:absolute;inset:0;z-index:1;cursor:pointer;background:transparent'
  // Frame and cover share a box of their own that fills the container and clips to it, so the cover lies
  // over the frame and never over anything around it (the caption bar).
  const box = doc.createElement('div')
  box.className = 'wf-widget-frame-box'
  box.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden'
  const runtime = runtimeFor(win)
  const entry: Entry = { frame, cover, name, document: withWidgetLead(options.html), options, engaged: false, stopped: false, disposed: false }
  const onCoverPress = (event: PointerEvent): void => {
    if (!event.isTrusted || event.button !== 0 || entry.disposed || entry.engaged) return
    event.preventDefault()
    event.stopPropagation()
    if (entry.stopped) load(runtime, entry)
    setEngaged(runtime, entry, true, { focus: true, via: 'press' })
  }
  // The press goes no further: no text selection, no focus change from the press itself.
  const onCoverMouseDown = (event: MouseEvent): void => { event.preventDefault() }
  cover.addEventListener('pointerdown', onCoverPress)
  cover.addEventListener('mousedown', onCoverMouseDown)
  runtime.entries.add(entry)
  try {
    box.append(frame, cover)
    options.container.appendChild(box)
    load(runtime, entry)
  } catch (error) {
    runtime.entries.delete(entry)
    box.remove()
    if (runtime.entries.size === 0) runtime.dispose()
    throw error
  }

  return {
    frame,
    get engaged() { return entry.engaged },
    get stopped() { return entry.stopped },
    engage() {
      if (entry.disposed) return
      if (entry.stopped) load(runtime, entry)
      setEngaged(runtime, entry, true, { focus: true })
    },
    disengage() {
      if (entry.disposed || !entry.engaged) return
      setEngaged(runtime, entry, false, { returnFocus: true })
    },
    dispose() {
      if (entry.disposed) return
      const hadFocus = doc.activeElement === frame
      if (entry.engaged) setEngaged(runtime, entry, false)
      unload(runtime, entry)
      entry.disposed = true
      runtime.entries.delete(entry)
      cover.removeEventListener('pointerdown', onCoverPress)
      cover.removeEventListener('mousedown', onCoverMouseDown)
      box.remove()
      if (hadFocus) { try { options.returnFocus() } catch { /* the caller's affair */ } }
      if (runtime.entries.size === 0) runtime.dispose()
    },
  }
}
