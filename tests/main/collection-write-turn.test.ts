/**
 * Review parcel P8 (second adjudication, decision 1): one write turn per Collection. Seams:
 * `CollectionWriteTurn` itself, and the Workspace's `exclusive` / `exclusiveAll` with the saves that
 * ask for the same turn. Each test runs the schedule that broke the per-path queue it replaces
 * (reviewer's findings 3, 4 and 5). Order is shown by an event log and by handshakes (a writer is
 * released by the test, and `waiting` says who is queued), never by a clock: a test that would
 * deadlock times out.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { AsyncResource } from 'node:async_hooks'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CollectionWriteTurn } from '../../src/main/collection-write-turn'
import { documentOnlyView } from '../../src/main/document-only-workspace'
import { repairRename } from '../../src/main/rename-repair'
import { ScrapStore } from '../../src/main/scraps'
import { Workspace } from '../../src/main/workspace'

type Deferred = { promise: Promise<void>; resolve: () => void }
const deferred = (): Deferred => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
/**
 * Start `work` as ANOTHER writer would. Which turn code belongs to is carried by the async context,
 * so anything a turn starts belongs to it; a second writer is one started from outside it. This is
 * bound here, at the top of the file, where no turn is running.
 */
const elsewhere = AsyncResource.bind(<T>(work: () => T): T => work())
/** Let everything that can run, run: several turns of the event loop, no clock. */
const settle = async (): Promise<void> => { for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve)) }

test('turns run one at a time, in the order they were asked for, whatever each one writes', async () => {
  const turn = new CollectionWriteTurn()
  const log: string[] = []
  const gate = deferred()
  const first = turn.run(async () => { log.push('first in'); await gate.promise; log.push('first out') })
  const second = turn.run(async () => { log.push('second in'); await settle(); log.push('second out') })
  const third = turn.run(async () => { log.push('third') })
  await settle()
  expect(log).toEqual(['first in'])
  expect(turn.waiting).toBe(2)
  gate.resolve()
  await Promise.all([first, second, third])
  expect(log).toEqual(['first in', 'first out', 'second in', 'second out', 'third'])
  expect(turn.waiting).toBe(0)
})

test('a turn resolves with its work\'s result; a turn that fails does not block the next', async () => {
  const turn = new CollectionWriteTurn()
  const failed = turn.run(async () => { throw new Error('the disk refused') })
  const thrown = turn.run(() => { throw new Error('thrown before any await') })
  const next = turn.run(async () => 'ran')
  await expect(failed).rejects.toThrow('the disk refused')
  await expect(thrown).rejects.toThrow('thrown before any await')
  expect(await next).toBe('ran')
  expect(turn.waiting).toBe(0)
})

test('code inside the turn that asks for it again runs at once, however deep, while others stay queued behind it', async () => {
  const turn = new CollectionWriteTurn()
  const log: string[] = []
  const held = turn.run(async () => {
    const queued = elsewhere(() => turn.run(async () => { log.push('queued writer') }))
    void queued
    await settle()
    expect(turn.waiting).toBe(1)
    expect(await turn.run(async () => {
      await turn.run(async () => { log.push('nested twice') })
      return 'its result'
    })).toBe('its result')
    await expect(turn.run(async () => { throw new Error('nested failure') })).rejects.toThrow('nested failure')
    log.push('holder done')
  })
  await held
  await settle()
  expect(log).toEqual(['nested twice', 'holder done', 'queued writer'])
})

test('finding 3 schedule: with two writers queued (one of them for two documents), a turn that asks again from inside is not held up by them, and the chain drains', async () => {
  // The per-path queue: A held a.md, C queued for [a.md, b.md] and reserved b.md, A asked for b.md
  // from inside and waited on C's reservation while C waited on A. Two waiters never left.
  const workspaceLike = new CollectionWriteTurn()
  const log: string[] = []
  const gate = deferred()
  const a = workspaceLike.run(async () => {
    log.push('A in')
    await gate.promise
    // B and C are queued by now. A asks for "another document" from inside its turn.
    await workspaceLike.run(async () => { log.push('A nested') })
    log.push('A out')
  })
  const b = elsewhere(() => workspaceLike.run(async () => { log.push('B') }))
  const c = elsewhere(() => workspaceLike.run(async () => { log.push('C') }))
  await settle()
  expect(log).toEqual(['A in'])
  expect(workspaceLike.waiting).toBe(2)
  gate.resolve()
  await Promise.all([a, b, c])
  expect(log).toEqual(['A in', 'A nested', 'A out', 'B', 'C'])
  // Idle: nobody is left waiting, and the next caller runs.
  expect(workspaceLike.waiting).toBe(0)
  expect(await workspaceLike.run(async () => 'idle chain runs the next caller')).toBe('idle chain runs the next caller')
})

test('finding 4 schedule: work a turn started and did not await, still running after the turn ended, waits for the turn like a stranger', async () => {
  // The per-path queue: the detached work kept a copy of its parent's paths and entered a document
  // while another writer held it.
  const turn = new CollectionWriteTurn()
  const log: string[] = []
  const release = { detached: deferred(), other: deferred() }
  let detached!: Promise<void>
  await turn.run(async () => {
    log.push('parent in')
    // Started inside the turn, in the turn's own context, and not awaited. Its inner work was begun
    // while the parent ran (so it is "nested"), and it asks for the turn again only later.
    detached = turn.run(async () => {
      await release.detached.promise
      log.push('detached asks')
      await turn.run(async () => { log.push('detached in') })
    })
    log.push('parent out')
  })
  const other = turn.run(async () => { log.push('other in'); await release.other.promise; log.push('other out') })
  await settle()
  expect(log).toEqual(['parent in', 'parent out', 'other in'])
  release.detached.resolve()
  await settle()
  // It asked while the other writer holds the turn: it is queued, not let in beside it.
  expect(log).toEqual(['parent in', 'parent out', 'other in', 'detached asks'])
  expect(turn.waiting).toBe(1)
  release.other.resolve()
  await Promise.all([other, detached])
  expect(log).toEqual(['parent in', 'parent out', 'other in', 'detached asks', 'other out', 'detached in'])
})

test('detached work that outlived its turn and asks again when no turn is running is given a turn of its own, not its parent\'s', async () => {
  const turn = new CollectionWriteTurn()
  const log: string[] = []
  const gate = deferred()
  const blocker = deferred()
  let detached!: Promise<void>
  await turn.run(async () => {
    detached = gate.promise.then(() => turn.run(async () => { log.push('detached in'); await blocker.promise; log.push('detached out') }))
  })
  gate.resolve()
  await settle()
  const stranger = turn.run(async () => { log.push('stranger') })
  await settle()
  expect(log).toEqual(['detached in'])
  expect(turn.waiting).toBe(1)
  blocker.resolve()
  await Promise.all([detached, stranger])
  expect(log).toEqual(['detached in', 'detached out', 'stranger'])
})

test('a detached child that throws, inside its parent\'s turn or after it, does not poison the chain', async () => {
  const turn = new CollectionWriteTurn()
  const gate = deferred()
  let during!: Promise<unknown>
  let after!: Promise<unknown>
  await turn.run(async () => {
    during = turn.run(async () => { throw new Error('child failed during the turn') })
    after = gate.promise.then(() => turn.run(async () => { throw new Error('child failed after the turn') }))
    // Neither is awaited by the turn. Handlers are attached so the failures are observed below.
    during.catch(() => {})
    after.catch(() => {})
  })
  gate.resolve()
  await expect(during).rejects.toThrow('child failed during the turn')
  await expect(after).rejects.toThrow('child failed after the turn')
  expect(await turn.run(async () => 'the next turn runs')).toBe('the next turn runs')
  expect(turn.waiting).toBe(0)
})

// ---- The Workspace: every write asks for the same one turn ----

let root: string
let workspace: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-turn-root-'))
  workspace = new Workspace(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')

test('the editor\'s save, a plain save, a create, a capability\'s save, a pasted picture, a scrap and a writer of ANOTHER document all wait for the turn', async () => {
  await writeFile(join(root, 'a.md'), 'one\n')
  const view = documentOnlyView(workspace).workspace
  const scraps = new ScrapStore(workspace)
  const gate = deferred()
  const holder = workspace.exclusive('a.md', async () => { await gate.promise })
  await settle()
  const writers = [
    // The editor's save says which version it was based on (save fix): the one on disk when it was typed.
    workspace.saveEditorText('a.md', 'two\n', { kind: 'disk', text: 'one\n' }),
    workspace.saveFile('a.md', 'three\n'),
    view.saveFile('a.md', 'four\n'),
    workspace.createFile('b.md', 'new\n'),
    workspace.saveImage(new Uint8Array([1, 2, 3]), 'png'),
    scraps.add('a.md', 'An offcut.'),
    workspace.exclusiveAll(async () => {}),
  ]
  await settle()
  expect(workspace.writersWaiting).toBe(writers.length)
  expect(await read('a.md')).toBe('one\n')
  expect(await Bun.file(join(root, 'b.md')).exists()).toBe(false)
  gate.resolve()
  await Promise.all([holder, ...writers])
  expect(await read('a.md')).toBe('four\n')
  expect(await read('b.md')).toBe('new\n')
  expect(workspace.writersWaiting).toBe(0)
})

test('finding 5 schedule: one document written through a folder link and by its own name is one Collection, one turn: the second writer waits for the first', async () => {
  // The per-path queue gave `notes/a.md` and `alias/a.md` different keys, so both writers ran at once.
  await mkdir(join(root, 'notes'))
  await writeFile(join(root, 'notes/a.md'), 'as it was\n')
  await symlink(join(root, 'notes'), join(root, 'alias'))
  const log: string[] = []
  const gate = deferred()
  const direct = workspace.exclusive('notes/a.md', async () => {
    log.push(`direct read: ${await read('notes/a.md')}`)
    await gate.promise
    await workspace.saveFile('notes/a.md', 'written by its own name\n')
    log.push('direct saved')
  })
  await settle()
  const linked = elsewhere(async () => {
    await workspace.saveFile('alias/a.md', 'written through the link\n')
    log.push('linked saved')
  })
  await settle()
  // Still as the first writer read it: the save through the link has not run.
  expect(workspace.writersWaiting).toBe(1)
  expect(await read('notes/a.md')).toBe('as it was\n')
  gate.resolve()
  await Promise.all([direct, linked])
  expect(log).toEqual(['direct read: as it was\n', 'direct saved', 'linked saved'])
  expect(await read('notes/a.md')).toBe('written through the link\n')
})

test('a writer inside a turn can save a document, save a second one, rename one, copy one and rename a folder, with other writers queued behind it', async () => {
  for (const name of ['a.md', 'b.md', 'm.md']) await writeFile(join(root, name), `${name}\n`)
  const queued: Array<Promise<unknown>> = []
  await workspace.exclusive('m.md', async () => {
    // Based on the version the editor saw (save fix): the holder's rewrite is a version it did not see, so
    // the queued save, when its turn comes, is refused and writes nothing over it.
    queued.push(elsewhere(() => workspace.saveEditorText('m.md', 'm.md, saved by the editor afterwards\n', { kind: 'disk', text: 'm.md\n' }).then(() => 'saved', (error: Error) => error.name)))
    await settle()
    expect(workspace.writersWaiting).toBe(1)
    await workspace.saveFile('m.md', 'rewritten by its holder\n')
    await workspace.saveFile('n.md', 'a second document\n')
    await workspace.saveFile('a.md', 'a third, earlier in name order\n')
    await workspace.renameFile('b.md', 'c.md')
    await workspace.duplicateFile('m.md')
    await workspace.renameFolder((await workspace.createFolder('drafts')).path, 'kept')
    expect(await read('m.md')).toBe('rewritten by its holder\n')
    expect(workspace.writersWaiting).toBe(1)
  })
  expect(await Promise.all(queued)).toEqual(['DiskChangedUnderBuffer'])
  expect(await read('m.md')).toBe('rewritten by its holder\n')
  expect(await read('m (copy).md')).toBe('rewritten by its holder\n')
  expect(await read('c.md')).toBe('b.md\n')
  expect(await read('a.md')).toBe('a third, earlier in name order\n')
})

test('a rename with its repair of every document that links to the renamed one finishes inside one turn, with saves of those documents queued until it ends', async () => {
  const refs = Array.from({ length: 12 }, (_, index) => `ref-${String(index + 1).padStart(2, '0')}.md`)
  const typed = 'See [[new]].\n\nAnd a line typed meanwhile.\n'
  await writeFile(join(root, 'old.md'), '# Old heading\n')
  for (const ref of refs) await writeFile(join(root, ref), 'See [[old]].\n')
  let queued: Array<Promise<unknown>> = []
  // As a request carried out for the command line: the one writer of the Collection while it runs.
  await workspace.exclusiveAll(async () => {
    // Based on the version the editor saw (save fix): the repaired text is one it did not see.
    queued = refs.map((ref) => elsewhere(() => workspace.saveEditorText(ref, typed, { kind: 'disk', text: 'See [[old]].\n' }).then(() => 'saved', (error: Error) => error.name)))
    await settle()
    expect(workspace.writersWaiting).toBe(refs.length)
    await workspace.renameFile('old.md', 'new.md')
    const result = await repairRename(workspace, 'old.md', 'new.md')
    expect(result.writtenPaths.sort()).toEqual(refs)
    for (const ref of refs) expect(await read(ref)).toBe('See [[new]].\n')
    expect(workspace.writersWaiting).toBe(refs.length)
  })
  // Each queued save ran after the repair and was refused, writing nothing over the repaired link.
  expect(await Promise.all(queued)).toEqual(refs.map(() => 'DiskChangedUnderBuffer'))
  for (const ref of refs) expect(await read(ref)).toBe('See [[new]].\n')
  expect(workspace.writersWaiting).toBe(0)
})
