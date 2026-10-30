import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { SnapshotStore, scriptedSessionFactory } from '@bridle/core'
import { WorkspaceAgent, buildE2EScriptedTurn } from '../../src/main/agent'
import { assertCollectionWritable, collectionWritesPaused, pauseCollectionWrites, pausedMessage, resumeCollectionWrites, WritesPausedError } from '../../src/main/collection-write-gate'
import { gatedSnapshots } from '../../src/main/gated-snapshots'
import { Workspace } from '../../src/main/workspace'

// Carried from ticket 09 into ticket 07: the gate judges the canonical target, and this app's own
// calls into the history store under `.bridle` ask the gate. (The desks and the diary are covered
// beside their other tests: plan-propose, board-material-desk, diary.)
let base: string
let root: string
let appData: string
const REASON = 'Saving is paused for this test.'

beforeEach(async () => {
  base = realpathSync(await mkdtemp(join(tmpdir(), 'wf-write-gate-')))
  root = join(base, 'Collection')
  appData = await mkdtemp(join(tmpdir(), 'wf-write-gate-data-'))
  await mkdir(join(root, 'talks'), { recursive: true })
  await writeFile(join(root, 'talks', 'york.md'), '# York\n')
})
afterEach(async () => {
  resumeCollectionWrites(root)
  await rm(base, { recursive: true, force: true })
  await rm(appData, { recursive: true, force: true })
})

test('the gate judges where a target really is: a link to the Collection, ".." and another spelling are the same place', async () => {
  await symlink(root, join(base, 'way-in'))
  await symlink(join(root, 'talks'), join(base, 'talks-link'))
  await mkdir(join(base, 'Collection-other'))
  pauseCollectionWrites(root, REASON)
  const inside = [
    root, join(root, 'talks', 'york.md'), join(root, 'not', 'there', 'yet.md'),
    join(base, 'way-in'), join(base, 'way-in', 'talks', 'york.md'), join(base, 'way-in', 'new.md'), join(base, 'talks-link', 'new.md'),
    `${base}/Collection-other/../Collection/talks/york.md`, `${root}/talks/../new.md`, `${root}/`, `${base}//Collection/./new.md`,
    // /var and /private/var on macOS: the temporary folder as it is usually named, not as it resolves.
    ...(tmpdir() === realpathSync(tmpdir()) ? [] : [join(tmpdir(), basename(base), 'Collection', 'new.md')]),
  ]
  for (const path of inside) {
    expect(collectionWritesPaused(path), path).toBe(true)
    expect(() => assertCollectionWritable(path), path).toThrow(WritesPausedError)
    expect(pausedMessage(path), path).toBe(REASON)
  }
  // On a disk that ignores case, the other spelling is the same folder.
  if (existsSync(join(base, 'COLLECTION'))) expect(collectionWritesPaused(join(base, 'COLLECTION', 'Talks', 'new.md'))).toBe(true)
  for (const path of [base, join(base, 'Collection-other'), join(base, 'Collection-other', 'new.md'), dirname(base), join(root, '..', 'elsewhere.md')]) {
    expect(collectionWritesPaused(path), path).toBe(false)
  }
  resumeCollectionWrites(root)
  for (const path of inside) expect(collectionWritesPaused(path), path).toBe(false)
})

test('a Collection paused under a name that is itself a link is paused under its real name too', async () => {
  await symlink(root, join(base, 'way-in'))
  pauseCollectionWrites(join(base, 'way-in'), REASON)
  try {
    expect(collectionWritesPaused(join(root, 'talks', 'york.md'))).toBe(true)
    expect(collectionWritesPaused(join(base, 'way-in', 'talks', 'york.md'))).toBe(true)
  } finally {
    resumeCollectionWrites(join(base, 'way-in'))
  }
  expect(collectionWritesPaused(join(root, 'talks', 'york.md'))).toBe(false)
})

const history = async (): Promise<Record<string, string>> => {
  const out: Record<string, string> = {}
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out[join(entry.parentPath, entry.name).slice(root.length + 1)] = await readFile(join(entry.parentPath, entry.name), 'utf8')
  }
  return out
}
const refusal = async (write: () => Promise<unknown>): Promise<unknown> => write().then(() => 'was not refused', (caught: unknown) => caught)

test('the history store handed to this app refuses every write while the Collection is paused, and reads go on', async () => {
  const raw = await SnapshotStore.open({ dir: join(root, '.bridle') })
  const store = gatedSnapshots(root, raw)
  const point = await store.beginRestorePoint('turn: before', 's')
  const taken = await store.snapshotFile(join(root, 'talks', 'york.md'), { sessionId: 's', origin: 'turn' })
  await writeFile(join(root, 'talks', 'york.md'), '# York, changed\n')
  const before = await history()
  pauseCollectionWrites(root, REASON)
  for (const write of [
    () => store.beginRestorePoint('turn: paused', 's'),
    () => store.snapshotFile(join(root, 'talks', 'york.md'), { sessionId: 's' }),
    () => store.restoreTo(point, { origin: 'turn' }),
  ]) {
    const error = await refusal(write)
    expect(error).toBeInstanceOf(WritesPausedError)
    expect((error as Error).message).toBe(REASON)
  }
  expect(await history()).toEqual(before)
  expect(await store.readSnapshotContent(taken.id)).toBe('# York\n')
  expect((await store.entries()).length).toBe(2)
  resumeCollectionWrites(root)
  expect(await store.restoreTo(point, { origin: 'turn' })).toEqual([join(root, 'talks', 'york.md')])
  expect(await readFile(join(root, 'talks', 'york.md'), 'utf8')).toBe('# York\n')
})

test('the agent\'s own history writes ask the gate: version snapshot, checkpoint and undo turn write nothing while paused', async () => {
  const workspace = new Workspace(root)
  const steps = [{ cap: 'housekeeping.create_file', input: { path: 'talks/agent.md', content: '# Agent\n' } }]
  const agent = await WorkspaceAgent.create({ mode: 'work', workspace, appDataDir: appData, sessionFactory: scriptedSessionFactory([buildE2EScriptedTurn(steps)]), onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {} })
  try {
    // Undo now requires a recorded turn, rather than a hand-labelled snapshot.
    await agent.runScriptedTurn('Create a note', steps)
    const before = await history()
    pauseCollectionWrites(root, REASON)
    for (const write of [() => agent.snapshotReviewVersion('talks/york.md'), () => agent.restoreLastTurn()]) {
      const error = await refusal(write)
      expect(error).toBeInstanceOf(WritesPausedError)
    }
    // A checkpoint follows a save; the save is what reports the refusal, the checkpoint just is not taken.
    await agent.checkpointFile('talks/york.md')
    expect(await history()).toEqual(before)

    resumeCollectionWrites(root)
    await agent.checkpointFile('talks/york.md')
    expect(Object.keys(await history()).length).toBe(Object.keys(before).length + 1)
    expect((await agent.snapshotReviewVersion('talks/york.md')).snapshotId).toBeTruthy()
    expect(await agent.restoreLastTurn()).toEqual([join(root, 'talks', 'agent.md')])
    expect(existsSync(join(root, 'talks', 'agent.md'))).toBe(false)
    expect(await readFile(join(root, 'talks', 'york.md'), 'utf8')).toBe('# York\n')
  } finally {
    await agent.dispose()
  }
})
