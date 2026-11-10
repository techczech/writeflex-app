// Backup activation r3 (review-writeflex-backup-activation-repair-r2, R1 residuals): the initiating window
// binding is admitted at the actual effects (registration rename, configuration rename, helper spawn) after
// their last wait, and a withdrawal after an effect reconciles only this call's additions. Real enrolment,
// real registration/configuration files and the real durable writer; the supervisor, the helper's one-shot
// answers and the service pairs are FAKES (labelled). No helper runs, no network, no credential.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { durableSeams, writeFileDurable, WriteRefused } from '../../src/main/backup-helper/durable-file'
import { createHelperSupervisor } from '../../src/main/backup-helper/supervisor'
import { fixture } from './backup-activation-fixture'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  delete durableSeams.beforeRename
  delete durableSeams.beforeDirSync
  while (cleanups.length) await cleanups.pop()!()
})

describe('R1 effects are admitted with the initiating binding', () => {
  test('withdrawn at the registration rename: nothing registered, nothing started, the switch removed, earlier vaults untouched', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    f.setWindow(f.a)
    const p = await f.e.preview(1)
    if (p.state !== 'ready') throw new Error('not ready')
    f.log.length = 0
    durableSeams.beforeRename = (target) => { if (target.endsWith('registrations.json')) { f.e.retireSender(1) } }
    const result = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
    expect(result.ok).toBe(false)
    expect(await f.registered()).toEqual([f.b])
    expect(f.log).toEqual(['preview:/a', 'enable:/a', 'disable:/a'])
    expect(f.services.receipts.nonAtomicPolicy(f.a)).toBe('copy')
  })

  test('same-root retirement (no folder change) counts: withdrawn while the old helper stops, reconciled to the earlier vaults', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    f.setWindow(f.a)
    const p = await f.e.preview(1)
    if (p.state !== 'ready') throw new Error('not ready')
    f.log.length = 0
    let once = true
    f.hooks.atStop = () => { if (once) { once = false; f.e.retireSender(1) } }
    const result = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
    expect(result.ok).toBe(false)
    // The registration of a was published, then withdrawn: the earlier file is back and b is served again.
    expect(await f.registered()).toEqual([f.b])
    expect(f.log).toEqual(['preview:/a', 'enable:/a', 'stop', 'stop', 'spawn:/b', 'disable:/a'])
    expect(f.started.flat()).not.toContain(f.a)
  })

  test('withdrawn immediately before the actual spawn: no helper for a starts; reconciled', async () => {
    const f = await fixture(cleanups)
    const p = await (async () => { f.setWindow(f.a); return f.e.preview(1) })()
    if (p.state !== 'ready') throw new Error('not ready')
    let once = true
    f.hooks.atSpawnAdmission = () => { if (once) { once = false; f.setWindow(f.c); f.e.retireSender(1) } }
    const result = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
    expect(result.ok).toBe(false)
    expect(f.log).toContain('start-refused')
    expect(f.started).toEqual([])
    // No registrations before: none after. r4: the undo removes only this attempt's entry from the file as
    // it is now and never unlinks it, so an empty list (same meaning as no file) may remain.
    expect((await f.registered()) ?? []).toEqual([])
    expect(f.log.at(-1)).toBe('disable:/a')
  })

  test('withdrawn while the spawned helper starts: its helper is stopped and the earlier vaults are served again', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    f.setWindow(f.a)
    const p = await f.e.preview(1)
    if (p.state !== 'ready') throw new Error('not ready')
    f.log.length = 0
    let once = true
    f.hooks.afterSpawn = () => { if (once) { once = false; f.e.retireSender(1) } }
    const result = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
    expect(result.ok).toBe(false)
    expect(f.log).toEqual(['preview:/a', 'enable:/a', 'stop', 'spawn:/b,/a', 'stop', 'spawn:/b', 'disable:/a'])
    expect(await f.registered()).toEqual([f.b])
    expect(f.services.receipts.nonAtomicPolicy(f.b)).toBe('refuse')
  })

  test('withdrawn during the registration folder sync (after the rename): reconciled', async () => {
    const f = await fixture(cleanups)
    f.setWindow(f.a)
    const p = await f.e.preview(1)
    if (p.state !== 'ready') throw new Error('not ready')
    let renamed = false
    durableSeams.beforeRename = (target) => { if (target.endsWith('registrations.json')) renamed = true }
    durableSeams.beforeDirSync = () => { if (renamed) { renamed = false; f.e.retireSender(1) } }
    const result = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
    expect(result.ok).toBe(false)
    // r4: only this attempt's entry is removed (never an unlink); an empty list means nothing registered.
    expect((await f.registered()) ?? []).toEqual([])
    expect(f.started).toEqual([])
    expect(f.log.at(-1)).toBe('disable:/a')
  })

  test('an undisturbed enable still registers, starts and serves the folder', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.a)).ok).toBe(true)
    expect(await f.registered()).toEqual([f.a])
    expect(f.started).toEqual([[f.a]])
  })
})

describe('durable write admission', () => {
  test('a refused admission replaces nothing and leaves no temporary file; admitted writes as before', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'wfr3d-')))
    cleanups.push(() => rm(base, { recursive: true, force: true }))
    const target = join(base, 'x.json')
    await writeFile(target, 'old\n')
    await expect(writeFileDurable(target, 'new\n', () => false)).rejects.toBeInstanceOf(WriteRefused)
    expect(await readFile(target, 'utf8')).toBe('old\n')
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(base)).toEqual(['x.json'])
    await writeFileDurable(target, 'new\n', () => true)
    expect(await readFile(target, 'utf8')).toBe('new\n')
  })
})

describe('supervisor spawn admission', () => {
  test('start asks admit after the stop and spawns nothing when it says no', async () => {
    let spawned = 0
    const s = createHelperSupervisor({ command: '/fixture/app', entry: '/fixture/helper.js', spawn: (() => { spawned++; throw new Error('not reached') }) as never, setTimer: () => 0, clearTimer: () => undefined })
    const order: string[] = []
    const state = await s.start('/c.json', '/run', () => { order.push('admit'); return false })
    expect(state.state).toBe('stopped')
    expect(spawned).toBe(0)
    expect(order).toEqual(['admit'])
  })
})
