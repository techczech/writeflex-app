import { expect, test } from 'bun:test'
import {
  createZoteroPluginWatcher,
  ZOTERO_PLUGIN_POLL_MS,
  ZOTERO_PLUGIN_REDRAIN_MS,
  type WatcherClock,
} from '../../src/main/zotero-plugin-watcher'

/** A clock whose timers fire only when the test says so, and whose time moves only when told. */
function manualClock(): WatcherClock & { pending: number; fire(): Promise<void>; delays: number[]; advance(ms: number): void } {
  const timers = new Map<number, () => void>()
  const delays: number[] = []
  let next = 1
  let now = 1_000_000
  return {
    advance(ms) { now += ms },
    clearTimeout(handle) { timers.delete(handle as number) },
    delays,
    async fire() {
      const due = [...timers.values()]
      timers.clear()
      now += ZOTERO_PLUGIN_POLL_MS
      for (const callback of due) callback()
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
    },
    now: () => now,
    get pending() { return timers.size },
    setTimeout(callback, milliseconds) {
      const id = next++
      delays.push(milliseconds)
      timers.set(id, callback)
      return id
    },
  }
}

function harness(initial: { waiting: number; reachable: boolean; drainEmpties?: boolean }) {
  const state = { ...initial, drains: 0, looks: 0 }
  const clock = manualClock()
  const watcher = createZoteroPluginWatcher({
    clock,
    drain: async () => {
      state.drains += 1
      if (initial.drainEmpties !== false) state.waiting = 0
    },
    hasPending: () => state.waiting > 0,
    isReachable: async () => {
      state.looks += 1
      return state.reachable
    },
  })
  return { clock, state, watcher }
}

test('with nothing waiting there is no timer and no ping at all', () => {
  const { clock, state, watcher } = harness({ reachable: true, waiting: 0 })
  watcher.poke()
  watcher.poke({ reachable: false })
  expect(clock.pending).toBe(0)
  expect(watcher.polling).toBe(false)
  expect(state.looks).toBe(0)
})

test('while something waits it pings every ten seconds and drains as soon as Zotero answers', async () => {
  const { clock, state, watcher } = harness({ reachable: false, waiting: 2 })
  watcher.poke()
  expect(clock.delays).toEqual([10_000])
  await clock.fire()
  await clock.fire()
  expect(state).toMatchObject({ drains: 0, looks: 2 })
  state.reachable = true
  await clock.fire()
  expect(state).toMatchObject({ drains: 1, looks: 3, waiting: 0 })
  // Drained to empty: polling stops by itself.
  expect(clock.pending).toBe(0)
  expect(watcher.polling).toBe(false)
})

test('Zotero already answering at the first ping is an edge: it drains at once', async () => {
  const { clock, state, watcher } = harness({ reachable: true, waiting: 1 })
  watcher.poke()
  await clock.fire()
  expect(state.drains).toBe(1)
})

test('rows left waiting while Zotero answers are retried at most once a minute, not every ping', async () => {
  const { clock, state, watcher } = harness({ drainEmpties: false, reachable: true, waiting: 1 })
  watcher.poke()
  await clock.fire()
  expect(state.drains).toBe(1)
  const pingsPerMinute = ZOTERO_PLUGIN_REDRAIN_MS / ZOTERO_PLUGIN_POLL_MS
  for (let ping = 1; ping < pingsPerMinute; ping += 1) await clock.fire()
  expect(state.drains).toBe(1)
  await clock.fire()
  expect(state.drains).toBe(2)
  watcher.stop()
})

test('a drain elsewhere that reached Zotero is not repeated by the watcher; one that did not re-arms the edge', async () => {
  const { clock, state, watcher } = harness({ drainEmpties: false, reachable: true, waiting: 1 })
  watcher.poke({ reachable: true })
  await clock.fire()
  expect(state.drains).toBe(0)
  watcher.poke({ reachable: false })
  await clock.fire()
  expect(state.drains).toBe(1)
  watcher.stop()
})

test('Zotero going away and coming back drains again on its return', async () => {
  const { clock, state, watcher } = harness({ drainEmpties: false, reachable: true, waiting: 1 })
  watcher.poke()
  await clock.fire()
  state.reachable = false
  await clock.fire()
  state.reachable = true
  await clock.fire()
  expect(state.drains).toBe(2)
  watcher.stop()
})

test('a ping that throws counts as unreachable, and stop ends the watch', async () => {
  const clock = manualClock()
  let drains = 0
  let throwNext = true
  const watcher = createZoteroPluginWatcher({
    clock,
    drain: async () => { drains += 1 },
    hasPending: () => true,
    isReachable: async () => {
      if (throwNext) {
        throwNext = false
        throw new Error('socket closed')
      }
      return true
    },
  })
  watcher.poke()
  await clock.fire()
  expect(drains).toBe(0)
  await clock.fire()
  expect(drains).toBe(1)
  watcher.stop()
  expect(clock.pending).toBe(0)
  watcher.poke()
  expect(clock.pending).toBe(0)
})
