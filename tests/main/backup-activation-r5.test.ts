// Backup activation r5 (review-writeflex-backup-history-activation-repair-r4, R1-C2): restart authority.
// Every enable records its attempt durably (activation-attempts.ts) before the engine switch or the
// registration can change, and removes the record only when the attempt was accepted or completely undone.
// A crash at any step, or a disk that keeps failing while the attempt is undone, leaves the record: the next
// start takes the attempt's own entry out and never serves the folder as accepted; other folders are served.
// Real enrolment, real registration/attempt/configuration files, the real durable writer and its fs seams;
// supervisor, helper one-shot answers and service pairs are FAKES (backup-activation-fixture.ts). A "crash"
// is a durable-write step that never returns; the old instance is then abandoned and a new one started.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { durableSeams } from '../../src/main/backup-helper/durable-file'
import type { BackupEnrolment } from '../../src/main/backup-helper/enrolment'
import { fixture } from './backup-activation-fixture'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  delete durableSeams.beforeRename
  delete durableSeams.beforeDirSync
  while (cleanups.length) await cleanups.pop()!()
})

type F = Awaited<ReturnType<typeof fixture>>
const regsFile = (f: F) => join(f.dir, 'registrations.json')
const attemptsFile = (f: F) => join(f.dir, 'activation-attempts.json')
const roots = async (f: F) => (JSON.parse(await readFile(regsFile(f), 'utf8')).vaults as Array<{ root: string }>).map((v) => v.root)
const records = async (f: F) => (JSON.parse(await readFile(attemptsFile(f), 'utf8')).attempts as Array<{ root: string; prior: unknown }>)
const never = () => new Promise<void>(() => {})
const settle = () => new Promise((r) => setTimeout(r, 20))
async function turnOnWith(f: F, e: BackupEnrolment, folder: string) {
  f.setWindow(folder)
  const p = await e.preview(1)
  if (p.state !== 'ready') throw new Error('not ready')
  return e.enable(1, { previewId: p.previewId, confirmPublic: false })
}
/** Starts an enable of a that "crashes" (never returns) at the first durable step `at` matches. */
async function crashingEnable(f: F, at: (target: string, step: 'rename' | 'dirsync', n: number) => boolean) {
  f.setWindow(f.a)
  const p = await f.e.preview(1)
  if (p.state !== 'ready') throw new Error('not ready')
  const counts = new Map<string, number>()
  let crashed = false
  const hit = (target: string, step: 'rename' | 'dirsync') => {
    const key = `${step}:${target}`
    const n = (counts.get(key) ?? 0) + 1
    counts.set(key, n)
    if (crashed || !at(target, step, n)) return
    crashed = true
    return never()
  }
  let lastRenamed = ''
  durableSeams.beforeRename = (target) => { lastRenamed = target; return hit(target, 'rename') }
  durableSeams.beforeDirSync = () => hit(lastRenamed, 'dirsync')
  void f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
  for (let i = 0; i < 100 && !crashed; i++) await settle()
  expect(crashed).toBe(true)
  delete durableSeams.beforeRename
  delete durableSeams.beforeDirSync
}

describe('R1-C2 a crash at any step of an enable is never accepted after a restart', () => {
  test('crash while recording the attempt (before the engine switch): nothing enabled, registered or started', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    f.log.length = 0
    await crashingEnable(f, (t, step) => t.endsWith('activation-attempts.json') && step === 'rename')
    expect(f.log).toEqual(['preview:/a', 'preview:/a'])
    const e2 = f.restart()
    await e2.startup()
    expect(await roots(f)).toEqual([f.b])
    expect(f.started.at(-1)).toEqual([f.b])
  })

  test('crash after the engine enable, before the registration rename: a not served, b served', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    f.log.length = 0
    await crashingEnable(f, (t, step) => t.endsWith('registrations.json') && step === 'rename')
    expect(f.log).toContain('enable:/a')
    const e2 = f.restart()
    await e2.startup()
    expect(await roots(f)).toEqual([f.b])
    expect(f.started.at(-1)).toEqual([f.b])
    expect((await records(f)).map((r) => r.root)).toEqual([f.a])
    f.setWindow(f.a)
    expect((await e2.status(1)).state).toBe('off')
  })

  test('crash after the registration rename (its folder sync): the next start takes a out first and serves only b', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    f.log.length = 0
    await crashingEnable(f, (t, step) => t.endsWith('registrations.json') && step === 'dirsync')
    expect(await roots(f)).toEqual([f.b, f.a])
    const e2 = f.restart()
    await e2.startup()
    expect(await roots(f)).toEqual([f.b])
    expect(f.started.at(-1)).toEqual([f.b])
    // No helper command runs at start: the switch is not touched there.
    expect(f.log.filter((l) => l.startsWith('disable'))).toEqual([])
  })

  test('crash after a fully served enable, before its record was removed: the next start does not accept it', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    await crashingEnable(f, (t, step, n) => t.endsWith('activation-attempts.json') && step === 'rename' && n === 2)
    // The old session served a; its acceptance was never recorded.
    expect(f.started.at(-1)).toEqual([f.b, f.a])
    const e2 = f.restart()
    await e2.startup()
    expect(f.started.at(-1)).toEqual([f.b])
    expect(await roots(f)).toEqual([f.b])
    // A later Turn on is accepted and clears every record of the folder.
    expect((await turnOnWith(f, e2, f.a)).ok).toBe(true)
    expect(f.started.at(-1)).toEqual([f.b, f.a])
    expect(await records(f)).toEqual([])
    await f.restart().startup()
    expect(f.started.at(-1)).toEqual([f.b, f.a])
  })
})

describe('R1-C2 continuing disk failure and recovery', () => {
  test('withdrawn after the rename while every later write fails: held now, taken out at the next start, b kept and served', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    f.setWindow(f.a)
    const p = await f.e.preview(1)
    if (p.state !== 'ready') throw new Error('not ready')
    let published = false
    durableSeams.beforeRename = (target) => { if (target.endsWith('registrations.json')) published = true }
    durableSeams.beforeDirSync = () => {
      if (!published) return
      published = false
      f.e.retireSender(1)
      durableSeams.beforeRename = () => { throw new Error('continuing disk failure') }
      throw new Error('first failure after the rename')
    }
    const result = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/uncertain/)
    // Still failing: the record keeps a held, here and in every apply of this session.
    expect(await roots(f)).toEqual([f.b, f.a])
    expect(f.started.flat()).not.toContain(f.a)
    expect((await f.e.status(1)).state).toBe('unavailable')
    // A restart while the disk still fails: a is not served (its entry cannot be taken out yet), b is.
    const e2 = f.restart()
    await e2.startup().catch(() => undefined)
    expect(await roots(f)).toEqual([f.b, f.a])
    expect((await e2.status(1)).state).toBe('unavailable')
    // The disk recovers: the next start takes a out; b is untouched and served.
    delete durableSeams.beforeRename
    delete durableSeams.beforeDirSync
    const startsBefore = f.started.length
    const e3 = f.restart()
    await e3.startup()
    expect(await roots(f)).toEqual([f.b])
    expect(f.started.slice(startsBefore)).toEqual([[f.b]])
    expect((await e3.status(1)).state).toBe('off')
    expect(f.log).not.toContain('disable:/a')
  })

  test('the attempt cannot be recorded: the engine is never asked to enable and nothing is registered', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    f.setWindow(f.a)
    const p = await f.e.preview(1)
    if (p.state !== 'ready') throw new Error('not ready')
    f.log.length = 0
    durableSeams.beforeRename = (target) => { if (target.endsWith('activation-attempts.json')) throw new Error('disk full') }
    const result = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/could not record the attempt first/)
    expect(f.log).toEqual(['preview:/a'])
    expect(await roots(f)).toEqual([f.b])
  })

  test('serving the new map fails while still admitted: the error is thrown and the folder is never accepted', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    f.setWindow(f.a)
    const p = await f.e.preview(1)
    if (p.state !== 'ready') throw new Error('not ready')
    let once = true
    f.hooks.afterSpawn = () => { if (!once) return; once = false; throw new Error('injected spawn failure') }
    await expect(f.e.enable(1, { previewId: p.previewId, confirmPublic: false })).rejects.toThrow('injected spawn failure')
    expect((await f.e.status(1)).state).toBe('unavailable')
    const e2 = f.restart()
    await e2.startup()
    expect(f.started.at(-1)).toEqual([f.b])
    expect(await roots(f)).toEqual([f.b])
  })
})

describe('R1-C2 the record itself', () => {
  test('a damaged or non-private record is never overwritten and serves nothing; registrations are kept', async () => {
    for (const damage of ['text', 'mode'] as const) {
      const f = await fixture(cleanups)
      expect((await f.turnOn(f.b)).ok).toBe(true)
      if (damage === 'text') await writeFile(attemptsFile(f), '{ damaged', { mode: 0o600 })
      else await chmod(attemptsFile(f), 0o644)
      const bytes = await readFile(attemptsFile(f), 'utf8')
      const startsBefore = f.started.length
      const e2 = f.restart()
      await e2.startup()
      expect(f.started.length).toBe(startsBefore)
      f.setWindow(f.b)
      expect(await e2.status(1)).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/unfinished backup changes/) })
      f.log.length = 0
      const result = await turnOnWith(f, e2, f.a)
      expect(result.ok).toBe(false)
      expect(f.log).not.toContain('enable:/a')
      expect(await readFile(attemptsFile(f), 'utf8')).toBe(bytes)
      expect(await roots(f)).toEqual([f.b])
    }
  })

  test('re-enabling a registered folder, withdrawn after publication: its earlier entry is kept but held across a restart until a fresh Turn on', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    expect((await f.turnOn(f.a)).ok).toBe(true)
    const old = JSON.parse(await readFile(regsFile(f), 'utf8')).vaults.find((v: { root: string }) => v.root === f.a)
    f.setWindow(f.a)
    const p = await f.e.preview(1)
    if (p.state !== 'ready') throw new Error('not ready')
    let once = true
    f.hooks.afterSpawn = () => { if (once) { once = false; f.e.retireSender(1) } }
    expect((await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })).ok).toBe(false)
    expect(JSON.parse(await readFile(regsFile(f), 'utf8')).vaults.find((v: { root: string }) => v.root === f.a)).toEqual(old)
    expect(f.log).not.toContain('disable:/a')
    expect(f.started.at(-1)).toEqual([f.b])
    expect(await f.e.status(1)).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/earlier backup settings are kept but not used/) })
    const e2 = f.restart()
    await e2.startup()
    expect(f.started.at(-1)).toEqual([f.b])
    expect((await records(f)).map((r) => r.prior !== null)).toEqual([true])
    expect((await turnOnWith(f, e2, f.a)).ok).toBe(true)
    expect(f.started.at(-1)).toEqual([f.b, f.a])
    expect(await records(f)).toEqual([])
  })

  test('bounded: with the record full, a new attempt is refused before any effect', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    const b = JSON.parse(await readFile(regsFile(f), 'utf8')).vaults[0]
    const attempts = Array.from({ length: 32 }, (_, i) => {
      const attempt = i.toString(16).padStart(32, '0')
      return { attempt, root: `/gone/${i}`, entry: { ...b, root: `/gone/${i}`, attempt }, prior: null, at: 1 }
    })
    await writeFile(attemptsFile(f), JSON.stringify({ schema: 1, attempts }), { mode: 0o600 })
    f.log.length = 0
    const result = await turnOnWith(f, f.e, f.a)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/Too many unfinished attempts/)
    expect(f.log).not.toContain('enable:/a')
    expect((await records(f)).length).toBe(32)
  })
})
