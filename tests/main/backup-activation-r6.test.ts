// Backup activation r6 (review-writeflex-backup-history-activation-repair-r5, R1-C2): the acceptance step.
// An enable is accepted at the rename that removes its attempt record, admitted by the window's binding
// synchronously immediately before that rename. Before it, any refusal or failure leaves the record and the
// attempt is undone (restart holds the folder whatever the undo manages); once the rename has returned it is
// accepted and never reported as failed. A rename whose own outcome is unknown is classified by reading the
// record back. Invariant checked in every case: an enable reported as not turned on is never served after a
// restart, and accepted folders, exact earlier entries and other folders are kept.
// Real enrolment, real registration/attempt/configuration files, the real durable writer and its fs seams;
// supervisor, helper one-shot answers and service pairs are FAKES (backup-activation-fixture.ts).
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, readFileSync } from 'node:fs'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { durableSeams } from '../../src/main/backup-helper/durable-file'
import type { BackupEnrolmentResult } from '../../src/shared/backup-enrolment'
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
const entries = async (f: F) => JSON.parse(await readFile(join(f.dir, 'registrations.json'), 'utf8')).vaults as Array<{ root: string }>
const recorded = async (f: F) => (JSON.parse(await readFile(attemptsFile(f), 'utf8')).attempts as Array<{ root: string }>).map((r) => r.root)
const failAll = () => { durableSeams.beforeRename = () => { throw new Error('continuing disk failure') } }

/** b accepted first; then an enable of a with `arm` installing seams for a's final (second) attempts write. */
async function scenario(arm: (f: F, finalWrite: () => boolean) => void) {
  const f = await fixture(cleanups)
  expect((await f.turnOn(f.b)).ok).toBe(true)
  const bEntry = JSON.stringify((await entries(f)).find((v) => v.root === f.b))
  f.setWindow(f.a)
  const p = await f.e.preview(1)
  if (p.state !== 'ready') throw new Error('not ready')
  let attemptWrites = 0
  let last = ''
  const finalWrite = () => last.endsWith(ATTEMPTS) && attemptWrites === 2
  arm(f, finalWrite)
  const armedRename = durableSeams.beforeRename
  durableSeams.beforeRename = (target) => {
    last = target
    if (target.endsWith(ATTEMPTS)) attemptWrites++
    return armedRename?.(target)
  }
  const result = await f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
  return { f, result, bEntry }
}

/** A new app process over the same files, the disk working again. */
async function restarted(f: F) {
  delete durableSeams.beforeRename
  delete durableSeams.beforeDirSync
  delete durableSeams.atRename
  const n = f.started.length
  const e = f.restart()
  await e.startup()
  return { starts: f.started.slice(n), status: await e.status(1) }
}

/** The invariant of every case: not turned on => never served after a restart; b's entry exactly kept. */
async function invariant(f: F, result: BackupEnrolmentResult, bEntry: string, after: { starts: string[][]; status: { state: string } }) {
  if (!result.ok) {
    expect(after.starts.flat()).not.toContain(f.a)
    expect(after.status.state).not.toBe('on')
  } else {
    expect(after.starts).toEqual([[f.b, f.a]])
    expect(after.status.state).toBe('on')
  }
  expect(JSON.stringify((await entries(f)).find((v) => v.root === f.b))).toBe(bEntry)
  expect(after.starts.flat()).toContain(f.b)
}

describe('R1-C2 r6 before the acceptance rename: never accepted', () => {
  test('window retired in the last wait before the rename (no gap to the admission): refused, record kept, held now and after restarts', async () => {
    const { f, result, bEntry } = await scenario((f, finalWrite) => {
      durableSeams.beforeRename = () => {
        if (!finalWrite()) return
        f.e.retireSender(1)
        failAll()
      }
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/^Something changed since this vault was checked/)
    // The rename never happened: the record still names a.
    expect(await recorded(f)).toEqual([f.a])
    expect((await f.e.status(1)).state).not.toBe('on')
    // A restart while the disk still fails: a held (its entry cannot be taken out yet), b served.
    const n = f.started.length
    const e2 = f.restart()
    await e2.startup().catch(() => undefined)
    expect(f.started.slice(n).flat()).not.toContain(f.a)
    expect((await e2.status(1)).state).toBe('unavailable')
    const after = await restarted(f)
    expect(after.starts).toEqual([[f.b]])
    expect(after.status.state).toBe('off')
    await invariant(f, result, bEntry, after)
  })

  test('the acceptance write fails before its rename and every later write fails: not turned on, record kept, never served after restart', async () => {
    const { f, result, bEntry } = await scenario((_f, finalWrite) => {
      durableSeams.beforeRename = () => { if (finalWrite()) { failAll(); throw new Error('final record write failed') } }
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/could not record that turning it on finished/)
    expect(await recorded(f)).toEqual([f.a])
    await invariant(f, result, bEntry, await restarted(f))
  })

  test('the rename call fails without taking effect: read back as held, not turned on, never served after restart', async () => {
    const { f, result, bEntry } = await scenario((_f, finalWrite) => {
      durableSeams.atRename = (_t, renamed) => { if (!renamed && finalWrite()) { failAll(); throw new Error('rename failed') } }
    })
    expect(result.ok).toBe(false)
    expect(await recorded(f)).toEqual([f.a])
    await invariant(f, result, bEntry, await restarted(f))
  })
})

describe('R1-C2 r6 after the acceptance rename: accepted, never reported failed', () => {
  test('folder sync fails after the rename, the window is retired and every later write fails: accepted (the reviewer counterexample, classified)', async () => {
    const { f, result, bEntry } = await scenario((f, finalWrite) => {
      let done = false
      durableSeams.beforeDirSync = () => {
        if (done || !finalWrite()) return
        done = true
        f.e.retireSender(1)
        failAll()
        throw new Error('final record folder sync failed')
      }
    })
    // Committed at the rename: reported and served as on; nothing claims a failure that a restart contradicts.
    expect(result.ok).toBe(true)
    expect(await recorded(f)).toEqual([])
    expect((await f.e.status(1)).state).toBe('on')
    await invariant(f, result, bEntry, await restarted(f))
  })

  test('if a power loss brings the record back after that unsynced rename, the restart holds a (fail-closed) and keeps b', async () => {
    let before = ''
    const { f, result } = await scenario((f, finalWrite) => {
      durableSeams.atRename = (_t, renamed) => { if (!renamed && finalWrite()) before = readFileSync(join(f.dir, ATTEMPTS), 'utf8') }
      durableSeams.beforeDirSync = () => { if (finalWrite() && before) { failAll(); throw new Error('final record folder sync failed') } }
    })
    expect(result.ok).toBe(true)
    // Simulated loss of the unsynced rename: the old record bytes are what the disk kept.
    await writeFile(attemptsFile(f), before, { mode: 0o600 })
    expect(await recorded(f)).toEqual([f.a])
    const after = await restarted(f)
    expect(after.starts).toEqual([[f.b]])
    expect(after.status.state).toBe('off')
  })

  test('the rename reports a failure although it took effect: read back as released, accepted and served after restart', async () => {
    const { f, result, bEntry } = await scenario((_f, finalWrite) => {
      durableSeams.atRename = (_t, renamed) => { if (renamed && finalWrite()) { failAll(); throw new Error('rename reported failure') } }
    })
    expect(result.ok).toBe(true)
    expect(await recorded(f)).toEqual([])
    await invariant(f, result, bEntry, await restarted(f))
  })

  test('crash after the acceptance rename (its folder sync never returns): the next start serves a as accepted', async () => {
    const f = await fixture(cleanups)
    expect((await f.turnOn(f.b)).ok).toBe(true)
    f.setWindow(f.a)
    const p = await f.e.preview(1)
    if (p.state !== 'ready') throw new Error('not ready')
    let attemptWrites = 0
    let last = ''
    let crashed = false
    durableSeams.beforeRename = (t) => { last = t; if (t.endsWith(ATTEMPTS)) attemptWrites++ }
    durableSeams.beforeDirSync = () => { if (last.endsWith(ATTEMPTS) && attemptWrites === 2) { crashed = true; return new Promise<void>(() => {}) } }
    void f.e.enable(1, { previewId: p.previewId, confirmPublic: false })
    for (let i = 0; i < 100 && !crashed; i++) await new Promise((r) => setTimeout(r, 20))
    expect(crashed).toBe(true)
    const after = await restarted(f)
    expect(after.starts).toEqual([[f.b, f.a]])
    expect(after.status.state).toBe('on')
  })
})

describe('R1-C2 r6 outcome unknown both ways (documented limit)', () => {
  test('rename reports failure after taking effect and the record cannot be read back: reported as possibly not on; undone when the disk allows', async () => {
    const { f, result, bEntry } = await scenario((f, finalWrite) => {
      durableSeams.atRename = (_t, renamed) => {
        if (!renamed || !finalWrite()) return
        chmodSync(join(f.dir, ATTEMPTS), 0o000)
        throw new Error('rename reported failure')
      }
    })
    await chmod(attemptsFile(f), 0o600)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/^Backup may not have been turned on/)
    // The disk allowed the undo: a's entry is out, so it is not served after a restart.
    expect((await entries(f)).map((v) => v.root)).toEqual([f.b])
    await invariant(f, result, bEntry, await restarted(f))
  })
})
