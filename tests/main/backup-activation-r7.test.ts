// Backup activation r7 (review-writeflex-backup-history-activation-repair-r6, R6-U1): a Turn on whose outcome
// is unknown. When the rename removing the attempt record reports failure, the record cannot be read back and
// undoing the attempt does not finish, enable answers `ok: null` (neither failed nor on), and status for that
// folder says so (`activation: 'unconfirmed'`, never "stays off") until it can be read again. Known failures
// stay `ok: false`, accepted stays `ok: true`, and an unknown outcome whose undo finished is a known failure.
// Real enrolment, real registration/attempt files, the real durable writer and its fs seams, and a real
// unreadable file (mode 000); supervisor, helper one-shot answers and service pairs are FAKES
// (backup-activation-fixture.ts).
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync } from 'node:fs'
import { chmod, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { durableSeams } from '../../src/main/backup-helper/durable-file'
import type { BackupEnrolmentResult, BackupEnrolmentStatus } from '../../src/shared/backup-enrolment'
import { fixture } from './backup-activation-fixture'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  delete durableSeams.beforeRename
  delete durableSeams.beforeDirSync
  delete durableSeams.atRename
  while (cleanups.length) await cleanups.pop()!()
})

type F = Awaited<ReturnType<typeof fixture>>
const ATTEMPTS = 'activation-attempts.json'
const attemptsFile = (f: F) => join(f.dir, ATTEMPTS)
const entries = async (f: F) => (JSON.parse(await readFile(join(f.dir, 'registrations.json'), 'utf8')).vaults as Array<{ root: string }>).map((v) => v.root)
const recorded = async (f: F) => (JSON.parse(await readFile(attemptsFile(f), 'utf8')).attempts as Array<{ root: string }>).map((r) => r.root)

/**
 * b accepted; then Turn on for a. At the final attempts write (the record removal) the rename reports an EIO
 * failure after (`effected`) or without taking effect, the record is made unreadable, and with
 * `continuing` every later write fails before its rename, so the undo cannot finish.
 */
async function unknownOutcome(effected: boolean, continuing: boolean) {
  const f = await fixture(cleanups)
  expect((await f.turnOn(f.b)).ok).toBe(true)
  f.setWindow(f.a)
  const p = await f.e.preview(1)
  if (p.state !== 'ready') throw new Error('not ready')
  let writes = 0
  let injected = false
  durableSeams.beforeRename = (t) => { if (t.endsWith(ATTEMPTS)) writes++ }
  durableSeams.atRename = (t, renamed) => {
    if (injected || !t.endsWith(ATTEMPTS) || writes !== 2 || renamed !== effected) return
    injected = true
    chmodSync(t, 0o000)
    if (continuing) durableSeams.beforeRename = () => { throw Object.assign(new Error('continuing I/O refusal'), { code: 'EIO' }) }
    throw Object.assign(new Error('rename outcome uncertain'), { code: 'EIO' })
  }
  const result = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
  expect(injected).toBe(true)
  return { f, result }
}

/** The disk working again: record readable, no injected faults. */
async function recover(f: F) {
  delete durableSeams.beforeRename
  delete durableSeams.atRename
  await chmod(attemptsFile(f), 0o600)
}

async function restarted(f: F) {
  const n = f.started.length
  const e = f.restart()
  await e.startup()
  return { starts: f.started.slice(n), status: await e.status(1) }
}

const unconfirmed = (s: BackupEnrolmentStatus) => s.state === 'unavailable' && s.activation === 'unconfirmed'
const saysStaysOff = (s: BackupEnrolmentStatus) => s.state === 'unavailable' && /stays off/.test(s.reason)

describe('R6-U1 outcome unknown and undo unfinished: ok null, never failed or off', () => {
  for (const effected of [true, false]) {
    test(`rename ${effected ? 'took effect' : 'did not take effect'}, record unreadable, undo keeps failing`, async () => {
      const { f, result } = await unknownOutcome(effected, true)
      // Structured: neither a known failure nor success.
      expect(result.ok).toBeNull()
      expect(result.ok === null && result.reason).toMatch(/^Backup may not have been turned on/)
      // The status actually returned, and the status asked for again (same session, still unreadable).
      for (const status of [result.status, await f.e.status(1), await f.e.status(1)]) {
        expect(unconfirmed(status)).toBe(true)
        expect(saysStaysOff(status)).toBe(false)
        expect(status.state === 'unavailable' && status.reason).toMatch(/could not be confirmed.*may still be in place.*backup may start/)
      }
      // Only this folder: another folder's window gets the ordinary unavailable status.
      f.setWindow(f.b)
      const other = await f.e.status(1)
      expect(unconfirmed(other)).toBe(false)
      expect(saysStaysOff(other)).toBe(true)
      f.setWindow(f.a)
      // A restart while still unreadable serves nothing (startup unchanged); in-session warning is per process.
      const still = f.restart()
      const n0 = f.started.length
      await still.startup()
      expect(f.started.slice(n0).flat()).not.toContain(f.a)
      // Resolved: once the record can be read, the warning goes and the status is the real one.
      await recover(f)
      const resolved = await f.e.status(1)
      expect(unconfirmed(resolved)).toBe(false)
      if (effected) {
        // The record removal had happened and a's entry stayed: a is backed up after recovery, as the warning said.
        expect(await recorded(f)).toEqual([])
        expect(await entries(f)).toContain(f.a)
        expect(resolved.state).toBe('on')
        const after = await restarted(f)
        expect(after.starts).toEqual([[f.b, f.a]])
        expect(after.status.state).toBe('on')
      } else {
        // The record still names a: held, then undone at the next start; never served.
        expect(await recorded(f)).toEqual([f.a])
        expect(resolved).toMatchObject({ state: 'unavailable' })
        const after = await restarted(f)
        expect(after.starts.flat()).not.toContain(f.a)
        expect(after.status.state).not.toBe('on')
      }
      // After resolution the warning does not come back for a later unreadable record.
      chmodSync(attemptsFile(f), 0o000)
      const later = await f.e.status(1)
      await chmod(attemptsFile(f), 0o600)
      expect(unconfirmed(later)).toBe(false)
    })
  }
})

describe('R6-U1 controls: known outcomes unchanged', () => {
  test('unknown outcome but the undo finished (disk working after the rename): known failure, ordinary status', async () => {
    const { f, result } = await unknownOutcome(true, false)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/^Backup may not have been turned on/)
    expect(unconfirmed(result.status)).toBe(false)
    expect(await entries(f)).toEqual([f.b])
    await recover(f)
    const after = await restarted(f)
    expect(after.starts.flat()).not.toContain(f.a)
  })

  test('write failure before the record rename with continuing failure: known failure, never unconfirmed', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    f.setWindow(f.a)
    const p = await f.e.preview(1)
    if (p.state !== 'ready') throw new Error('not ready')
    let writes = 0
    durableSeams.beforeRename = (t) => {
      if (!t.endsWith(ATTEMPTS) || ++writes !== 2) return
      durableSeams.beforeRename = () => { throw new Error('continuing disk failure') }
      throw new Error('disk failure before the record rename')
    }
    const result: BackupEnrolmentResult = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
    expect(result.ok).toBe(false)
    expect(unconfirmed(result.status)).toBe(false)
    expect(unconfirmed(await f.e.status(1))).toBe(false)
  })

  test('accepted: ok true, status on, no activation field', async () => {
    const f = await fixture(cleanups)
    const result = await f.turnOn(f.a)
    expect(result.ok).toBe(true)
    expect(result.status.state).toBe('on')
    expect('activation' in result.status).toBe(false)
  })
})
