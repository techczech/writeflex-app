/**
 * Window-close guard (ADR-0012). Saving is automatic, so a native close — the red traffic light, the
 * Window menu, ⌘Q — never prompts and never discards. windows.ts intercepts the BrowserWindow 'close'
 * event and hands it to the renderer, which flushes every dirty buffer and re-requests the close; only
 * a FAILED write keeps the window open.
 *
 * This module holds the whole decision: whether to intercept (`shouldGuardClose`) and what one close
 * goes through from the request to the window going (`createCloseController`). The states and what
 * holds in each are in docs/plans/quit-does-not-stall/quit-and-window-close-spec.md.
 *
 * Kept electron-free (like jumps.ts) so the decision logic is unit-testable without a live window.
 */

export type CloseGuardState = { forceClose: boolean; workspace: unknown }

/**
 * True when the native close must be intercepted and handed to the renderer: the close hasn't already
 * been resolved (`forceClose`, set by the renderer's proceed path) and a Workspace is bound (the start
 * screen has nothing to flush).
 */
export function shouldGuardClose(state: CloseGuardState): boolean {
  return !state.forceClose && state.workspace != null
}

/** How long the renderer has to ACKNOWLEDGE a close request. It acks on receipt, before its flush, so
 *  this covers one IPC round trip. It is not a flush deadline. */
export const CLOSE_ACK_MS = 2000
/** A close the renderer acknowledged and has not finished after this long is "still saving": a further
 *  close request then asks the person what to do. */
export const CLOSE_STALLED_MS = 5000

/** Why the person is being asked: the renderer never answered; it answered and is still saving; or its
 *  app has stopped and it holds text it could not write (nothing is left on screen to say so). */
export type CloseStallKind = 'no-answer' | 'still-saving' | 'could-not-save'
export type CloseStallChoice = 'wait' | 'close'

export type CloseControllerPorts = {
  /** `shouldGuardClose` for this window, read now. */
  shouldGuard(): boolean
  /** The renderer process is gone (crashed, killed, web contents destroyed): no text is left in it. */
  rendererGone(): boolean
  /** The window's page is still loading. This alone proves nothing about text: a page can run the app
   *  while a resource of its first load is pending. The controller heeds it only until the app has
   *  reported that it started in this page (`appStarted`). */
  rendererLoading(): boolean
  /** Send the close request to the renderer. */
  requestRenderer(): void
  /** Mark the close resolved and close the window; the guard passes this close through. */
  closeNow(): void
  /** Ask the person whether to keep waiting. Aborting `signal` withdraws the question. */
  ask(kind: CloseStallKind, signal: AbortSignal): Promise<CloseStallChoice>
  /** The person kept a window whose text could not be saved: its close is over, as for a close the
   *  renderer cancels (the caller clears the quit intent). */
  kept?(): void
  record(event: string, details?: Record<string, unknown>): void
  now(): number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export type CloseController = {
  /** The window's native 'close' event. 'hold': the caller must preventDefault. */
  onNativeClose(): 'pass' | 'hold'
  /** The renderer received the request and is alive. */
  acked(): void
  /** The renderer finished (every buffer written), or asked for a close of its own: the window goes. */
  proceed(): void
  /** The renderer abandoned the close (a write failed): the window stays open. */
  cancelled(): void
  /** The request arrived in a page whose app never started (no script of it ran): there is no editor
   *  in it and there never was, so it holds no text. A page whose app started and then broke answers
   *  for itself (proceed, or `unsaved`), because it can hold text. */
  unattended(): void
  /** The renderer's app has stopped and it holds text it could not write. The person is asked: the
   *  window closes only if they choose it; otherwise the close ends and the window stays. */
  unsaved(): void
  /** The renderer process went away. */
  rendererGone(): void
  /** The app's script has started in the window's current page (reported by its preload, from the top
   *  frame, when the app puts its close listener in place before mounting). From here until the page
   *  is replaced the page may hold text. */
  appStarted(): void
  /** The top frame committed a new document (reload, navigation): the app has not started in it, and
   *  a close in flight is over. True if one was. */
  reset(): boolean
  /** Call the close in flight off (the vault switcher's bound ran out, window-switch.ts): it ends here,
   *  and every close answer the renderer sends until it has acknowledged (`abandonAcked`) is an answer to
   *  the abandoned close and is dropped (`abandoning`). The caller tells the renderer. */
  abandon(): void
  /** The renderer has dropped the abandoned close: its answers from here on are its own again. */
  abandonAcked(): void
  /** True between `abandon` and `abandonAcked` (or a new page, or the renderer going). */
  readonly abandoning: boolean
  readonly inFlight: boolean
}

/**
 * One close per window. A request while one is in flight starts nothing and arms nothing. A window is
 * closed without the renderer's own "every buffer is written" only when no text can be left in it (the
 * renderer is gone, or the app has not started in the page) or when the person chose to close anyway.
 */
/**
 * What an unacknowledged close does once the wait is over (rule R-C). "Still loading" lets the window
 * go only while the app has never started in the current page: after that the page can hold text
 * whatever its load state, and the person is asked.
 */
export function unacknowledgedClose(renderer: { gone: boolean; loading: boolean; appEverStarted: boolean }): 'renderer-gone' | 'renderer-loading' | 'ask' {
  if (renderer.gone) return 'renderer-gone'
  if (renderer.loading && !renderer.appEverStarted) return 'renderer-loading'
  return 'ask'
}

export function createCloseController(ports: CloseControllerPorts): CloseController {
  let inFlight = false
  let acked = false
  /** The acknowledgement did not arrive in time and the renderer is alive. */
  let overdue = false
  /** When the renderer acknowledged, or when the person last chose to keep waiting. */
  let waitingSince = 0
  let timer: unknown = null
  /** The app has started in the window's current page. Cleared only by `reset` (a new document). */
  let appEverStarted = false
  let asking: AbortController | null = null
  /** An abandoned close the renderer has not yet acknowledged dropping. */
  let abandoning = false
  let askingKind: CloseStallKind | null = null

  const clearAckTimer = (): void => {
    if (timer !== null) { ports.clearTimer(timer); timer = null }
  }
  const withdrawQuestion = (): void => {
    const open = asking
    asking = null
    open?.abort()
  }
  const end = (): void => {
    clearAckTimer()
    withdrawQuestion()
    inFlight = false
    acked = false
    overdue = false
  }
  const force = (reason: string): void => {
    end()
    ports.record('window.close.forced', { reason })
    ports.closeNow()
  }
  /** `onWait`: what choosing to wait does, when it is more than going on waiting. */
  const ask = (kind: CloseStallKind, onWait?: () => void): void => {
    if (asking) return
    const mine = new AbortController()
    asking = mine
    askingKind = kind
    ports.record('window.close.stalled', { kind })
    const answered = (choice: CloseStallChoice): void => {
      if (asking !== mine) return // withdrawn: the close moved on while the question was open
      asking = null
      waitingSince = ports.now()
      if (choice === 'close') force('chosen')
      else onWait?.()
    }
    ports.ask(kind, mine.signal).then(answered, () => answered('wait'))
  }

  return {
    get inFlight() { return inFlight },
    get abandoning() { return abandoning },
    onNativeClose() {
      if (!ports.shouldGuard()) return 'pass'
      if (ports.rendererGone()) {
        end()
        ports.record('window.close.forced', { reason: 'renderer-gone' })
        return 'pass'
      }
      if (inFlight) {
        ports.record('window.close.ignored-in-flight', { acked })
        if (!acked && overdue) ask('no-answer')
        else if (acked && ports.now() - waitingSince >= CLOSE_STALLED_MS) ask('still-saving')
        return 'hold'
      }
      inFlight = true
      acked = false
      overdue = false
      ports.record('window.close.requested')
      ports.requestRenderer()
      timer = ports.setTimer(() => {
        timer = null
        if (!inFlight || acked) return
        const outcome = unacknowledgedClose({ gone: ports.rendererGone(), loading: ports.rendererLoading(), appEverStarted })
        if (outcome !== 'ask') return force(outcome)
        overdue = true
        ask('no-answer')
      }, CLOSE_ACK_MS)
      return 'hold'
    },
    acked() {
      if (!inFlight || acked) return
      clearAckTimer()
      withdrawQuestion() // asked because it had not answered; it has now
      acked = true
      overdue = false
      waitingSince = ports.now()
      ports.record('window.close.acked')
    },
    proceed() {
      // The answer to a close that was called off: the window stays.
      if (abandoning) { ports.record('window.close.dropped-abandoned', { answer: 'proceed' }); return }
      end()
      ports.record('window.close.proceed')
      ports.closeNow()
    },
    cancelled() {
      end()
      ports.record('window.close.cancelled')
    },
    unattended() {
      if (inFlight) force('no-handler')
    },
    unsaved() {
      if (!inFlight || abandoning) return
      if (asking && askingKind === 'could-not-save') return // already asked; one question
      clearAckTimer()
      withdrawQuestion() // a "not answered" question is out of date: it has answered, with this
      acked = true
      overdue = false
      waitingSince = ports.now()
      ask('could-not-save', () => {
        end()
        ports.record('window.close.cancelled', { reason: 'unsaved-kept' })
        ports.kept?.()
      })
    },
    rendererGone() {
      abandoning = false
      if (inFlight) force('renderer-gone')
    },
    appStarted() {
      appEverStarted = true
    },
    reset() {
      const was = inFlight
      appEverStarted = false
      abandoning = false
      end()
      if (was) ports.record('window.close.cancelled', { reason: 'page-replaced' })
      return was
    },
    abandon() {
      const was = inFlight
      end()
      abandoning = true
      ports.record('window.close.abandoned', { inFlight: was })
    },
    abandonAcked() {
      abandoning = false
    },
  }
}
