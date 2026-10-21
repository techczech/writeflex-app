import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChangeStore, closedCodeOf, closedReasonOf, type NewChange } from '../../src/main/changes'
import { fingerprintOf } from '../../src/main/guarded-document-read'
import { proposePartTitles } from '../../src/main/folio-part-proposals'
import { registerPlanIpcHandlers, type PlanIpcHandler } from '../../src/main/plan-ipc'
import { readPlan } from '../../src/main/plan'
import { folioOutline } from '../../src/main/folio-outline'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { CHANGED_SINCE_LOOKED } from '../../src/main/title-conflict-fix'
import { WRITEFLEX_AGENT_AUTHOR, WRITEFLEX_SELF_AUTHOR } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'
import { folioScope } from '../../src/shared/folio-running-order'
import { titleUndoOnScreen, titleUndoScreen } from '../../src/renderer/src/app/title-conflict-actions'

// Title-conflict buttons (2026-10-19): the write path behind the Plan's and the Outline's fixes.
// Seam: the Plan IPC handlers `title:fix-part`, `title:fix-folio`, `title:undo` (main/plan-ipc.ts over
// main/title-conflict-fix.ts), as tests/main/plan-ipc.test.ts drives its neighbours.

let root: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-title-fix-'))
  ws = new Workspace(root)
  invalidateFolioPlaces(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')
const seen = async (rel: string): Promise<{ path: string; fingerprint: string }> => ({ path: rel, fingerprint: fingerprintOf(await readFile(join(root, rel))) })

function harness(options: { afterCheckpoint?: (path: string) => Promise<void> } = {}) {
  const handlers = new Map<string, PlanIpcHandler>()
  const checkpoints: string[] = []
  const diskChanges: string[][] = []
  registerPlanIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => ({ workspace: ws }),
    requireWorkspace: (state) => state.workspace,
    checkpointFile: async (_state, path) => { checkpoints.push(path); await options.afterCheckpoint?.(path) },
    notifyCollectionChanged: () => {},
    notifyChangedOnDisk: (_state, paths) => diskChanges.push(paths),
  })
  const invoke = async (channel: string, input: unknown): Promise<any> => handlers.get(channel)!({ sender: { id: 1 } }, input)
  return { invoke, checkpoints, diskChanges }
}

const A = '---\ntitle: The cost\n---\n\n# What it costs\n\nText of A.\n'
const B = '---\ntitle: Items\nstatus: draft\n---\n\n## List of items {#items}\n\nText of B.\n'
const C = '---\ntitle: Same\n---\n\n# same\n'

async function folio(): Promise<void> {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[a]]\n- [[b]]\n- [[c]]\n')
  await write('report/a.md', A)
  await write('report/b.md', `---\ntitle: Items\nstatus: draft\n---\n\n# List of items {#items}\n\nText of B.\n`)
  await write('report/c.md', C)
}

test('the Folio outline reads a differing title with the version it was read from; the Outline too', async () => {
  await folio()
  const plan = await readPlan(ws, 'report')
  const a = plan!.parts.find((part) => part.path === 'report/a.md')!
  expect(a.heading).toMatchObject({ mismatch: true, frontmatterTitle: 'The cost', headingText: 'What it costs', fingerprint: (await seen('report/a.md')).fingerprint })
  expect(plan!.parts.find((part) => part.path === 'report/c.md')!.heading).toMatchObject({ mismatch: false })
  expect(plan!.parts.find((part) => part.path === 'report/c.md')!.heading!.fingerprint).toBeUndefined()
  const outline = await folioOutline(ws, 'report/a.md')
  expect(outline!.pieces.find((file) => file.path === 'report/a.md')!.titleConflict).toEqual({ title: 'The cost', heading: 'What it costs', fingerprint: (await seen('report/a.md')).fingerprint })
})

test('title:fix-part writes the heading’s text into the title after a checkpoint, and its Undo puts it back', async () => {
  await folio()
  const api = harness()
  const answer = await api.invoke('title:fix-part', { dir: 'report', item: await seen('report/a.md'), direction: 'heading-to-title' })
  expect(answer).toMatchObject({ ok: true, written: ['report/a.md'], skipped: [] })
  expect(await read('report/a.md')).toBe('---\ntitle: What it costs\n---\n\n# What it costs\n\nText of A.\n')
  expect(api.checkpoints).toEqual(['report/a.md'])
  expect(api.diskChanges).toEqual([['report/a.md']])
  expect(await api.invoke('title:undo', { token: answer.undo })).toEqual({ ok: true, restored: ['report/a.md'], kept: [] })
  expect(await read('report/a.md')).toBe(A)
  // A step is used once.
  expect(await api.invoke('title:undo', { token: answer.undo })).toEqual({ ok: false, message: 'There is no title change to undo.' })
})

test('title:fix-part use title as heading keeps the attribute block and the rest of the file', async () => {
  await folio()
  const api = harness()
  const answer = await api.invoke('title:fix-part', { dir: 'report', item: await seen('report/b.md'), direction: 'title-to-heading' })
  expect(answer.ok).toBe(true)
  expect(await read('report/b.md')).toBe('---\ntitle: Items\nstatus: draft\n---\n\n# Items {#items}\n\nText of B.\n')
})

test('title:fix-part never inserts a heading into a part whose first heading comes after paragraphs: its waiting change does that', async () => {
  const head = '---\ntitle: How (not) to learn about AI with metaphors: a field guide\n---\n\n'
  const body = 'People reach for metaphors first.\n\nSome of them help.\n\n## TLDR;\n\nMetaphors are tools.\n'
  await folio()
  await write('report/c.md', head + body)
  const plan = await readPlan(ws, 'report')
  expect(plan!.parts.find((part) => part.path === 'report/c.md')!.heading).toMatchObject({ mismatch: false, mode: 'missing' })
  expect((await folioOutline(ws, 'report/a.md'))!.pieces.find((file) => file.path === 'report/c.md')!.titleConflict).toBeUndefined()
  const api = harness()
  expect(await api.invoke('title:fix-part', { dir: 'report', item: await seen('report/c.md'), direction: 'heading-to-title' }))
    .toEqual({ ok: false, message: 'This document does not start with a heading, so there is no heading to use as its title.' })
  expect(await api.invoke('title:fix-part', { dir: 'report', item: await seen('report/c.md'), direction: 'title-to-heading' }))
    .toEqual({ ok: false, message: 'This part does not start with a heading. The change that adds its title as the heading is waiting in the Changes.' })
  expect(await read('report/c.md')).toBe(head + body)
  expect(api.checkpoints).toEqual([])
})

test('a file that changed since it was looked at is refused with the plain sentence, and nothing is written', async () => {
  await folio()
  const api = harness()
  const item = await seen('report/a.md')
  await write('report/a.md', `${A}More.\n`)
  expect(await api.invoke('title:fix-part', { dir: 'report', item, direction: 'heading-to-title' })).toEqual({ ok: false, message: CHANGED_SINCE_LOOKED })
  expect(await read('report/a.md')).toBe(`${A}More.\n`)
  expect(api.checkpoints).toEqual([])
})

test('a file that changes between the read and the write is refused and keeps the other program’s text', async () => {
  await folio()
  const outside = 'Rewritten elsewhere.\n'
  const api = harness({ afterCheckpoint: async (path) => { await write(path, outside) } })
  expect(await api.invoke('title:fix-part', { dir: 'report', item: await seen('report/a.md'), direction: 'title-to-heading' })).toEqual({ ok: false, message: CHANGED_SINCE_LOOKED })
  expect(await read('report/a.md')).toBe(outside)
})

test('title:fix-part refuses a path outside the Folio or the workspace, and a bad request', async () => {
  await folio()
  await write('elsewhere/x.md', A)
  const api = harness()
  await expect(api.invoke('title:fix-part', { dir: 'report', item: await seen('elsewhere/x.md'), direction: 'heading-to-title' })).rejects.toThrow('not a part of this Folio')
  await expect(api.invoke('title:fix-part', { dir: 'report', item: { path: '../outside.md', fingerprint: 'a'.repeat(64) }, direction: 'heading-to-title' })).rejects.toThrow()
  await expect(api.invoke('title:fix-part', { dir: 'report', item: { path: 'report/a.md', fingerprint: 'nope' }, direction: 'heading-to-title' })).rejects.toThrow('Invalid title change.')
  await expect(api.invoke('title:fix-part', { dir: 'report', item: await seen('report/a.md'), direction: 'sideways' })).rejects.toThrow('Invalid title change.')
  expect(await read('elsewhere/x.md')).toBe(A)
})

test('title:fix-folio fixes every part named in one step, and one Undo restores them all', async () => {
  await folio()
  const api = harness()
  const items = [await seen('report/a.md'), await seen('report/b.md')]
  const answer = await api.invoke('title:fix-folio', { dir: 'report', items, direction: 'title-to-heading' })
  expect(answer).toMatchObject({ ok: true, written: ['report/a.md', 'report/b.md'], skipped: [] })
  expect(await read('report/a.md')).toBe('---\ntitle: The cost\n---\n\n# The cost\n\nText of A.\n')
  expect(api.checkpoints).toEqual(['report/a.md', 'report/b.md'])
  const undone = await api.invoke('title:undo', { token: answer.undo })
  expect(undone).toEqual({ ok: true, restored: ['report/a.md', 'report/b.md'], kept: [] })
  expect(await read('report/a.md')).toBe(A)
  expect(await read('report/b.md')).toBe('---\ntitle: Items\nstatus: draft\n---\n\n# List of items {#items}\n\nText of B.\n')
})

test('title:fix-folio skips a part that changed and writes the rest; Undo leaves a file edited since alone', async () => {
  await folio()
  const api = harness()
  const items = [await seen('report/a.md'), await seen('report/b.md')]
  await write('report/b.md', 'Changed.\n')
  const answer = await api.invoke('title:fix-folio', { dir: 'report', items, direction: 'heading-to-title' })
  expect(answer).toMatchObject({ ok: true, written: ['report/a.md'], skipped: [{ path: 'report/b.md', message: CHANGED_SINCE_LOOKED }] })
  await write('report/a.md', 'Edited after the fix.\n')
  const undone = await api.invoke('title:undo', { token: answer.undo })
  expect(undone).toMatchObject({ ok: true, restored: [], kept: [{ path: 'report/a.md' }] })
  expect(await read('report/a.md')).toBe('Edited after the fix.\n')
})

test('title:fix-folio refuses the whole call when a path is not one of the Folio’s parts', async () => {
  await folio()
  await write('report/_report-structure.json', JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }] }))
  await write('report/loose.md', A)
  const api = harness()
  const items = [await seen('report/a.md'), await seen('report/loose.md')]
  await expect(api.invoke('title:fix-folio', { dir: 'report', items, direction: 'heading-to-title' })).rejects.toThrow('not a part of this Folio')
  expect(await read('report/a.md')).toBe(A)
})

const RETIRED = (path: string, over: Partial<NewChange> = {}): NewChange => ({
  path, provenance: 'agent', editClass: 'housekeeping', category: 'structure', summary: 'Make the title match the heading “What it costs”',
  oldText: 'title: The cost', newText: 'title: What it costs', anchor: { from: 4, to: 19 }, isCorrection: false, author: WRITEFLEX_SELF_AUTHOR, ...over,
})

test('the retired “Make the title match the heading” proposal is no longer filed, and an open one is closed as superseded', async () => {
  await folio()
  const changes = new ChangeStore(ws)
  const open = await changes.add(RETIRED('report/a.md'))
  const decided = await changes.add(RETIRED('report/a.md', { newText: 'title: What it costs ' }))
  await changes.setStatus(decided.id, 'rejected')
  const result = await proposePartTitles(ws, changes, 'report')
  expect(result.proposed).toBe(0)
  const byId = new Map((await changes.list()).map((change) => [change.id, change]))
  expect([byId.get(open.id)!.status, closedCodeOf(byId.get(open.id)!)]).toEqual(['rejected', 'superseded'])
  expect(closedReasonOf(byId.get(open.id)!)).toContain('Use heading as title')
  expect(closedReasonOf(byId.get(decided.id)!)).toBeNull()
  expect((await changes.list()).filter((change) => change.summary.startsWith('Make the title match'))).toHaveLength(2)
  expect(await read('report/a.md')).toBe(A)
})

// Sol review round 1 (2026-10-19).

test('title:fix-part writes only a part of the Folio: a normalised path, compared exactly with its parts', async () => {
  await folio()
  await write('report/_report-structure.json', JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }] }))
  await write('elsewhere/x.md', A)
  await write('report/loose.md', A)
  await write('report/sub/deep.md', A)
  const api = harness()
  const fingerprint = (await seen('report/a.md')).fingerprint
  const fix = (path: string) => api.invoke('title:fix-part', { dir: 'report', item: { path, fingerprint }, direction: 'heading-to-title' })
  // Under the Folio's folder by prefix, but resolving elsewhere.
  await expect(fix('report/../elsewhere/x.md')).rejects.toThrow('not a part of this Folio')
  // Under the Folio's folder and not one of its parts.
  await expect(fix('report/loose.md')).rejects.toThrow('not a part of this Folio')
  await expect(fix('report/sub/deep.md')).rejects.toThrow('not a part of this Folio')
  // Absolute, leaving the workspace, or with a backslash.
  await expect(fix(join(root, 'report/a.md'))).rejects.toThrow()
  await expect(fix('/report/a.md')).rejects.toThrow()
  await expect(fix('report/../../outside.md')).rejects.toThrow()
  await expect(fix('report\\a.md')).rejects.toThrow('Invalid title change.')
  await expect(fix('report\\..\\elsewhere\\x.md')).rejects.toThrow('Invalid title change.')
  expect(api.checkpoints).toEqual([])
  expect(await read('elsewhere/x.md')).toBe(A)
  expect(await read('report/loose.md')).toBe(A)
  expect(await read('report/sub/deep.md')).toBe(A)
  // A path that normalises to a part is that part.
  expect(await fix('report/./a.md')).toMatchObject({ ok: true, written: ['report/a.md'] })
  expect(await read('report/a.md')).toBe('---\ntitle: What it costs\n---\n\n# What it costs\n\nText of A.\n')
})

test('title:fix-folio normalises each path before it checks it and refuses one that resolves outside the parts', async () => {
  await folio()
  await write('elsewhere/x.md', A)
  const api = harness()
  const items = [await seen('report/a.md'), { ...(await seen('elsewhere/x.md')), path: 'report/../elsewhere/x.md' }]
  await expect(api.invoke('title:fix-folio', { dir: 'report', items, direction: 'heading-to-title' })).rejects.toThrow('not a part of this Folio')
  expect(await read('report/a.md')).toBe(A)
  expect(await read('elsewhere/x.md')).toBe(A)
})

test('retirement closes an open “Make the title match the heading” of a file no longer in the running order', async () => {
  await folio()
  const changes = new ChangeStore(ws)
  // Filed while report/gone.md was a part; it has since left the running order (it is not in the Index Note).
  await write('report/_report-structure.json', JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }] }))
  await write('report/gone.md', A)
  const gone = await changes.add(RETIRED('report/gone.md'))
  const listed = await changes.add(RETIRED('report/a.md'))
  // Another Folio's record is not this Folio's to close.
  await write('other/z.md', A)
  const other = await changes.add(RETIRED('other/z.md'))
  const result = await proposePartTitles(ws, changes, 'report')
  expect(result.withdrawn).toBe(2)
  const byId = new Map((await changes.list()).map((change) => [change.id, change]))
  expect(closedCodeOf(byId.get(gone.id)!)).toBe('superseded')
  expect(closedCodeOf(byId.get(listed.id)!)).toBe('superseded')
  expect(byId.get(other.id)!.status).toBe('pending')
  expect(await read('report/gone.md')).toBe(A)
})

test('the title Undo is offered and run only while the Folio it was made in is on screen', () => {
  const scope = folioScope('/w', 'report')
  // The Outline shows the step's Folio; no Plan.
  expect(titleUndoOnScreen(scope, titleUndoScreen('/w', 'report', null))).toEqual({ usable: true, kept: true })
  // The step's Plan is shown.
  expect(titleUndoOnScreen(scope, titleUndoScreen('/w', 'other', 'report'))).toEqual({ usable: true, kept: true })
  // A Plan of another Folio covers the Outline of this one: kept, not usable until that Plan closes.
  expect(titleUndoOnScreen(scope, titleUndoScreen('/w', 'report', 'other'))).toEqual({ usable: false, kept: true })
  // Another Folio came on screen: neither offered nor kept.
  expect(titleUndoOnScreen(scope, titleUndoScreen('/w', 'other', null))).toEqual({ usable: false, kept: false })
  // No Folio on screen (between two files): kept, not usable.
  expect(titleUndoOnScreen(scope, titleUndoScreen('/w', null, null))).toEqual({ usable: false, kept: true })
  // Another workspace.
  expect(titleUndoOnScreen(scope, titleUndoScreen('/v', 'report', null)).usable).toBe(false)
})

test('retirement closes only “Make the title match the heading” records: every other kind under the folder stays as it is', async () => {
  await folio()
  await write('report/_report-structure.json', JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }] }))
  // Off the running order, so the per-part pass never visits them: only the records-wide retirement could close these.
  await write('report/gone.md', A)
  await write('report/sub/deep.md', A)
  const changes = new ChangeStore(ws)
  const retired = await changes.add(RETIRED('report/sub/deep.md'))
  const others = [
    // WriteFlex's own add-a-heading kind.
    await changes.add(RETIRED('report/gone.md', { summary: 'Add the heading “The cost”', editClass: 'insert', oldText: '', newText: '# The cost\n\n', anchor: { from: 25, to: 25 }, insertAfter: '' })),
    // The same summary filed by the in-app agent (not WriteFlex's author): not the retired kind.
    await changes.add(RETIRED('report/gone.md', { author: WRITEFLEX_AGENT_AUTHOR })),
    // The same summary in another category.
    await changes.add(RETIRED('report/sub/deep.md', { category: 'style' })),
    // An ordinary agent edit and a writer's own change.
    await changes.add(RETIRED('report/gone.md', { summary: 'Tighten the opening', category: 'style', author: WRITEFLEX_AGENT_AUTHOR })),
    await changes.add(RETIRED('report/sub/deep.md', { provenance: 'writer', summary: 'My own edit', category: null, author: { name: 'Dominik' } })),
  ]
  const result = await proposePartTitles(ws, changes, 'report')
  expect(result.withdrawn).toBe(1)
  const byId = new Map((await changes.list()).map((change) => [change.id, change]))
  expect(closedCodeOf(byId.get(retired.id)!)).toBe('superseded')
  for (const other of others) expect([other.summary, byId.get(other.id)!.status, closedReasonOf(byId.get(other.id)!)]).toEqual([other.summary, 'pending', null])
})
