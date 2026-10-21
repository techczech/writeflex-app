/**
 * Second-review parcel P10, invariant 2: an undo of a folder move with an Index Note, killed at any
 * point including before the entry is marked undone, is completed or refused file by file by the next
 * `writeflex undo`, and never throws "neither ... is there".
 *
 * The entry holds two moves, the folder (`talks` -> `events`) and then its Index Note inside the new
 * name (`events/_talks_INDEX.md` -> `events/_events_INDEX.md`). Undo reverses the note, then the folder.
 * Once the folder is back, both names of the note's move are under `events`, which is gone.
 *
 * Schedules: the undo killed (SIGKILL, in a child) at each of its write steps, and after its last change
 * to the Collection before `markUndone` (the `mark-undone` seam); and an undo that reversed both moves
 * but refused a file somebody had edited, finished later.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { childKiller, withChildren } from '../helpers/cli-killed-write'
import { writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'

let fx: WriteFixture
const killer = childKiller()
const INDEX = '# Talks\n\nThe talks, in order: [[york]], then [[intro]].\n'
const LINKING = '# Reading list\n\nStart at [[_talks_INDEX]], then [[_talks_INDEX|the talks index]].\n'
beforeEach(async () => {
  fx = await writeFixture()
  await fx.write('talks/_talks_INDEX.md', INDEX)
  await fx.write('reading.md', LINKING)
  await fx.write('more-reading.md', LINKING)
})
afterEach(async () => {
  await killer.endAll()
  await fx.dispose()
})

const moveFolder = async (f: WriteFixture): Promise<string> => {
  const moved = await f.cli(['move-folder', 'talks', 'events'])
  expect(moved.json.error?.message ?? '').toBe('')
  expect(moved.json.result).toMatchObject({ indexNote: { from: 'talks/_talks_INDEX.md', to: 'events/_events_INDEX.md' } })
  return moved.json.result!.undo as string
}

/** How many write steps the undo of the folder move takes, counted on a run that is not killed. */
async function undoSteps(f: WriteFixture): Promise<number> {
  await moveFolder(f)
  let steps = 0
  const undone = await f.cli(['undo'], { write: { seams: { beforeWrite: async () => { steps += 1 } } } })
  expect(undone.json.error?.message ?? '').toBe('')
  return steps
}

test('an undo of a folder move with its Index Note, killed at each write and before it is marked undone, is finished by the next undo', async () => {
  const f = fx
  const before = await f.snapshot()
  const steps = await undoSteps(f)
  expect(await f.snapshot()).toEqual(before)
  // The note back, the folder back, and the repaired files: more than the two moves.
  expect(steps).toBeGreaterThan(2)
  const stops: Array<number | 'mark-undone'> = [...Array.from({ length: steps }, (_, i) => i + 1), 'mark-undone']
  for (const stop of stops) {
    const id = await moveFolder(f)
    await killer.killedAt(f, stop, ['undo'])
    if (stop === 'mark-undone') {
      // The kill fell where it was meant to: everything is back on disk, and the entry is not marked undone.
      expect(await f.snapshot(), `stop ${stop}`).toEqual(before)
      expect(existsSync(join(f.root, 'events')), `stop ${stop}`).toBe(false)
    }
    const listed = (await f.cli(['undo', '--list'])).json.result!.changes as Array<{ id: string; undone: boolean; undoStopped: boolean }>
    expect(listed.find((row) => row.id === id), `stop ${stop}`).toMatchObject({ undone: false })

    const finished = await f.cli(['undo'])
    expect(finished.json.error?.message ?? '', `stop ${stop}`).toBe('')
    expect(finished.json.result, `stop ${stop}`).toMatchObject({ undone: id })
    expect(await f.snapshot(), `stop ${stop}`).toEqual(before)
    expect((await f.journalNames()).filter((name) => name.endsWith('.intent.jsonl')), `stop ${stop}`).toEqual([])
    expect((await f.cli(['undo', id])).json.error!.message, `stop ${stop}`).toContain('already undone')
  }
}, withChildren(12))

test('an undo that moved the folder and its Index Note back but refused an edited file is finished later, with the note judged under the folder\'s old name', async () => {
  const f = fx
  const before = await f.snapshot()
  const id = await moveFolder(f)
  const after = await f.snapshot()
  // Killed at its second write: one repaired file put back, the moves not yet reversed.
  await killer.killedAt(f, 2, ['undo'])
  const state = await f.snapshot()
  const pending = Object.keys(after).filter((path) => !path.startsWith('events/') && state[path] === after[path] && after[path] !== before[path])
  expect(pending.length).toBeGreaterThan(0)
  const edited = pending[0]
  const mine = `${await f.read(edited)}\nA line the writer added since.\n`
  await f.write(edited, mine)

  // The resumed undo moves the note and the folder back, puts the rest back, and refuses the edited file.
  const refused = await f.cli(['undo'])
  expect(refused.code).toBe(1)
  expect(refused.json.error!.message).toContain(`${edited} has changed since the command line wrote it`)
  expect(existsSync(join(f.root, 'events'))).toBe(false)
  expect(await f.read('talks/_talks_INDEX.md')).toBe(INDEX)
  expect((await f.cli(['undo', '--list'])).json.result!.changes).toMatchObject([{ id, undone: false, undoStopped: true }])

  // With the file as the command line left it, the next undo judges both moves as reversed and finishes.
  await f.write(edited, Buffer.from(after[edited], 'base64'))
  const finished = await f.cli(['undo'])
  expect(finished.json.error?.message ?? '').toBe('')
  expect(finished.json.result).toMatchObject({ undone: id, resumed: true, restored: [edited] })
  expect(await f.snapshot()).toEqual(before)
}, withChildren(1))
