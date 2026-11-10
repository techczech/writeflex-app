// Backup activation r4 (review-writeflex-backup-history-activation-r3, R1-C1 and R1-C2): a withdrawn enable
// owns one registration entry, never the registrations file. Its undo works on the file as it is NOW,
// keeps every other writer's entries, and runs after a rename whose outcome is unknown (its folder sync
// failed) or when serving the new map throws. Real enrolment, real registration/configuration files, the
// real durable writer and its fs seams; supervisor, helper one-shot answers and service pairs are FAKES
// (backup-activation-fixture.ts). "Another writer" is a plain file write between our operations.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { durableSeams } from '../../src/main/backup-helper/durable-file'
import { fixture } from './backup-activation-fixture'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  delete durableSeams.beforeRename
  delete durableSeams.beforeDirSync
  while (cleanups.length) await cleanups.pop()!()
})

type F = Awaited<ReturnType<typeof fixture>>
const regsFile = (f: F) => join(f.base, 'userData', 'backup-helper', 'registrations.json')
const entries = async (f: F) => JSON.parse(await readFile(regsFile(f), 'utf8')).vaults as Array<{ id: string; root: string; local: string | null; attempt?: string }>
/** Another writer of the registrations file: adds (or replaces) one entry with a plain write. */
async function externalWrite(f: F, entry: { id: string; root: string; local: string }): Promise<void> {
  const file = JSON.parse(await readFile(regsFile(f), 'utf8'))
  file.vaults = [...file.vaults.filter((v: { root: string }) => v.root !== entry.root), { ...file.vaults[0], ...entry, attempt: undefined }]
  await writeFile(regsFile(f), JSON.stringify(file))
}
async function shownFor(f: F, folder: string) {
  f.setWindow(folder)
  const p = await f.e.preview(1)
  if (p.state !== 'ready') throw new Error('not ready')
  return p
}

describe('R1-C1 the undo owns this attempt\'s entry, not the file', () => {
  test('another writer\'s registration added while the helper starts is kept and served; only a is removed', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    const p = await shownFor(f, f.a)
    f.log.length = 0
    let once = true
    f.hooks.afterSpawn = async () => { if (!once) return; once = false; await externalWrite(f, { id: 'external-c', root: f.c, local: '/external.git' }); f.e.retireSender(1) }
    const result = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
    expect(result.ok).toBe(false)
    expect((await entries(f)).map((v) => v.root)).toEqual([f.b, f.c])
    // The current union is served again, and the switch this attempt made is removed.
    expect(f.log).toEqual(['preview:/a', 'enable:/a', 'stop', 'spawn:/b,/a', 'stop', 'spawn:/b,/c', 'disable:/a'])
  })

  test('a registration of the same folder by another writer is theirs: kept, and its switch is not removed', async () => {
    const f = await fixture(cleanups)
    const p = await shownFor(f, f.a)
    let once = true
    f.hooks.afterSpawn = async () => { if (!once) return; once = false; await externalWrite(f, { id: 'other-a', root: f.a, local: '/other.git' }); f.e.retireSender(1) }
    const result = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
    expect(result.ok).toBe(false)
    expect((await entries(f)).map((v) => [v.id, v.root])).toEqual([['other-a', f.a]])
    expect(f.log).not.toContain('disable:/a')
  })

  test('a damaged file at the undo is never overwritten, the switch is left, and the answer says the undo is uncertain', async () => {
    const f = await fixture(cleanups)
    const p = await shownFor(f, f.a)
    let once = true
    f.hooks.afterSpawn = async () => { if (!once) return; once = false; await writeFile(regsFile(f), '{ damaged by another program'); f.e.retireSender(1) }
    const result = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
    expect(result.ok).toBe(false)
    expect(await readFile(regsFile(f), 'utf8')).toBe('{ damaged by another program')
    expect(f.log).not.toContain('disable:/a')
    expect(!result.ok && result.reason).toMatch(/uncertain/)
    // A damaged file serves nothing: the helper is not started again for a.
    expect(f.started.at(-1)).toContain(f.a)
    expect(f.log.filter((l) => l.startsWith('spawn:')).length).toBe(1)
  })

  test('an undisturbed enable writes this attempt\'s id with its entry; turning off removes only that folder', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    expect((await f.turnOn(f.a)).ok).toBe(true)
    const [b, a] = await entries(f)
    expect(a!.attempt).toMatch(/^[0-9a-f]{32}$/)
    expect(b!.attempt).not.toBe(a!.attempt)
    await externalWrite(f, { id: 'external-c', root: f.c, local: '/external.git' })
    f.setWindow(f.a)
    expect((await f.e.disable(1)).ok).toBe(true)
    expect((await entries(f)).map((v) => v.root)).toEqual([f.b, f.c])
  })
})

describe('R1-C2 a rename whose outcome is unknown enters the same undo', () => {
  test('withdrawn while the folder sync after the rename THROWS, with another writer\'s entry added: a removed and disabled, c kept', async () => {
    const f = await fixture(cleanups)
    const p = await shownFor(f, f.a)
    let renamed = false
    durableSeams.beforeRename = (target) => { if (target.endsWith('registrations.json')) renamed = true }
    durableSeams.beforeDirSync = async () => {
      if (!renamed) return
      renamed = false
      delete durableSeams.beforeRename
      await externalWrite(f, { id: 'external-c', root: f.c, local: '/external.git' })
      f.e.retireSender(1)
      throw new Error('injected folder sync failure after the registration rename')
    }
    const result = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
    expect(result.ok).toBe(false)
    // The failed sync is reported, never hidden.
    expect(!result.ok && result.reason).toMatch(/injected folder sync failure/)
    expect((await entries(f)).map((v) => v.root)).toEqual([f.c])
    expect(f.log.at(-1)).toBe('disable:/a')
    expect(f.started.flat()).not.toContain(f.a)

    // The next start reads the file as left: a is not served.
    await f.e.startup()
    expect(f.started.at(-1)).toEqual([f.c])
  })

  test('withdrawn when the undo\'s own write also fails its folder sync: a is still absent, disabled, and the answer says uncertain', async () => {
    const f = await fixture(cleanups)
    const p = await shownFor(f, f.a)
    // Every registrations write fails its folder sync after its rename: the forward one and the undo's.
    let renamed = false
    durableSeams.beforeRename = (target) => { if (target.endsWith('registrations.json')) renamed = true }
    durableSeams.beforeDirSync = () => {
      if (!renamed) return
      renamed = false
      f.e.retireSender(1)
      throw new Error('injected folder sync failure')
    }
    const result = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
    delete durableSeams.beforeRename
    delete durableSeams.beforeDirSync
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/uncertain/)
    expect((await entries(f)).map((v) => v.root)).toEqual([])
    expect(f.log).toContain('disable:/a')
    expect(f.started.flat()).not.toContain(f.a)
    // A later undisturbed Turn on in the same session serves the folder again.
    expect((await f.turnOn(f.a)).ok).toBe(true)
    expect(f.started.at(-1)).toEqual([f.a])
  })

  test('still admitted when the folder sync fails: the I/O error is thrown, never a false success', async () => {
    const f = await fixture(cleanups)
    const p = await shownFor(f, f.a)
    let renamed = false
    durableSeams.beforeRename = (target) => { if (target.endsWith('registrations.json')) renamed = true }
    durableSeams.beforeDirSync = () => { if (renamed) { renamed = false; throw new Error('injected folder sync failure') } }
    await expect(f.e.enable(1, { previewId: p.previewId, confirmPublic: false })).rejects.toThrow('injected folder sync failure')
    expect(f.started).toEqual([])
  })

  test('withdrawn when serving the new map throws (the spawn fails): reconciled to the earlier vaults', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    const p = await shownFor(f, f.a)
    f.log.length = 0
    let once = true
    f.hooks.afterSpawn = () => { if (!once) return; once = false; f.e.retireSender(1); throw new Error('injected spawn failure') }
    const result = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
    expect(result.ok).toBe(false)
    expect((await entries(f)).map((v) => v.root)).toEqual([f.b])
    expect(f.log).toEqual(['preview:/a', 'enable:/a', 'stop', 'spawn:/b,/a', 'stop', 'spawn:/b', 'disable:/a'])
  })
})
