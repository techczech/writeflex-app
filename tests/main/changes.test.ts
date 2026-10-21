import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isHiddenWorkspacePath, Workspace } from '../../src/main/workspace'
import { plantChangeAt } from '../helpers/plant-change-path'
import {
  ChangeStore,
  parseChangeLine,
  serializeChanges,
  changeJournalPath,
  closedReasonOf,
  type Change,
  type NewChange,
  type ChangeStatus,
  type EditClass,
} from '../../src/main/changes'

let root: string
let ws: Workspace
let store: ChangeStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-changes-'))
  ws = new Workspace(root)
  store = new ChangeStore(ws)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const agentEdit = (over: Partial<NewChange> = {}): NewChange => ({
  path: '02-method.md',
  provenance: 'agent',
  editClass: 'content',
  summary: 'Abstract lengthened',
  oldText: 'We tested recall.',
  newText: 'Across two cohorts we tested cued recall.',
  isCorrection: false,
  ...over,
})

// ---- the store ---------------------------------------------------------------------------------

test('add assigns a namespaced id, a timestamp, and a default pending status', async () => {
  const change = await store.add(agentEdit())
  expect(change.id).toMatch(/^c_[0-9a-z]+$/)
  expect(change.ts).toBeGreaterThan(0)
  expect(change.status).toBe('pending')
  expect(existsSync(join(root, '.writeflex', 'changes.jsonl'))).toBe(true)
})

test('list returns every change and narrows by scope', async () => {
  await store.add(agentEdit({ path: 'a.md', provenance: 'agent' }))
  await store.add(agentEdit({ path: 'b.md', provenance: 'writer', editClass: null }))
  await store.add(agentEdit({ path: 'a.md', provenance: 'reviewer', appliedBy: 'agent', reviewerLabel: 'Jo' }))
  expect(await store.list()).toHaveLength(3)
  expect(await store.list({ path: 'a.md' })).toHaveLength(2)
  expect(await store.list({ provenance: 'writer' })).toHaveLength(1)
  expect((await store.list({ provenance: 'reviewer' }))[0].appliedBy).toBe('agent')
})

test('a writer edit is stored unclassified and classified lazily', async () => {
  const edit = await store.add(agentEdit({ provenance: 'writer', editClass: null, isCorrection: true }))
  expect(edit.editClass).toBeNull()
  const classified = await store.setEditClass(edit.id, 'copy')
  expect(classified.editClass).toBe('copy')
  expect((await store.get(edit.id))?.editClass).toBe('copy')
})

test('setEditClass can lazily classify a normal change as a move', async () => {
  const edit = await store.add(agentEdit({ provenance: 'writer', editClass: null, isCorrection: true }))
  const classified = await store.setEditClass(edit.id, 'move')
  expect(classified.editClass).toBe('move')
  expect(classified.moveTo).toBeUndefined()
  expect((await store.get(edit.id))?.editClass).toBe('move')
})

test('setStatus accepts/rejects and persists across a fresh store instance', async () => {
  const change = await store.add(agentEdit())
  await store.setStatus(change.id, 'accepted')
  const reopened = new ChangeStore(ws)
  const persisted = await reopened.get(change.id)
  expect(persisted?.status).toBe('accepted')
})

test('setStatus can mark a change held for workshop review', async () => {
  const change = await store.add(agentEdit())
  await store.setStatus(change.id, 'held')
  const reopened = new ChangeStore(ws)
  const persisted = await reopened.get(change.id)
  expect(persisted?.status).toBe('held')
})

test('setStatus on an unknown id rejects without corrupting the journal', async () => {
  await store.add(agentEdit())
  await expect(store.setStatus('c_missing', 'accepted')).rejects.toThrow('No change with id')
  expect(await store.list()).toHaveLength(1)
})

test('concurrent adds all land (serialised writes never clobber)', async () => {
  await Promise.all(Array.from({ length: 25 }, (_, i) => store.add(agentEdit({ path: `f${i}.md` }))))
  const all = await store.list()
  expect(all).toHaveLength(25)
  expect(new Set(all.map((c) => c.id)).size).toBe(25) // no id collisions
})

test('an identical proposed replacement is dropped instead of becoming a change', async () => {
  const text = "shopping list to make sure we don't forget to buy something while we're out shopping and before that we will keep a piece of paper"

  const result = await store.addProposedReplacement(agentEdit({ oldText: text, newText: text }))

  expect(result).toBeNull()
  expect(await store.list()).toEqual([])
})

test('a proposed single-word substitution stores only the differing word and its adjusted anchor', async () => {
  const oldText = 'We took a shopping list to make sure nothing was forgotten before leaving the house.'
  const newText = 'We took a written list to make sure nothing was forgotten before leaving the house.'

  const result = await store.addProposedReplacement(agentEdit({
    oldText,
    newText,
    anchor: { from: 100, to: 100 + oldText.length },
  }))

  expect(result).toMatchObject({
    oldText: 'shopping',
    newText: 'written',
    anchor: { from: 110, to: 118 },
  })
  expect(await store.list()).toHaveLength(1)
})

test('a whole-sentence rewrite remains one coherent replacement rather than diff confetti', async () => {
  const result = await store.addProposedReplacement(agentEdit({
    oldText: 'The quick brown fox jumps over the sleepy dog.',
    newText: 'The tired hound watched as a red fox crossed the field.',
  }))

  expect(result).toMatchObject({
    oldText: 'quick brown fox jumps over the sleepy dog',
    newText: 'tired hound watched as a red fox crossed the field',
  })
  expect(await store.list()).toHaveLength(1)
})

test('a corrupt journal line is skipped, not fatal', async () => {
  await mkdir(join(root, '.writeflex'), { recursive: true })
  const good = JSON.stringify({ ...agentEdit(), id: 'c_good', ts: 1, status: 'pending' })
  await writeFile(join(root, '.writeflex', 'changes.jsonl'), `${good}\n{ broken json\n\n`, 'utf8')
  const all = await store.list()
  expect(all).toHaveLength(1)
  expect(all[0].id).toBe('c_good')
})

test('the journal round-trips through the store byte-stably', async () => {
  await store.add(agentEdit())
  const raw = await readFile(join(root, changeJournalPath()), 'utf8')
  const reparsed = raw.split('\n').map(parseChangeLine).filter(Boolean) as Change[]
  expect(serializeChanges(reparsed)).toBe(raw)
})

// ---- write-side well-formedness (a bad IPC payload must not orphan history) ---------------------

test('add refuses an out-of-union enum instead of persisting a line the next read would drop', async () => {
  await store.add(agentEdit()) // one good record already in the journal
  await expect(
    store.add({ ...agentEdit(), provenance: 'martian' as NewChange['provenance'] }),
  ).rejects.toThrow(/malformed/i)
  // The rejected add wrote nothing; the good record still lists and the journal stays readable.
  const all = await store.list()
  expect(all).toHaveLength(1)
  expect(all[0].provenance).toBe('agent')
})

test('setStatus refuses an invalid status and leaves the existing record intact', async () => {
  const c = await store.add(agentEdit())
  await expect(store.setStatus(c.id, 'done' as ChangeStatus)).rejects.toThrow(/malformed/i)
  expect((await store.get(c.id))?.status).toBe('pending') // unchanged, not orphaned
})

test('setEditClass refuses an invalid class and leaves the existing record intact', async () => {
  const c = await store.add(agentEdit({ editClass: null }))
  await expect(store.setEditClass(c.id, 'style' as EditClass)).rejects.toThrow(/malformed/i)
  expect((await store.get(c.id))?.editClass).toBeNull() // unchanged
})

// ---- Closed with a reason (command line and skill, ticket 01) ----

test('close records the reason, takes the Change out of pending, and survives a reload', async () => {
  const change = await store.add(agentEdit())

  const closed = await store.close(change.id, '  oldText was not found in 02-method.md.  ')

  expect(closed.status).toBe('rejected')
  expect(closedReasonOf(closed)).toBe('oldText was not found in 02-method.md.')
  expect(await store.list({ status: 'pending' })).toEqual([])
  expect(await store.list({ status: 'accepted' })).toEqual([])
  const reloaded = await new ChangeStore(new Workspace(root)).get(change.id)
  expect(reloaded).toEqual(closed)
  expect(closedReasonOf(reloaded!)).toBe('oldText was not found in 02-method.md.')
  expect((reloaded as Change & { closedAt?: number }).closedAt).toBeGreaterThan(0)
})

test('a held Change can be closed; an accepted one is history and is left untouched', async () => {
  const held = await store.add(agentEdit({ status: 'held' }))
  const accepted = await store.add(agentEdit({ status: 'accepted' }))

  expect(closedReasonOf(await store.close(held.id, 'The file has gone.'))).toBe('The file has gone.')
  expect(await store.close(accepted.id, 'The file has gone.')).toEqual(accepted)
  expect((await store.get(accepted.id))?.status).toBe('accepted')
})

test('close refuses an empty reason and an unknown id', async () => {
  const change = await store.add(agentEdit())

  await expect(store.close(change.id, '   ')).rejects.toThrow(/needs a reason/)
  await expect(store.close('c_missing', 'reason')).rejects.toThrow(/No change with id/)
  expect((await store.get(change.id))?.status).toBe('pending')
})

test('reopening a closed Change makes it an ordinary pending one; the same status keeps the reason', async () => {
  const change = await store.add(agentEdit())
  await store.close(change.id, 'The file has gone.')

  expect(closedReasonOf(await store.setStatus(change.id, 'rejected'))).toBe('The file has gone.')
  const reopened = await store.setStatus(change.id, 'pending')

  expect(reopened).toEqual(change)
  expect(closedReasonOf(reopened)).toBeNull()
  expect(await readFile(join(root, '.writeflex', 'changes.jsonl'), 'utf8')).not.toContain('closedReason')
})

test('records written before closure existed still parse, and a closed record round-trips through the ledger parser', async () => {
  const old = '{"id":"c_old1","path":"a.md","ts":1,"provenance":"agent","editClass":"copy","summary":"s","oldText":"a","newText":"b","status":"rejected","isCorrection":false}'
  const closed = '{"id":"c_new1","path":"a.md","ts":2,"provenance":"agent","editClass":"copy","category":null,"summary":"s","oldText":"a","newText":"b","status":"rejected","isCorrection":false,"closedReason":"a.md no longer exists.","closedAt":3}'
  await mkdir(join(root, '.writeflex'), { recursive: true })
  await writeFile(join(root, '.writeflex', 'changes.jsonl'), `${old}\n${closed}\n`)

  const [first, second] = await store.list()

  expect(first.id).toBe('c_old1')
  expect(closedReasonOf(first)).toBeNull()
  expect(closedReasonOf(second)).toBe('a.md no longer exists.')
  expect(serializeChanges([parseChangeLine(closed)!])).toBe(`${closed}\n`)
  // A reason of the wrong type, or on a Change that is not rejected, is not a closure.
  expect(closedReasonOf({ ...second, closedReason: 7 } as unknown as Change)).toBeNull()
  expect(closedReasonOf({ ...second, status: 'pending' })).toBeNull()
})

// ---- The status-only door (ticket 01 follow-up): it never stands in for Accept ----

test('the review door refuses to mark an agent or reviewer Change accepted; the record is unchanged', async () => {
  const agent = await store.add(agentEdit())
  const reviewer = await store.add(agentEdit({ provenance: 'reviewer', appliedBy: 'agent', reviewerLabel: 'R2' }))

  for (const change of [agent, reviewer]) {
    await expect(store.setReviewStatus(change.id, 'accepted')).rejects.toThrow(/only by Accept/)
    expect(await store.get(change.id)).toEqual(change)
  }
})

test('the review door still settles the writer\'s own Change as accepted, and moves any Change to held, rejected or pending', async () => {
  const own = await store.add(agentEdit({ provenance: 'writer', editClass: null }))
  const agent = await store.add(agentEdit())

  expect((await store.setReviewStatus(own.id, 'accepted')).status).toBe('accepted')
  expect((await store.setReviewStatus(own.id, 'pending')).status).toBe('pending')
  expect((await store.setReviewStatus(agent.id, 'held')).status).toBe('held')
  expect((await store.setReviewStatus(agent.id, 'rejected')).status).toBe('rejected')
  expect((await store.setReviewStatus(agent.id, 'pending')).status).toBe('pending')
})

test('a Change whose path is not a document can only end rejected, by any status door', async () => {
  await mkdir(join(root, '.bridle'), { recursive: true })
  await symlink(join(root, '.bridle'), join(root, 'notes'))
  const paths = ['.writeflex/changes.jsonl', 'notes/journal.jsonl', '../escape.md']
  const moves: Array<(id: string, status: ChangeStatus) => Promise<unknown>> = [
    (id, status) => store.setStatus(id, status),
    (id, status) => store.setReviewStatus(id, status),
    (id, status) => store.saveVersion([id], 'v_1', { [id]: status }),
  ]

  for (const path of paths) {
    for (const move of moves) {
      for (const status of ['accepted', 'pending', 'held'] as const) {
        // The writer's own provenance is the one the review door lets through to accepted elsewhere.
        // A dot-folder or `..` path is refused at add (next/0.23): planted in the journal, as a hand edit would.
        const change = isHiddenWorkspacePath(path)
          ? await plantChangeAt(root, store, agentEdit({ provenance: 'writer', editClass: null }), path)
          : await store.add(agentEdit({ path, provenance: 'writer', editClass: null }))
        await move(change.id, status)
        const after = (await store.get(change.id))!
        expect(after.status).toBe('rejected')
        expect(closedReasonOf(after)).toContain(path)
        expect(after.snapshotId).toBeUndefined()
      }
    }
  }
  const plain = await plantChangeAt(root, store, agentEdit(), '.git/config')
  expect((await store.setReviewStatus(plain.id, 'rejected')).status).toBe('rejected')
  expect(await store.list({ status: 'accepted' })).toEqual([])
  expect(await store.list({ status: 'pending' })).toEqual([])
  expect(await store.list({ status: 'held' })).toEqual([])
})
