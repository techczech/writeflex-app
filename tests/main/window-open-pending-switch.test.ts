import { expect, test } from 'bun:test'

/**
 * Vaults 06 review round 2, at the WindowManager seam (src/main/windows.ts `openFolder`), in a child
 * process with Electron and the bind faked:
 * - an ordinary open (Open Recent, the menu, the start screen, a writeflex:// link) that finds a hidden
 *   window a switch has opened neither returns nor focuses it: the switch's source window is brought
 *   forward and told "Switching to <name>…" (the pending set is injected);
 * - a bind that fails, or bookkeeping after the bind that throws, destroys the window the open made
 *   and lets the folder's claim go.
 */
const probe = String.raw`
  import { mock } from 'bun:test'
  import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'

  const home = await realpath(await mkdtemp(join(tmpdir(), 'writeflex-open-pending-')))
  void mock.module('electron', () => ({
    app: { getPath: () => home, getVersion: () => '0.0.0-test', isPackaged: false, quit: () => {} },
    BrowserWindow: class {},
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, removeHandler: () => {}, on: () => {} },
  }))
  let bindBehaviour = 'ok'
  void mock.module('./src/main/ipc.ts', () => ({
    bindWorkspace: async (state, root) => {
      if (bindBehaviour === 'throws') throw new Error('bind failed')
      state.workspace = { root }
    },
    flushPendingFocus: () => {},
  }))
  const [{ WindowManager }, { registerWindow }] = await Promise.all([
    import('./src/main/windows.ts'),
    import('./src/main/state.ts'),
  ])

  let nextId = 100
  const log = []
  function fakeWindow(name) {
    const listeners = new Map()
    const window = {
      name,
      destroyed: false,
      webContents: { id: nextId++, send: (channel, payload) => log.push(name + ' send ' + channel + ' ' + payload), isDestroyed: () => window.destroyed },
      on: (event, fn) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]) },
      once: (event, fn) => { listeners.set(event, [...(listeners.get(event) ?? []), fn]) },
      removeListener: () => {},
      isDestroyed: () => window.destroyed,
      focus: () => log.push('focus ' + name),
      destroy: () => { window.destroyed = true; log.push('destroy ' + name); for (const fn of listeners.get('closed') ?? []) fn() },
    }
    return window
  }

  const recents = []
  const settings = { get: () => null, recents: () => recents, pinned: () => [], touchRecent: (root) => { if (settingsThrows) throw new Error('recents failed'); recents.push(root) } }
  let settingsThrows = false
  const pending = new Map()
  class TestManager extends WindowManager {
    createWindow() {
      const state = registerWindow(fakeWindow('created'))
      log.push('create')
      return state
    }
    switchReservations() {
      return { isPending: (state) => pending.has(state), sourceOf: (state) => pending.get(state) }
    }
  }
  const manager = new TestManager(settings, undefined, { stepDone: () => {} })

  // A switch from window A into /…/Notes has opened a hidden target there.
  const notes = join(home, 'Notes')
  await mkdir(notes, { recursive: true })
  const source = registerWindow(fakeWindow('source'))
  source.workspace = { root: join(home, 'A') }
  const hidden = registerWindow(fakeWindow('hidden'))
  hidden.workspace = { root: notes }
  pending.set(hidden, source)

  const pendingResult = await manager.openFolder(null, notes)
  const pendingLog = log.splice(0)
  const pendingRecorded = recents.length

  // Once shown (no longer pending), the same open focuses that window, as for any open root.
  pending.delete(hidden)
  const shownResult = await manager.openFolder(null, notes)
  const shownLog = log.splice(0)

  // A bind that fails: the window the open made is destroyed and the claim let go (a second open can claim it).
  const other = join(home, 'Other')
  await mkdir(other, { recursive: true })
  bindBehaviour = 'throws'
  let bindError = ''
  try { await manager.openFolder(null, other) } catch (error) { bindError = String(error) }
  const bindLog = log.splice(0)
  const claimFreeAfterBind = await manager.ownership.claim(other).then(() => true, () => false)
  await manager.ownership.release(other)

  // Bookkeeping after a good bind throws: the same.
  const third = join(home, 'Third')
  await mkdir(third, { recursive: true })
  bindBehaviour = 'ok'
  settingsThrows = true
  let afterBindError = ''
  try { await manager.openFolder(null, third) } catch (error) { afterBindError = String(error) }
  const afterBindLog = log.splice(0)
  settingsThrows = false
  const claimFreeAfterBookkeeping = await manager.ownership.claim(third).then(() => true, () => false)
  await manager.ownership.release(third)

  // Round 3 (T1): a start-screen window reused, bookkeeping after the bind throws. The window stays bound
  // and is returned with a notice; the folder stays claimed while it is bound.
  const fourth = join(home, 'Fourth')
  await mkdir(fourth, { recursive: true })
  const start = registerWindow(fakeWindow('start'))
  settingsThrows = true
  let reusedError = ''
  let reusedResult = null
  try { reusedResult = await manager.openFolder(start, fourth) } catch (error) { reusedError = String(error) }
  settingsThrows = false
  const reusedLog = log.splice(0)
  const reusedBound = start.workspace?.root === fourth
  const reusedClaimHeld = manager.ownership.owns(fourth)

  // A reused start-screen window whose bind throws before it binds: nothing bound, the claim let go,
  // the window kept (it is the start screen still).
  const fifth = join(home, 'Fifth')
  await mkdir(fifth, { recursive: true })
  const start2 = registerWindow(fakeWindow('start2'))
  bindBehaviour = 'throws'
  let unboundError = ''
  try { await manager.openFolder(start2, fifth) } catch (error) { unboundError = String(error) }
  bindBehaviour = 'ok'
  const unboundLog = log.splice(0)
  const unboundClaimHeld = manager.ownership.owns(fifth)
  const unboundWorkspace = start2.workspace ?? null

  console.log(JSON.stringify({
    reusedError, reusedIsStart: reusedResult === start, reusedLog, reusedBound, reusedClaimHeld,
    unboundError, unboundLog, unboundClaimHeld, unboundWorkspace,
    pendingResult: pendingResult === null ? null : 'a window',
    pendingLog, pendingRecorded,
    shownIsHidden: shownResult === hidden, shownLog,
    bindError, bindLog, claimFreeAfterBind,
    afterBindError, afterBindLog, claimFreeAfterBookkeeping,
  }))
  await rm(home, { recursive: true, force: true })
  process.exit(0)
`

async function runProbe(): Promise<Record<string, unknown>> {
  const child = Bun.spawn([process.execPath, '-e', probe], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`The open-folder probe failed: ${stderr}`)
  return JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, unknown>
}

test('ordinary opens treat a pending hidden target as busy; a failed open cleans up its own window and claim', async () => {
  const result = await runProbe()
  // Pending: nothing returned, the hidden window untouched, the source focused and told.
  expect(result.pendingResult).toBeNull()
  expect(result.pendingLog).toEqual(['focus source', 'source send window:status Switching to Notes…'])
  expect(result.pendingRecorded).toBe(0)
  // Shown: an ordinary existing window, focused.
  expect(result.shownIsHidden).toBe(true)
  expect(result.shownLog).toEqual(['focus hidden'])
  // Bind failure: the created window destroyed, the claim free again.
  expect(result.bindError).toContain('bind failed')
  expect(result.bindLog).toEqual(['create', 'destroy created'])
  expect(result.claimFreeAfterBind).toBe(true)
  // Post-bind bookkeeping failure: the same.
  expect(result.afterBindError).toContain('recents failed')
  expect(result.afterBindLog).toEqual(['create', 'destroy created'])
  expect(result.claimFreeAfterBookkeeping).toBe(true)
}, 20_000)

test('round 3 (T1): a reused start-screen window that bound keeps the claim when bookkeeping fails; one that did not bind lets it go', async () => {
  const result = await runProbe()
  // Bound and failed afterwards: no throw, the window returned, still bound, the folder still ours, and told.
  expect(result.reusedError).toBe('')
  expect(result.reusedIsStart).toBe(true)
  expect(result.reusedBound).toBe(true)
  expect(result.reusedClaimHeld).toBe(true)
  expect(result.reusedLog).toEqual(['start send window:status Fourth is open, but part of opening it failed: recents failed'])
  // Never bound: the error stands, the claim goes, the start-screen window stays (not destroyed).
  expect(result.unboundError).toContain('bind failed')
  expect(result.unboundClaimHeld).toBe(false)
  expect(result.unboundWorkspace).toBeNull()
  expect(result.unboundLog).toEqual([])
}, 20_000)
