import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChangeStore } from '../../src/main/changes'
import { newRequestId } from '../../src/main/cli/request-format'
import { waitForRequestDisposals, watchRequestInbox } from '../../src/main/request-inbox-watch'
import { requestedVersionSave, type VersionSaveBinding, type VersionSnapshotAgent } from '../../src/main/requested-version-save'
import { snapshotVersionOfSavedText } from '../../src/main/saved-text-version'
import { VersionStore } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'
import { writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'
import { content, inboxNames, openAsApp, plantRequest, type AppSide } from '../helpers/request-app'

// Ticket 07, review round: an executor, and the version save it is given, belong to ONE Collection
// for their whole life. A window bound to another Collection, or closed, while a request is in
// flight must end with that request refused, never carried out somewhere else.
let a: WriteFixture
let b: WriteFixture
let links: string
const apps: AppSide[] = []

beforeEach(async () => {
  a = await writeFixture()
  b = await writeFixture()
  links = realpathSync(await mkdtemp(join(tmpdir(), 'wf-binding-links-')))
})
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close()
  await a.dispose()
  await b.dispose()
  await rm(links, { recursive: true, force: true })
})

const stores = async (fx: WriteFixture): Promise<Record<string, string>> =>
  Object.fromEntries(Object.entries(await fx.snapshot()).filter(([path]) => path.startsWith('.bridle/') || path.startsWith('.writeflex/versions') || path.startsWith('.writeflex/changes')))
/** An agent of the Collection at `root`, as far as a version save uses one. */
const agentOf = (root: string): VersionSnapshotAgent => {
  const workspace = new Workspace(root)
  return {
    workspace,
    snapshotReviewVersion: async (path) => {
      const { SnapshotStore } = await import('@bridle/core')
      return snapshotVersionOfSavedText({ workspace, snapshots: await SnapshotStore.open({ dir: join(root, '.bridle') }), sessionId: 'app-session', path })
    },
  }
}
const bindingFor = (root: string, extra: Partial<VersionSaveBinding> = {}): VersionSaveBinding => {
  const workspace = new Workspace(root)
  return { workspace, versions: new VersionStore(workspace), changes: new ChangeStore(workspace), live: () => true, author: async () => ({ name: 'App Writer' }), agent: async () => agentOf(root), ...extra }
}
const owner = async (): Promise<void> => {}
const INPUT = { path: 'notes.md', name: 'Asked for' }
const refusal = async (work: Promise<unknown>): Promise<string> => work.then(() => 'was not refused', (error: unknown) => (error as Error).message)
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve }
}

test('a save bound to its Collection saves there, also when the Collection is named through a link', async () => {
  await symlink(a.root, join(links, 'way-in'))
  const saved = await requestedVersionSave(bindingFor(join(links, 'way-in'), { agent: async () => agentOf(a.root) }))(INPUT, owner)
  expect(saved.record).toMatchObject({ path: 'notes.md', name: 'Asked for', author: { name: 'App Writer' } })
  expect((await new VersionStore(new Workspace(a.root)).list({ path: 'notes.md' })).map((version) => version.id)).toEqual([saved.record.id])
})

test('a window bound to another Collection while a save waits for its agent: the save is refused and neither Collection is written', async () => {
  const before = { a: await stores(a), b: await stores(b) }
  let live = true
  const waiting = deferred<VersionSnapshotAgent | null>()
  const told: string[] = []
  const save = requestedVersionSave(bindingFor(a.root, { live: () => live, agent: () => waiting.promise, onSaved: () => { told.push('saved') } }))
  const result = refusal(save(INPUT, owner))
  // The window is bound to B: what it now calls "the current agent" is B's.
  live = false
  waiting.resolve(agentOf(b.root))
  expect(await result).toContain('no longer has this Collection open')
  expect({ a: await stores(a), b: await stores(b) }).toEqual(before)
  expect(told).toEqual([])

  // Bound away between the snapshot and the version record: the record is not written either.
  live = true
  let asked = 0
  const late = refusal(requestedVersionSave(bindingFor(a.root, { live: () => live }))(INPUT, async () => { asked += 1; if (asked === 2) live = false }))
  expect(await late).toContain('no longer has this Collection open')
  expect((await stores(a))['.writeflex/versions.jsonl']).toBe(before.a['.writeflex/versions.jsonl'])
  expect(await stores(b)).toEqual(before.b)
})

test('an agent or a store of another Collection is never used, even while the binding is live', async () => {
  const before = { a: await stores(a), b: await stores(b) }
  const otherWorkspace = new Workspace(b.root)
  const cases: Array<[string, Partial<VersionSaveBinding>]> = [
    ['no longer has this Collection open', { agent: async () => agentOf(b.root) }],
    ['belong to another Collection', { versions: new VersionStore(otherWorkspace) }],
    ['belong to another Collection', { changes: new ChangeStore(otherWorkspace) }],
    ['no history store open', { agent: async () => null }],
  ]
  for (const [phrase, extra] of cases) {
    expect(await refusal(requestedVersionSave(bindingFor(a.root, extra))(INPUT, owner)), phrase).toContain(phrase)
    expect({ a: await stores(a), b: await stores(b) }, phrase).toEqual(before)
  }
})

test('an executor disposed while it carries out a request refuses it, puts back what it wrote, and leaves the requests it had not read', async () => {
  const seen: string[] = []
  let disposed: Promise<void> | null = null
  let idle = false
  const app: AppSide = await openAsApp(a, { seams: { write: { beforeWrite: async (path) => {
    seen.push(path)
    // The move is made and one file repaired: now the window is bound to another Collection.
    if (seen.length === 4) disposed = app.executor.dispose().then(() => { idle = true })
  } } } })
  apps.push(app)
  const before = await content(a)
  const first = await plantRequest(a, 'move', { path: 'talks/york.md', to: 'talks/york-2026.md' }, { id: newRequestId(new Date(Date.now() - 2000)) })
  const second = await plantRequest(a, 'create', { path: 'made-later.md', content: 'x' }, { id: newRequestId(new Date(Date.now() - 1000)) })
  const drained = await app.executor.drain()
  expect(seen.length).toBeGreaterThanOrEqual(4)
  expect(drained.handled).toMatchObject([{ id: first, outcome: 'refused', operation: 'move' }])
  expect(drained.handled[0].reason).toContain('WriteFlex closed this Collection while the request was being carried out')
  expect(drained.handled[0].reason).toContain('put back')
  expect(idle).toBe(false) // it was not idle while the request ran
  await disposed
  // Everything is as it was, and the second request was not read, answered or carried out.
  expect(await content(a)).toEqual(before)
  expect(await inboxNames(a)).toEqual([`${second}.json`])
  expect(existsSync(join(a.root, 'made-later.md'))).toBe(false)
  // Nothing further is ever carried out by it; the refused request is on record, so no later executor runs it either.
  expect(await app.executor.drain()).toEqual({ handled: [], ignored: [] })
  expect(await inboxNames(a)).toEqual([`${second}.json`])
  await plantRequest(a, 'move', { path: 'talks/york.md', to: 'talks/york-2026.md' }, { id: first })
  const again = await app.restarted().drain()
  expect(again.handled.find((handled) => handled.id === first)).toMatchObject({ outcome: 'refused', repeat: true })
  expect(existsSync(join(a.root, 'talks/york.md'))).toBe(true)
})

test('a requested version save in flight when its executor is disposed writes no store', async () => {
  const waiting = deferred<VersionSnapshotAgent | null>()
  let asked!: () => void
  const reached = new Promise<void>((done) => { asked = done })
  const app = await openAsApp(a, { saveVersion: requestedVersionSave(bindingFor(a.root, { agent: () => { asked(); return waiting.promise } })) })
  apps.push(app)
  const before = await stores(a)
  const id = await plantRequest(a, 'save-version', { path: 'notes.md', name: 'In flight' })
  const draining = app.executor.drain()
  await reached
  const disposed = app.executor.dispose()
  waiting.resolve(agentOf(a.root))
  expect((await draining).handled).toMatchObject([{ id, outcome: 'refused', operation: 'save-version' }])
  await disposed
  expect(await stores(a)).toEqual(before)
})

test('disposing the inbox watch disposes its executor, and is not settled until the request in flight has ended', async () => {
  let entered!: () => void
  let release!: () => void
  const inside = new Promise<void>((done) => { entered = done })
  const held = new Promise<void>((done) => { release = done })
  const app = await openAsApp(a, { seams: { write: { beforeWrite: async () => { entered(); await held } } } })
  apps.push(app)
  const watching = watchRequestInbox(app.executor, { pollMs: 5 })
  await plantRequest(a, 'create', { path: 'asked.md', content: 'x' })
  await inside
  let settled = false
  const disposal = watching.dispose().then(() => { settled = true })
  let waited = false
  const lockHolder = waitForRequestDisposals().then(() => { waited = true })
  await new Promise((done) => { setTimeout(done, 60) })
  expect({ settled, waited }).toEqual({ settled: false, waited: false })
  release()
  await disposal
  await lockHolder
  expect(existsSync(join(a.root, 'asked.md'))).toBe(false)
  expect(await app.executor.drain()).toEqual({ handled: [], ignored: [] })
})
