import { describe, expect, test } from 'bun:test'
import { createWindowSwitch, routeToExistingWindow, whenRendererReady, type WindowSwitchPorts } from '../../src/main/window-switch'

/**
 * Vaults ticket 06 (review 2026-10-16): the switch replaces the window. Fake window operations record
 * every step, so the order (open hidden → close the source → show) and each refusal is pinned, with
 * the per-window and per-root reservations.
 */
type Win = { name: string; root: string | null; gone: boolean }
type Place = { x: number }

type Over = {
  windows?: Win[]
  open?: 'busy' | 'fails' | (() => Promise<void>)
  /** Opening finds this window (it opened on the root meanwhile) instead of making one. */
  existing?: Win
  /** Runs on the new window as soon as it exists. */
  afterOpen?: (win: Win) => void
  close?: boolean | (() => Promise<boolean>)
  /** The source closes on its own while the folder opens. */
  sourceClosesDuringOpen?: boolean
  /** The new window's page: ready (default), never ready, or decided by hand. */
  ready?: boolean | (() => Promise<boolean>)
  /** Calling the close off: true (the source stays) unless the close is already past recall. */
  abandon?: boolean
  /** The switch's bound on the source's close. */
  closeTimeoutMs?: number
  /** A step that throws. */
  throws?: 'requestClose' | 'show' | 'whenReady' | 'discard'
}

function harness(over: Over = {}) {
  const steps: string[] = []
  const source: Win = { name: 'source', root: '/a', gone: false }
  const windows: Win[] = [source, ...(over.windows ?? [])]
  let made = 0
  const ports: WindowSwitchPorts<Win, Place> = {
    rootOf: (win) => win.root,
    canonical: (root) => root.replace(/\/+$/, ''),
    ownerWindow: (root, except) => windows.find((win) => win !== except && !win.gone && win.root === root),
    focus: (win) => { steps.push(`focus ${win.name}`) },
    placement: (win) => { steps.push(`placement ${win.name}`); return { x: 7 } },
    openHidden: async (root, placement, focusFile) => {
      steps.push(`open ${root} at ${placement.x}${focusFile ? ` file ${focusFile}` : ''}`)
      if (typeof over.open === 'function') await over.open()
      if (over.sourceClosesDuringOpen) source.gone = true
      if (over.open === 'busy') return { kind: 'busy' }
      if (over.open === 'fails') throw new Error('bind failed')
      if (over.existing) return { kind: 'existing', window: over.existing }
      const win: Win = { name: `new${++made}`, root, gone: false }
      windows.push(win)
      over.afterOpen?.(win)
      return { kind: 'opened', window: win }
    },
    whenReady: async (win) => {
      steps.push(`ready? ${win.name}`)
      if (over.throws === 'whenReady') throw new Error('ready probe failed')
      return typeof over.ready === 'function' ? over.ready() : over.ready ?? true
    },
    requestClose: (win) => {
      steps.push(`close ${win.name}`)
      if (over.throws === 'requestClose') throw new Error('close request failed')
      let abandoned = false
      const closed = (async () => {
        const outcome = typeof over.close === 'function' ? await over.close() : over.close ?? true
        // A close called off never closes the window later, whatever its flush did.
        if (outcome && !abandoned) win.gone = true
        return outcome && !abandoned
      })()
      return {
        closed,
        abandon: () => {
          steps.push(`abandon ${win.name}`)
          if (over.abandon === false) return false
          abandoned = true
          return true
        },
      }
    },
    isGone: (win) => win.gone,
    show: (win, placement) => {
      steps.push(`show ${win.name} at ${placement.x}`)
      if (over.throws === 'show') throw new Error('show failed')
    },
    discard: async (win) => {
      steps.push(`discard ${win.name}`)
      win.gone = true
      if (over.throws === 'discard') throw new Error('discard failed')
    },
  }
  return { ports, steps, source, windows, machine: createWindowSwitch(ports, { closeTimeoutMs: over.closeTimeoutMs ?? 1000 }) }
}

/** A promise the test settles by hand. */
function gate<T = void>() {
  let open!: (value: T) => void
  const promise = new Promise<T>((resolve) => { open = resolve })
  return { promise, open }
}

describe('a clean switch', () => {
  test('opens the root hidden at the source\'s place, closes the source by its close, then shows the new window', async () => {
    const { machine, steps, source } = harness()
    const outcome = await machine.switchWindow(source, '/b/')
    expect(outcome).toMatchObject({ status: 'switched', root: '/b' })
    expect(steps).toEqual(['placement source', 'open /b at 7', 'ready? new1', 'close source', 'show new1 at 7'])
  })

  test('a file the dialog picked rides to the new window', async () => {
    const { machine, steps, source } = harness()
    await machine.switchWindow(source, '/b', 'chapter.md')
    expect(steps[1]).toBe('open /b at 7 file chapter.md')
  })

  test('a source that closed on its own while the folder opened is not asked again; the new window shows', async () => {
    const { machine, steps, source } = harness({ sourceClosesDuringOpen: true })
    expect((await machine.switchWindow(source, '/b')).status).toBe('switched')
    expect(steps).toEqual(['placement source', 'open /b at 7', 'ready? new1', 'show new1 at 7'])
  })
})

describe('refusals', () => {
  test('the window\'s own root: nothing happens', async () => {
    const { machine, steps, source } = harness()
    expect(await machine.switchWindow(source, '/a/')).toEqual({ status: 'unchanged' })
    expect(steps).toEqual([])
  })

  test('a root another window shows: that window is focused, nothing opens or closes', async () => {
    const other: Win = { name: 'other', root: '/b', gone: false }
    const { machine, steps, source } = harness({ windows: [other] })
    expect(await machine.switchWindow(source, '/b')).toEqual({ status: 'focused', root: '/b' })
    expect(steps).toEqual(['focus other'])
  })

  test('opening found a window already on the root (it opened meanwhile): focused, nothing closes', async () => {
    const late: Win = { name: 'late', root: '/c', gone: false }
    const { machine, steps, source } = harness({ existing: late })
    expect(await machine.switchWindow(source, '/c')).toEqual({ status: 'focused', root: '/c' })
    expect(steps).toEqual(['placement source', 'open /c at 7', 'focus late'])
  })

  test('a folder another program holds (busy): nothing closes', async () => {
    const { machine, steps, source } = harness({ open: 'busy' })
    expect(await machine.switchWindow(source, '/b')).toEqual({ status: 'busy' })
    expect(steps).toEqual(['placement source', 'open /b at 7'])
  })

  test('opening fails: the error reaches the caller and nothing closes', async () => {
    const { machine, steps, source } = harness({ open: 'fails' })
    await expect(machine.switchWindow(source, '/b')).rejects.toThrow('bind failed')
    expect(steps).not.toContain('close source')
    expect(source.gone).toBe(false)
  })

  test('the source\'s close is refused (a write failed): the new window is discarded and the source stays', async () => {
    const { machine, steps, source } = harness({ close: false })
    expect(await machine.switchWindow(source, '/b')).toEqual({ status: 'stayed' })
    expect(steps).toEqual(['placement source', 'open /b at 7', 'ready? new1', 'close source', 'discard new1'])
    expect(source.gone).toBe(false)
  })

  test('after a refusal the window can switch again', async () => {
    let refuse = true
    const { machine, source } = harness({ close: async () => !refuse })
    expect((await machine.switchWindow(source, '/b')).status).toBe('stayed')
    refuse = false
    expect((await machine.switchWindow(source, '/b')).status).toBe('switched')
  })

  test('a new window that died before it could be shown: the source is not closed', async () => {
    const { machine, steps, source } = harness({ afterOpen: (win) => { win.gone = true } })
    await expect(machine.switchWindow(source, '/b')).rejects.toThrow('closed before it could be shown')
    expect(steps).not.toContain('close source')
    expect(source.gone).toBe(false)
    // The reservations are let go: the window can switch again.
    expect(await machine.switchWindow(source, '/a')).toEqual({ status: 'unchanged' })
  })
})

describe('reservations', () => {
  test('a second switch from the same window while one is in flight is refused, and does nothing', async () => {
    const opening = gate()
    const { machine, steps, source } = harness({ open: () => opening.promise })
    const first = machine.switchWindow(source, '/b')
    expect(await machine.switchWindow(source, '/c')).toEqual({ status: 'switching' })
    opening.open()
    expect((await first).status).toBe('switched')
    expect(steps.filter((step) => step.startsWith('open'))).toEqual(['open /b at 7'])
  })

  test('the refusal holds while the source\'s close is under way, and lifts once the switch ends', async () => {
    const closing = gate<boolean>()
    const { machine, source } = harness({ close: () => closing.promise })
    const first = machine.switchWindow(source, '/b')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await machine.switchWindow(source, '/c')).toEqual({ status: 'switching' })
    closing.open(false)
    expect((await first).status).toBe('stayed')
    expect(machine.isPending(source)).toBe(false)
  })

  test('two windows switching into one root: the second is refused while the first holds it (no second window on the root)', async () => {
    const opening = gate()
    const other: Win = { name: 'other', root: '/x', gone: false }
    const { machine, steps, source } = harness({ windows: [other], open: () => opening.promise })
    const first = machine.switchWindow(source, '/b')
    expect(await machine.switchWindow(other, '/b/')).toEqual({ status: 'switching' })
    opening.open()
    expect((await first).status).toBe('switched')
    expect(steps.filter((step) => step.startsWith('open'))).toEqual(['open /b at 7'])
    // Once shown, the root's window is an ordinary owner: the other window's switch focuses it.
    expect(await machine.switchWindow(other, '/b')).toEqual({ status: 'focused', root: '/b' })
  })

  test('the hidden window is pending until shown or discarded, and is never focused by another switch', async () => {
    const closing = gate<boolean>()
    const other: Win = { name: 'other', root: '/x', gone: false }
    const { machine, source, windows } = harness({ windows: [other], close: () => closing.promise })
    const first = machine.switchWindow(source, '/b')
    await new Promise((resolve) => setTimeout(resolve, 0))
    const hidden = windows.find((win) => win.name === 'new1')!
    expect(machine.isPending(hidden)).toBe(true)
    closing.open(true)
    await first
    expect(machine.isPending(hidden)).toBe(false)
  })

  test('different windows may switch to different roots at once', async () => {
    const other: Win = { name: 'other', root: '/x', gone: false }
    const { machine, source } = harness({ windows: [other] })
    const [a, b] = await Promise.all([machine.switchWindow(source, '/b'), machine.switchWindow(other, '/c')])
    expect(a.status).toBe('switched')
    expect(b.status).toBe('switched')
  })
})

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

describe('round 2: the source\'s close reaches a terminal answer before the switch decides', () => {
  test('a slow close that succeeds (well past the old 5 s refusal, here scaled down) still switches', async () => {
    // The bound is 200 ms; the close takes 80 ms. Under round 1 a fixed short wait counted this as refused.
    const { machine, steps, source } = harness({ closeTimeoutMs: 200, close: async () => { await tick(80); return true } })
    expect((await machine.switchWindow(source, '/b')).status).toBe('switched')
    expect(steps).toEqual(['placement source', 'open /b at 7', 'ready? new1', 'close source', 'show new1 at 7'])
    expect(source.gone).toBe(true)
  })

  test('a close the source keeps open (a write failed) keeps the source and discards the target', async () => {
    const { machine, steps, source, windows } = harness({ close: async () => { await tick(20); return false } })
    expect(await machine.switchWindow(source, '/b')).toEqual({ status: 'stayed' })
    expect(steps).toEqual(['placement source', 'open /b at 7', 'ready? new1', 'close source', 'discard new1'])
    expect(source.gone).toBe(false)
    expect(windows.find((win) => win.name === 'new1')!.gone).toBe(true)
  })

  test('a close still undecided at the bound is called off: the source stays even when its flush later succeeds', async () => {
    const flush = gate<boolean>()
    const { machine, steps, source } = harness({ closeTimeoutMs: 30, close: () => flush.promise })
    expect(await machine.switchWindow(source, '/b')).toEqual({ status: 'stayed', reason: 'close-timed-out' })
    expect(steps).toEqual(['placement source', 'open /b at 7', 'ready? new1', 'close source', 'abandon source', 'discard new1'])
    // The abandoned flush finishes well: the window does not close by it.
    flush.open(true)
    await tick(5)
    expect(source.gone).toBe(false)
  })

  test('a close past recall at the bound is awaited, and the switch completes', async () => {
    const flush = gate<boolean>()
    const { machine, steps, source } = harness({ closeTimeoutMs: 20, abandon: false, close: () => flush.promise })
    const outcome = machine.switchWindow(source, '/b')
    await tick(40)
    expect(steps.at(-1)).toBe('abandon source')
    flush.open(true)
    expect((await outcome).status).toBe('switched')
    expect(steps.at(-1)).toBe('show new1 at 7')
  })
})

describe('round 2: the new window is shown only once its page is ready', () => {
  test('waits for the page before asking the source to close', async () => {
    const page = gate<boolean>()
    const { machine, steps, source } = harness({ ready: () => page.promise })
    const outcome = machine.switchWindow(source, '/b')
    await tick()
    expect(steps).not.toContain('close source')
    page.open(true)
    expect((await outcome).status).toBe('switched')
  })

  test('a page that fails or is not ready in time: the target is discarded, the source is never asked to close', async () => {
    const { machine, steps, source } = harness({ ready: false })
    await expect(machine.switchWindow(source, '/b')).rejects.toThrow('did not finish loading')
    expect(steps).toEqual(['placement source', 'open /b at 7', 'ready? new1', 'discard new1'])
    expect(source.gone).toBe(false)
    expect(await machine.switchWindow(source, '/a')).toEqual({ status: 'unchanged' })
  })
})

describe('round 2: every exceptional exit discards the uncommitted target and lets the reservations go', () => {
  for (const step of ['whenReady', 'requestClose', 'show'] as const) {
    test(`a throw in ${step}`, async () => {
      const { machine, steps, source, windows } = harness({ throws: step })
      await expect(machine.switchWindow(source, '/b')).rejects.toThrow()
      expect(steps.at(-1)).toBe('discard new1')
      const target = windows.find((win) => win.name === 'new1')!
      expect(target.gone).toBe(true)
      expect(machine.isPending(target)).toBe(false)
      // Both reservations are released: the same window may switch into the same root again.
      const again = harness()
      expect((await again.machine.switchWindow(again.source, '/b')).status).toBe('switched')
      expect(await machine.switchWindow(source, '/a')).toEqual({ status: 'unchanged' })
    })
  }

  test('a throw while opening (no target exists) leaves nothing pending and the root free', async () => {
    const { machine, steps, source } = harness({ open: 'fails' })
    await expect(machine.switchWindow(source, '/b')).rejects.toThrow('bind failed')
    expect(steps.some((step) => step.startsWith('discard'))).toBe(false) // opening cleans up its own window
    // Let in again (not 'switching'): it reaches the open, which fails again.
    await expect(machine.switchWindow(source, '/b')).rejects.toThrow('bind failed')
  })

  test('a discard that itself throws does not hide the outcome or keep the reservations', async () => {
    const { machine, source } = harness({ close: false, throws: 'discard' })
    expect(await machine.switchWindow(source, '/b')).toEqual({ status: 'stayed' })
    expect(await machine.switchWindow(source, '/a')).toEqual({ status: 'unchanged' })
  })
})

describe('round 2: ordinary opens and a pending hidden target', () => {
  test('a pending target routes to its source, never to itself; any other window is focused', async () => {
    const closing = gate<boolean>()
    const { machine, source, windows } = harness({ close: () => closing.promise })
    const first = machine.switchWindow(source, '/b')
    await tick()
    const hidden = windows.find((win) => win.name === 'new1')!
    expect(machine.sourceOf(hidden)).toBe(source)
    expect(routeToExistingWindow(hidden, machine)).toEqual({ kind: 'switching', source })
    expect(routeToExistingWindow(source, machine)).toEqual({ kind: 'focus', window: source })
    closing.open(true)
    await first
    expect(routeToExistingWindow(hidden, machine)).toEqual({ kind: 'focus', window: hidden })
  })
})

describe('round 2: renderer readiness', () => {
  function readiness(timeoutMs = 50) {
    let ready = false
    let report: (() => void) | null = null
    let fail: (() => void) | null = null
    const offs: string[] = []
    const promise = whenRendererReady({
      isReady: () => ready,
      onReport: (listener) => { report = listener; return () => { offs.push('report') } },
      onFailure: (listener) => { fail = listener; return () => { offs.push('failure') } },
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      timeoutMs,
    })
    return { promise, offs, becomeReady: () => { ready = true; report?.() }, reportNotReady: () => report?.(), fail: () => fail?.() }
  }

  test('ready once the page reports the bound root; a report of something else keeps waiting', async () => {
    const probe = readiness()
    probe.reportNotReady()
    probe.becomeReady()
    expect(await probe.promise).toBe(true)
    expect(probe.offs.sort()).toEqual(['failure', 'report'])
  })

  test('a failed load or a gone renderer is not ready', async () => {
    const probe = readiness()
    probe.fail()
    expect(await probe.promise).toBe(false)
  })

  test('no report within the time is not ready', async () => {
    const probe = readiness(15)
    expect(await probe.promise).toBe(false)
  })
})
