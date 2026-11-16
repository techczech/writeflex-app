// Review round 3 (PR 247): an update restart's recovery yields to a quit the person asked for (ADR-0054 item 7).
import { describe, expect, test } from 'bun:test'
import { createRestartClose, type RecallableClose } from '../../src/main/restart-windows'

function harness() {
  let quitting = false
  let windows = 1
  let opened = 0
  let resumed = 0
  let finishStop: (ok: boolean) => void = () => {}
  let finishClose: (closed: boolean) => void = () => {}
  const close: RecallableClose = {
    closed: new Promise<boolean>((resolve) => { finishClose = (closed) => { if (closed) windows = 0; resolve(closed) } }),
    abandon: () => false, // already past recall
  }
  const restart = createRestartClose({
    closeEach: () => [close],
    finishWork: async () => {},
    backup: () => ({ stop: () => new Promise<boolean>((resolve) => { finishStop = resolve }), resume: () => { resumed++ } }),
    windowCount: () => windows,
    openWindow: () => { opened++; windows++ },
    quitting: () => quitting,
  })
  return {
    restart,
    quit: () => { quitting = true },
    closeWindow: () => finishClose(true),
    quitClosesWindows: () => { windows = 0 },
    finishStop: (ok = true) => finishStop(ok),
    counts: () => ({ opened, resumed, windows }),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('update restart recovery yields to a quit', () => {
  test('quit during the backup stop: the deferred recovery starts no backup and opens no window', async () => {
    const h = harness()
    let live = true
    const done = h.restart.close({ live: () => live, onCallOff: () => {} })
    h.closeWindow()
    await tick(); await tick()
    // The helper is stopping; the watchdog ends the attempt and the engine recovers (deferred behind the stop).
    live = false
    h.restart.recover()
    // At once: a window again; the backup start waits for the stop.
    expect(h.counts()).toEqual({ opened: 1, resumed: 0, windows: 1 })
    // The person presses Cmd-Q: that window closes; then the stop settles.
    h.quit()
    h.quitClosesWindows()
    h.finishStop(true)
    await done
    h.restart.recover() // the engine's second recovery once close() has settled
    expect(h.counts()).toEqual({ opened: 1, resumed: 0, windows: 0 })
  })

  test('quit before a late close past recall: no window is opened afterwards', async () => {
    const h = harness()
    let live = true
    const done = h.restart.close({ live: () => live, onCallOff: () => {} })
    live = false
    h.quit()
    h.closeWindow()
    await done
    h.restart.recover()
    expect(h.counts().opened).toBe(0)
    expect(h.counts().resumed).toBe(0)
  })

  test('without a quit, the same late close recovers: a window, and no backup start (never stopped)', async () => {
    const h = harness()
    let live = true
    const done = h.restart.close({ live: () => live, onCallOff: () => {} })
    live = false
    h.closeWindow()
    await done
    h.restart.recover()
    expect(h.counts()).toEqual({ opened: 1, resumed: 0, windows: 1 })
  })
})

describe('a quit called off after recovery was held back', () => {
  test('the stop settled during a guarded quit; the quit is called off: backup starts again', async () => {
    let quitting = false
    let resumed = 0
    let finishStop: (ok: boolean) => void = () => {}
    let finishClose: (closed: boolean) => void = () => {}
    let windows = 1
    const restart = createRestartClose({
      closeEach: () => [{ closed: new Promise<boolean>((resolve) => { finishClose = (c) => { windows = 0; resolve(c) } }), abandon: () => false }],
      finishWork: async () => {},
      backup: () => ({ stop: () => new Promise<boolean>((resolve) => { finishStop = resolve }), resume: () => { resumed++ } }),
      windowCount: () => windows,
      openWindow: () => { windows++ },
      quitting: () => quitting,
    })
    let live = true
    const done = restart.close({ live: () => live, onCallOff: () => {} })
    finishClose(true)
    await tick(); await tick()
    live = false
    restart.recover() // a window again; the backup start waits for the stop
    quitting = true // Cmd-Q, held by a close guard awaiting a save
    finishStop(true)
    await done
    restart.recover()
    expect(resumed).toBe(0)
    quitting = false // the save failed: the quit is called off
    restart.quitCancelled()
    expect(resumed).toBe(1)
    restart.quitCancelled() // idempotent
    expect(resumed).toBe(1)
  })

  test('a backup start stopped by the quit fence is started again when the quit is called off', () => {
    let quitting = true
    let resumed = 0
    const restart = createRestartClose({
      closeEach: () => [],
      finishWork: async () => {},
      backup: () => ({ stop: async () => true, resume: () => { resumed++ } }),
      windowCount: () => 1,
      openWindow: () => {},
      quitting: () => quitting,
    })
    restart.backupStoppedForQuit()
    quitting = false
    restart.quitCancelled()
    expect(resumed).toBe(1)
  })
})
