// Updating in place (ADR-0054, porting TalkWeaver scripts/test-update-engine.mjs): the engine's order and its one
// restart gate (src/main/update-engine.ts), driven with fake timers, a fake download that resolves when the test says
// so, a fake hand-over and a fake Squirrel.Mac that answers late, fails, or arms ShipIt on its own schedule, and a
// withdrawal that can fail.
//  D1 download and verify, D2 waiting: Squirrel.Mac receives no call at all (no feed address, no check, not even a
//  listener). D3: the hand-over only after a blocker check, then one more check and the spent flag before the native
//  request. D4: a blocker at the last moment, the watchdog, a failed install: the withdrawal is checked, and a failed
//  one is reported, never swallowed.
// The real electron-updater MacUpdater (Electron's autoUpdater faked) runs in a child process
// (tests/helpers/update-engine-mac-updater-probe.ts), because faking `electron` would leak into other test files.
// Then the downloaded file's size and version checks on real zips (macOS only: ditto, unzip and plutil).
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUpdateEngine, verifyMacDownload, RESTART_WATCHDOG_MS, launchdJobPresence, pathPresence, type Offer, type RestartClose } from '../../src/main/update-engine'
import { createRestartClose, type RecallableClose } from '../../src/main/restart-windows'
import { inPlaceRefusal } from '../../src/shared/update-install'
import { UPDATE_INSTALL_IDENTITY } from '../../src/shared/update-identity'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
const deferred = <T = unknown>(): Deferred<T> => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const tick = () => new Promise<void>((r) => setImmediate(r))
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick() }

function fakeTimers() {
  let t = 0
  const due = new Map<number, { at: number; fn: () => void }>()
  let next = 1
  return {
    set: (fn: () => void, ms: number) => { const id = next++; due.set(id, { at: t + ms, fn }); return id },
    clear: (id: unknown) => { due.delete(id as number) },
    advance(ms: number) { t += ms; for (const [id, d] of [...due]) if (d.at <= t) { due.delete(id); d.fn() } },
    pending: () => due.size,
  }
}

const IDENTITY = { appName: 'WriteFlex', userAgent: 'WriteFlex' }
const OFFER: Offer = { version: '0.29.0', released: '2026-11-20', url: `${UPDATE_INSTALL_IDENTITY.releaseAssetPrefix}v0.29.0/WriteFlex-mac-arm64.zip`, sha512: 'x', size: 100 }

type Quit = { blockers: string[]; attempt: number | null; phase: string; windows: number; from: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rig = Record<string, any> & {
  blockers: string[]; quits: Quit[]; prepares: number; withdrawals: number; releases: number; checks: number; fetches: number; verifies: number
  handOvers: number; nativeAccess: number; calls: string[]; order: string[]; log: string[]; armed: boolean; withdraw: 'ok' | 'fails' | 'throws' | 'hold'
  /** Open windows; closeWindows: 'auto' closes them all at once, 'hold' waits for the test (r.d.close). */
  windows: number; close: 'auto' | 'hold'; closes: number; abandoned: number
}

/**
 * A fake Squirrel.Mac. Every method call is recorded in rig.calls (with the order of everything the rig sees).
 * ready() models what Squirrel.Mac does before it says "ready": it writes its install request and launches ShipIt;
 * rig.armed is then true until a withdrawal removes it. quitAndInstall records what held at that moment and who called it.
 */
function fakeNative(rig: Rig) {
  const n = new EventEmitter() as EventEmitter & { setFeedURL(): void; checkForUpdates(): void; quitAndInstall(): void; ready(): Promise<void> }
  const on = n.on.bind(n)
  n.on = ((event: string, fn: (...args: unknown[]) => void) => { rig.calls.push(`on:${event}`); return on(event, fn) }) as typeof n.on
  n.setFeedURL = () => { rig.calls.push('setFeedURL'); rig.order?.push('setFeedURL') }
  n.checkForUpdates = () => { rig.calls.push('checkForUpdates'); rig.order?.push('checkForUpdates'); rig.prepares += 1 }
  n.quitAndInstall = () => {
    rig.calls.push('quitAndInstall')
    rig.quits.push({ blockers: [...rig.blockers], attempt: rig.engine.attemptId(), phase: rig.engine.state().phase, windows: rig.windows, from: new Error().stack ?? '' })
  }
  /** Squirrel.Mac arms ShipIt and says so; then the turns the commit takes (the windows closing) are let run. */
  n.ready = async () => { rig.armed = true; n.emit('update-downloaded'); await settle() }
  return n
}

/**
 * One engine with every port faked and each await held until the test releases it.
 * withdraw: 'ok' (removes what is armed, checked gone), 'fails' (found, not gone), 'throws', or 'hold' (a deferred
 * the test resolves with a Withdrawal).
 */
function rig({ platform = 'darwin', gate = (): string | null => null, autoVerify = true, holdHandOver = false, holdRefresh = false, app }: {
  platform?: string; gate?: () => string | null; autoVerify?: boolean; holdHandOver?: boolean; holdRefresh?: boolean
  /** The app's side of the commit instead of the rig's (closeWindows and commitAbandoned), given the rig. */
  app?: (r: Rig) => { closeWindows(restart: RestartClose): Promise<boolean>; commitAbandoned(): void }
} = {}): Rig {
  const r = { blockers: [], quits: [], prepares: 0, withdrawals: 0, releases: 0, checks: 0, fetches: 0, verifies: 0, handOvers: 0, nativeAccess: 0, calls: [], order: [], log: [], d: {}, tokens: [], armed: false, withdraw: 'ok', windows: 2, close: 'auto', closes: 0, abandoned: 0 } as unknown as Rig
  r.timers = fakeTimers()
  r.native = fakeNative(r)
  const own = app?.(r)
  r.engine = createUpdateEngine({
    identity: IDENTITY,
    platform,
    gate,
    blockers: () => { r.order.push('blockers'); return [...r.blockers] },
    downloader: () => ({
      check: () => { r.checks += 1; r.d.check = deferred<boolean>(); return r.d.check.promise },
      retrieve: (token, progress) => { r.fetches += 1; r.tokens.push(token); r.progress = progress; r.d.fetch = deferred<string>(); return r.d.fetch.promise },
    }),
    verify: () => { r.verifies += 1; if (autoVerify) return Promise.resolve(null); r.d.verify = deferred(); return r.d.verify.promise },
    // electron-updater's hand-over: its local address, then Squirrel.Mac's feed address.
    handOver: (file) => {
      r.handOvers += 1; r.order.push('handOver'); r.handedFile = file
      if (holdHandOver) { r.d.handOver = deferred<void>(); return r.d.handOver.promise.then(() => r.native.setFeedURL()) }
      r.native.setFeedURL(); return Promise.resolve()
    },
    native: () => { r.nativeAccess += 1; return r.native },
    // The app's own close route: 'auto' closes every window; 'hold' resolves when the test says (true: all closed).
    closeWindows: () => {
      r.closes += 1; r.order.push('closeWindows')
      if (r.close === 'auto') { r.windows = 0; return Promise.resolve(true) }
      r.d.close = deferred<boolean>()
      return r.d.close.promise
    },
    ...(own ? { closeWindows: own.closeWindows } : {}),
    openWindows: () => r.windows,
    commitAbandoned: () => { r.abandoned += 1; own?.commitAbandoned() },
    // What is read asynchronously (the backup helper's activity): 'holdRefresh' waits for the test (r.d.refresh).
    refreshBlockers: () => {
      r.order.push('refresh')
      if (!holdRefresh) return Promise.resolve()
      r.d.refresh = deferred<void>()
      return r.d.refresh.promise
    },
    withdrawNative: () => {
      r.withdrawals += 1
      const found = r.armed
      if (r.withdraw === 'throws') return Promise.reject(new Error('launchctl is gone'))
      if (r.withdraw === 'fails') return Promise.resolve({ found: true, gone: false })
      if (r.withdraw === 'hold') { r.d.withdraw = deferred(); return r.d.withdraw.promise }
      r.armed = false
      return Promise.resolve({ found, gone: true })
    },
    releaseFiles: () => { r.releases += 1 },
    timers: r.timers,
    now: () => 0,
    changed: () => {},
    log: (m) => r.log.push(m),
  })
  r.phase = () => r.engine.state().phase
  /** Nothing at all reached Squirrel.Mac or the hand-over. */
  r.untouched = (why: string) => {
    assert.deepEqual(r.calls, [], `${why}: Squirrel.Mac received no call (no feed address, no check, no listener)`)
    assert.equal(r.handOvers, 0, `${why}: nothing was handed over`)
    assert.equal(r.nativeAccess, 0, `${why}: the native updater was not even asked for`)
    assert.equal(r.armed, false, `${why}: nothing is armed`)
  }
  /** Drive an attempt to a named point. */
  r.to = async (point: string) => {
    r.started = r.engine.start(OFFER)
    await settle()
    if (point === 'checking') return
    r.d.check.resolve(true); await settle()
    if (point === 'downloading') { r.progress(50, 100); return }
    r.progress(100, 100)
    if (point === 'bytes-in') return
    r.d.fetch.resolve('/cache/WriteFlex-mac-arm64.zip'); await settle()
    if (point === 'verifying') return
    if (!autoVerify) { r.d.verify.resolve(null); await settle() }
    await r.started
    await settle()
  }
  return r
}

/** The one rule: the native install is called only from quitIfPermitted, with no blocker and a live attempt. */
function onlyThroughTheGate(r: Rig) {
  for (const q of r.quits) {
    assert.deepEqual(q.blockers, [], 'the native install is never called while a blocker holds')
    assert.notEqual(q.attempt, null, 'the native install is called only for the live attempt')
    assert.equal(q.phase, 'restarting')
    assert.equal(q.windows, 0, 'the native install is never called with a window open')
    assert.match(q.from, /quitIfPermitted/, 'the native install is called only from quitIfPermitted')
  }
}
const D1_POINTS = ['checking', 'downloading', 'bytes-in', 'verifying']
const pointName = (point: string) => (point === 'bytes-in' ? 'after the bytes are in, before the download resolves' : `while ${point}`)

test('the withdrawal\'s two checks: only a definite answer counts; a check that failed is never read as "gone"', () => {
  expect(launchdJobPresence({ status: 0 })).toBe('present')
  expect(launchdJobPresence({ status: 113 })).toBe('absent')
  expect(launchdJobPresence({ status: null, signal: 'SIGTERM' })).toBe('unknown')
  expect(launchdJobPresence({ status: null, error: new Error('spawn ENOENT') })).toBe('unknown')
  expect(launchdJobPresence({ status: 1 })).toBe('unknown')
  expect(pathPresence(() => ({}))).toBe('present')
  expect(pathPresence(() => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) })).toBe('absent')
  expect(pathPresence(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })).toBe('unknown')
})

// ── The happy path ──────────────────────────────────────────────────────────────────────────────

test('the click with nothing holding: D1 download and check, then (blockers read) the hand-over, (blockers read again) Squirrel.Mac prepares, then the one gate quits and installs', async () => {
  const r = rig()
  await r.to('done')
  assert.equal(r.phase(), 'restarting')
  assert.equal(r.handOvers, 1)
  assert.equal(r.handedFile, '/cache/WriteFlex-mac-arm64.zip', 'the verified file is the one handed over')
  assert.equal(r.prepares, 1)
  assert.match(r.order.join(' '), /refresh blockers handOver setFeedURL blockers checkForUpdates$/, 'refreshed, a blocker check before the hand-over, and another before the native request')
  assert.equal(r.quits.length, 0, 'preparing is not permission to quit')
  assert.equal(r.timers.pending(), 1, 'the watchdog runs')
  r.order.length = 0
  await r.native.ready()
  assert.equal(r.quits.length, 1)
  assert.deepEqual(r.order, ['refresh', 'blockers', 'closeWindows', 'blockers'], 'ready: refreshed, checked, every window closed, checked again, then installed')
  onlyThroughTheGate(r)
  assert.equal(r.withdrawals, 0)
  assert.equal(r.abandoned, 0)
})

// ── D1 and D2: nothing native at all ────────────────────────────────────────────────────────────

for (const point of D1_POINTS) {
  test(`D1 ${pointName(point)}: Squirrel.Mac has received no call at all`, async () => {
    const r = rig({ autoVerify: point !== 'verifying' })
    await r.to(point)
    assert.equal(r.phase(), 'downloading')
    r.untouched(point)
  })
}

test('D2 (a blocker holds when the download is verified): waiting with the verified file on disk; Squirrel.Mac has received no call; Restart while it holds still none', async () => {
  const r = rig()
  r.blockers = ['exporting']
  await r.to('done')
  assert.equal(r.phase(), 'waiting')
  r.untouched('waiting')
  assert.equal(r.releases, 0, 'the verified file waits on disk')
  assert.equal(r.engine.restart().phase, 'waiting', 'Restart while it holds does nothing')
  r.untouched('Restart while held')
  assert.equal(r.timers.pending(), 0, 'no watchdog while waiting')
})

test('a simulated exit in D2 leaves nothing armed: the process ends with no hand-over, no native request and no ShipIt', async () => {
  const r = rig()
  r.blockers = ['agent']
  await r.to('done')
  assert.equal(r.phase(), 'waiting')
  // What an exit, a crash or a forced kill would find: nothing was handed to Squirrel.Mac, so ShipIt was never launched.
  r.untouched('the moment of the exit')
  // A late native event (none can come: nothing was asked) would not install either.
  r.native.emit('update-downloaded')
  assert.equal(r.quits.length, 0)
})

// ── Cancel ──────────────────────────────────────────────────────────────────────────────────────

for (const point of D1_POINTS) {
  test(`Cancel ${pointName(point)}: idle at once; whatever arrives later is ignored and releases its file; nothing native, ever`, async () => {
    const r = rig({ autoVerify: point !== 'verifying' })
    await r.to(point)
    r.engine.cancel()
    assert.equal(r.phase(), 'idle', 'Cancel changes the state at once')
    if (point !== 'verifying') assert.equal(r.releases, 0, 'files are released once the download has settled, not under it')
    if (point === 'checking') r.d.check.resolve(true)
    if (point === 'downloading' || point === 'bytes-in') { assert.equal(r.tokens[0].cancelled, true, 'the download is cancelled'); r.d.fetch.resolve('/cache/late.zip') }
    if (point === 'verifying') r.d.verify.resolve(null)
    await settle()
    await r.started
    assert.equal(r.phase(), 'idle')
    assert.equal(r.fetches, point === 'checking' ? 0 : 1, 'nothing more is downloaded after Cancel')
    assert.equal(r.releases, 1, 'the late result releases its file')
    r.untouched(`Cancel ${point}`)
    assert.equal(r.withdrawals, 0, 'nothing to withdraw')
    assert.equal(r.engine.restart().phase, 'idle', 'Restart after Cancel does nothing: a new click on Update is needed')
    r.untouched(`Restart after Cancel ${point}`)
  })
}

test('Cancel while the download fails late (electron-updater rejects with its cancellation): still idle, no failure shown', async () => {
  const r = rig()
  await r.to('downloading')
  r.engine.cancel()
  const e = new Error('cancelled'); e.name = 'CancellationError'
  r.d.fetch.reject(e)
  await settle(); await r.started
  assert.equal(r.phase(), 'idle')
  assert.equal(r.releases, 1)
  r.untouched('cancelled download')
})

test('Cancel in D2 (waiting): idle, the verified file deleted, nothing native ever existed', async () => {
  const r = rig()
  r.blockers = ['exporting']
  await r.to('done')
  r.engine.cancel()
  assert.equal(r.phase(), 'idle')
  assert.equal(r.releases, 1)
  r.untouched('Cancel while waiting')
  r.blockers = []
  assert.equal(r.engine.restart().phase, 'idle')
  r.untouched('Restart after Cancel')
})

test('no Cancel once restarting (D3): the person committed; Cancel does nothing', async () => {
  const r = rig()
  await r.to('done')
  assert.equal(r.engine.cancel().phase, 'restarting')
  await r.native.ready()
  assert.equal(r.quits.length, 1)
  assert.equal(r.engine.cancel().phase, 'restarting')
  onlyThroughTheGate(r)
})

// ── A blocker at every phase ────────────────────────────────────────────────────────────────────

for (const point of D1_POINTS) {
  test(`a blocker appearing ${pointName(point)}: the download finishes and waits; nothing native; Restart once clear hands over after a blocker check`, async () => {
    const r = rig({ autoVerify: point !== 'verifying' })
    await r.to(point)
    r.blockers = ['agent']
    if (point === 'checking') { r.d.check.resolve(true); await settle(); r.progress(100, 100) }
    if (point !== 'verifying') { if (point !== 'bytes-in' && point !== 'checking') r.progress(100, 100); r.d.fetch.resolve('/cache/f.zip'); await settle() }
    if (point === 'verifying' || r.d.verify) r.d.verify?.resolve(null)
    await settle(); await r.started
    assert.equal(r.phase(), 'waiting')
    r.untouched(`waiting after a blocker ${point}`)
    r.blockers = []
    r.order.length = 0
    assert.equal(r.engine.restart().phase, 'restarting')
    await settle()
    assert.match(r.order.join(' '), /^blockers handOver setFeedURL blockers checkForUpdates$/, 'Restart: blocker check, hand-over, blocker check, native request (the IPC handler refreshes before Restart)')
    await r.native.ready()
    assert.equal(r.quits.length, 1)
    onlyThroughTheGate(r)
  })
}

test('a blocker appearing during the hand-over (before Squirrel.Mac is asked): back to waiting; nothing asked, nothing armed', async () => {
  const r = rig({ holdHandOver: true })
  await r.to('done')
  assert.equal(r.phase(), 'restarting')
  r.blockers = ['sharing']
  r.d.handOver.resolve(); await settle()
  assert.equal(r.phase(), 'waiting')
  assert.equal(r.prepares, 0, 'Squirrel.Mac was not asked')
  assert.equal(r.armed, false)
  assert.equal(r.timers.pending(), 0)
  r.blockers = []
  r.engine.restart()
  r.d.handOver.resolve(); await settle()
  assert.equal(r.prepares, 1)
  await r.native.ready()
  assert.equal(r.quits.length, 1)
  onlyThroughTheGate(r)
})

// ── The commit: every window closed by the app's own route before the native install ─────────────

test('finding 1: a window kept open (its save failed) ends the restart at once; the checked withdrawal follows; the watchdog and a much later close install nothing', async () => {
  const r = rig()
  r.close = 'hold'
  await r.to('done')
  await r.native.ready()
  assert.equal(r.closes, 1, 'the windows are asked to close')
  assert.equal(r.quits.length, 0, 'nothing installs while the windows close')
  // The close flush fails: WriteFlex keeps the window open.
  r.d.close.resolve(false); await settle()
  assert.equal(r.engine.attemptId(), null, 'the restart attempt has ended')
  assert.equal(r.withdrawals, 1, 'the withdrawal is checked (D4)')
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.29.0', cause: 'held', pending: false })
  assert.equal(r.abandoned, 1, 'the app is told the restart will not happen (the backup helper starts again)')
  // The person starts an export, then much later the watchdog time passes and they close the last window.
  r.blockers = ['exporting']
  r.timers.advance(RESTART_WATCHDOG_MS * 2)
  r.blockers = []
  r.windows = 0
  await r.native.ready() // even a late "ready" from Squirrel.Mac
  await settle()
  assert.equal(r.quits.length, 0, 'nothing installs')
  assert.ok(!r.calls.includes('quitAndInstall'), 'the native install was never called, so no window-closing observer exists to install later')
})

test('finding 1: the watchdog while the windows are still closing ends the restart; a close that finishes much later installs nothing', async () => {
  const r = rig()
  r.close = 'hold'
  await r.to('done')
  await r.native.ready()
  r.timers.advance(RESTART_WATCHDOG_MS)
  await settle()
  assert.equal(r.engine.state().phase, 'reopen')
  assert.equal(r.engine.state().cause, 'held')
  assert.equal(r.engine.state().pending, false, 'checked: nothing will install')
  r.windows = 0
  r.d.close.resolve(true); await settle()
  assert.equal(r.quits.length, 0)
  assert.ok(!r.calls.includes('quitAndInstall'))
})

// Review round 2, finding 1: the engine with the app's own side of the commit (restart-windows.ts createRestartClose),
// fake windows whose closes the test settles, and a fake backup helper.
function withAppSide(opts: { recallable: boolean; holdStop?: boolean }) {
  const app = { opened: 0, stops: 0, resumes: 0, running: true, abandons: 0, closes: [] as Array<Deferred<boolean>>, stop: null as Deferred<boolean> | null }
  const r = rig({
    app: (rig) => {
      const side = createRestartClose({
        closeEach: () => Array.from({ length: rig.windows }, (): RecallableClose => {
          const d = deferred<boolean>()
          app.closes.push(d)
          return { closed: d.promise, abandon: () => { app.abandons += 1; if (!opts.recallable) return false; d.resolve(false); return true } }
        }),
        finishWork: () => Promise.resolve(),
        backup: () => ({
          stop: () => { app.stops += 1; app.running = false; if (!opts.holdStop) return Promise.resolve(true); app.stop = deferred<boolean>(); return app.stop.promise },
          resume: () => { app.resumes += 1; app.running = true },
        }),
        windowCount: () => rig.windows,
        openWindow: () => { app.opened += 1; rig.windows += 1 },
      })
      return { closeWindows: (restart) => side.close(restart), commitAbandoned: () => side.recover() }
    },
  })
  return { r, app }
}

test('round 2 finding 1: a close past recall that finishes after the watchdog stops nothing: no backup stop, a window exists, backup running, no native install', async () => {
  const { r, app } = withAppSide({ recallable: false })
  await r.to('done')
  await r.native.ready()
  assert.equal(app.closes.length, 2, 'both windows were asked to close')
  r.timers.advance(RESTART_WATCHDOG_MS)
  await settle()
  assert.equal(r.engine.attemptId(), null, 'the watchdog ended the attempt')
  assert.equal(app.abandons, 2, 'every close was offered the call-off')
  // The closes were already past recall: the windows close after the attempt has ended.
  r.windows = 0
  for (const d of app.closes) d.resolve(true)
  await settle()
  assert.equal(app.stops, 0, 'an ended attempt never stops the backup helper')
  assert.equal(app.running, true, 'scheduled backup is running')
  assert.equal(r.windows, 1, 'a window exists')
  assert.equal(app.opened, 1, 'exactly one window was opened')
  assert.equal(r.quits.length, 0, 'no native install')
  assert.ok(!r.calls.includes('quitAndInstall'))
  assert.equal(r.engine.state().phase, 'reopen')
})

test('round 2 finding 1: the watchdog calls off a close that can be recalled: that window stays, nothing is stopped, no window is added, no native install', async () => {
  const { r, app } = withAppSide({ recallable: true })
  await r.to('done')
  await r.native.ready()
  r.timers.advance(RESTART_WATCHDOG_MS)
  await settle()
  assert.equal(app.abandons, 2, 'both closes were abandoned')
  assert.equal(r.windows, 2, 'the windows stay open')
  assert.equal(app.opened, 0)
  assert.equal(app.stops, 0)
  assert.equal(app.running, true)
  assert.equal(r.quits.length, 0)
})

test('round 2 finding 1: a window kept open ends the restart; only the closes still under way are called off, never the one already answered', async () => {
  const { r, app } = withAppSide({ recallable: true })
  await r.to('done')
  await r.native.ready()
  app.closes[0].resolve(false) // the first window's write failed: kept
  await settle()
  assert.equal(r.engine.attemptId(), null, 'the attempt ended (D4)')
  assert.equal(app.abandons, 1, 'only the second window\'s close, still under way, was called off')
  assert.equal(r.windows, 2, 'both windows stay')
  assert.equal(app.stops, 0)
  assert.equal(app.opened, 0)
  assert.equal(r.quits.length, 0)
})

test('round 2 finding 1: the watchdog while the backup helper is stopping: a window at once, backup started again once the stop has settled, once only, no native install', async () => {
  const { r, app } = withAppSide({ recallable: true, holdStop: true })
  await r.to('done')
  await r.native.ready()
  r.windows = 0
  for (const d of app.closes) d.resolve(true)
  await settle()
  assert.equal(app.stops, 1, 'every window closed while live: the helper is being stopped')
  r.timers.advance(RESTART_WATCHDOG_MS)
  await settle()
  assert.equal(r.windows, 1, 'a window at once')
  assert.equal(app.resumes, 0, 'not started again while its stop is still under way')
  app.stop!.resolve(true)
  await settle()
  assert.equal(app.resumes, 1, 'started again once the stop settled')
  assert.equal(app.running, true)
  assert.equal(app.opened, 1, 'no second window from the second recovery')
  assert.equal(r.quits.length, 0, 'no native install')
  assert.ok(!r.calls.includes('quitAndInstall'))
})

test('finding 1: the native install is never called with a window open: a window opened again after the close, or a blocker that began while the windows closed, ends the restart instead', async () => {
  for (const what of ['a window', 'a blocker'] as const) {
    const r = rig()
    r.close = 'hold'
    await r.to('done')
    await r.native.ready()
    if (what === 'a window') r.windows = 1
    else { r.windows = 0; r.blockers = ['finishing'] }
    r.d.close.resolve(true); await settle()
    assert.equal(r.quits.length, 0, `${what}: no install`)
    assert.ok(!r.calls.includes('quitAndInstall'), `${what}: the native install was not called`)
    assert.equal(r.engine.state().phase, 'reopen', what)
    assert.equal(r.abandoned, 1, what)
  }
})

test('finding 1: the blockers are refreshed (the backup helper\'s activity) before the commit; a cycle found then holds the restart and no window is closed', async () => {
  const r = rig({ holdRefresh: true })
  await r.to('downloading')
  r.progress(100, 100); r.d.fetch.resolve('/cache/f.zip'); await settle()
  r.d.refresh.resolve(); await settle(); await r.started; await settle()
  assert.equal(r.phase(), 'restarting')
  r.native.emit('update-downloaded'); r.armed = true
  await settle()
  assert.equal(r.closes, 0, 'nothing closes before the refresh has answered')
  r.blockers = ['backup']
  r.d.refresh.resolve(); await settle()
  assert.equal(r.closes, 0, 'a backup cycle holds the restart: no window closes')
  assert.equal(r.quits.length, 0)
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.29.0', cause: 'held', pending: false })
})

// ── D4: the narrow leftovers ────────────────────────────────────────────────────────────────────

test('a blocker appearing during D3\'s preparation: the app does not quit; "reopen" pending at once; the withdrawal is checked, then "quit and reopen"; the run is spent', async () => {
  const r = rig()
  r.withdraw = 'hold'
  await r.to('done')
  r.blockers = ['exporting']
  await r.native.ready()
  assert.equal(r.quits.length, 0, 'an export began while Squirrel.Mac was preparing: no quit')
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.29.0', cause: 'held', pending: true }, 'until the withdrawal is checked, it says the update will install at the next quit')
  assert.equal(r.withdrawals, 1)
  assert.equal(r.timers.pending(), 0)
  r.armed = false
  r.d.withdraw.resolve({ found: true, gone: true }); await settle()
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.29.0', cause: 'held', pending: false }, 'checked: nothing will install; quit and reopen')
  assert.equal(r.releases, 1)
  // Spent: nothing native, no download, until WriteFlex is reopened.
  r.blockers = []
  const checks = r.checks
  assert.equal((await r.engine.start(OFFER)).phase, 'reopen')
  assert.equal(r.engine.restart().phase, 'reopen')
  assert.equal(r.engine.cancel().phase, 'reopen')
  r.native.emit('update-downloaded')
  assert.equal(r.checks, checks, 'nothing is downloaded')
  assert.equal(r.prepares, 1, 'Squirrel.Mac is not asked again')
  assert.equal(r.quits.length, 0)
})

test('a withdrawal that fails is reported, not swallowed: the state stays "WriteFlex will finish updating when it next quits"', async () => {
  for (const how of ['fails', 'throws'] as const) {
    const r = rig()
    r.withdraw = how
    await r.to('done')
    r.blockers = ['unsaved']
    await r.native.ready()
    await settle()
    assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.29.0', cause: 'held', pending: true }, `${how}: still pending`)
    assert.match(r.log.join('\n'), /withdrawal NOT confirmed/, `${how}: logged`)
    assert.match(r.log.join('\n'), /when WriteFlex quits/, `${how}: the log names the app from its identity`)
    assert.equal(r.quits.length, 0)
  }
})

test('a blocker read that fails holds the restart (fail closed): before the hand-over → waiting; at the gate → reopen', async () => {
  const before = rig()
  before.blockers = { [Symbol.iterator]() { throw new Error('the window list is gone') } } as unknown as string[]
  await before.to('done')
  assert.equal(before.phase(), 'waiting')
  before.untouched('a failed blocker read')
  const atGate = rig()
  await atGate.to('done')
  atGate.blockers = { [Symbol.iterator]() { throw new Error('the window list is gone') } } as unknown as string[]
  await atGate.native.ready()
  await settle()
  assert.equal(atGate.quits.length, 0)
  assert.equal(atGate.phase(), 'reopen')
})

test('the watchdog in D3 with no answer: "may finish when it next quits" (pending, even after a clean check: Squirrel.Mac may still arm); its late answer never installs and a clean check then says "reopen"', async () => {
  const r = rig()
  await r.to('done')
  r.timers.advance(RESTART_WATCHDOG_MS - 1)
  assert.equal(r.phase(), 'restarting')
  r.timers.advance(1)
  await settle()
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.29.0', cause: 'no-answer', pending: true })
  assert.equal(r.withdrawals, 1, 'withdrawn and checked at once')
  assert.equal(r.releases, 1)
  await r.native.ready() // Squirrel.Mac arms ShipIt late
  await settle()
  assert.equal(r.quits.length, 0, 'a native answer after the watchdog never installs')
  assert.equal(r.withdrawals, 2, 'what it armed late is withdrawn')
  assert.equal(r.armed, false)
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.29.0', cause: 'no-answer', pending: false })
  assert.equal(r.engine.restart().phase, 'reopen', 'Restart cannot revive it')
})

test('the watchdog in D3, then a late answer whose withdrawal fails: stays pending', async () => {
  const r = rig()
  await r.to('done')
  r.timers.advance(RESTART_WATCHDOG_MS)
  await settle()
  r.withdraw = 'fails'
  await r.native.ready()
  await settle()
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.29.0', cause: 'no-answer', pending: true })
})

test('the watchdog during the hand-over itself (Squirrel.Mac never asked): failed; the late hand-over asks nothing', async () => {
  const r = rig({ holdHandOver: true })
  await r.to('done')
  r.timers.advance(RESTART_WATCHDOG_MS)
  assert.deepEqual(r.engine.state(), { phase: 'failed', version: '0.29.0', reason: 'other' })
  r.d.handOver.resolve(); await settle()
  assert.equal(r.prepares, 0)
})

test('a failed install after the native install was called: "may finish when it next quits", then the checked withdrawal', async () => {
  const r = rig()
  await r.to('done')
  await r.native.ready()
  assert.equal(r.quits.length, 1)
  r.native.emit('error', new Error('Code signature at URL file:///x did not pass validation'))
  assert.equal(r.engine.state().phase, 'reopen')
  assert.equal(r.engine.state().cause, 'install-failed')
  await settle()
  assert.equal(r.engine.state().pending, false)
  onlyThroughTheGate(r)
})

test('Squirrel.Mac refusing the new app in D3 (before it arms anything): failed with the reason; checked; Try again may use Squirrel.Mac again', async () => {
  const r = rig()
  await r.to('done')
  r.native.emit('error', new Error('Code signature at URL file:///x did not pass validation: code failed to satisfy specified code requirement(s)'))
  assert.equal(r.engine.state().phase, 'restarting', 'no outcome (and so no Try again) until the check has answered')
  assert.equal(r.engine.attemptId(), null, 'but the attempt has ended at once')
  await settle()
  assert.equal(r.withdrawals, 1, 'checked that nothing is armed')
  assert.equal(r.engine.state().phase, 'failed')
  assert.equal(r.engine.state().reason, 'signature')
  const again = r.engine.start(OFFER)
  await settle(); r.d.check.resolve(true); await settle(); r.d.fetch.resolve('/f.zip'); await settle(); await again; await settle()
  assert.equal(r.prepares, 2, 'nothing was armed, so Squirrel.Mac may be asked again')
  await r.native.ready()
  assert.equal(r.quits.length, 1)
  onlyThroughTheGate(r)
})

test('Squirrel.Mac refusing, but the check finds something armed it cannot remove: the person reads that it may install at the next quit', async () => {
  const r = rig()
  await r.to('done')
  r.withdraw = 'fails'
  r.native.emit('error', new Error('something odd'))
  await settle()
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.29.0', cause: 'install-failed', pending: true })
})

// ── The spent flag, re-read before any native request ────────────────────────────────────────────

test('finding 2: Try again while a refused preparation\'s check is still running starts nothing; an unconfirmed check then keeps "may install when it quits" (pending), never "unchanged"', async () => {
  const r = rig()
  r.withdraw = 'hold'
  await r.to('done')
  assert.equal(r.prepares, 1)
  // Squirrel.Mac refuses; the check of what it may have left is still running.
  r.native.emit('error', new Error('something odd'))
  assert.equal(r.phase(), 'restarting', 'no failure, and so no Try again, before the check answers')
  const checks = r.checks
  // Try again (or Update from another window) at once: refused while the check runs.
  assert.equal((await r.engine.start(OFFER)).phase, 'restarting')
  await settle()
  assert.equal(r.checks, checks, 'nothing is downloaded while the check runs')
  // The check answers: something is still there.
  r.d.withdraw.resolve({ found: true, gone: false }); await settle()
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.29.0', cause: 'install-failed', pending: true })
  // Nothing turns that into "unchanged": not a click, not a change of offer.
  assert.equal((await r.engine.start(OFFER)).phase, 'reopen')
  r.engine.reset()
  assert.deepEqual(r.engine.state(), { phase: 'reopen', version: '0.29.0', cause: 'install-failed', pending: true })
  assert.equal(r.checks, checks)
  assert.equal(r.prepares, 1)
  assert.equal(r.quits.length, 0)
})

test('a refused preparation whose check found something armed and removed it: failed, and the run is spent (Try again asks nothing)', async () => {
  const r = rig()
  r.withdraw = 'hold'
  await r.to('done')
  r.native.emit('error', new Error('something odd'))
  r.d.withdraw.resolve({ found: true, gone: true }); await settle()
  assert.deepEqual(r.engine.state(), { phase: 'failed', version: '0.29.0', reason: 'other' })
  const checks = r.checks
  assert.deepEqual(await r.engine.start(OFFER), { phase: 'failed', version: '0.29.0', reason: 'reopen' })
  assert.equal(r.checks, checks, 'nothing is downloaded in a spent run')
  assert.equal(r.prepares, 1)
  assert.equal(r.quits.length, 0)
})

// ── Clicks during an attempt, a new attempt after an old one ────────────────────────────────────

test('a second click during an attempt does nothing; Try again after a failure starts a new attempt', async () => {
  const r = rig()
  await r.to('downloading')
  await r.engine.start(OFFER).then((s) => assert.equal(s.phase, 'downloading'))
  assert.equal(r.checks, 1)
  r.d.fetch.reject(new Error('net::ERR_CONNECTION_RESET'))
  await settle(); await r.started
  assert.deepEqual(r.engine.state(), { phase: 'failed', version: '0.29.0', reason: 'network' })
  assert.equal(r.releases, 1)
  r.untouched('a failed download')
  const again = r.engine.start(OFFER)
  await settle()
  assert.equal(r.checks, 2)
  r.d.check.resolve(true); await settle()
  r.d.fetch.resolve('/f.zip'); await settle(); await again; await settle()
  assert.equal(r.phase(), 'restarting')
  assert.equal(await r.engine.start(OFFER).then((s) => s.phase), 'restarting', 'a click while restarting does nothing')
  assert.equal(r.handOvers, 1)
})

test('Update straight after Cancel waits for the cancelled download to settle (they never share electron-updater)', async () => {
  const r = rig()
  await r.to('downloading')
  const first = r.d.fetch
  r.engine.cancel()
  const second = r.engine.start(OFFER)
  await settle()
  assert.equal(r.checks, 1, 'the new attempt has not asked yet')
  first.resolve('/late.zip')
  await settle()
  assert.equal(r.releases, 1, 'the old file was released first')
  assert.equal(r.checks, 2, 'then the new attempt starts')
  r.d.check.resolve(true); await settle(); r.d.fetch.resolve('/f.zip'); await settle(); await second; await settle()
  assert.equal(r.phase(), 'restarting')
  assert.equal(r.handedFile, '/f.zip', 'the new attempt\'s file is the one handed over')
  await r.native.ready()
  assert.equal(r.quits.length, 1)
  onlyThroughTheGate(r)
})

test('an attempt has an identity: a late download result of an ended attempt is ignored and does not touch the new one', async () => {
  const r = rig()
  await r.to('downloading')
  const firstId = r.engine.attemptId()
  assert.notEqual(firstId, null)
  r.engine.cancel()
  assert.equal(r.engine.attemptId(), null, 'no live attempt after Cancel')
  const second = r.engine.start(OFFER)
  const oldFetch = r.d.fetch
  oldFetch.resolve('/old.zip'); await settle()
  assert.ok(r.engine.attemptId()! > firstId!, 'the new attempt has a new identity')
  r.d.check.resolve(true); await settle(); r.d.fetch.resolve('/new.zip'); await settle(); await second; await settle()
  assert.equal(r.handedFile, '/new.zip', 'only the live attempt\'s file is ever handed over')
})

test('a download that is not the version offered: failed "wrong-version", never handed to Squirrel.Mac', async () => {
  const r = rig({ autoVerify: false })
  await r.to('verifying')
  r.d.verify.resolve('wrong-version')
  await settle(); await r.started
  assert.deepEqual(r.engine.state(), { phase: 'failed', version: '0.29.0', reason: 'wrong-version' })
  r.untouched('a refused file')
})

// ── Refused before anything happens ─────────────────────────────────────────────────────────────

test('Windows: no in-place update; refused before any download, whatever the gate says', async () => {
  const r = rig({ platform: 'win32' })
  const s = await r.engine.start(OFFER)
  assert.equal(s.phase, 'idle')
  assert.equal(r.checks + r.fetches + r.prepares + r.handOvers, 0)
  assert.match(r.log.join('\n'), /no in-place update on win32/)
})

test('a Store copy, a development run and distraction-free writing are refused at the engine, before any download', async () => {
  const facts = (source: string) => ({ platform: 'darwin', arch: 'arm64', source, file: { url: OFFER.url, sha512: 'x', size: 1, bundleId: UPDATE_INSTALL_IDENTITY.bundleId }, appPath: '/Applications/WriteFlex.app', writable: true, writeError: null, bundleId: UPDATE_INSTALL_IDENTITY.bundleId })
  for (const [why, gate] of [['store', () => inPlaceRefusal(facts('store'))], ['development', () => inPlaceRefusal(facts('development'))], ['protected', () => 'distraction-free writing is on']] as const) {
    const r = rig({ gate })
    const s = await r.engine.start(OFFER)
    assert.equal(s.phase, 'idle', why)
    assert.equal(r.checks + r.fetches, 0, `${why}: nothing is asked or downloaded`)
    r.untouched(why)
  }
  // And a website copy passes the same gate.
  assert.equal(inPlaceRefusal(facts('website')), null)
})

// ── The real electron-updater, in a child process ───────────────────────────────────────────────

test('the real MacUpdater: its own routes to the native install refuse; D1 and D2 make no call on Squirrel.Mac and open no local address; Restart hands over, then prepares; a blocker at the gate does not quit', async () => {
  const child = Bun.spawn([process.execPath, 'tests/helpers/update-engine-mac-updater-probe.ts'], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`MacUpdater probe failed (exit ${code}):\n${stderr}\n${stdout}`)
  const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')
  expect(result).toEqual({
    control: { installsByItself: true, setsFeedAtDownload: true },
    held: { phase: 'waiting', nativeCalls: [], server: false, refusals: 2, quitsFromDependency: 0, cannotReplace: true },
    restart: { native: ['setFeedURL', 'checkForUpdates'], listening: true, quitsWhileHeld: 0, phase: 'reopen', withdrawn: 1 },
    clickClear: { phase: 'restarting', prepares: 1, quits: 1, throughGate: true },
    userAgent: 'WriteFlex',
  })
}, 30_000)

// ── The downloaded file: size and the version inside (real zips; macOS) ──────────────────────────

test.skipIf(process.platform !== 'darwin')('the downloaded file: the feed\'s size, and inside it the version offered, newer than the running one, with the stated bundle identifier', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-engine-zip-'))
  const BUNDLE = UPDATE_INSTALL_IDENTITY.bundleId
  const zip = (name: string, version: string, bundleId: string, extra: string[] = []) => {
    const root = join(dir, `src-${name}`)
    for (const app of ['WriteFlex.app', ...extra]) {
      mkdirSync(join(root, app, 'Contents'), { recursive: true })
      writeFileSync(join(root, app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`)
    }
    const out = join(dir, `${name}.zip`)
    if (extra.length) execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', root, out])
    else execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(root, 'WriteFlex.app'), out])
    return { path: out, size: statSync(out).size }
  }
  try {
    const offer = (z: { size: number }, over: Partial<Offer> = {}): Offer => ({ ...OFFER, version: '0.29.0', size: z.size, bundleId: BUNDLE, ...over })
    const good = zip('good', '0.29.0', BUNDLE)
    assert.equal(await verifyMacDownload(good.path, offer(good), '0.28.0'), null)
    assert.equal(await verifyMacDownload(good.path, { ...offer(good), bundleId: undefined }, '0.28.0'), null, 'a stand-in feed without a bundle identifier checks none')
    assert.equal(await verifyMacDownload(good.path, offer(good, { size: good.size + 1 }), '0.28.0'), 'mismatch', 'a size other than the feed\'s is refused')
    const older = zip('older', '0.27.0', BUNDLE)
    assert.equal(await verifyMacDownload(older.path, offer(older), '0.28.0'), 'wrong-version', 'an older signed build under the new name is refused')
    assert.equal(await verifyMacDownload(good.path, offer(good, { version: '0.30.0' }), '0.28.0'), 'wrong-version', 'not the version offered')
    assert.equal(await verifyMacDownload(good.path, offer(good), '0.29.0'), 'wrong-version', 'not newer than the running version')
    const alphaInside = zip('alpha', '0.29.0-alpha.10', BUNDLE)
    assert.equal(await verifyMacDownload(alphaInside.path, offer(alphaInside, { version: '0.29.0-alpha.10' }), '0.29.0-alpha.2'), null, 'alpha.10 is newer than alpha.2')
    assert.equal(await verifyMacDownload(alphaInside.path, offer(alphaInside, { version: '0.29.0-alpha.10' }), '0.29.0'), 'wrong-version', 'an alpha is older than its release')
    const other = zip('other', '0.29.0', 'net.example.other')
    assert.equal(await verifyMacDownload(other.path, offer(other), '0.28.0'), 'wrong-version', 'another app')
    const beta = zip('beta', '0.29.0', `${BUNDLE}.beta`)
    assert.equal(await verifyMacDownload(beta.path, offer(beta), '0.28.0'), 'wrong-version', 'a beta build is another app')
    const two = zip('two', '0.29.0', BUNDLE, ['Other.app'])
    assert.equal(await verifyMacDownload(two.path, offer(two), '0.28.0'), 'wrong-version', 'two apps in one zip')
    const junk = join(dir, 'junk.zip'); writeFileSync(junk, Buffer.alloc(50, 1))
    assert.equal(await verifyMacDownload(junk, offer({ size: 50 }), '0.28.0'), 'wrong-version', 'not a zip')
    // A real build's zip has the same shape: the release workflow zips with ditto --keepParent.
    assert.match(readFileSync(new URL('../../src/main/update-engine.ts', import.meta.url), 'utf8'), /\^\[\^\/\]\+\\\.app\\\/Contents\\\/Info\\\.plist\$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 30_000)

test('the engine imports nothing of WriteFlex: only its identity is handed in', () => {
  const source = readFileSync(new URL('../../src/main/update-engine.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  expect(imports.sort()).toEqual(['../shared/update-install-state.ts', '@app-patterns/updates', 'electron-updater', 'electron-updater/out/providers/Provider.js', 'node:child_process', 'node:fs/promises'].sort())
  expect(source).not.toMatch(/WriteFlex|writeflex/)
  const state = readFileSync(new URL('../../src/shared/update-install-state.ts', import.meta.url), 'utf8')
  expect(state).not.toMatch(/WriteFlex|writeflex|^import/m)
})
