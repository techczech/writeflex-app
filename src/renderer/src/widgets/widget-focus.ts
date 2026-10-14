/**
 * Widgets and the keyboard (interactive-widgets-in-documents, ticket 02): one guard per window.
 * Ported from TalkWeaver `embed-focus.js` at 6ec8102f, without slide visits, presenter panes and
 * same-origin frames (a widget's origin is always opaque), and with a `dispose`.
 *
 * THE RULE: a widget frame that the window has not engaged never holds the window's focus. A widget
 * can put the focus on itself with no gesture (focus() at load, on a timer); the writer's next key
 * would then go to the widget instead of the document. So whenever the window's focused element is a
 * widget frame that is not engaged, the window takes the focus back. An engaged frame got the focus
 * from the writer and is left alone. A widget can also put the focus on ANOTHER widget's frame
 * (`window.focus()` may be called across origins), so the rule covers every widget frame.
 *
 * THE TRIGGERS: the window's `blur` (at once, when the widget's script has returned, and a task
 * later), the window's `focus` and `visibilitychange`, `focusin` in the document, every `watch()`,
 * and an interval while a widget is live, because the browser raises no event in the window when a
 * frame takes the focus while the window's own document does not hold it.
 *
 * THE TEXT FIELD the widget took the focus FROM (the editor) gets it back, so typing goes on. Only a
 * loss the widget caused counts: a field left in the same turn as a trusted press of the writer's in
 * this document (a pointer press, or Tab, Escape or Enter) was left on purpose.
 *
 * THE BUDGET. More than `grabLimit` take-backs within `grabWindowMs` (in a window that has the focus,
 * not caused by the writer's own press, take-backs closer than `grabGapMs` counted once) and every
 * widget that is not engaged is stopped (`onStopped`): which script asked for the focus cannot be
 * known here, so a count per frame would stop the wrong widget.
 */

export type WidgetFocusGuardOptions = {
  window: Window
  /** Whether `frame` is a live widget frame, and whether the writer has engaged it. Null: not a widget. */
  status: (frame: Element) => { engaged: boolean } | null
  /** Whether any widget is live in this window (the interval ends itself when none is). */
  livePresent: () => boolean
  /** Whether a widget is engaged now. */
  inUse: () => boolean
  /** The budget is spent: stop every widget that is not engaged. */
  onStopped: () => void
  watchMs?: number
  restoreMs?: number
  grabLimit?: number
  grabWindowMs?: number
  grabGapMs?: number
  /** TEST-ONLY (e2e gate set): false switches the rule off, to show the main-process key gate alone. */
  enabled?: () => boolean
}

export type WidgetFocusGuard = {
  /** The rule, now. True when the focus was taken back from a frame. */
  check(): boolean
  /** Check now, and keep checking while a widget is live. */
  watch(): void
  /** Move the focus off `frame` (BEFORE it is emptied or removed). True when it held the focus. */
  release(frame: HTMLIFrameElement): boolean
  /** A frame that was a widget's: the rule holds for it even after its record has gone. */
  remember(frame: HTMLIFrameElement): void
  dispose(): void
}

export function createWidgetFocusGuard(options: WidgetFocusGuardOptions): WidgetFocusGuard {
  const host = options.window
  const doc = host.document
  const watchMs = options.watchMs ?? 200
  const restoreMs = options.restoreMs ?? 400
  const grabLimit = options.grabLimit ?? 10
  const grabWindowMs = options.grabWindowMs ?? 2000
  const grabGapMs = options.grabGapMs ?? 20
  const pressGraceMs = 100
  const now = (): number => host.performance.now()
  let disposed = false

  // Every timer this guard starts, so dispose leaves none behind.
  const timeouts = new Set<number>()
  const later = (fn: () => void, ms = 0): void => {
    const handle = host.setTimeout(() => { timeouts.delete(handle); if (!disposed) fn() }, ms)
    timeouts.add(handle)
  }
  const soon = (fn: () => void): void => host.queueMicrotask(() => { if (!disposed) fn() })

  let pressCount = 0
  let pressing = false
  let pressedAt = -Infinity
  let lost: { el: HTMLElement; at: number; presses: number; given: boolean } | null = null
  let timer: number | null = null
  let grabTimes: number[] = []
  const known = new WeakSet<Element>()

  function isTextField(el: EventTarget | null): el is HTMLElement {
    if (!el || (el as Node).nodeType !== 1) return false
    const element = el as HTMLElement
    if (element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable) return true
    return element.tagName === 'INPUT' && !/^(button|checkbox|radio|range|color|file|image|reset|submit)$/i.test((element as HTMLInputElement).type)
  }
  function isShown(el: HTMLElement): boolean {
    if (!el.isConnected) return false
    const visible = (el as HTMLElement & { checkVisibility?: (o: object) => boolean }).checkVisibility
    if (typeof visible === 'function') return visible.call(el, { visibilityProperty: true })
    return el.getClientRects().length > 0
  }

  function mayNotHoldFocus(el: Element | null): el is HTMLIFrameElement {
    if (!el || el.tagName !== 'IFRAME') return false
    const status = options.status(el)
    if (status) return !status.engaged
    return known.has(el)
  }

  function overBudget(): boolean {
    const at = now()
    if (grabTimes.length > 0 && at - grabTimes[grabTimes.length - 1] < grabGapMs) return false
    grabTimes = grabTimes.filter((time) => at - time < grabWindowMs)
    grabTimes.push(at)
    return grabTimes.length > grabLimit
  }
  function countGrab(frame: HTMLIFrameElement): void {
    if (options.inUse() || !overBudget()) return
    grabTimes = []
    try { options.onStopped() } catch { /* the caller's affair */ }
    // This may be running inside the widget's own focus() call, which puts the focus back on the frame
    // as it returns: take it off the emptied frame when that call is over.
    const letGo = (): void => { takeBack(frame) }
    soon(letGo)
    later(letGo)
  }

  function afterThisTurn(fn: () => void): void {
    const scheduler = (host as Window & { scheduler?: { postTask?: (f: () => void, o: object) => Promise<void> } }).scheduler
    if (scheduler && typeof scheduler.postTask === 'function') {
      scheduler.postTask(() => { if (!disposed) fn() }, { priority: 'user-blocking' }).catch(() => { /* aborted */ })
    } else later(fn)
  }
  function onPress(event: Event): void {
    if (!event.isTrusted) return
    if (event.type === 'keydown') {
      const key = (event as KeyboardEvent).key
      if (key !== 'Tab' && key !== 'Escape' && key !== 'Enter') return
    }
    pressCount += 1
    pressing = true
    pressedAt = now()
    lost = null
    const mine = pressCount
    afterThisTurn(() => { if (pressCount === mine) pressing = false })
  }

  function takeBack(frame: HTMLIFrameElement): boolean {
    if (!frame || doc.activeElement !== frame) return false
    // Only a window that has the focus asks for it: a window behind another application must not come
    // to the front because a widget focused itself.
    const windowFocused = doc.hasFocus()
    const field = lost
    lost = null
    try { frame.blur() } catch { /* ignore */ }
    if (windowFocused) { try { host.focus() } catch { /* ignore */ } }
    if (field && now() - field.at <= restoreMs) {
      // Not here: this may be running inside the widget's own focus() call, and a focus set there is
      // undone when that call completes. When its script has returned, and once more a task later.
      const giveBack = (): void => {
        if (field.given || field.presses !== pressCount || pressing || options.inUse()) return
        const active = doc.activeElement
        if (active && active !== doc.body && active !== frame && !mayNotHoldFocus(active)) return
        if (!isShown(field.el)) return
        field.given = true
        try { field.el.focus({ preventScroll: true }) } catch { /* ignore */ }
      }
      soon(giveBack)
      later(giveBack)
    }
    // The widget's script may go on to focus something of its own in the same turn (focus() on the
    // window, then on a field): the window's record then names the editor while the keys go to the
    // widget, and no event says so. When the widget's script has returned, a task later, and again
    // shortly after, the window focuses its own element once more, unless the writer has pressed something or engaged a widget since.
    const presses = pressCount
    const confirm = (): void => {
      if (options.enabled?.() === false) return
      if (presses !== pressCount || pressing || options.inUse()) return
      const active = doc.activeElement
      if (active === frame) { check(); return }
      if (active && mayNotHoldFocus(active)) return
      reassert()
    }
    soon(confirm)
    later(confirm)
    later(confirm, 50)
    return true
  }

  function remember(frame: HTMLIFrameElement): void { known.add(frame) }

  function release(frame: HTMLIFrameElement): boolean {
    if (!frame) return false
    remember(frame)
    return takeBack(frame)
  }

  function check(): boolean {
    if (disposed || options.enabled?.() === false) return false
    const el = doc.activeElement
    if (!mayNotHoldFocus(el)) return false
    const windowFocused = doc.hasFocus()
    const byTheWriter = pressing || now() - pressedAt < pressGraceMs
    if (options.status(el)) remember(el)
    if (!takeBack(el)) return false
    if (windowFocused && !byTheWriter) countGrab(el)
    return true
  }

  // The window's own record can go on naming the editor while the keys go to a widget that focused
  // itself (twice in one turn, the second time while this window was handing the focus back). The window
  // then focuses its own element again, which moves the keyboard back to the window's document. (Main's
  // key gate holds any key that would reach the widget in the meantime: src/main/widget-keyboard.ts.)
  function reassert(): void {
    const active = doc.activeElement as HTMLElement | null
    if (active && active !== doc.body && active !== doc.documentElement && typeof active.focus === 'function') {
      try { active.blur(); active.focus({ preventScroll: true }) } catch { /* ignore */ }
      return
    }
    if (!doc.body) return
    // Nothing of the window's holds the focus: hold it for a moment with an element of our own.
    const holder = doc.createElement('span')
    holder.tabIndex = -1
    holder.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;outline:none'
    doc.body.appendChild(holder)
    try { holder.focus({ preventScroll: true }); holder.blur() } catch { /* ignore */ }
    holder.remove()
  }

  function watch(): void {
    check()
    if (timer !== null || disposed) return
    timer = host.setInterval(() => {
      if (!options.livePresent()) { if (timer !== null) host.clearInterval(timer); timer = null; return }
      check()
    }, watchMs)
  }

  const onBlur = (): void => { check(); soon(check); later(check) }
  const onFocus = (): void => { check() }
  const onFocusIn = (): void => { if (!check()) lost = null }
  const onFocusOut = (event: FocusEvent): void => {
    lost = !pressing && isTextField(event.target) ? { el: event.target, at: now(), presses: pressCount, given: false } : null
  }
  const pressTypes = ['pointerdown', 'pointerup', 'mousedown', 'click', 'keydown'] as const
  host.addEventListener('blur', onBlur)
  host.addEventListener('focus', onFocus)
  doc.addEventListener('visibilitychange', onFocus)
  doc.addEventListener('focusin', onFocusIn, true)
  doc.addEventListener('focusout', onFocusOut, true)
  for (const type of pressTypes) host.addEventListener(type, onPress, true)

  return {
    check,
    watch,
    release,
    remember,
    dispose() {
      if (disposed) return
      disposed = true
      if (timer !== null) host.clearInterval(timer)
      timer = null
      for (const handle of timeouts) host.clearTimeout(handle)
      timeouts.clear()
      host.removeEventListener('blur', onBlur)
      host.removeEventListener('focus', onFocus)
      doc.removeEventListener('visibilitychange', onFocus)
      doc.removeEventListener('focusin', onFocusIn, true)
      doc.removeEventListener('focusout', onFocusOut, true)
      for (const type of pressTypes) host.removeEventListener(type, onPress, true)
      lost = null
    },
  }
}
