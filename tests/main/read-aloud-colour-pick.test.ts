import { expect, test } from 'bun:test'
import { SettingsStore } from '../../src/main/settings'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createColourPick } from '../../src/renderer/src/editor/read-aloud-colour-pick'

function harness(initial: string) {
  let stored = initial
  const calls: Array<{ value: string; log: boolean }> = []
  let timer: (() => void) | null = null
  const pick = createColourPick({
    read: () => stored,
    apply: (value, log) => { stored = value; calls.push({ value, log }) },
    setTimer: (callback) => { timer = callback; return 1 },
    clearTimer: () => { timer = null },
  })
  return { pick, calls, fire: () => timer?.(), stored: () => stored, pending: () => timer !== null }
}

test('drag ticks apply live without a log; the commit writes one logged entry from the pre-pick colour', () => {
  const h = harness('terracotta')
  for (const colour of ['#101010', '#202020', '#303030']) h.pick.tick(colour)
  expect(h.calls.every((call) => !call.log)).toBe(true)
  expect(h.stored()).toBe('#303030') // live
  h.pick.commit()
  expect(h.calls.filter((call) => call.log)).toEqual([{ value: '#303030', log: true }])
  expect(h.calls.at(-2)).toEqual({ value: 'terracotta', log: false }) // the colour before the pick is restored first
  expect(h.stored()).toBe('#303030')
})

test('without a change event the commit fires after the colour stops changing', () => {
  const h = harness('blue')
  h.pick.tick('#111111')
  h.pick.tick('#222222')
  expect(h.pending()).toBe(true)
  h.fire()
  expect(h.calls.filter((call) => call.log)).toEqual([{ value: '#222222', log: true }])
  expect(h.pending()).toBe(false)
})

test('a commit with nothing picked, or the same colour picked back, writes nothing', () => {
  const h = harness('blue')
  h.pick.commit()
  expect(h.calls).toEqual([])
  h.pick.tick('#abcdef')
  h.pick.tick('blue')
  h.pick.commit()
  expect(h.calls.some((call) => call.log)).toBe(false)
})

test('a second pick after a commit starts from the new stored colour', () => {
  const h = harness('terracotta')
  h.pick.tick('#111111')
  h.pick.commit()
  h.pick.tick('#222222')
  h.pick.commit()
  expect(h.calls.filter((call) => call.log).map((call) => call.value)).toEqual(['#111111', '#222222'])
  expect(h.calls.filter((call) => !call.log && call.value === '#111111').length).toBeGreaterThan(0)
})

test('against the real settings store: dozens of ticks leave exactly one changelog row, old = pre-pick colour', async () => {
  const store = new SettingsStore(join(await mkdtemp(join(tmpdir(), 'wf-ra-pick-')), 'settings.json'))
  store.set('readAloud.colour', 'blue', 'Read-aloud highlight', { log: false })
  const pick = createColourPick({
    read: () => String(store.get('readAloud.colour')),
    apply: (value, log) => store.set('readAloud.colour', value, 'Read-aloud highlight', { log }),
    setTimer: () => 1,
    clearTimer: () => {},
  })
  for (let tick = 0; tick < 40; tick++) pick.tick(`#${(tick * 6).toString(16).padStart(2, '0')}3050`)
  expect(store.changelog()).toEqual([])
  pick.commit()
  const log = store.changelog()
  expect(log).toHaveLength(1)
  expect(log[0]).toMatchObject({ key: 'readAloud.colour', old: 'blue', new: '#ea3050' })
})
