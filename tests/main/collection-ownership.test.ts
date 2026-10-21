import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_OPEN_WAIT_MS, busyNotice, claimWithRetry, CollectionOwnership, lostNotice, unavailableNotice, unavailableReason } from '../../src/main/collection-ownership'
import { collectionWritesPaused } from '../../src/main/collection-write-gate'
import { Workspace, WritesPausedError } from '../../src/main/workspace'
import { VersionStore } from '../../src/main/versions'
import { ScrapStore } from '../../src/main/scraps'
import { ChangeStore, type NewChange } from '../../src/main/changes'
import { exportDocument } from '../../src/main/export'
import { writeMaterial } from '../../src/main/board-material'
import { inspectOwnerLock, ownerLockPath, OwnerLockBusyError, type OwnerLockRecord } from '../../src/main/owner-lock'
import { crashedOwner, lockChild } from '../helpers/owner-lock-child'

const roots: string[] = []
const owners: CollectionOwnership[] = []
async function collection(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wf-ownership-'))
  roots.push(root)
  await mkdir(join(root, '.writeflex'))
  return root
}
function ownership(options: ConstructorParameters<typeof CollectionOwnership>[0] = {}): { owner: CollectionOwnership; log: Array<{ event: string; details: Record<string, unknown> }> } {
  const log: Array<{ event: string; details: Record<string, unknown> }> = []
  const owner = new CollectionOwnership({ diagnostic: (event, details) => { log.push({ event, details }) }, ...options })
  owners.push(owner)
  return { owner, log }
}
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.releaseAll()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const onDisk = async (root: string): Promise<OwnerLockRecord> => JSON.parse(await readFile(ownerLockPath(root), 'utf8')) as OwnerLockRecord

test('the stated bound: the app waits ten seconds for another owner', () => {
  expect(APP_OPEN_WAIT_MS).toBe(10_000)
})

test('opening a Collection takes the lock as the app; closing its window releases it', async () => {
  const root = await collection()
  const { owner } = ownership()
  expect(await owner.claim(root)).toBe('owned')
  expect(owner.owns(root)).toBe(true)
  expect(await onDisk(root)).toMatchObject({ pid: process.pid, kind: 'app', host: hostname() })
  await owner.release(root)
  expect(owner.owns(root)).toBe(false)
  expect(await inspectOwnerLock(root)).toEqual({ state: 'free', conflictCopies: [] })
  await owner.release(root) // a window that never bound releases nothing
})

test('while the app has a Collection open, a second real process cannot take it; after close it can', async () => {
  const root = await collection()
  const { owner } = ownership()
  await owner.claim(root)
  const refused = await lockChild('race', root, 0, 0).finished
  expect(refused.lines).toEqual(['busy'])
  await owner.release(root)
  const allowed = await lockChild('race', root, 0, 0).finished
  expect(allowed.lines).toEqual(['acquired'])
}, 20_000)

/** A timer the test fires by hand: what `claim` scheduled, at what interval, and whether `release` stopped it. */
function handTimer(): { schedule: NonNullable<ConstructorParameters<typeof CollectionOwnership>[0]>['schedule']; beats: Array<{ beat: () => Promise<void>; ms: number; stopped: boolean }> } {
  const beats: Array<{ beat: () => Promise<void>; ms: number; stopped: boolean }> = []
  return {
    beats,
    schedule: (beat, ms) => {
      const entry = { beat, ms, stopped: false }
      beats.push(entry)
      return () => { entry.stopped = true }
    },
  }
}

test('the lock is refreshed on a timer while the Collection is open', async () => {
  const root = await collection()
  let clock = 1_000_000
  const timer = handTimer()
  const { owner } = ownership({ heartbeatMs: 25, schedule: timer.schedule, env: { now: () => clock } })
  await owner.claim(root)
  expect(timer.beats.map(({ ms, stopped }) => ({ ms, stopped }))).toEqual([{ ms: 25, stopped: false }])
  const first = await onDisk(root)
  // The timer fires twice while the Collection is open: the heartbeat advances each time, same token.
  clock += 25
  await timer.beats[0].beat()
  clock += 25
  await timer.beats[0].beat()
  const later = await onDisk(root)
  expect(later.token).toBe(first.token)
  expect(later.heartbeatAt).toBe(first.heartbeatAt + 50)
  await owner.release(root)
  expect(timer.beats[0].stopped).toBe(true)
  // A beat that fires after the release (a tick already queued) does not put the file back.
  clock += 25
  await timer.beats[0].beat()
  expect(existsSync(ownerLockPath(root))).toBe(false)
})

test('quitting releases every open Collection', async () => {
  const [first, second] = [await collection(), await collection()]
  const { owner } = ownership()
  await owner.claim(first)
  await owner.claim(second)
  await owner.releaseAll()
  expect(existsSync(ownerLockPath(first))).toBe(false)
  expect(existsSync(ownerLockPath(second))).toBe(false)
})

test('a crash leaves a lock that the next start recovers, and the recovery is logged', async () => {
  const root = await collection()
  const pid = await crashedOwner(root)
  const { owner, log } = ownership()
  expect(await owner.claim(root)).toBe('owned')
  expect((await onDisk(root)).pid).toBe(process.pid)
  expect(log).toHaveLength(1)
  expect(log[0].event).toBe('owner-lock.recovered')
  expect(log[0].details).toMatchObject({ root, reason: 'process-gone', previous: { pid, kind: 'command-line' } })
  expect(JSON.stringify(log)).not.toContain('token')
}, 20_000)

test('starting while a short-lived owner is writing: the app waits, then opens with the lock', async () => {
  const root = await collection()
  // The writer holds until the test lets it go, not for a fixed time.
  const until = join(root, 'writer-may-release')
  const writer = lockChild('hold', root, 0, until)
  await writer.said('held')
  let judged = 0
  // The app has met the writer's live lock (it asked whether the writer's process is there) and is
  // waiting: only then does the writer let go. Nothing here depends on how long anything takes.
  const { owner } = ownership({ waitMs: 600_000, env: { pidIsAlive: (pid) => {
    if (pid === writer.pid && judged++ === 0) void writeFile(until, '')
    try { process.kill(pid, 0); return true } catch { return false }
  } } })
  let asked = 0
  expect(await claimWithRetry(owner, root, async () => { asked += 1; return false })).toBe(true)
  expect(judged).toBeGreaterThan(0)
  expect(asked).toBe(0)
  expect((await writer.finished).lines).toEqual(['held', 'released'])
  expect(await onDisk(root)).toMatchObject({ pid: process.pid, kind: 'app' })
}, 20_000)

test('when the wait runs out the app does not open: the user is asked, Cancel leaves the other owner untouched', async () => {
  const root = await collection()
  const until = join(root, 'writer-may-release')
  const writer = lockChild('hold', root, 0, until)
  await writer.said('held')
  const { owner } = ownership({ waitMs: 200 })
  const asked: OwnerLockBusyError[] = []
  expect(await claimWithRetry(owner, root, async (busy) => { asked.push(busy); return false })).toBe(false)
  expect(asked).toHaveLength(1)
  expect(asked[0].owner).toMatchObject({ pid: writer.pid, kind: 'command-line' })
  expect(asked[0].waitedMs).toBeGreaterThanOrEqual(200)
  expect(owner.owns(root)).toBe(false)
  expect((await onDisk(root)).pid).toBe(writer.pid)

  // Try Again, pressed until the writer has finished, opens with the lock. The writer is let go
  // when the user is first asked again, so at least one Try Again is certain.
  let retries = 0
  expect(await claimWithRetry(owner, root, async () => {
    if (retries++ === 0) await writeFile(until, '')
    return true
  })).toBe(true)
  expect(retries).toBeGreaterThan(0)
  expect(owner.owns(root)).toBe(true)
  expect((await onDisk(root)).pid).toBe(process.pid)
  await writer.finished
}, 30_000)

test('a reopen that overlaps the previous window\'s delayed release keeps the lock', async () => {
  const root = await collection()
  const { owner } = ownership()
  await owner.claim(root) // first window
  await owner.claim(root) // reopened before the first window's release ran
  await owner.release(root) // the first window's release arrives late
  expect(owner.owns(root)).toBe(true)
  expect(existsSync(ownerLockPath(root))).toBe(true)
  await owner.release(root)
  expect(existsSync(ownerLockPath(root))).toBe(false)
})

test('a lock taken over while the window was open is noticed on the next beat and taken back when free', async () => {
  const root = await collection()
  // The timer is out of the way; refreshNow() is the beat, so the order of events is exact.
  const { owner, log } = ownership({ heartbeatMs: 600_000 })
  const changes: string[] = []
  owner.watch((changed, change) => { changes.push(`${change} ${changed}`) })
  await owner.claim(root)
  // The lock file goes (a sync client, a person tidying up) and another owner takes the Collection
  // before this app's next beat can put it back.
  await rm(ownerLockPath(root))
  // The thief holds until the test lets it go, not for a fixed time.
  const until = join(root, 'thief-may-release')
  const thief = lockChild('race', root, 0, 0, until)
  await thief.said('acquired')
  await owner.refreshNow()
  expect(owner.owns(root)).toBe(false)
  expect(owner.lost(root)).toBe(true)
  expect(log.map((entry) => entry.event)).toContain('owner-lock.lost')
  expect(changes).toEqual([`lost ${root}`])
  await owner.refreshNow() // still taken: nothing new to report
  expect(changes).toEqual([`lost ${root}`])
  await writeFile(until, '')
  await thief.finished
  await owner.refreshNow()
  expect(owner.owns(root)).toBe(true)
  expect(owner.lost(root)).toBe(false)
  expect(log.map((entry) => entry.event)).toContain('owner-lock.reclaimed')
  expect(changes).toEqual([`lost ${root}`, `regained ${root}`])
  expect((await onDisk(root)).pid).toBe(process.pid)
}, 20_000)

test('a running app keeps its lock against a second process with a heartbeat ten minutes old, as after sleep', async () => {
  const root = await collection()
  // No beat for ten minutes by everyone else's clock: the app's timers did not run while asleep.
  const { owner } = ownership({ heartbeatMs: 600_000, env: { now: () => Date.now() - 10 * 60_000 } })
  await owner.claim(root)
  const second = lockChild('race', root, 0, 0)
  expect((await second.finished).lines).toEqual(['busy'])
  expect(owner.owns(root)).toBe(true)
  expect((await onDisk(root)).pid).toBe(process.pid)
}, 20_000)

test('refreshNow rewrites every open Collection\'s heartbeat at once, and index.ts calls it when the system resumes', async () => {
  const [first, second] = [await collection(), await collection()]
  let clock = 1_000_000
  const { owner } = ownership({ heartbeatMs: 600_000, env: { now: () => clock } })
  await owner.claim(first)
  await owner.claim(second)
  const before = [(await onDisk(first)).heartbeatAt, (await onDisk(second)).heartbeatAt]
  clock += 20
  await owner.refreshNow()
  expect((await onDisk(first)).heartbeatAt).toBeGreaterThan(before[0])
  expect((await onDisk(second)).heartbeatAt).toBeGreaterThan(before[1])
  const index = await readFile(join(import.meta.dir, '../../src/main/index.ts'), 'utf8')
  expect(index).toMatch(/powerMonitor\.on\('resume', \(\) => \{ void manager\?\.ownership\.refreshNow\(\) \}\)/)
})

/** Open two Collections as the app, then let another machine's lock arrive by sync over the first's. */
async function lostAndKept(): Promise<{ owner: CollectionOwnership; root: string; other: string; told: string[]; lose: () => Promise<void>; regain: () => Promise<void> }> {
  const [root, other] = [await collection(), await collection()]
  const { owner } = ownership({ heartbeatMs: 600_000 })
  const told: string[] = []
  owner.watch((changed, change) => { told.push(`${change} ${changed}`) })
  await owner.claim(root)
  await owner.claim(other)
  const lose = async (): Promise<void> => {
    const foreign: OwnerLockRecord = { version: 1, pid: 4242, kind: 'app', host: 'some-other-mac', startedAt: Date.now(), heartbeatAt: Date.now(), processStartedAt: null, token: 'foreign' }
    await writeFile(ownerLockPath(root), JSON.stringify(foreign))
    await owner.refreshNow()
  }
  const regain = async (): Promise<void> => {
    await rm(ownerLockPath(root)) // the other machine lets go
    await owner.refreshNow()
  }
  return { owner, root, other, told, lose, regain }
}
/** Every file under `dir` with its bytes, the lock files aside: any write, create or delete changes this. */
async function treeBytes(dir: string, base = dir): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) Object.assign(out, await treeBytes(abs, base))
    else if (!entry.name.startsWith('owner.lock')) out[abs.slice(base.length + 1)] = await readFile(abs, 'utf8')
  }
  return out
}
const refusal = async (write: () => Promise<unknown>): Promise<unknown> => write().then(() => 'was not refused', (caught: unknown) => caught)

test('while the lock is lost, writes to that Collection are refused and the user is told; they resume when it is held again', async () => {
  const { root, other, told, regain, lose } = await lostAndKept()
  const ws = new Workspace(root)
  await ws.saveFile('notes.md', 'first\n')
  await mkdir(join(root, 'talks'))
  await writeFile(join(root, 'talks', 'york.md'), 'york\n')
  const before = await treeBytes(root)
  await lose()
  expect(told).toEqual([`lost ${root}`])
  expect(collectionWritesPaused(root)).toBe(true)
  expect(collectionWritesPaused(other)).toBe(false)

  const refusals = [
    () => ws.saveFile('notes.md', 'second\n'),
    () => ws.saveEditorText('notes.md', 'second\n'),
    () => ws.createFile('new.md', 'new\n'),
    () => ws.duplicateFile('notes.md'),
    () => ws.renameFile('notes.md', 'renamed.md'),
    () => ws.createFolder('folder'),
    () => ws.renameFolder('talks', 'lectures'),
    () => ws.saveImage(new Uint8Array([1, 2, 3]), 'png'),
    () => ws.saveNamedImage(new Uint8Array([1, 2, 3]), 'picture.png'),
    // Deleting a document, as moving a scrap out of its file does, and the trash handlers' own check.
    () => writeMaterial(ws, [{ path: 'notes.md', before: 'first\n', after: null }]),
    async () => { ws.assertWritable() },
    // A Workspace opened on the same Collection later (a rebind, a second reader) is paused too.
    () => new Workspace(root).saveFile('notes.md', 'second\n'),
  ]
  for (const write of refusals) {
    const error = await refusal(write)
    expect(error).toBeInstanceOf(WritesPausedError)
    expect((error as Error).message).toContain('another program')
  }
  // Nothing landed, not even a temporary file; reading still works.
  expect(await treeBytes(root)).toEqual(before)
  expect((await ws.readFile('notes.md')).content).toBe('first\n')
  expect((await ws.listFiles()).map((file) => file.path)).toEqual(['notes.md', 'talks/york.md'])
  // Only the Collection that lost its lock is paused.
  await new Workspace(other).saveFile('notes.md', 'unaffected\n')

  await regain()
  expect(told).toEqual([`lost ${root}`, `regained ${root}`])
  expect(collectionWritesPaused(root)).toBe(false)
  expect((await ws.saveFile('notes.md', 'second\n')).content).toBe('second\n')
  await writeMaterial(ws, [{ path: 'talks/york.md', before: 'york\n', after: null }])
  expect(existsSync(join(root, 'talks', 'york.md'))).toBe(false)
})

test('every store under the Collection asks the same question: versions, scraps, the review ledger and export into the folder are refused while the lock is lost, and work again once it is held', async () => {
  const { root, other, regain, lose } = await lostAndKept()
  const ws = new Workspace(root)
  await ws.saveFile('piece.md', '# Piece\n\nSome words here.\n')
  const versions = new VersionStore(ws)
  const scraps = new ScrapStore(ws)
  const ledger = new ChangeStore(ws)
  const change: NewChange = { path: 'piece.md', provenance: 'agent', editClass: 'content', summary: 'Reworded', oldText: 'Some words here.', newText: 'Other words here.', isCorrection: false }
  // One of each already on disk, so the stores' update and delete paths have something to refuse.
  const version = await versions.append({ path: 'piece.md', name: 'First', author: { name: 'Dom' } })
  const scrap = await scraps.add('piece.md', 'a spare cutting')
  const filed = await ledger.add(change)
  const outside = await mkdtemp(join(tmpdir(), 'wf-ownership-export-'))
  roots.push(outside)
  const before = await treeBytes(root)
  await lose()

  const writes: Record<string, () => Promise<unknown>> = {
    'versions.append': () => versions.append({ path: 'piece.md', name: 'Second', author: { name: 'Dom' } }),
    'versions.appendFirstForPath': () => versions.appendFirstForPath('other.md', async () => ({ name: 'First', author: { name: 'Dom' } })),
    'versions.rename': () => versions.rename(version.id, 'Renamed'),
    'scraps.add': () => scraps.add('piece.md', 'another cutting'),
    'scraps.add to a new file': () => scraps.add('talks/york.md', 'a cutting in a folder not there yet'),
    'scraps.toggleDone': () => scraps.toggleDone(scrap.id),
    'scraps.setColour': () => scraps.setColour(scrap.id, 'yellow'),
    'scraps.remove': () => scraps.remove(scrap.id),
    'ledger.add': () => ledger.add({ ...change, summary: 'Another' }),
    'ledger.setStatus': () => ledger.setStatus(filed.id, 'accepted'),
    'export into the Collection': () => exportDocument(ws, { path: 'piece.md', format: 'html', target: join(root, 'piece.html') }),
    'export into a folder of the Collection': () => exportDocument(ws, { path: 'piece.md', format: 'docx', target: join(root, '.writeflex', 'piece.docx') }),
  }
  for (const [name, write] of Object.entries(writes)) {
    const error = await refusal(write)
    expect(error, name).toBeInstanceOf(Error)
    expect((error as Error).message, name).toContain('another program has taken over the folder')
    // Each fails as its store already reports a failed write: the stores throw it as it is, export
    // words it as its other write failures.
    if (name.startsWith('export')) expect((error as Error).message, name).toStartWith('WriteFlex could not write the file (')
    else expect(error, name).toBeInstanceOf(WritesPausedError)
  }
  expect(await treeBytes(root)).toEqual(before)
  // Reads go on, and a store may still be listed.
  expect((await versions.list()).map((entry) => entry.name)).toEqual(['First'])
  expect((await scraps.list()).map((entry) => entry.text)).toEqual(['a spare cutting'])
  expect((await ledger.list()).map((entry) => entry.summary)).toEqual(['Reworded'])
  // Not gated: an export to somewhere outside the Collection, and every store of another Collection.
  expect((await exportDocument(ws, { path: 'piece.md', format: 'html', target: join(outside, 'piece.html') })).target).toBe(join(outside, 'piece.html'))
  await new VersionStore(new Workspace(other)).append({ path: 'a.md', name: 'Elsewhere', author: { name: 'Dom' } })

  await regain()
  for (const [name, write] of Object.entries(writes)) {
    expect(await refusal(write), name).not.toBeInstanceOf(Error)
  }
  expect((await versions.list()).map((entry) => entry.name)).toContain('Second')
  expect(existsSync(join(root, 'piece.html'))).toBe(true)
  expect((await ledger.list()).length).toBe(2)
}, 20_000)

test('closing a Collection whose lock is lost lifts its pause, so a later open starts clean', async () => {
  const { owner, root, lose } = await lostAndKept()
  await lose()
  expect(collectionWritesPaused(root)).toBe(true)
  await owner.release(root)
  expect(collectionWritesPaused(root)).toBe(false)
})

test('what the user is told when the lock is lost says what is paused and that it resumes by itself', () => {
  const notice = lostNotice('/srv/ada/notes')
  expect(notice.message).toBe('Saving to “notes” is paused')
  expect(notice.detail).toContain('Another program has taken over this folder')
  expect(notice.detail).toContain('Nothing you have typed is lost')
  expect(notice.detail).toContain('resumes by itself')
})

/** An ownership whose only beat is `refreshNow`, with what its watchers were told. */
function stepped(): { owner: CollectionOwnership; log: Array<{ event: string; details: Record<string, unknown> }>; told: string[] } {
  const { owner, log } = ownership({ heartbeatMs: 600_000 })
  const told: string[] = []
  owner.watch((changed, change) => { told.push(`${change} ${changed}`) })
  return { owner, log, told }
}
/** Read-only as the writer meets it: saves and store writes refused in the notice's words, reading untouched. */
async function expectReadOnly(owner: CollectionOwnership, root: string): Promise<void> {
  expect(owner.owns(root)).toBe(false)
  expect(owner.unavailable(root)).toBe(true)
  expect(owner.lost(root)).toBe(false)
  expect(collectionWritesPaused(root)).toBe(true)
  const ws = new Workspace(root)
  for (const write of [
    () => ws.saveFile('notes.md', 'second\n'),
    () => ws.createFile('new.md', 'new\n'),
    () => new VersionStore(ws).append({ path: 'notes.md', name: 'First', author: { name: 'Dom' } }),
    () => new ScrapStore(ws).add('notes.md', 'a cutting'),
  ]) {
    const error = await refusal(write)
    expect(error).toBeInstanceOf(WritesPausedError)
    expect((error as Error).message).toBe(unavailableReason(root))
  }
  expect((await ws.readFile('notes.md')).content).toBe('first\n')
  expect((await ws.listFiles()).map((file) => file.path)).toEqual(['notes.md'])
}

test('a Collection whose .writeflex cannot be written opens read-only; a later beat takes the lock and saving resumes by itself', async () => {
  const root = await collection()
  await writeFile(join(root, 'notes.md'), 'first\n')
  await chmod(join(root, '.writeflex'), 0o555)
  try {
    const { owner, log, told } = stepped()
    expect(await owner.claim(root)).toBe('unlockable')
    expect(log).toEqual([{ event: 'owner-lock.unavailable', details: { root, code: 'EACCES' } }])
    await expectReadOnly(owner, root)
    await owner.refreshNow() // still cannot be taken: nothing changes and nothing new is said
    await expectReadOnly(owner, root)
    expect(told).toEqual([])
    expect(await readdir(join(root, '.writeflex'))).toEqual([])

    await chmod(join(root, '.writeflex'), 0o755)
    await owner.refreshNow()
    expect(owner.owns(root)).toBe(true)
    expect(owner.unavailable(root)).toBe(false)
    expect(collectionWritesPaused(root)).toBe(false)
    expect(told).toEqual([`regained ${root}`])
    expect(await onDisk(root)).toMatchObject({ pid: process.pid, kind: 'app' })
    expect((await new Workspace(root).saveFile('notes.md', 'second\n')).content).toBe('second\n')
    await owner.release(root)
  } finally {
    await chmod(join(root, '.writeflex'), 0o755)
  }
})

test('a Collection whose .writeflex is a link (or a file) opens read-only, and nothing is written where the link points', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'wf-ownership-outside-'))
  roots.push(outside)
  for (const stand of ['link', 'file'] as const) {
    const root = await collection()
    await writeFile(join(root, 'notes.md'), 'first\n')
    await rm(join(root, '.writeflex'), { recursive: true })
    if (stand === 'link') await symlink(outside, join(root, '.writeflex'))
    else await writeFile(join(root, '.writeflex'), 'not a folder')
    const { owner, log, told } = stepped()
    expect(await owner.claim(root), stand).toBe('unlockable')
    expect(log).toEqual([{ event: 'owner-lock.unavailable', details: { root, code: 'not-a-folder' } }])
    await expectReadOnly(owner, root)
    await owner.refreshNow()
    await expectReadOnly(owner, root)
    expect(told).toEqual([])
    expect(await readdir(outside), stand).toEqual([])

    // Put right (the link or file removed), the next beat takes the lock in a real folder.
    await rm(join(root, '.writeflex'))
    await owner.refreshNow()
    expect(owner.owns(root), stand).toBe(true)
    expect(collectionWritesPaused(root)).toBe(false)
    expect(told).toEqual([`regained ${root}`])
    expect(existsSync(ownerLockPath(root))).toBe(true)
    expect(await readdir(outside), stand).toEqual([])
    await owner.release(root)
  }
})

test('a beat that cannot confirm the lock pauses saving and says so once; a beat that can resumes it', async () => {
  const root = await collection()
  await writeFile(join(root, 'notes.md'), 'first\n')
  const { owner, log, told } = stepped()
  expect(await owner.claim(root)).toBe('owned')
  const held = await onDisk(root)
  await chmod(join(root, '.writeflex'), 0o555) // the heartbeat can be read and can no longer be rewritten
  try {
    await owner.refreshNow()
    await expectReadOnly(owner, root)
    expect(told).toEqual([`unavailable ${root}`])
    expect(log.map((entry) => entry.event)).toEqual(['owner-lock.refresh-failed'])
    await owner.refreshNow()
    expect(told).toEqual([`unavailable ${root}`])
    expect(log).toHaveLength(1)
    expect(await onDisk(root)).toEqual(held) // still this app's on disk: nobody else can take it meanwhile
  } finally {
    await chmod(join(root, '.writeflex'), 0o755)
  }
  await owner.refreshNow()
  expect(owner.owns(root)).toBe(true)
  expect(collectionWritesPaused(root)).toBe(false)
  expect(told).toEqual([`unavailable ${root}`, `regained ${root}`])
  expect((await onDisk(root)).token).toBe(held.token)
})

test('what the user is told when the folder cannot be marked as in use: what is paused, why, what still works, and that it resumes by itself', () => {
  expect(unavailableReason('/srv/ada/notes')).toBe('WriteFlex is not saving to “notes” because it cannot mark the folder as in use. Saving resumes by itself when it can.')
  expect(unavailableNotice('/srv/ada/notes')).toEqual({
    message: 'Saving to “notes” is paused',
    detail: 'WriteFlex could not mark this folder as in use, so it is not saving to it: without that mark, another program could change the folder at the same time. '
      + 'You can still read, search and copy. Anything you type stays in the open tabs, marked as not saved. '
      + 'WriteFlex keeps trying, and saving resumes by itself when it can; your next edit, or closing the tab or window, then saves as usual.',
  })
})

test('the request executor is told real ownership, and a window opened without the lock is told so', async () => {
  const main = (file: string): Promise<string> => readFile(join(import.meta.dir, '../../src/main', file), 'utf8')
  expect(await main('ipc.ts')).toContain('ownsCollection: () => stillBound() && ownsRoot(workspace.root),')
  const windows = await main('windows.ts')
  expect(windows).toContain('await bindWorkspace(target, canonicalRoot, this.settings, (root) => this.ownership.owns(root))')
  expect(windows).toContain("if (this.ownership.unavailable(canonicalRoot)) this.#ownershipChanged(canonicalRoot, 'unavailable')")
})

test('what the user is told names the other program, its process number and how long WriteFlex waited', () => {
  const record: OwnerLockRecord = { version: 1, pid: 4242, kind: 'command-line', host: 'Studio', startedAt: 0, heartbeatAt: 0, processStartedAt: null, token: 't' }
  const root = '/srv/ada/Writing/Spring talk'
  const commandLine = busyNotice(new OwnerLockBusyError(root, record, 10_012), 'studio')
  expect(commandLine.message).toBe('“Spring talk” is in use by another program')
  expect(commandLine.detail).toBe('The writeflex command (process number 4242) is writing to this folder. WriteFlex waited 10 seconds and has not opened the folder, so that two programs never change it at the same time.')
  expect(busyNotice(new OwnerLockBusyError(root, { ...record, kind: 'app' }, 10_000), 'Studio').detail).toStartWith('Another WriteFlex window (process number 4242) has this folder open.')
  expect(busyNotice(new OwnerLockBusyError(root, { ...record, kind: 'something-else' as never }, 10_000), 'Studio').detail).toStartWith('A program with process number 4242 has this folder open.')
  expect(busyNotice(new OwnerLockBusyError(root, { ...record, kind: 'app' }, 10_000), 'Laptop').detail).toStartWith('Another WriteFlex window (process number 4242) on Studio has this folder open. If it is closed there, this clears within 2 minutes.')
  expect(busyNotice(new OwnerLockBusyError(root, null, 900), 'Laptop').detail).toStartWith('Another program is writing to this folder. WriteFlex waited 1 second and')
  expect(JSON.stringify(commandLine)).not.toContain('token')
})
