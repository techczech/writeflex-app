import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import {
  ChangeStore,
  parseChangeLine,
  serializeChanges,
  changeJournalPath,
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
