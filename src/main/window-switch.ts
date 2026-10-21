/**
 * The vault switcher's switch (vaults ticket 06, review 2026-10-16): switching a window to another root
 * REPLACES the window. The chosen root opens in a new window, hidden, at the old window's place; the old
 * window then closes by the ordinary close route (its renderer writes every document, drains its
 * ledger, and main makes the close checkpoints, releases the lock and disposes its services); only once
 * it has closed is the new window shown. Nothing of a live window is rebound in place.
 *
 * The window manager supplies the window operations; this module is the order of the steps, every way
 * they can stop, and the two reservations that keep switches apart:
 * - one switch at a time per source window (a second request while one is in flight is refused);
 * - one switch at a time into a root (a root a switch is opening is not opened or focused by another).
 *
 * Order, and why:
 * 1. The chosen root is this window's own: nothing to do.
 * 2. Another window already shows it: focus that window and stop (ADR-0007, one window per root).
 * 3. Open the root in a new hidden window at the source's place. A failure (thrown) or a lock that
 *    could not be had closes nothing.
 * 4. Wait until the new window's page has loaded the root (round 2): a page that fails to load, or is
 *    not ready in time, is discarded and the source is not asked to close.
 * 5. Close the source by the ordinary close route and wait for its outcome: closed, or kept open (a
 *    write failed). A close still undecided after `closeTimeoutMs` is abandoned (the source's page is
 *    told, and main drops any late answer to it), so the source can no longer close by it; if the close
 *    was already past the point of no return, its outcome is awaited instead (round 2: no timeout is
 *    taken as a refusal while the close can still succeed).
 * 6. Closed: show the new window. Kept open or abandoned: the new window is discarded, the source stays.
 *
 * Every exit before the new window is shown, thrown or returned, discards it (round 2).
 */

/** A close the switch asked for: its outcome, and the way to call it off. */
export type CloseAttempt = {
  /** True once the window has closed; false once its close was kept open (a write failed, the person kept it). */
  closed: Promise<boolean>
  /** Call the close off: the window's page drops it and main ignores a late answer to it, so the window
   *  stays. False when it is too late (the window is already closing): `closed` then settles true. */
  abandon(): boolean
}

export type WindowSwitchPorts<W, P> = {
  /** The window's bound root (canonical), or null on the start screen. */
  rootOf(window: W): string | null
  /** The canonical form of a root (realpath, case). */
  canonical(root: string): string
  /** A window other than `except` that shows `root`, if any. */
  ownerWindow(root: string, except: W): W | undefined
  focus(window: W): void
  /** Where the source window is on screen now (bounds, full screen), for the new window to take. */
  placement(window: W): P
  /** Open `root` in a NEW hidden window at `placement` (the ordinary open-folder path: lock, bind,
   *  recents). `existing`: a window that already showed the root was found instead (and focused);
   *  `busy`: another program holds the folder and the person chose not to wait. Throws when it fails,
   *  having cleaned up any window it made. `focusFile`: a file in the root the new window opens at. */
  openHidden(root: string, placement: P, focusFile: string | null): Promise<{ kind: 'opened'; window: W } | { kind: 'existing'; window: W } | { kind: 'busy' }>
  /** Resolves true once the new window's page has loaded and shows its root; false when it failed to
   *  load, its renderer went away, or it was not ready within the window manager's time. */
  whenReady(window: W): Promise<boolean>
  /** Close `window` by the ordinary close route. No time limit of its own. */
  requestClose(window: W): CloseAttempt
  /** The window has closed (or was destroyed). */
  isGone(window: W): boolean
  /** Show and focus the new window at `placement`. */
  show(window: W, placement: P): void
  /** Close a hidden window nobody has seen; it holds nothing to write. */
  discard(window: W): Promise<void>
}

export type WindowSwitchOptions = {
  /** How long the source's close may stay undecided before it is abandoned. */
  closeTimeoutMs?: number
}

/** The source's close safety bound: long, because a slow save that succeeds must still switch. */
export const SWITCH_CLOSE_TIMEOUT_MS = 60_000

export type WindowSwitchOutcome<W> =
  /** The source closed and `window` now shows `root` where the source was. */
  | { status: 'switched'; root: string; window: W }
  /** The chosen root is the source's own. */
  | { status: 'unchanged' }
  /** Another window shows the chosen root: it was brought forward; nothing else happened. */
  | { status: 'focused'; root: string }
  /** Another program holds the folder and the person chose not to wait (they were told). */
  | { status: 'busy' }
  /** A switch is already under way from this window, or into this root: nothing was done. */
  | { status: 'switching' }
  /** The source's close was kept open, or (`reason: 'close-timed-out'`) had not finished after the
   *  switch's bound and was called off: the new window was closed, the source stays. */
  | { status: 'stayed'; reason?: 'close-timed-out' }

export type WindowSwitch<W> = {
  switchWindow(source: W, requested: string, focusFile?: string | null): Promise<WindowSwitchOutcome<W>>
  /** A hidden window a switch has opened and not yet shown. */
  isPending(window: W): boolean
  /** The window a pending hidden window is to replace (undefined when `window` is not pending). */
  sourceOf(window: W): W | undefined
}

export function createWindowSwitch<W, P>(ports: WindowSwitchPorts<W, P>, options: WindowSwitchOptions = {}): WindowSwitch<W> {
  const closeTimeoutMs = options.closeTimeoutMs ?? SWITCH_CLOSE_TIMEOUT_MS
  const sources = new Set<W>()
  const roots = new Set<string>()
  /** Hidden target → the source it replaces. */
  const pending = new Map<W, W>()

  /** The source's close, to a terminal answer: 'closed', 'kept', or 'abandoned' after the bound. */
  async function closeSource(source: W): Promise<'closed' | 'kept' | 'abandoned'> {
    const attempt = ports.requestClose(source)
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), closeTimeoutMs) })
    try {
      const first = await Promise.race([attempt.closed, late])
      if (first !== 'late') return first ? 'closed' : 'kept'
    } finally {
      clearTimeout(timer)
    }
    if (attempt.abandon()) return 'abandoned'
    // Too late to call it off: the window is already going. Its outcome is the answer.
    return (await attempt.closed) ? 'closed' : 'kept'
  }

  async function switchWindow(source: W, requested: string, focusFile: string | null = null): Promise<WindowSwitchOutcome<W>> {
    if (sources.has(source)) return { status: 'switching' }
    const root = ports.canonical(requested)
    if (ports.rootOf(source) === root) return { status: 'unchanged' }
    if (roots.has(root)) return { status: 'switching' }
    const elsewhere = ports.ownerWindow(root, source)
    if (elsewhere) {
      // A window another switch has opened and not yet shown cannot be brought forward.
      if (pending.has(elsewhere)) return { status: 'switching' }
      ports.focus(elsewhere)
      return { status: 'focused', root }
    }

    sources.add(source)
    roots.add(root)
    let target: W | null = null
    let shown = false
    try {
      const placement = ports.placement(source)
      const opened = await ports.openHidden(root, placement, focusFile)
      if (opened.kind === 'busy') return { status: 'busy' }
      if (opened.kind === 'existing') {
        ports.focus(opened.window)
        return { status: 'focused', root }
      }
      target = opened.window
      pending.set(target, source)
      if (ports.isGone(target)) throw new Error('The new window closed before it could be shown.')
      if (!(await ports.whenReady(target))) throw new Error('The new window did not finish loading. Nothing was closed.')
      if (ports.isGone(target)) throw new Error('The new window closed before it could be shown.')
      // The source closed on its own while the folder opened: the person still asked for the switch.
      const closed = ports.isGone(source) ? 'closed' : await closeSource(source)
      if (closed === 'kept') return { status: 'stayed' }
      if (closed === 'abandoned') return { status: 'stayed', reason: 'close-timed-out' }
      if (ports.isGone(target)) throw new Error('The new window closed before it could be shown.')
      ports.show(target, placement)
      shown = true
      return { status: 'switched', root, window: target }
    } finally {
      // Every exit that did not show the new window, returned or thrown, closes it again.
      if (target !== null && !shown) {
        try { await ports.discard(target) } catch { /* discard cleans up as far as it can; the exit stands */ }
      }
      if (target !== null) pending.delete(target)
      sources.delete(source)
      roots.delete(root)
    }
  }

  return { switchWindow, isPending: (window) => pending.has(window), sourceOf: (window) => pending.get(window) }
}

/**
 * What an ordinary open (Open Recent, the menu, the start screen, a writeflex:// link) does on finding
 * `existing` already showing its root (round 2): focus it, unless it is a hidden window a switch has
 * opened and not yet shown. That one is not the open's to show or focus; the switch's source window is
 * brought forward instead and told the switch is under way.
 */
export function routeToExistingWindow<W>(existing: W, switches: Pick<WindowSwitch<W>, 'isPending' | 'sourceOf'>):
  | { kind: 'focus'; window: W }
  | { kind: 'switching'; source: W | undefined } {
  if (!switches.isPending(existing)) return { kind: 'focus', window: existing }
  return { kind: 'switching', source: switches.sourceOf(existing) }
}

/** How long a new window's page has to load its root before the switch gives it up. */
export const RENDERER_READY_TIMEOUT_MS = 15_000

export type RendererReadyPorts = {
  /** The page has loaded and shows the root the window was bound to. Read now. */
  isReady(): boolean
  /** Call `listener` whenever the page reports in (read `isReady` again then). Returns the unsubscribe. */
  onReport(listener: () => void): () => void
  /** Call `listener` when the page cannot become ready: its load failed, its renderer went, the window closed. */
  onFailure(listener: () => void): () => void
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  timeoutMs?: number
}

/** True once the page is ready; false on a failure or when `timeoutMs` passes first. Never rejects. */
export function whenRendererReady(ports: RendererReadyPorts): Promise<boolean> {
  if (ports.isReady()) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settled = false
    const unsubscribe: Array<() => void> = []
    const settle = (ready: boolean): void => {
      if (settled) return
      settled = true
      ports.clearTimer(timer)
      for (const off of unsubscribe) { try { off() } catch { /* already gone */ } }
      resolve(ready)
    }
    const timer = ports.setTimer(() => settle(false), ports.timeoutMs ?? RENDERER_READY_TIMEOUT_MS)
    unsubscribe.push(ports.onReport(() => { if (ports.isReady()) settle(true) }))
    unsubscribe.push(ports.onFailure(() => settle(false)))
    // A report that landed between the first read and the subscriptions.
    if (ports.isReady()) settle(true)
  })
}
