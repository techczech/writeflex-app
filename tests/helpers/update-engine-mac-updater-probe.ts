// Child-process probe for tests/main/update-engine.test.ts: the real electron-updater MacUpdater behind the real engine,
// with Electron's autoUpdater replaced by a fake (faking `electron` in the test process would leak into other files).
// Its download is stubbed (no network): it ends, as the real one does, by calling the updater's own updateDownloaded().
// Prints one JSON line of findings; any failed assertion exits non-zero.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Quit = { blockers: string[]; from: string }
type Rig = { blockers: string[]; quits: Quit[]; prepares: number; calls: string[]; withdrawn: number; refusals: string[] }
type FakeNative = EventEmitter & { setFeedURL(): void; checkForUpdates(): void; quitAndInstall(): void; ready(): void }

let current: FakeNative | null = null
// Bun copies the mocked module's properties once, so `autoUpdater` is a stable object that forwards every call to the
// fake of the scenario running now.
const forwarding = new Proxy({}, {
  get: (_target, key) => {
    if (!current) throw new Error('no fake Squirrel.Mac for this scenario')
    const value = (current as unknown as Record<PropertyKey, unknown>)[key]
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(current) : value
  },
})
mock.module('electron', () => ({ autoUpdater: forwarding }))

function fakeNative(rig: Rig): FakeNative {
  const n = new EventEmitter() as FakeNative
  const on = n.on.bind(n)
  n.on = ((event: string, fn: (...args: unknown[]) => void) => { rig.calls.push(`on:${event}`); return on(event, fn) }) as typeof n.on
  n.setFeedURL = () => { rig.calls.push('setFeedURL') }
  n.checkForUpdates = () => { rig.calls.push('checkForUpdates'); rig.prepares += 1 }
  n.quitAndInstall = () => { rig.calls.push('quitAndInstall'); rig.quits.push({ blockers: [...rig.blockers], from: new Error().stack ?? '' }) }
  n.ready = () => { n.emit('update-downloaded') }
  return n
}

const { createUpdateEngine, closeDependencyInstallPath, dependencyDownload } = await import('../../src/main/update-engine.ts')
const { MacUpdater } = await import('electron-updater')
const IDENTITY = { appName: 'WriteFlex', userAgent: 'WriteFlex' }
const OFFER = { version: '0.29.0', released: '2026-11-20', url: 'https://github.com/techczech/writeflex-app/releases/download/v0.29.0/WriteFlex-mac-arm64.zip', sha512: 'x', size: 100 }
const tick = () => new Promise<void>((r) => setImmediate(r))
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick() }
const fakeTimers = () => ({ set: () => 0, clear: () => {} })
/** The hand-over starts a real local HTTP server: wait for Squirrel.Mac to be asked by time, not by ticks (a loaded
 *  machine running the whole suite needs more than a few turns of the event loop). */
const untilPrepared = async (r: { prepares: number }, ms = 10_000) => {
  for (const end = Date.now() + ms; r.prepares === 0 && Date.now() < end;) await new Promise((done) => setTimeout(done, 10))
}

function fakeApp(dir: string) {
  return {
    version: '0.28.0', name: 'WriteFlex', isPackaged: true, appUpdateConfigPath: join(dir, 'app-update.yml'), userDataPath: dir, baseCachePath: dir,
    whenReady: () => Promise.resolve(), quit: () => { throw new Error('the app must not quit') }, relaunch: () => {}, onQuit: () => {},
  }
}
const newRig = (): Rig => ({ blockers: [], quits: [], prepares: 0, calls: [], withdrawn: 0, refusals: [] })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyUpdater = any

const result: Record<string, unknown> = {}

// Control 1: an unclosed MacUpdater reaches the native install by itself (what TalkWeaver's reviewer found).
{
  const r = newRig(); r.blockers = ['exporting']
  current = fakeNative(r)
  const dir = mkdtempSync(join(tmpdir(), 'wf-engine-control-'))
  try {
    const u: AnyUpdater = new MacUpdater(undefined, fakeApp(dir) as never)
    u.logger = null
    u.autoInstallOnAppQuit = false
    u.quitAndInstall()
    current.emit('update-downloaded')
    result.control = { installsByItself: r.quits.length === 1 }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
// Control 2: an unclosed MacUpdater sets the native feed address as soon as a download finishes (what D1 must not do).
{
  const r = newRig()
  current = fakeNative(r)
  const dir = mkdtempSync(join(tmpdir(), 'wf-engine-control2-'))
  const file = join(dir, 'f.zip'); writeFileSync(file, Buffer.alloc(10, 1))
  try {
    const u: AnyUpdater = new MacUpdater(undefined, fakeApp(dir) as never)
    u.logger = null
    u.autoInstallOnAppQuit = false
    await u.updateDownloaded({ url: new URL(OFFER.url), info: { url: OFFER.url, sha512: 'x', size: 10 } }, { downloadedFile: file, version: OFFER.version })
    ;(result.control as Record<string, unknown>).setsFeedAtDownload = r.calls.includes('setFeedURL')
    u.closeServerIfExists()
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** The real MacUpdater, closed by closeDependencyInstallPath, behind the real engine; its download stubbed. */
function realRig(dir: string) {
  const r = newRig()
  current = fakeNative(r)
  const file = join(dir, 'WriteFlex-mac-arm64.zip')
  writeFileSync(file, Buffer.alloc(100, 7))
  const u: AnyUpdater = new MacUpdater(undefined, fakeApp(dir) as never)
  u.logger = null
  const closed = closeDependencyInstallPath(u, IDENTITY, (m) => r.refusals.push(m))
  u.checkForUpdates = async () => ({ isUpdateAvailable: true })
  u.downloadUpdate = async () => {
    await u.updateDownloaded({ url: new URL(OFFER.url), info: { url: OFFER.url, sha512: 'x', size: 100 } }, { downloadedFile: file, version: OFFER.version })
    return []
  }
  const engine = createUpdateEngine({
    identity: IDENTITY,
    platform: 'darwin', gate: () => null, blockers: () => [...r.blockers],
    downloader: () => dependencyDownload(u, () => {}),
    verify: async (f) => (f === file ? null : 'other'),
    handOver: (f) => closed.handOver(f),
    native: () => u.nativeUpdater,
    // The app's own close route, faked: every window closes at once.
    closeWindows: async () => true,
    openWindows: () => 0,
    withdrawNative: async () => { r.withdrawn += 1; return { found: true, gone: true } },
    releaseFiles: () => { u.closeServerIfExists() },
    timers: fakeTimers(), // the restart watchdog must not keep this process alive
    changed: () => {}, log: () => {},
  })
  return { r, u, engine }
}

// D1 and D2 with the real MacUpdater: no call on Squirrel.Mac and no local address; Restart hands over then prepares;
// a blocker appearing at the gate does not quit.
{
  const dir = mkdtempSync(join(tmpdir(), 'wf-engine-real-'))
  try {
    const { r, u, engine } = realRig(dir)
    const constructorListeners = [...r.calls]
    assert.equal(u.nativeUpdater, forwarding, 'the updater talks to the faked Electron autoUpdater')
    r.blockers = ['agent']
    await engine.start(OFFER)
    const nativeCalls = r.calls.slice(constructorListeners.length)
    const server = u.server !== undefined && u.server !== null
    u.quitAndInstall()
    u.handleUpdateDownloaded()
    u.nativeUpdater.emit('update-downloaded')
    let cannotReplace = false
    try { u.quitAndInstall = () => {}; } catch (error) { cannotReplace = error instanceof TypeError }
    try { u.updateDownloaded = async () => []; cannotReplace = false } catch (error) { cannotReplace = cannotReplace && error instanceof TypeError }
    result.held = { phase: engine.state().phase, nativeCalls, server, refusals: r.refusals.length, quitsFromDependency: r.quits.length, cannotReplace }
    assert.deepEqual(r.calls.filter((c) => c === 'setFeedURL' || c === 'checkForUpdates'), [], 'still nothing native')
    r.blockers = []
    engine.restart()
    await untilPrepared(r)
    const native = r.calls.filter((c) => c === 'setFeedURL' || c === 'checkForUpdates')
    const listening = u.server?.listening === true
    r.blockers = ['exporting']
    u.nativeUpdater.ready()
    await settle()
    result.restart = { native, listening, quitsWhileHeld: r.quits.length, phase: engine.state().phase, withdrawn: r.withdrawn }
    u.closeServerIfExists()
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// The click with nothing holding hands over, prepares and installs once through the gate.
{
  const dir = mkdtempSync(join(tmpdir(), 'wf-engine-real2-'))
  try {
    const { r, u, engine } = realRig(dir)
    await engine.start(OFFER)
    await untilPrepared(r)
    const phase = engine.state().phase
    u.nativeUpdater.ready()
    await settle() // the commit closes the windows (one turn), then the gate installs
    result.clickClear = { phase, prepares: r.prepares, quits: r.quits.length, throughGate: r.quits.every((q) => q.blockers.length === 0 && /quitIfPermitted/.test(q.from)) }
    result.userAgent = u.requestHeaders?.['User-Agent'] ?? null
    u.closeServerIfExists()
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

console.log(JSON.stringify(result))
process.exit(0)
