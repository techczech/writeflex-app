import { openAsApp } from '../helpers/request-app'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { VersionStore } from '../../src/main/versions'
import { followVersionMap, prepareVersionMove, undoVersionMap, withVersionMove, settleVersionMoves, waitingVersionHistory, prepareVersionRestore, previewVersionMap } from '../../src/main/version-moves'
import { suggestHistoryAttachments } from '../../src/main/version-history-reattach'
import { writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'
import { buildVerbTable } from '../../src/main/verbs'
import { FolioWorkspace } from '../../src/main/folio-workspace'
import { readFolioPlan } from '../../src/main/plan'
import { writeRoomAuthoring } from '../../src/main/folio-room-authoring'
import { pangramFolio } from '../fixtures/folio-room/folio-room-fixtures'
import { forgetBinUndoRecords, readFolioBin } from '../../src/main/folio-bin'

let root: string
let ws: Workspace
let store: VersionStore
const author = { name: 'Writer' }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-versions-follow-'))
  ws = new Workspace(root)
  store = new VersionStore(ws)
  await writeFile(join(root, 'a.md'), '# First\n')
})
afterEach(async () => { forgetBinUndoRecords(); await rm(root, { recursive: true, force: true }) })
const seed = (path = 'a.md', ts = 1) => store.append({ path, name: `Version ${ts}`, author, ts })

test('editor rename, subsequent version, chained guarded move and reverse keep ordered full history', async () => {
  const first = await seed()
  const prefix = await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')
  await ws.renameFile('a.md', 'b.md')
  const second = await seed('b.md', 2)
  await ws.renameFile('b.md', 'c.md', { documentOnly: true })
  expect((await store.list({ path: 'c.md' })).map(v => v.id)).toEqual([second.id, first.id])
  expect(await store.list({ path: 'a.md' })).toEqual([])
  await ws.renameFile('c.md', 'b.md', { documentOnly: true })
  await ws.renameFile('b.md', 'a.md')
  expect((await new VersionStore(ws).list({ path: 'a.md' })).map(v => v.id)).toEqual([second.id, first.id])
  expect((await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')).startsWith(prefix)).toBe(true)
})

test('Undo preserves history already at the destination before the move', async () => {
  const first = await seed()
  const detached = await seed('b.md', 0)
  await ws.renameFile('a.md', 'b.md')
  await ws.renameFile('b.md', 'a.md')
  expect((await store.list({ path: 'a.md' })).map(v => v.id)).toEqual([first.id])
  expect((await store.list({ path: 'b.md' })).map(v => v.id)).toEqual([detached.id])
})

test.each([false, true])('folder rename follows every descendant (guarded = %s)', async guarded => {
  await mkdir(join(root, 'folder'))
  await rename(join(root, 'a.md'), join(root, 'folder/a.md'))
  const version = await seed('folder/a.md')
  await ws.renameFolder('folder', 'renamed', { documentOnly: guarded })
  expect((await store.list({ path: 'renamed/a.md' }))[0].id).toBe(version.id)
  await ws.renameFolder('renamed', 'folder', { documentOnly: guarded })
  expect((await store.list({ path: 'folder/a.md' }))[0].id).toBe(version.id)
})

test('a crash before the physical move leaves both file and history at the old name', async () => {
  const version = await seed()
  prepareVersionMove(root, 'a.md', 'b.md')
  expect((await new VersionStore(ws).list({ path: 'a.md' }))[0].id).toBe(version.id)
  expect(await store.list({ path: 'b.md' })).toEqual([])
})

test('a crash after the physical move resolves the durable intent without writing on read', async () => {
  const version = await seed()
  prepareVersionMove(root, 'a.md', 'b.md')
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  const before = await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')
  expect((await new VersionStore(ws).list({ path: 'b.md' }))[0].id).toBe(version.id)
  expect(await store.list({ path: 'a.md' })).toEqual([])
  expect(await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')).toBe(before)
})

test('an unrelated target does not activate an interrupted move', async () => {
  const version = await seed()
  prepareVersionMove(root, 'a.md', 'b.md')
  await writeFile(join(root, 'b.md'), '# Another\n')
  expect((await store.list({ path: 'a.md' }))[0].id).toBe(version.id)
  expect(await store.list({ path: 'b.md' })).toEqual([])
})

test('failed move cancels the intent and leaves history in place', async () => {
  const version = await seed()
  await expect(withVersionMove(root, 'a.md', 'b.md', async () => { throw new Error('Refused') })).rejects.toThrow('Refused')
  expect((await store.list({ path: 'a.md' }))[0].id).toBe(version.id)
})

test('map import reports each refusal; Undo affects only the versions it attached', async () => {
  const first = await seed()
  const existing = await seed('b.md', 2)
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  const result = followVersionMap(root, 'old_path\tnew_path\na.md\tb.md\nmissing.md\tb.md\na.md\tno.md\na.md\t../outside.md\n')
  expect(result.attached).toBe(1)
  expect(result.refused).toHaveLength(3)
  expect((await store.list({ path: 'b.md' })).map(v => v.id)).toEqual([existing.id, first.id])
  const later = await seed('b.md', 3)
  expect(undoVersionMap(root, result.undo!)).toBe(1)
  expect((await store.list({ path: 'a.md' })).map(v => v.id)).toEqual([first.id])
  expect((await store.list({ path: 'b.md' })).map(v => v.id)).toEqual([later.id, existing.id])
  expect(() => undoVersionMap(root, result.undo!)).toThrow()
})

test('map Undo refuses without writing when an attached history moved again', async () => {
  await seed()
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  const result = followVersionMap(root, 'a.md\tb.md\n')
  await ws.renameFile('b.md', 'c.md')
  const before = await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')
  expect(() => undoVersionMap(root, result.undo!)).toThrow(/moved again/)
  expect(await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')).toBe(before)
})

test('map refuses linked paths and malformed/duplicate rows; all-refused creates no journal', async () => {
  const result = followVersionMap(root, 'none.md\ta.md\n')
  expect(result.undo).toBeNull()
  await seed()
  await symlink('a.md', join(root, 'link.md'))
  const mapped = followVersionMap(root, 'a.md\tlink.md\na.md\ta.md\na.md\t.git/a.md\na.md\tb.md\textra\n')
  expect(mapped.refused).toHaveLength(4)
  expect(mapped.attached).toBe(0)
})

test('map reads never follow a linked journal or write through it', async () => {
  await seed()
  const original = await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')
  await rename(join(root, '.writeflex/versions.jsonl'), join(root, 'victim.md'))
  await symlink('../victim.md', join(root, '.writeflex/versions.jsonl'))
  expect(followVersionMap(root, 'a.md\ta.md\n').attached).toBe(0)
  expect(await readFile(join(root, 'victim.md'), 'utf8')).toBe(original)
})

async function cliFixture(work: (fx: WriteFixture) => Promise<void>) {
  const fx = await writeFixture()
  try { await work(fx) } finally { await fx.dispose() }
}

test('CLI move and its actual undo keep versions attached', () => cliFixture(async fx => {
  await fx.write('a.md', '# First\n')
  const versions = new VersionStore(new Workspace(fx.root))
  const first = await versions.append({ path: 'a.md', name: 'Before', author })
  const moved = await fx.cli(['move', 'a.md', 'b.md'])
  expect(moved.code).toBe(0)
  expect((await versions.list({ path: 'b.md' }))[0].id).toBe(first.id)
  const undone = await fx.cli(['undo', moved.json.result!.undo as string])
  expect(undone.code).toBe(0)
  expect((await versions.list({ path: 'a.md' }))[0].id).toBe(first.id)
}))

test('CLI map route, matching first-version suggestion, agent route and undo', () => cliFixture(async fx => {
  await fx.write('a.md', '# First\n')
  const saved = await fx.cli(['save-version', 'a.md', '--name', 'First'])
  expect(saved.code).toBe(0)
  await rename(join(fx.root, 'a.md'), join(fx.root, 'b.md'))
  const workspace = new Workspace(fx.root)
  const before = await fx.snapshot()
  expect(await suggestHistoryAttachments(workspace, 'b.md')).toEqual([{ from: 'a.md', to: 'b.md' }])
  expect(await fx.snapshot()).toEqual(before)
  await fx.write('moves.tsv', 'old_path\tnew_path\na.md\tb.md\n')
  const followed = await fx.cli(['follow-history', '--map', 'moves.tsv'])
  expect(followed.code).toBe(0)
  expect(followed.json.result).toMatchObject({ attached: 1, refused: [] })
  const undone = await fx.cli(['undo-history', followed.json.result!.undo as string])
  expect(undone.code).toBe(0)
  const verb = buildVerbTable(workspace).find(v => v.id === 'history.follow')!
  const input = { map: 'moves.tsv' }
  await verb.preview!(input)
  const answer = await verb.run({} as never, input)
  expect(JSON.parse(answer.text)).toMatchObject({ attached: 1, refused: [] })
  const undo = buildVerbTable(workspace).find(v => v.id === 'history.undo_follow')!
  expect((await undo.run({} as never, { undo: JSON.parse(answer.text).undo })).isError).not.toBe(true)
}))

test('Folio bin remove, Undo, restore to a different path and Undo restore retain versions', async () => {
  const built = await pangramFolio(root)
  const fws = new FolioWorkspace(ws, built.dir)
  const from = `${built.dir}/contents/02-report.md`
  const first = await seed(from)
  const plan = (await readFolioPlan(fws, built.dir))!
  const removed = await writeRoomAuthoring(fws, { op: 'remove', indices: [1], expected: plan.parts })
  if (!removed.ok) throw new Error(removed.message)
  const binned = `${built.dir}/.folio-bin/02-report.md`
  expect((await store.list({ path: binned }))[0].id).toBe(first.id)
  const undone = await writeRoomAuthoring(fws, { op: 'undo', token: removed.token! })
  expect(undone.ok).toBe(true)
  expect((await store.list({ path: from }))[0].id).toBe(first.id)
  const removedAgain = await writeRoomAuthoring(fws, { op: 'remove', indices: [1], expected: (await readFolioPlan(fws, built.dir))!.parts })
  expect(removedAgain.ok).toBe(true)
  const restored = await writeRoomAuthoring(fws, { op: 'restore', id: readFolioBin({ root }, built.dir).items[0].id })
  if (!restored.ok) throw new Error(restored.message)
  expect((await store.list({ path: restored.paths.find(path => path.endsWith('/02-report.md'))! }))[0].id).toBe(first.id)
  expect((await writeRoomAuthoring(fws, { op: 'undo', token: restored.token! })).ok).toBe(true)
  expect((await store.list({ path: binned }))[0].id).toBe(first.id)
})

test('a recovered move stays attached through a later atomic save and a second move', async () => {
  const first = await seed()
  prepareVersionMove(root, 'a.md', 'b.md')
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  await ws.saveFile('b.md', '# Edited after restarting\n')
  expect((await new VersionStore(ws).list({ path: 'b.md' }))[0].id).toBe(first.id)
  await ws.renameFile('b.md', 'c.md')
  expect((await new VersionStore(ws).list({ path: 'c.md' }))[0].id).toBe(first.id)
})

test('a torn last append cannot consume the next move intent', async () => {
  await seed()
  const { appendFile } = await import('node:fs/promises')
  await appendFile(join(root, '.writeflex/versions.jsonl'), '{"kind":"version-paths-finish"')
  await ws.renameFile('a.md', 'b.md')
  expect(await store.list({ path: 'b.md' })).toHaveLength(1)
})

test('an interrupted letter-case rename follows the directory entry, not a case-insensitive lookup', async () => {
  const first = await seed()
  prepareVersionMove(root, 'a.md', 'A.md')
  expect((await store.list({ path: 'a.md' }))[0].id).toBe(first.id)
  await rename(join(root, 'a.md'), join(root, 'A.md'))
  expect((await store.list({ path: 'A.md' }))[0].id).toBe(first.id)
})


test('CLI history attachment and Undo are routed through the app owner when the Collection is open', () => cliFixture(async fx => {
  await fx.write('a.md', '# First\n')
  const versions = new VersionStore(new Workspace(fx.root))
  const first = await versions.append({ path: 'a.md', name: 'Before', author })
  await rename(join(fx.root, 'a.md'), join(fx.root, 'b.md'))
  await fx.write('moves.tsv', 'a.md\tb.md\n')
  let notifications = 0
  const app = await openAsApp(fx, { onVersionHistoryChanged: () => { notifications++ } })
  const stop = app.answering()
  try {
    const result = await fx.cli(['follow-history', '--map', 'moves.tsv'])
    expect(result.code).toBe(0)
    expect(result.json).toMatchObject({ via: 'app', outcome: 'done' })
    expect((await versions.list({ path: 'b.md' }))[0].id).toBe(first.id)
    const undone = await fx.cli(['undo-history', result.json.result!.undo as string])
    expect(undone.code).toBe(0)
    expect(undone.json).toMatchObject({ via: 'app', outcome: 'done' })
    expect((await versions.list({ path: 'a.md' }))[0].id).toBe(first.id)
    expect(notifications).toBe(2)
  } finally { await stop(); await app.close() }
}))


test('a stale version metadata append cannot detach history after a move', async () => {
  const first = await seed()
  await ws.renameFile('a.md', 'b.md')
  // A version-title update can have read the old row before the move won the write turn.
  await store.append({ ...first, name: 'Renamed version', path: 'a.md' })
  expect(await store.list({ path: 'a.md' })).toEqual([])
  expect((await store.list({ path: 'b.md' }))[0]).toMatchObject({ id: first.id, name: 'Renamed version' })
  await ws.renameFile('b.md', 'a.md')
  expect((await store.list({ path: 'a.md' }))[0].id).toBe(first.id)
})


test('P1: unfinished move never gives a replacement at the old path its history', async () => {
  const first = await seed()
  prepareVersionMove(root, 'a.md', 'b.md')
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  await writeFile(join(root, 'a.md'), '# Unrelated\n')
  expect(await store.list({ path: 'a.md' })).toEqual([])
  expect((await store.list({ path: 'b.md' })).map(v => v.id)).toEqual([first.id])
  await seed('b.md', 2)
  expect(await store.list({ path: 'a.md' })).toEqual([])
})

test('P2: map refuses a still-present old file without writing', async () => {
  await seed()
  await writeFile(join(root, 'b.md'), '# Unrelated\n')
  const before = await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')
  const result = followVersionMap(root, 'a.md\tb.md\n')
  expect(result.attached).toBe(0)
  expect(result.refused[0].reason).toMatch(/old path still exists/i)
  expect(await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')).toBe(before)
})

test('P3: complete unterminated records survive reads and async append; torn tails do not consume saves', async () => {
  const first = await seed()
  const journal = join(root, '.writeflex/versions.jsonl')
  await writeFile(journal, (await readFile(journal, 'utf8')).trimEnd())
  expect((await store.list()).map(v => v.id)).toEqual([first.id])
  const second = await seed('a.md', 2)
  expect((await store.list()).map(v => v.id)).toEqual([second.id, first.id])
  const { appendFile } = await import('node:fs/promises')
  await appendFile(journal, '{"torn":')
  const third = await seed('a.md', 3)
  expect((await store.list()).map(v => v.id)).toEqual([third.id, second.id, first.id])
})

test('P4: suggestion reads create no bookkeeping folder', async () => {
  expect(await suggestHistoryAttachments(ws, 'a.md')).toEqual([])
  const { existsSync } = await import('node:fs')
  expect(existsSync(join(root, '.writeflex'))).toBe(false)
})

test('P5: map Undo refuses after a later rename without changing the journal', async () => {
  await seed()
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  const result = followVersionMap(root, 'a.md\tb.md\n')
  await ws.renameFile('b.md', 'c.md')
  const before = await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')
  expect(() => undoVersionMap(root, result.undo!)).toThrow(/moved again/)
  expect(await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')).toBe(before)
})

test('P6: stale version metadata cannot override durable history assignments', async () => {
  const first = await seed()
  await ws.renameFile('a.md', 'b.md')
  await store.append({ ...first, name: 'Updated', ts: 2 })
  expect(await store.list({ path: 'a.md' })).toEqual([])
  expect((await store.list({ path: 'b.md' }))[0].name).toBe('Updated')
})

test('P7: outside atomic replacement holds history for explicit recovery', async () => {
  const first = await seed()
  prepareVersionMove(root, 'a.md', 'b.md')
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  await writeFile(join(root, 'replacement.md'), '# Outside edit\n')
  await rename(join(root, 'replacement.md'), join(root, 'b.md'))
  expect(await store.list()).toEqual([])
  expect(followVersionMap(root, 'a.md\tb.md\n').attached).toBe(1)
  expect((await store.list({ path: 'b.md' })).map(v => v.id)).toEqual([first.id])
})


test('saveVersionOfSavedText holds the write turn through its snapshot and journal append', async () => {
  const { saveVersionOfSavedText } = await import('../../src/main/saved-text-version')
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const saving = saveVersionOfSavedText({
    workspace: ws, versions: store, changes: { list: async () => [] }, author,
    confirmOwner: async () => {},
    snapshot: async () => { entered(); await held; return { versionId: 'restore', snapshotId: 'snapshot' } },
  }, { path: 'a.md', name: 'Racing version' })
  await started
  const moving = ws.renameFile('a.md', 'b.md')
  // A synchronous handshake: the rename must be queued, rather than entering its turn.
  const waiting = ws.writersWaiting
  release()
  const saved = await saving
  await moving
  expect(waiting).toBe(1)
  expect((await store.list({ path: 'b.md' })).map(v => v.id)).toEqual([saved.record.id])
  expect(await store.list({ path: 'a.md' })).toEqual([])
})

test('failed finish logs and retries at the next owner-lock settle', async () => {
  const { pauseCollectionWrites, resumeCollectionWrites } = await import('../../src/main/collection-write-gate')
  const { spyOn } = await import('bun:test')
  const { CollectionOwnership } = await import('../../src/main/collection-ownership')
  const first = await seed()
  const intent = prepareVersionMove(root, 'a.md', 'b.md')
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  const log = spyOn(console, 'error').mockImplementation(() => {})
  const owner = new CollectionOwnership({ schedule: () => () => {} })
  try {
    pauseCollectionWrites(root, 'Lost lock')
    intent.finish()
    expect(log).toHaveBeenCalled()
    resumeCollectionWrites(root)
    await owner.claim(root)
    expect((await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8'))).toContain(`"id":"${intent.id}","state":"done"`)
    await writeFile(join(root, 'a.md'), '# Other\n')
    expect(await store.list({ path: 'a.md' })).toEqual([])
    expect((await store.list({ path: 'b.md' }))[0].id).toBe(first.id)
  } finally { log.mockRestore(); resumeCollectionWrites(root); await owner.releaseAll() }
})

test('attachment Undo is derived from the last un-undone journal record per file', async () => {
  const { pendingHistoryAttachment } = await import('../../src/main/version-moves')
  await seed()
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  const attached = followVersionMap(root, 'a.md\tb.md\n')
  expect(pendingHistoryAttachment(new Workspace(root).root, 'b.md')).toEqual({ id: attached.undo, files: 1 })
  undoVersionMap(root, attached.undo!)
  expect(pendingHistoryAttachment(root, 'b.md')).toBeNull()
})

test('history.follow approval preview shows parsed map rows and their count', async () => {
  await writeFile(join(root, 'moves.tsv'), 'old_path\tnew_path\na.md\tb.md\nc.md\td.md\n')
  const verb = buildVerbTable(ws).find(v => v.id === 'history.follow')!
  const preview = await verb.preview!({ map: 'moves.tsv' })
  expect(preview).toContain('2')
  expect(preview).toContain('a.md → b.md')
  expect(preview).toContain('c.md → d.md')
})


test('changed bytes after outside atomic replacement hide history until explicit recovery', async () => {
  const first = await seed()
  prepareVersionMove(root, 'a.md', 'b.md')
  await writeFile(join(root, 'replacement.md'), '# Other\n')
  await rename(join(root, 'replacement.md'), join(root, 'a.md'))
  expect(await store.list({ path: 'a.md' })).toEqual([])
  await writeFile(join(root, 'c.md'), '# Other\n')
  expect(followVersionMap(root, 'a.md\tc.md\n').attached).toBe(1)
  expect((await store.list({ path: 'c.md' })).map(v => v.id)).toEqual([first.id])
})

test('CLI and agent follow routes refuse a live source with no history changes', () => cliFixture(async fx => {
  await fx.write('a.md', '# First\n')
  await fx.write('b.md', '# Other\n')
  const workspace = new Workspace(fx.root)
  const versions = new VersionStore(workspace)
  const first = await versions.append({ path: 'a.md', name: 'Before', author })
  await fx.write('moves.tsv', 'a.md\tb.md\n')
  const followed = await fx.cli(['follow-history', '--map', 'moves.tsv'])
  expect(followed.json.result).toMatchObject({ attached: 0, undo: null })
  const verb = buildVerbTable(workspace).find(v => v.id === 'history.follow')!
  const input = { map: 'moves.tsv' }
  await verb.preview!(input)
  const result = JSON.parse((await verb.run({} as never, input)).text)
  expect(result).toMatchObject({ attached: 0, undo: null })
  expect(result.refused[0].reason).toMatch(/old path still exists/i)
  expect((await versions.list({ path: 'a.md' })).map(v => v.id)).toEqual([first.id])
  expect(await versions.list({ path: 'b.md' })).toEqual([])
}))


test.each(['save', 'claim'])('R2-1: interrupted unmoved intent is cancelled before %s', async mode => {
  const first = await seed()
  const second = await seed('a.md', 2)
  const intent = prepareVersionMove(root, 'a.md', 'b.md')
  const { CollectionOwnership } = await import('../../src/main/collection-ownership')
  const owner = new CollectionOwnership({ schedule: () => () => {} })
  try {
    if (mode === 'claim') await owner.claim(root)
    else await ws.saveFile('a.md', '# Saved after interruption\n')
    expect((await store.list({ path: 'a.md' })).map(v => v.id)).toEqual([second.id, first.id])
    expect(await store.list({ path: 'b.md' })).toEqual([])
    expect(await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')).toContain(`"id":"${intent.id}","state":"cancelled"`)
  } finally { await owner.releaseAll() }
})

test('R2-2: changed map after preview is refused without any journal write', async () => {
  await seed()
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  await writeFile(join(root, 'c.md'), '# Third\n')
  await writeFile(join(root, 'moves.tsv'), 'a.md\tb.md\n')
  const verb = buildVerbTable(ws).find(v => v.id === 'history.follow')!
  const input = { map: 'moves.tsv' }
  await verb.preview!(input)
  const before = await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')
  await writeFile(join(root, 'moves.tsv'), 'a.md\tc.md\n')
  const answer = await verb.run({} as never, input)
  expect(answer.isError).toBe(true)
  expect(answer.text).toMatch(/map changed/i)
  expect(await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')).toBe(before)
})

test('R2-2: preview validates accepted and refused rows exactly as applied', async () => {
  await seed()
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  await writeFile(join(root, 'moves.tsv'), 'old_path\tnew_path\r\na.md\tb.md\r\na.md\tb.md\r\nb.md\tc.md\r\n')
  const verb = buildVerbTable(ws).find(v => v.id === 'history.follow')!
  const input = { map: 'moves.tsv' }
  const preview = await verb.preview!(input)
  expect(preview).toContain('Accepted (line 2): a.md → b.md')
  expect(preview).toContain('Refused (line 3): a.md → b.md — The old path is listed more than once.')
  expect(preview).toContain('Refused (line 4): b.md → c.md — The old path still exists')
  const answer = await verb.run({} as never, input)
  expect(JSON.parse(answer.text)).toMatchObject({ attached: 1, refused: [{ line: 3 }, { line: 4 }] })
})

test('R2-2: preview escapes control and bidi characters in names', async () => {
  await writeFile(join(root, 'moves.tsv'), 'a\u001b\u202e.md\tb.md\n')
  const verb = buildVerbTable(ws).find(v => v.id === 'history.follow')!
  const preview = await verb.preview!({ map: 'moves.tsv' })
  expect(preview).not.toContain('\u001b')
  expect(preview).not.toContain('\u202e')
  expect(preview).toContain('a\\u001b\\u202e.md')
})


test('R2-1: a staged copy restore is not cancelled by a re-entrant save', async () => {
  const first = await seed()
  const intent = prepareVersionMove(root, 'a.md', 'b.md', true)
  await writeFile(join(root, 'b.md'), '# First\n')
  await ws.saveFile('other.md', '# Plan document write during restore\n')
  expect(await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')).not.toContain(`"id":"${intent.id}","state":"cancelled"`)
  await rm(join(root, 'a.md'))
  intent.finish()
  expect((await store.list({ path: 'b.md' })).map(v => v.id)).toEqual([first.id])
})

test('R2-4: multi-row attachment Undo reports the whole action file count', async () => {
  const { pendingHistoryAttachment } = await import('../../src/main/version-moves')
  await seed()
  await seed('a.md', 2)
  await writeFile(join(root, 'c.md'), '# Third\n')
  await seed('c.md', 3)
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  await rename(join(root, 'c.md'), join(root, 'd.md'))
  const result = followVersionMap(root, 'a.md\tb.md\nc.md\td.md\n')
  expect(pendingHistoryAttachment(root, 'b.md')).toEqual({ id: result.undo, files: 2 })
  expect(pendingHistoryAttachment(root, 'd.md')).toEqual({ id: result.undo, files: 2 })
})

test('R2-2: changed validation after preview is refused without journal writes', async () => {
  await seed()
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  await writeFile(join(root, 'moves.tsv'), 'a.md\tb.md\n')
  const verb = buildVerbTable(ws).find(v => v.id === 'history.follow')!
  const input = { map: 'moves.tsv' }
  await verb.preview!(input)
  const before = await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')
  await writeFile(join(root, 'a.md'), '# Reappeared\n')
  const answer = await verb.run({} as never, input)
  expect(answer.isError).toBe(true)
  expect(answer.text).toMatch(/validation changed/i)
  expect(await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')).toBe(before)
})


test('R3-1: new old-name file cannot inherit interrupted history; map recovers to outside destination', async () => {
  const first = await seed()
  prepareVersionMove(root, 'a.md', 'b.md')
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  await rename(join(root, 'b.md'), join(root, 'c.md'))
  await writeFile(join(root, 'a.md'), '# Unrelated\n')
  expect(await store.list({ path: 'a.md' })).toEqual([])
  settleVersionMoves(root, true)
  await ws.saveFile('a.md', '# New unrelated edit\n')
  const unrelated = await seed('a.md', 2)
  expect((await store.list({ path: 'a.md' })).map(v => v.id)).toEqual([unrelated.id])
  const result = followVersionMap(root, 'a.md\tc.md\n')
  expect(result).toMatchObject({ attached: 1, refused: [] })
  expect((await store.list({ path: 'c.md' })).map(v => v.id)).toEqual([first.id])
  expect((await store.list({ path: 'a.md' })).map(v => v.id)).toEqual([unrelated.id])
})

test.each(['save', 'claim'])('R3-1: identical bytes with replaced inode stay held back after %s', async mode => {
  const first = await seed()
  prepareVersionMove(root, 'a.md', 'b.md')
  await writeFile(join(root, 'replacement.md'), '# First\n')
  await rename(join(root, 'replacement.md'), join(root, 'a.md'))
  expect(await store.list()).toEqual([])
  if (mode === 'claim') settleVersionMoves(root, true)
  await ws.saveFile('a.md', '# Changed by save\n')
  expect(await store.list()).toEqual([])
  expect(followVersionMap(root, 'a.md\ta.md\n').attached).toBe(1)
  expect((await store.list()).map(v => v.id)).toEqual([first.id])
})

test('R3-3: missing and linked map targets produce plain relative refusal reasons in preview and run', async () => {
  await seed()
  await rename(join(root, 'a.md'), join(root, 'c.md'))
  await symlink('/missing-private-target', join(root, 'linked.md'))
  await writeFile(join(root, 'moves.tsv'), 'a.md\tmissing.md\na.md\tlinked.md\n')
  const verb = buildVerbTable(ws).find(v => v.id === 'history.follow')!
  const input = { map: 'moves.tsv' }
  const preview = await verb.preview!(input)
  expect(preview).not.toContain(root)
  expect(preview).not.toContain('/private/')
  const result = await verb.run({} as never, input)
  expect(result.text).not.toContain(root)
  expect(JSON.stringify(result.details)).not.toContain(root)
  expect(JSON.parse(result.text).refused).toHaveLength(2)
})

test.each(['allow', 'stage', 'adoption'] as const)('R3-2: Bridle asks and verifies the map under %s', async policy => {
  const { buildWriteFlexManifest } = await import('../../src/main/capabilities')
  const { ApprovalBroker, executeCapability } = await import('@bridle/core')
  await seed()
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  await writeFile(join(root, 'moves.tsv'), 'a.md\tb.md\n')
  const cap = buildWriteFlexManifest(ws).capabilities.find(v => v.name === 'history.follow')!
  let requests = 0
  const broker = new ApprovalBroker({ onRequest: request => {
    requests++
    expect(request.preview).toContain('Accepted (line 1): a.md → b.md')
    queueMicrotask(() => broker.resolve(request.id, true))
  } })
  const result = await executeCapability(cap, { map: 'moves.tsv' }, {
    trigger: { id: 'user', source: 'user', trust: 'interactive' }, sessionId: 'session',
    ...(policy === 'adoption' ? { adoption: true as const } : {}),
  }, {
    lane: 'live', policy: () => policy === 'stage' ? 'stage' : 'allow',
    broker, snapshots: null, audit: { record: async () => {} } as never, trace: () => {},
  })
  expect(requests).toBe(1)
  expect(result.isError).not.toBe(true)
  expect(JSON.parse(result.text)).toMatchObject({ attached: 1, refused: [] })
})

test('R3-2: staged clone needs its own fresh approval; each approval is one-shot', async () => {
  await seed()
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  await writeFile(join(root, 'moves.tsv'), 'a.md\tb.md\n')
  const verb = buildVerbTable(ws).find(v => v.id === 'history.follow')!
  const input = { map: 'moves.tsv' }
  await verb.preview!(input)
  const clone = structuredClone(input)
  expect((await verb.run({} as never, clone)).isError).toBe(true)
  await verb.preview!(clone)
  expect((await verb.run({} as never, clone)).isError).not.toBe(true)
  expect((await verb.run({} as never, clone)).isError).toBe(true)
})


// Every row uses the same identity rule; labels retain the review probe's provenance.
const interruptedMoveCases = [
  { name: 'crash before rename: source identity', at: 'a.md' },
  { name: 'crash after rename: destination identity', move: true, at: 'b.md' },
  { name: 'r1 F-1/P1: replacement source after rename', move: true, replaceSource: true, at: 'b.md' },
  { name: 'r1 F-1/P7: atomic destination replacement', move: true, atomic: 'b.md', at: null },
  { name: 'r2 R2-1: save before rename', save: true, at: 'a.md' },
  { name: 'r2 R2-3: outside source move plus unrelated destination', outsideSource: true, target: true, at: null },
  { name: 'r3 R3-1 / r4 P1: rename then outside move and replacement source', move: true, onward: true, replaceSource: true, at: null },
  { name: 'r3 Q2b: moved destination deleted and source replaced', move: true, deleteTarget: true, replaceSource: true, at: null },
  { name: 'r4 P4: unperformed letter-case rename then save', caseOnly: true, save: true, at: 'A.md' },
  { name: 'performed letter-case rename: actual entry decides', caseOnly: true, move: true, at: 'a.md' },
  { name: 'r4 P5: unrelated destination then save', target: true, save: true, at: 'a.md' },
  { name: 'r5 dot-named document: identical atomic save and map recovery', dot: true, atomic: '.draft.md', identical: true, at: null },
  { name: 'r4 atomic save identical bytes: hold and recover to same name', atomic: 'a.md', identical: true, at: null },
  { name: 'r4 atomic save changed bytes: hold and recover to same name', atomic: 'a.md', at: null },
  { name: 'copy destination hash wins while source still exists', copy: true, target: true, identical: true, at: 'b.md' },
  { name: 'copy unrelated destination does not veto source identity', copy: true, target: true, at: 'a.md' },
] as const

test.each(interruptedMoveCases)('$name', async row => {
  const c = row as { dot?: boolean; move?: boolean; replaceSource?: boolean; atomic?: string; identical?: boolean; save?: boolean; outsideSource?: boolean; target?: boolean; onward?: boolean; deleteTarget?: boolean; caseOnly?: boolean; copy?: boolean; at: string | null }
  const from = c.dot ? '.draft.md' : c.caseOnly ? 'A.md' : 'a.md'
  if (c.caseOnly || c.dot) await rename(join(root, 'a.md'), join(root, from))
  const first = await seed(from)
  const to = c.caseOnly ? 'a.md' : 'b.md'
  const intent = prepareVersionMove(root, from, to, c.copy)
  if (c.move) await rename(join(root, from), join(root, to))
  if (c.onward) await rename(join(root, to), join(root, 'c.md'))
  if (c.deleteTarget) await rm(join(root, to))
  if (c.outsideSource) await rename(join(root, 'a.md'), join(root, 'c.md'))
  if (c.replaceSource) await writeFile(join(root, 'a.md'), '# Unrelated\n')
  if (c.target) await writeFile(join(root, to), c.identical ? '# First\n' : '# Unrelated\n')
  if (c.atomic) {
    await writeFile(join(root, 'replacement.md'), c.identical ? '# First\n' : '# Changed\n')
    await rename(join(root, 'replacement.md'), join(root, c.atomic))
  }
  if (c.save) await ws.saveFile(from, '# In-app save\n')
  expect((await store.list()).filter(v => v.id === first.id).map(v => v.path)).toEqual(c.at ? [c.at] : [])
  if (c.save) expect(await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')).toContain(`"id":"${intent.id}","state":"cancelled"`)
  if (c.at === null) {
    const before = await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')
    expect(waitingVersionHistory(root)).toEqual([{ from, count: 1 }])
    expect(await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')).toBe(before)
    const target = c.atomic ?? (c.deleteTarget ? 'a.md' : 'c.md')
    const mapped = followVersionMap(root, `${from}\t${target}\n`)
    expect(mapped).toMatchObject({ attached: 1, refused: [] })
    const records = (await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const cancelled = records.findIndex(r => r.kind === 'version-paths-finish' && r.id === intent.id && r.state === 'cancelled')
    expect(cancelled).toBeGreaterThan(-1)
    expect(cancelled).toBeLessThan(records.findIndex(r => r.id === mapped.undo))
    expect((await store.list({ path: target })).map(v => v.id)).toContain(first.id)
    // Creating the old intent's destination later must never steal the attachment.
    if (target !== to) await writeFile(join(root, to), '# Later unrelated target\n')
    settleVersionMoves(root, true)
    expect((await store.list({ path: target })).map(v => v.id)).toContain(first.id)
    expect(undoVersionMap(root, mapped.undo!)).toBe(1)
    expect((await store.list()).some(v => v.id === first.id)).toBe(false)
    // Undo remains held back after a reload, and another map can recover it again.
    expect(followVersionMap(root, `${from}\t${target}\n`).attached).toBe(1)
  }
})


test('recovering one descendant leaves the rest of an interrupted folder move held back', async () => {
  await mkdir(join(root, 'folder'))
  await rename(join(root, 'a.md'), join(root, 'folder/a.md'))
  await writeFile(join(root, 'folder/second.md'), '# Second\n')
  const first = await seed('folder/a.md')
  const second = await seed('folder/second.md', 2)
  prepareVersionMove(root, 'folder', 'moved')
  await rename(join(root, 'folder'), join(root, 'moved'))
  await rename(join(root, 'moved'), join(root, 'outside'))
  const result = followVersionMap(root, 'folder/a.md\toutside/a.md\n')
  expect(result.attached).toBe(1)
  expect((await store.list()).map(v => v.id)).toEqual([first.id])
  expect(waitingVersionHistory(root)).toEqual([{ from: 'folder/second.md', count: 1 }])
  undoVersionMap(root, result.undo!)
  expect(await store.list()).toEqual([])
  expect(waitingVersionHistory(root).reduce((count, row) => count + row.count, 0)).toBe(2)
  expect(followVersionMap(root, 'folder/second.md\toutside/second.md\n').attached).toBe(1)
  expect((await store.list()).map(v => v.id)).toEqual([second.id])
})

test('hashing is capped for copy evidence while large ordinary moves still use inode identity', async () => {
  const { truncate } = await import('node:fs/promises')
  const { MAX_GUARDED_DOCUMENT_BYTES } = await import('../../src/main/guarded-document-read')
  await truncate(join(root, 'a.md'), MAX_GUARDED_DOCUMENT_BYTES + 1)
  await seed()
  expect(() => prepareVersionMove(root, 'a.md', 'b.md', true)).toThrow(/too large/)
  const intent = prepareVersionMove(root, 'a.md', 'b.md')
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  expect(await store.list({ path: 'b.md' })).toHaveLength(1)
  intent.finish()
})


test('restore settlement keeps an unidentifiable atomic replacement held back', async () => {
  const first = await seed()
  await ws.renameFile('a.md', 'b.md')
  const restore = prepareVersionRestore(root, [{ from: 'b.md', to: 'a.md' }])
  await writeFile(join(root, 'replacement.md'), '# Unexpected restored bytes\n')
  await rename(join(root, 'replacement.md'), join(root, 'a.md'))
  await rm(join(root, 'b.md'))
  restore.settle()
  expect(await store.list()).toEqual([])
  expect(waitingVersionHistory(root)).toEqual([{ from: 'b.md', count: 1 }])
  expect(followVersionMap(root, 'b.md\ta.md\n').attached).toBe(1)
  expect((await store.list()).map(v => v.id)).toEqual([first.id])
})


test.each([false, true])('r5 parent-case rename preserves actual path (performed = %s)', async performed => {
  const { existsSync } = await import('node:fs')
  await mkdir(join(root, 'Dir'))
  await rename(join(root, 'a.md'), join(root, 'Dir/a.md'))
  if (!existsSync(join(root, 'dir/a.md'))) {
    console.warn('SKIP parent-case APFS probe: temporary volume is case-sensitive.')
    return
  }
  const first = await seed('Dir/a.md')
  if (performed) await ws.renameFile('Dir/a.md', 'dir/a.md')
  else prepareVersionMove(root, 'Dir/a.md', 'dir/a.md')
  await ws.saveFile('Dir/a.md', '# Saved after parent-case request\n')
  expect((await ws.listFiles()).map(file => file.path)).toContain('Dir/a.md')
  expect((await store.list({ path: 'Dir/a.md' })).map(v => v.id)).toContain(first.id)
  expect(await store.list({ path: 'dir/a.md' })).toEqual([])
  expect(waitingVersionHistory(root)).toEqual([])
})

test('r5 legacy parent-case intent uses full actual spelling before save', async () => {
  const { existsSync } = await import('node:fs')
  const { appendFile, stat } = await import('node:fs/promises')
  await mkdir(join(root, 'Dir'))
  await rename(join(root, 'a.md'), join(root, 'Dir/a.md'))
  if (!existsSync(join(root, 'dir/a.md'))) { console.warn('SKIP parent-case legacy probe: temporary volume is case-sensitive.'); return }
  const first = await seed('Dir/a.md')
  const info = await stat(join(root, 'Dir/a.md'))
  await appendFile(join(root, '.writeflex/versions.jsonl'), JSON.stringify({ kind: 'version-paths', id: 'legacy-case', assignments: [{ id: first.id, from: 'Dir/a.md', to: 'dir/a.md' }], evidence: { from: 'Dir/a.md', to: 'dir/a.md', dev: info.dev, ino: info.ino } }) + '\n')
  expect((await store.list({ path: 'Dir/a.md' })).map(v => v.id)).toEqual([first.id])
  await ws.saveFile('Dir/a.md', '# Save\n')
  expect((await store.list({ path: 'Dir/a.md' })).map(v => v.id)).toContain(first.id)
})

test('r5 bin is a recovery source only; hidden folders remain refused', async () => {
  await mkdir(join(root, '.folio-bin'))
  await rename(join(root, 'a.md'), join(root, '.folio-bin/a.md'))
  const first = await seed('.folio-bin/a.md')
  prepareVersionMove(root, '.folio-bin/a.md', 'b.md')
  await writeFile(join(root, 'replacement.md'), '# First\n')
  await rename(join(root, 'replacement.md'), join(root, '.folio-bin/a.md'))
  await writeFile(join(root, '.draft.md'), '# First\n')
  expect(followVersionMap(root, '.folio-bin/a.md\t.folio-bin/a.md\n').refused).toHaveLength(1)
  expect(followVersionMap(root, '.folio-bin/a.md\t.writeflex/x.md\n').refused).toHaveLength(1)
  expect(followVersionMap(root, '.folio-bin/a.md\t.draft.md\n')).toMatchObject({ attached: 1, refused: [] })
  expect((await store.list({ path: '.draft.md' })).map(v => v.id)).toEqual([first.id])
})

test('r5 pre-save settle failure logs but saves; lost identity stays held and recoverable', async () => {
  const { spyOn } = await import('bun:test')
  const appends = await import('../../src/main/checked-store-append')
  const first = await seed()
  prepareVersionMove(root, 'a.md', 'b.md')
  const append = appends.appendStoreLineSync
  const failure = spyOn(appends, 'appendStoreLineSync').mockImplementation((...args) => {
    if (args[1] === '.writeflex/versions.jsonl') throw new Error('Injected settle append failure')
    return append(...args)
  })
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await ws.saveFile('a.md', '# Save must succeed\n')
    expect(log).toHaveBeenCalled()
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('# Save must succeed\n')
    expect((await store.list()).some(v => v.id === first.id)).toBe(false)
    expect(waitingVersionHistory(root)).toEqual([{ from: 'a.md', count: 1 }])
  } finally { failure.mockRestore(); log.mockRestore() }
  expect(followVersionMap(root, 'a.md\ta.md\n').attached).toBe(1)
  expect((await store.list({ path: 'a.md' })).map(v => v.id)).toContain(first.id)
})

test('r5 suggestions include held history at a live old name, including same-name recovery', () => cliFixture(async fx => {
  await fx.write('.draft.md', '# First\n')
  expect((await fx.cli(['save-version', '.draft.md', '--name', 'First'])).code).toBe(0)
  const workspace = new Workspace(fx.root)
  prepareVersionMove(fx.root, '.draft.md', 'final.md')
  await writeFile(join(fx.root, 'replacement.md'), '# First\n')
  await rename(join(fx.root, 'replacement.md'), join(fx.root, '.draft.md'))
  await fx.write('other.md', '# First\n')
  expect(await suggestHistoryAttachments(workspace, 'other.md')).toEqual([{ from: '.draft.md', to: 'other.md' }])
  expect(await suggestHistoryAttachments(workspace, '.draft.md')).toEqual([{ from: '.draft.md', to: '.draft.md' }])
}))

test('r5 last finish wins for reverse moves and destination history exclusion', async () => {
  const first = await seed()
  const earlier = await seed('b.md', 0)
  const intent = prepareVersionMove(root, 'a.md', 'b.md')
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  intent.cancel()
  intent.finish()
  await ws.renameFile('b.md', 'a.md')
  expect((await store.list({ path: 'a.md' })).map(v => v.id)).toEqual([first.id])
  expect((await store.list({ path: 'b.md' })).map(v => v.id)).toEqual([earlier.id])
})


test('r6 waiting attachment excludes a deleted replacement own orphaned version', async () => {
  const held = await seed()
  prepareVersionMove(root, 'a.md', 'missing.md')
  await writeFile(join(root, 'replacement.md'), '# Replacement\n')
  await rename(join(root, 'replacement.md'), join(root, 'a.md'))
  const orphan = await seed('a.md', 2)
  await rm(join(root, 'a.md'))
  await writeFile(join(root, 'b.md'), '# Target\n')
  expect(waitingVersionHistory(root)).toEqual([{ from: 'a.md', count: 1 }])
  const text = 'a.md\tb.md\n'
  const plan = previewVersionMap(root, text, true)
  expect(plan.assignments.map(a => a.id)).toEqual([held.id])
  const result = followVersionMap(root, text, JSON.stringify(plan), true)
  expect((await store.list({ path: 'b.md' })).map(v => v.id)).toEqual([held.id])
  expect((await store.list({ path: 'a.md' })).map(v => v.id)).toEqual([orphan.id])
  undoVersionMap(root, result.undo!)
  expect(waitingVersionHistory(root)).toEqual([{ from: 'a.md', count: 1 }])
})

test.each([false, true])('r6 rename through a linked folder still moves the file (history = %s)', async history => {
  const { spyOn } = await import('bun:test')
  await mkdir(join(root, 'real'))
  await rename(join(root, 'a.md'), join(root, 'real/a.md'))
  await symlink('real', join(root, 'L'))
  if (history) await seed('L/a.md')
  const warning = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await ws.renameFile('L/a.md', 'L/b.md')
    expect(await readFile(join(root, 'real/b.md'), 'utf8')).toBe('# First\n')
    if (history) {
      expect(warning).toHaveBeenCalledWith('The file rename will proceed, but its history cannot move through a linked path.', expect.anything())
      expect(await store.list({ path: 'L/b.md' })).toEqual([])
      expect(await store.list({ path: 'L/a.md' })).toHaveLength(1)
    }
  } finally { warning.mockRestore() }
})

test('r6 attachment refuses a changed approved plan without writing', async () => {
  await seed()
  await rename(join(root, 'a.md'), join(root, 'b.md'))
  const text = 'a.md\tb.md\n'
  const plan = JSON.stringify(previewVersionMap(root, text))
  await seed('a.md', 2)
  const before = await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')
  expect(() => followVersionMap(root, text, plan)).toThrow('changed since approval')
  expect(await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')).toBe(before)
})

// Merge regressions: the Folio refusal must precede the durable history intent.
test('one-Folio refusal writes no version-move record', async () => {
  await mkdir(join(root, 'book/ch'), { recursive: true })
  await writeFile(join(root, 'book/_book_INDEX.md'), '## Running order\n')
  await writeFile(join(root, 'declaration.md'), '## Running order\n')
  const version = await seed('declaration.md')
  const before = await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')
  await expect(ws.renameFile('declaration.md', 'book/ch/_ch_INDEX.md', { documentOnly: true })).rejects.toThrow('already occupies')
  expect(await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8')).toBe(before)
  expect((await store.list({ path: 'declaration.md' }))[0].id).toBe(version.id)
  expect(await readFile(join(root, 'declaration.md'), 'utf8')).toBe('## Running order\n')
})

test.each([false, true])('allowed Folio part folder move carries every history (guarded = %s)', async guarded => {
  await mkdir(join(root, 'book/parts'), { recursive: true })
  await writeFile(join(root, 'book/_book_INDEX.md'), '## Running order\n')
  await writeFile(join(root, 'book/parts/a.md'), '# Part A\n')
  await writeFile(join(root, 'book/parts/b.md'), '# Part B\n')
  const a = await seed('book/parts/a.md')
  const b = await seed('book/parts/b.md')
  await ws.renameFolder('book/parts', 'chapters', { documentOnly: guarded })
  expect((await store.list({ path: 'book/chapters/a.md' }))[0].id).toBe(a.id)
  expect((await store.list({ path: 'book/chapters/b.md' }))[0].id).toBe(b.id)
  expect(await store.list({ path: 'book/parts/a.md' })).toEqual([])
  await ws.renameFile('book/chapters/a.md', 'renamed.md', { documentOnly: guarded })
  expect((await store.list({ path: 'book/chapters/renamed.md' }))[0].id).toBe(a.id)
})
