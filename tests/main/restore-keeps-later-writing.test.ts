// Restoring a checkpoint never deletes writing added after it (upkeep ticket 03). A checkpoint taken
// before WriteFlex created a file records the file as absent; Bridle's restore planner deletes it
// without comparing its bytes with anything. Automatic saves never snapshot (ADR-0013 tier 1), so
// prose typed into the file afterwards is nowhere in the journal. The app's one seam to the store,
// `gatedSnapshots(...).restoreTo`, keeps such a file and refuses the whole restore.
//
// Real temporary Collection, real Bridle SnapshotStore opened as the app opens it, real files.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnapshotStore } from '@bridle/core'
import { gatedSnapshots, type CollectionSnapshots } from '../../src/main/gated-snapshots'
import { restoreFailure } from '../../src/main/restore-failure'
import { Workspace } from '../../src/main/workspace'

let root: string
let ws: Workspace
let snapshots: CollectionSnapshots

const SESSION = 'restore-keeps-later-writing'
const INDEX = 'Folio/Index Note.md'
const PART = 'Folio/part-one.md'
const created = '# Folio\n\n- [[part-one]]\n'
const typedLater = `${created}\nA paragraph the writer typed after the step, saved by autosave.\n`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-restore-later-writing-'))
  ws = new Workspace(root)
  await ws.createFile(PART, 'Part one, as it was.\n')
  snapshots = gatedSnapshots(root, await SnapshotStore.open({ dir: join(root, '.bridle'), root }))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** An app step that creates the Index Note: a restore point, the absent snapshot, then the write. */
async function stepCreatingIndexNote(): Promise<string> {
  const point = await snapshots.beginRestorePoint('running order: Folio', SESSION)
  await snapshots.snapshotFile(ws.absolute(INDEX), { sessionId: SESSION, origin: 'host' })
  await ws.createFile(INDEX, created)
  return point
}

const read = (path: string) => readFile(join(root, path), 'utf8')
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

test('a created file the writer typed into after the checkpoint survives the restore, bytes and all', async () => {
  const point = await stepCreatingIndexNote()
  await ws.saveFile(INDEX, typedLater) // autosave: no snapshot

  const error = await snapshots.restoreTo(point, { origin: 'host' }).then(() => null, (thrown: unknown) => thrown)

  expect(error).not.toBeNull()
  expect(existsSync(join(root, INDEX))).toBe(true)
  expect(await read(INDEX)).toBe(typedLater)
  const failure = restoreFailure(error, root)
  expect(failure.kind).toBe('refused')
  expect(failure.notRestored).toEqual([ws.absolute(INDEX)])
  expect(failure.message).toContain(INDEX)
  expect(failure.message).toContain('no file was changed')
})

test('a created file still holding the bytes WriteFlex last recorded is deleted as before', async () => {
  // Recorded in the journal: a snapshot of the file as it stands (a saved version, a later step's snapshot).
  const fromJournal = await stepCreatingIndexNote()
  await snapshots.snapshotFile(ws.absolute(INDEX), { sessionId: SESSION, origin: 'host' })
  expect(await snapshots.restoreTo(fromJournal, { origin: 'host' })).toEqual([ws.absolute(INDEX)])
  expect(existsSync(join(root, INDEX))).toBe(false)

  // Recorded by the caller: the step that wrote it vouches for the bytes it wrote (the undo desks).
  const vouched = await stepCreatingIndexNote()
  expect(await snapshots.restoreTo(vouched, { origin: 'host', written: [{ file: ws.absolute(INDEX), sha256: sha(created) }] })).toEqual([ws.absolute(INDEX)])
  expect(existsSync(join(root, INDEX))).toBe(false)
})

test('the refusal is whole: no other file in that restore is changed', async () => {
  const point = await snapshots.beginRestorePoint('running order: Folio', SESSION)
  await snapshots.snapshotFile(ws.absolute(PART), { sessionId: SESSION, origin: 'host' })
  await snapshots.snapshotFile(ws.absolute(INDEX), { sessionId: SESSION, origin: 'host' })
  await ws.saveFile(PART, 'Part one, as the step left it.\n')
  await ws.createFile(INDEX, created)
  await ws.saveFile(INDEX, typedLater)

  // The caller vouches only for what the step wrote; the later prose is still not what it wrote.
  await expect(snapshots.restoreTo(point, { origin: 'host', written: [{ file: ws.absolute(INDEX), sha256: sha(created) }] })).rejects.toThrow()

  expect(await read(PART)).toBe('Part one, as the step left it.\n')
  expect(await read(INDEX)).toBe(typedLater)
})

// Review round 1 on PR 268.

test('a created file the guard cannot read is never deleted', async () => {
  const point = await stepCreatingIndexNote()
  await ws.saveFile(INDEX, typedLater)
  await chmod(join(root, INDEX), 0o000)
  try {
    await expect(snapshots.restoreTo(point, { origin: 'host' })).rejects.toThrow()
  } finally {
    await chmod(join(root, INDEX), 0o644)
  }
  expect(await read(INDEX)).toBe(typedLater)
})

test('a save by another program as the restore starts is judged with the plan that runs, and kept', async () => {
  const store = await SnapshotStore.open({ dir: join(root, '.bridle'), root })
  snapshots = gatedSnapshots(root, store)
  const point = await stepCreatingIndexNote()
  // After the app's own checks, before Bridle plans: an atomic save (a new file renamed over the name).
  const restoreTo = store.restoreTo.bind(store)
  store.restoreTo = async (...args: Parameters<typeof restoreTo>) => {
    await writeFile(join(root, 'outside-save.tmp'), typedLater)
    await rename(join(root, 'outside-save.tmp'), join(root, INDEX))
    return restoreTo(...args)
  }
  await expect(snapshots.restoreTo(point, { origin: 'host' })).rejects.toThrow('writing added after')
  expect(await read(INDEX)).toBe(typedLater)
})
