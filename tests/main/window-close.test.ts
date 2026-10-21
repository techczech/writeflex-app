import { describe, expect, it } from 'bun:test'
import { CLOSE_ACK_MS, CLOSE_STALLED_MS, createCloseController, shouldGuardClose, unacknowledgedClose, type CloseStallChoice, type CloseStallKind } from '../../src/main/window-close'

describe('shouldGuardClose', () => {
  it('intercepts (hands to the renderer) when a workspace is bound', () => {
    // The renderer, not this predicate, decides what to flush — so a bound window is always held and
    // asked. Saving is automatic (ADR-0012): the renderer flushes every dirty buffer, then closes.
    expect(shouldGuardClose({ forceClose: false, workspace: {} })).toBe(true)
  })

  it('does not intercept on the start screen (no workspace) — nothing to flush', () => {
    expect(shouldGuardClose({ forceClose: false, workspace: null })).toBe(false)
  })

  it('does not intercept once the close is already resolved (forceClose)', () => {
    // The renderer-initiated proceed (last tab closed, or after flushing) sets forceClose so the guard
    // passes it straight through — without this, closing would loop.
    expect(shouldGuardClose({ forceClose: true, workspace: {} })).toBe(false)
  })
})

// One close per window (docs/plans/quit-does-not-stall/quit-and-window-close-spec.md). The controller
// is driven with a fake window: a clock, the timer it arms, what the renderer is doing, and the answer
// to the stalled-close question.
function fakeClose(options: { guarded?: boolean } = {}) {
  let clock = 0
  let gone = false
  let loading = false
  const timers: Array<{ run: () => void; at: number; live: boolean }> = []
  const events: string[] = []
  const questions: Array<{ kind: CloseStallKind; signal: AbortSignal; answer: (choice: CloseStallChoice) => void }> = []
  let requests = 0
  let closes = 0
  let kept = 0
  const controller = createCloseController({
    shouldGuard: () => options.guarded !== false && closes === 0,
    rendererGone: () => gone,
    rendererLoading: () => loading,
    requestRenderer: () => { requests += 1 },
    closeNow: () => { closes += 1 },
    kept: () => { kept += 1 },
    ask: (kind, signal) => new Promise((resolve) => { questions.push({ kind, signal, answer: resolve }) }),
    record: (event, details) => { events.push(details?.reason ? `${event}:${String(details.reason)}` : details?.kind ? `${event}:${String(details.kind)}` : event) },
    now: () => clock,
    setTimer: (run, ms) => { const timer = { run, at: clock + ms, live: true }; timers.push(timer); return timer },
    clearTimer: (handle) => { (handle as { live: boolean }).live = false },
  })
  const tick = (ms: number): void => {
    clock += ms
    for (const timer of timers) if (timer.live && timer.at <= clock) { timer.live = false; timer.run() }
  }
  return {
    controller, events, questions, tick,
    setGone: (value: boolean) => { gone = value },
    setLoading: (value: boolean) => { loading = value },
    get requests() { return requests }, get closes() { return closes }, get kept() { return kept },
    get armed() { return timers.filter((timer) => timer.live).length },
    get timersMade() { return timers.length },
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createCloseController', () => {
  it('passes a close that is not guarded, and asks the renderer for one that is', () => {
    const start = fakeClose({ guarded: false })
    expect(start.controller.onNativeClose()).toBe('pass')
    expect(start.requests).toBe(0)

    const bound = fakeClose()
    expect(bound.controller.onNativeClose()).toBe('hold')
    expect(bound.requests).toBe(1)
    expect(bound.events).toEqual(['window.close.requested'])
  })

  it('a repeat request while one is in flight starts nothing and arms nothing', () => {
    const w = fakeClose()
    w.controller.onNativeClose()
    w.tick(300)
    expect(w.controller.onNativeClose()).toBe('hold')
    w.tick(300)
    expect(w.controller.onNativeClose()).toBe('hold')
    expect(w.requests).toBe(1)
    expect(w.timersMade).toBe(1) // the first request's, never re-armed or extended
    expect(w.events.filter((event) => event === 'window.close.ignored-in-flight')).toHaveLength(2)
    // The one timer still ends 2000 ms after the FIRST request, not the last.
    w.tick(CLOSE_ACK_MS - 600)
    expect(w.questions).toHaveLength(1)
  })

  it('the acknowledgement cancels the wait; proceed closes the window once', () => {
    const w = fakeClose()
    w.controller.onNativeClose()
    w.controller.acked()
    expect(w.armed).toBe(0)
    w.tick(60_000)
    expect(w.closes).toBe(0) // a slow flush is never closed out from under the renderer
    expect(w.questions).toHaveLength(0)
    w.controller.proceed()
    expect(w.closes).toBe(1)
    expect(w.controller.inFlight).toBe(false)
    expect(w.events).toEqual(['window.close.requested', 'window.close.acked', 'window.close.proceed'])
  })

  it('a cancelled close leaves the window open and the next request is a fresh close', () => {
    const w = fakeClose()
    w.controller.onNativeClose()
    w.controller.acked()
    w.controller.cancelled()
    expect(w.closes).toBe(0)
    expect(w.controller.inFlight).toBe(false)
    expect(w.controller.onNativeClose()).toBe('hold')
    expect(w.requests).toBe(2)
  })

  it('a live renderer that does not acknowledge is never closed without the person’s choice', async () => {
    const w = fakeClose()
    w.controller.onNativeClose()
    w.tick(CLOSE_ACK_MS)
    expect(w.closes).toBe(0)
    expect(w.questions.map((question) => question.kind)).toEqual(['no-answer'])
    // Keep waiting: nothing is armed, the window stays, and the late acknowledgement is still accepted.
    w.questions[0].answer('wait')
    await settle()
    expect(w.closes).toBe(0)
    expect(w.armed).toBe(0)
    w.controller.acked()
    w.controller.proceed()
    expect(w.closes).toBe(1)
    expect(w.events).not.toContain('window.close.forced:chosen')
  })

  it('"Close anyway" closes the window, and is recorded as the person’s choice', async () => {
    const w = fakeClose()
    w.controller.onNativeClose()
    w.tick(CLOSE_ACK_MS)
    w.questions[0].answer('close')
    await settle()
    expect(w.closes).toBe(1)
    expect(w.events).toContain('window.close.forced:chosen')
  })

  it('an acknowledgement that arrives while the question is open withdraws it', async () => {
    const w = fakeClose()
    w.controller.onNativeClose()
    w.tick(CLOSE_ACK_MS)
    w.controller.acked()
    expect(w.questions[0].signal.aborted).toBe(true)
    // An answer to the withdrawn question changes nothing.
    w.questions[0].answer('close')
    await settle()
    expect(w.closes).toBe(0)
    expect(w.controller.inFlight).toBe(true)
  })

  it('after "Keep waiting", a further request asks again; one question at a time', async () => {
    const w = fakeClose()
    w.controller.onNativeClose()
    w.tick(CLOSE_ACK_MS)
    w.controller.onNativeClose() // the question is open: nothing new
    expect(w.questions).toHaveLength(1)
    w.questions[0].answer('wait')
    await settle()
    w.controller.onNativeClose()
    expect(w.questions).toHaveLength(2)
    expect(w.requests).toBe(1)
  })

  it('an acknowledged close that is still saving asks only on a further request, after 5 s', async () => {
    const w = fakeClose()
    w.controller.onNativeClose()
    w.controller.acked()
    w.tick(CLOSE_STALLED_MS - 1)
    w.controller.onNativeClose()
    expect(w.questions).toHaveLength(0)
    w.tick(1)
    w.controller.onNativeClose()
    expect(w.questions.map((question) => question.kind)).toEqual(['still-saving'])
    // The renderer finishes while the question is open: it is withdrawn and the window closes.
    w.controller.proceed()
    expect(w.questions[0].signal.aborted).toBe(true)
    expect(w.closes).toBe(1)
  })

  it('a renderer with no text left is closed at once: gone, still loading, or nothing mounted', () => {
    const goneAtRequest = fakeClose()
    goneAtRequest.setGone(true)
    expect(goneAtRequest.controller.onNativeClose()).toBe('pass')
    expect(goneAtRequest.requests).toBe(0)

    const diesDuring = fakeClose()
    diesDuring.controller.onNativeClose()
    diesDuring.controller.acked()
    diesDuring.controller.rendererGone()
    expect(diesDuring.closes).toBe(1)
    expect(diesDuring.events).toContain('window.close.forced:renderer-gone')

    const loading = fakeClose()
    loading.setLoading(true)
    loading.controller.onNativeClose()
    loading.tick(CLOSE_ACK_MS)
    expect(loading.closes).toBe(1)
    expect(loading.questions).toHaveLength(0)
    expect(loading.events).toContain('window.close.forced:renderer-loading')

    const blank = fakeClose()
    blank.controller.onNativeClose()
    blank.controller.unattended()
    expect(blank.closes).toBe(1)
    expect(blank.armed).toBe(0)
    expect(blank.events).toContain('window.close.forced:no-handler')
  })

  it('"nothing mounted" and "renderer gone" close nothing when no close is in flight', () => {
    const w = fakeClose()
    w.controller.unattended()
    w.controller.rendererGone()
    w.controller.acked()
    expect(w.closes).toBe(0)
    expect(w.events).toEqual([])
  })

  it('a broken app holding text it could not write: the person is asked, and the window goes only if they choose it', async () => {
    const w = fakeClose()
    w.controller.onNativeClose()
    w.controller.acked()
    w.controller.unsaved()
    expect(w.closes).toBe(0)
    expect(w.questions.map((question) => question.kind)).toEqual(['could-not-save'])
    expect(w.events).toContain('window.close.stalled:could-not-save')
    w.questions[0].answer('close')
    await settle()
    expect(w.closes).toBe(1)
    expect(w.kept).toBe(0)
    expect(w.events).toContain('window.close.forced:chosen')
  })

  it('kept open, that close is over (quit intent cleared by the caller) and the next request is a fresh close', async () => {
    const w = fakeClose()
    w.controller.onNativeClose()
    w.controller.unsaved() // before any acknowledgement: the 2 s timer must not fire into the question
    expect(w.armed).toBe(0)
    w.questions[0].answer('wait')
    await settle()
    expect(w.closes).toBe(0)
    expect(w.kept).toBe(1)
    expect(w.controller.inFlight).toBe(false)
    expect(w.events).toContain('window.close.cancelled:unsaved-kept')
    w.tick(CLOSE_ACK_MS + CLOSE_STALLED_MS)
    expect(w.closes).toBe(0)
    expect(w.controller.onNativeClose()).toBe('hold')
    expect(w.requests).toBe(2)
  })

  it('"could not save" with no close in flight asks nothing; with a question already open it asks once', () => {
    const idle = fakeClose()
    idle.controller.unsaved()
    expect(idle.questions).toHaveLength(0)

    const w = fakeClose()
    w.controller.onNativeClose()
    w.controller.unsaved()
    w.controller.onNativeClose() // a repeat ⌘Q while the question is open
    w.controller.unsaved()
    expect(w.questions).toHaveLength(1)
    expect(w.closes).toBe(0)
  })

  it('a page replaced during a close ends it, so the flag cannot outlive the page', () => {
    const w = fakeClose()
    expect(w.controller.reset()).toBe(false)
    w.controller.onNativeClose()
    w.controller.acked()
    expect(w.controller.reset()).toBe(true)
    expect(w.controller.inFlight).toBe(false)
    expect(w.controller.onNativeClose()).toBe('hold')
    expect(w.requests).toBe(2)
  })
})

// Rule R-C: "still loading" lets an unanswered window go only until the app has started in the page.
describe('an unacknowledged close: forced, or asked', () => {
  it('classification: gone wins; loading counts only while the app has never started in the page', () => {
    expect(unacknowledgedClose({ gone: true, loading: true, appEverStarted: true })).toBe('renderer-gone')
    expect(unacknowledgedClose({ gone: true, loading: false, appEverStarted: false })).toBe('renderer-gone')
    expect(unacknowledgedClose({ gone: false, loading: true, appEverStarted: false })).toBe('renderer-loading')
    expect(unacknowledgedClose({ gone: false, loading: true, appEverStarted: true })).toBe('ask')
    expect(unacknowledgedClose({ gone: false, loading: false, appEverStarted: true })).toBe('ask')
    expect(unacknowledgedClose({ gone: false, loading: false, appEverStarted: false })).toBe('ask')
  })

  it('the app started while a resource of the page is still loading, and does not answer: the person is asked, nothing is forced', () => {
    const w = fakeClose()
    w.setLoading(true)
    w.controller.appStarted()
    w.controller.onNativeClose()
    w.tick(CLOSE_ACK_MS)
    expect(w.closes).toBe(0)
    expect(w.questions.map((question) => question.kind)).toEqual(['no-answer'])
    expect(w.events).not.toContain('window.close.forced:renderer-loading')
  })

  it('the report holds however the load state moves afterwards, and whenever it arrived', () => {
    const w = fakeClose()
    w.controller.onNativeClose() // requested first
    w.setLoading(true)
    w.controller.appStarted() // reported during the wait
    w.tick(CLOSE_ACK_MS)
    expect(w.closes).toBe(0)
    expect(w.questions).toHaveLength(1)
  })

  it('a new document in the top frame starts over: the app has not started in it, so loading counts again', async () => {
    const w = fakeClose()
    w.controller.appStarted()
    w.controller.reset() // reload: navigation committed
    w.setLoading(true)
    w.controller.onNativeClose()
    w.tick(CLOSE_ACK_MS)
    expect(w.closes).toBe(1)
    expect(w.events).toContain('window.close.forced:renderer-loading')
  })

  it('a close that is cancelled or answered does not forget that the app started', () => {
    const w = fakeClose()
    w.controller.appStarted()
    w.controller.onNativeClose()
    w.controller.acked()
    w.controller.cancelled()
    w.setLoading(true)
    w.controller.onNativeClose()
    w.tick(CLOSE_ACK_MS)
    expect(w.closes).toBe(0)
    expect(w.questions).toHaveLength(1)
  })
})

// Vaults 06 review round 2: the vault switcher calls a close off after its bound. The renderer's late
// answer to that close must never close the window.
describe('a close called off (abandon)', () => {
  it('ends the close, and drops the renderer\'s proceed sent before it heard', () => {
    const fake = fakeClose()
    expect(fake.controller.onNativeClose()).toBe('hold')
    fake.controller.acked()
    fake.controller.abandon()
    expect(fake.controller.inFlight).toBe(false)
    expect(fake.controller.abandoning).toBe(true)
    fake.controller.proceed() // the flush finished and its window:close was already on the way
    expect(fake.closes).toBe(0)
    expect(fake.events).toContain('window.close.dropped-abandoned')
  })

  it('withdraws a question that was open and arms nothing', () => {
    const fake = fakeClose()
    fake.controller.onNativeClose()
    fake.tick(CLOSE_ACK_MS) // no answer: the person is asked
    expect(fake.questions).toHaveLength(1)
    fake.controller.abandon()
    expect(fake.questions[0]!.signal.aborted).toBe(true)
    expect(fake.armed).toBe(0)
  })

  it('once the renderer acknowledges, its closes are its own again', () => {
    const fake = fakeClose()
    fake.controller.onNativeClose()
    fake.controller.abandon()
    fake.controller.abandonAcked()
    expect(fake.controller.abandoning).toBe(false)
    fake.controller.proceed() // e.g. ⌘W with no tab open, after the abandonment
    expect(fake.closes).toBe(1)
  })

  it('a new page or a gone renderer clears the drop (no stale latch can trap the window)', () => {
    const page = fakeClose()
    page.controller.abandon()
    page.controller.reset()
    expect(page.controller.abandoning).toBe(false)
    const crashed = fakeClose()
    crashed.controller.abandon()
    crashed.controller.rendererGone()
    expect(crashed.controller.abandoning).toBe(false)
  })

  it('a later close request starts a fresh close', () => {
    const fake = fakeClose()
    fake.controller.onNativeClose()
    fake.controller.abandon()
    fake.controller.abandonAcked()
    expect(fake.controller.onNativeClose()).toBe('hold')
    expect(fake.requests).toBe(2)
  })
})
