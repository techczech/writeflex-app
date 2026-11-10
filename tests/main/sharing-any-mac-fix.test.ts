import { afterEach, expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServiceClient } from '../../src/main/sharing-client'
import { createShareSync } from '../../src/main/sharing-share-sync'
import { sharingWorkspace } from '../../src/main/sharing-workspace'
import { readRecords, relativePathOk, type ShareRecord } from '../../src/main/sharing-share-record'
import { readerClaimFor, releaseReaderClaim, setReaderNotesSource } from '../../src/main/sharing-reader-notes-run'
import type { Change } from '../../src/engine'
import { createLocalSharingRoots } from '../../src/main/sharing-local-roots'
import * as identityReader from '../../src/main/sharing-workspace'
import * as storeReader from '../../src/main/checked-store-write'
import { spyOn } from 'bun:test'
import { SettingsStore } from '../../src/main/settings'

let scratch = ''
afterEach(async () => { setReaderNotesSource(null); if (scratch) await rm(scratch, { recursive: true, force: true }); scratch = '' })

test('build 13 is detected before unknown HTML/non-JSON routes: legacy comments and Accept keep working', async () => {
  for (const status of [404, 405]) {
    const paths: string[] = []
    const client = createServiceClient({ fetch: (async (input: unknown) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (path === '/version') return Response.json({ service: 'writeflex-sharing', build: 13 })
      if (path.endsWith('/notes')) return Response.json({ notes: [{ key: 'legacy-note' }], more: false, refused: {} })
      return new Response('<html>Link off</html>', { status })
    }) as typeof fetch })
    expect(await client.noteState('https://fixture.test', 'abcdefghijklmnopqrstuv', 'fixture-owner')).toMatchObject({ kind: 'ok', body: { notes: [{ key: 'legacy-note' }] } })
    expect(await client.claimNote('https://fixture.test', 'abcdefghijklmnopqrstuv', 'fixture-owner', 'key', 'operation')).toMatchObject({ kind: 'ok', body: { allowed: true } })
    expect(paths).toEqual(['/version', '/shares/abcdefghijklmnopqrstuv/notes'])
  }
})

async function syncWorld(build = 15) {
  scratch = await mkdtemp(join(tmpdir(), 'wf-sharing-fixes-'))
  const a = join(scratch, 'original'), b = join(scratch, 'copy')
  await mkdir(a); await mkdir(b)
  const identity = (await sharingWorkspace(a))[0]
  await cp(join(a, '.writeflex'), join(b, '.writeflex'), { recursive: true })
  let remembered: import('../../src/main/sharing-local-roots').SharingWorkspaceRoots = {}, records: ShareRecord[] = [], lists = 0, clock = Date.now()
  const problems: string[] = []
  let open = [a]
  const client = createServiceClient({ fetch: (async (input: unknown, init?: RequestInit) => {
    if (String(input).endsWith('/version')) return Response.json({ service: 'writeflex-sharing', build })
    if (String(input).endsWith('/record')) return Response.json(init?.method === 'PUT' ? { kept: true } : { workspace: identity, kind: 'piece', path: 'paper.md', name: null, madeAt: 1, partKeys: {}, parts: [] })
    lists++
    const seen = JSON.parse(String(init?.body)).workspaces[0]
    if (seen.id !== identity.id) return Response.json({ workspace: seen, records: [] })
    return Response.json({ workspace: identity, records: [{ workspace: identity, kind: 'piece', path: 'paper.md', name: null, madeAt: 1, partKeys: {}, parts: [], shareId: 'abcdefghijklmnopqrstuv', on: true, revision: 1 }] })
  }) as typeof fetch })
  const sync = createShareSync({ access: () => ({ address: 'https://fixture.test', base: 'https://fixture.test', key: 'fixture' }), client,
    records: () => records, replace: (next) => { records = next; return true }, tokenFor: () => 'fixture-owner', keepToken: () => true,
    now: () => clock, problem: (id, reason, kind = 'refused') => { problems.push(reason); records = records.map((r) => r.shareId === id ? { ...r, problem: { kind, reason, at: clock } } : r) },
    workspaceRoots: { read: () => remembered, write: (next) => { remembered = next; return true } }, openRoots: () => open,
  })
  return { seed: (value: ShareRecord[]) => { records = value }, a, b, identity, sync, records: () => records, remembered: () => remembered, lists: () => lists, problems, tick: (ms: number) => { clock += ms }, open: (roots: string[]) => { open = roots } }
}

test('a same-Mac copy holds both roots and changes only the chosen copy identity', async () => {
  const w = await syncWorld()
  await w.sync.refresh(w.a)
  w.open([w.a, w.b])
  await w.sync.refresh(w.b)
  expect(w.records()[0].root).toBe(w.a)
  expect(w.sync.conflict(w.a)?.roots).toEqual([w.a, w.b].sort())
  expect(w.sync.conflict(w.b)?.roots).toEqual([w.a, w.b].sort())
  expect((await sharingWorkspace(w.b, undefined, { readOnly: true }))[0].id).toBe(w.identity.id)
  const originalBytes = await readFile(join(w.a, '.writeflex/sharing-workspace.json'), 'utf8')
  expect(await w.sync.register(w.records()[0])).toBe(false)
  expect(await w.sync.chooseOriginal(w.b, w.a)).toBe(true)
  expect(await readFile(join(w.a, '.writeflex/sharing-workspace.json'), 'utf8')).toBe(originalBytes)
  const copy = JSON.parse(await readFile(join(w.b, '.writeflex/sharing-workspace.json'), 'utf8'))
  expect(copy.id).not.toBe(w.identity.id)
  expect(copy.aliases).toEqual([])
  await w.sync.refresh(w.b, true)
  expect(w.remembered()[copy.id]).toMatchObject({ root: w.b })
  await cp(join(w.a, '.writeflex/sharing-workspace.json'), join(w.b, '.writeflex/sharing-workspace conflict.json'))
  await w.sync.refresh(w.b, true)
  expect((await sharingWorkspace(w.b, undefined, { readOnly: true })).map((id) => id.id)).toEqual([copy.id])
  expect(w.records()[0].root).toBe(w.a)
})

test('a fresh Mac accepts the synced identity at its first local root', async () => {
  const w = await syncWorld()
  w.open([w.b])
  await w.sync.refresh(w.b)
  expect(w.records()[0].root).toBe(w.b)
  expect(w.remembered()[w.identity.id]).toMatchObject({ root: w.b })
})

test('two open roots with one identity and no history attach neither until the original is chosen', async () => {
  const w = await syncWorld()
  w.open([w.a, w.b])
  await Promise.all([w.sync.refresh(w.a), w.sync.refresh(w.b)])
  expect(w.records()).toEqual([])
  expect(w.sync.conflict(w.a)).toEqual({ roots: [w.a, w.b].sort() })
  expect(w.sync.conflict(w.b)).toEqual({ roots: [w.a, w.b].sort() })
  expect(w.lists()).toBe(0)
  expect(await w.sync.chooseOriginal(w.a, '/not-an-offered-root')).toBe(false)
  expect(await w.sync.chooseOriginal(w.a, w.b)).toBe(true)
  await w.sync.refresh(w.b)
  expect(w.records()[0].root).toBe(w.b)
  expect(JSON.parse(await readFile(join(w.a, '.writeflex/sharing-workspace.json'), 'utf8')).id).not.toBe(w.identity.id)
})

test('an unshared Collection gets no identity file or admin list, and successful discovery is cached for 60 seconds', async () => {
  const w = await syncWorld()
  const unshared = join(scratch, 'unshared'); await mkdir(unshared)
  await w.sync.refresh(unshared)
  expect(await readFile(join(unshared, '.writeflex/sharing-workspace.json'), 'utf8').catch(() => null)).toBeNull()
  expect(w.lists()).toBe(0)
  await w.sync.refresh(w.a); await w.sync.refresh(w.a)
  expect(w.lists()).toBe(1)
  w.tick(60_001)
  await w.sync.refresh(w.a)
  expect(w.lists()).toBe(2)
})

test('local uploadable paths use the service path rules', () => {
  for (const path of ['a\u0001.md', 'a\u007f.md', '../a.md', '/a.md', 'a\\b.md']) expect(relativePathOk(path)).toBe(false)
  expect(relativePathOk('notes/a.md')).toBe(true)
  expect(relativePathOk('notes/a:b.md')).toBe(true)
  // Legacy records stay visible so the Sharing page can explain why they cannot be uploaded.
  expect(readRecords([{ shareId: 'abcdefghijklmnopqrstuv', root: '/fixture', path: 'a:b.md' }])).toHaveLength(1)
})

test('manual claim release respects cancellation and rechecks a changed claim after confirmation', async () => {
  const at = Date.now() - 700000
  let claim = { at, mine: false }, released = 0
  const change = { outsideSource: 'reader', readerNote: { shareId: 'abcdefghijklmnopqrstuv', key: 'reader.note', kind: 'edit' } } as unknown as Change
  setReaderNotesSource({ links: () => [{ shareId: 'abcdefghijklmnopqrstuv', base: 'https://fixture.test', owner: 'fixture-owner' } as any],
    fetchNotes: async () => ({ kind: 'ok', status: 200, body: { notes: [{ key: 'reader.note', claim }], more: false, refused: {} } }),
    markCollected: async () => ({ kind: 'ok', status: 200, body: { collected: [], already: [], unknown: [] } }),
    releaseAccept: async (_base, _id, _owner, _key, _operation, force, expectedAt) => { expect(force).toBe(true); expect(expectedAt).toBe(claim.at); released++; return { kind: 'ok' } },
  })
  expect(await releaseReaderClaim('/fixture', change, async () => false)).toBe(false)
  expect(released).toBe(0)
  expect(await releaseReaderClaim('/fixture', change, async () => { claim = { at: at + 1, mine: false }; return true })).toBe(false)
  expect(released).toBe(0)
  expect(await releaseReaderClaim('/fixture', change, async () => true)).toBe(true)
  expect(released).toBe(1)
  expect(readerClaimFor(change)).toBeNull()
})


test('an invalid legacy record stays visible and reports why its metadata cannot be uploaded', async () => {
  const w = await syncWorld()
  await w.sync.refresh(w.a)
  expect(await w.sync.register({ ...w.records()[0], path: 'bad\\path.md' })).toBe(false)
  expect(w.problems.at(-1)).toContain('not uploadable')
  expect(await w.sync.register({ ...w.records()[0], parts: [{ path: 'paper.md', title: 'a'.repeat(1001), missing: false }] })).toBe(false)
  expect(w.problems.at(-1)).toContain('1,000 characters')
  expect(w.records()).toHaveLength(1)
})

test('this Mac remembers its workspace roots in app data across restart, independently of workspace files', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'wf-sharing-root-settings-'))
  const path = join(scratch, 'userData/settings.json')
  const store = new SettingsStore(path)
  const roots = { workspaceaaaaaaaa: '/synthetic/original' }
  expect(store.setSharingWorkspaceRoots(roots)).toBe(true)
  roots.workspaceaaaaaaaa = '/changed-by-caller'
  expect(new SettingsStore(path).sharingWorkspaceRoots()).toEqual({ workspaceaaaaaaaa: '/synthetic/original' })
  await writeFile(path, JSON.stringify({ sharingWorkspaceRoots: { workspaceaaaaaaaa: 42, workspacebbbbbbbb: '/synthetic/valid' } }))
  expect(new SettingsStore(path).sharingWorkspaceRoots()).toEqual({ workspacebbbbbbbb: '/synthetic/valid' })
})

test('a local move during a conditional rename is never overwritten by its older cache completion', async () => {
  const workspace = { id: 'workspaceaaaaaaaa', createdAt: 1 }
  let records = readRecords([{ shareId: 'abcdefghijklmnopqrstuv', root: '/fixture', path: 'paper.md', generation: 0, madeAt: 1, on: true }])
  const client = createServiceClient({ fetch: (async (input: unknown, init?: RequestInit) => {
    if (String(input).endsWith('/version')) return Response.json({ service: 'writeflex-sharing', build: 15 })
    if (init?.method === 'GET') return Response.json({ workspace, kind: 'piece', path: 'paper.md', name: null, madeAt: 1, partKeys: {}, parts: [] })
    // A file move committed locally while the service handled this rename.
    records = [{ ...records[0], path: 'moved.md', generation: 1, registryPending: true }]
    return Response.json({ kept: true })
  }) as typeof fetch })
  const sync = createShareSync({ access: () => ({ base: 'https://fixture.test', address: 'https://fixture.test', key: 'fixture-admin' }), client,
    records: () => records, replace: (next) => { records = next; return true }, tokenFor: () => 'fixture-owner', keepToken: () => true })
  expect(await sync.rename(records[0], 'New name')).toBe(false)
  expect(records[0]).toMatchObject({ path: 'moved.md', generation: 1, registryPending: true })
})


test('symlink and real path are one root and a move keeps identity and links', async () => {
  const w = await syncWorld()
  const alias = join(scratch, 'alias')
  await symlink(w.a, alias)
  w.open([w.a, alias])
  await w.sync.refresh(alias)
  expect(w.sync.conflict(w.a)).toBeNull()
  expect(w.records()[0].root).toBe(await realpath(w.a))
  const moved = join(scratch, 'renamed')
  await rename(w.a, moved)
  w.open([moved])
  await w.sync.refresh(moved, true)
  expect((await sharingWorkspace(moved, undefined, { readOnly: true }))[0]).toEqual(w.identity)
  expect(w.records()[0].root).toBe(await realpath(moved))
  expect(w.remembered()[w.identity.id]).toMatchObject({ root: await realpath(moved) })
})

test('an identity changed by sync never re-registers cached links under the new id', async () => {
  const w = await syncWorld()
  await w.sync.refresh(w.a)
  const before = w.records()[0]
  const changed = (await sharingWorkspace(w.a, undefined, { fresh: true }))[0]
  expect(changed.id).not.toBe(w.identity.id)
  await w.sync.refresh(w.a, true)
  expect(await w.sync.register(before)).toBe(false)
  expect(w.records()[0].workspaceId).toBe(w.identity.id)
  expect(w.records()[0].problem?.kind).toBe('workspace-copy')
})

test('old-service record uploads refuse with an update code and leave the pending registration', async () => {
  const client = createServiceClient({ fetch: (async () => Response.json({ service: 'writeflex-sharing', build: 13 })) as typeof fetch })
  expect(await client.putRecord('https://fixture.test', 'abcdefghijklmnopqrstuv', 'fixture-owner', {} as any)).toMatchObject({ kind: 'refused', code: 'older_service', status: 426 })
})


test('registering on an old service retains pending state and explains the needed update', async () => {
  const w = await syncWorld(13)
  w.seed(readRecords([{ shareId: 'abcdefghijklmnopqrstuv', root: w.a, path: 'paper.md', madeAt: 1, registryPending: true }]))
  expect(await w.sync.register(w.records()[0])).toBe(false)
  expect(w.records()[0].registryPending).toBe(true)
  expect(w.records()[0].problem).toMatchObject({ kind: 'service-update' })
  expect(w.problems.at(-1)).toBe('Moved here; links follow once the sharing service is updated (Settings › Sharing › Update)')
})

test('choosing the other folder moves the links to that original and gives only the copy a new id', async () => {
  const w = await syncWorld()
  await w.sync.refresh(w.a)
  w.open([w.a, w.b])
  await w.sync.refresh(w.b)
  const kept = await readFile(join(w.b, '.writeflex/sharing-workspace.json'), 'utf8')
  expect(await w.sync.chooseOriginal(w.a, w.b)).toBe(true)
  await w.sync.refresh(w.b, true)
  expect(await readFile(join(w.b, '.writeflex/sharing-workspace.json'), 'utf8')).toBe(kept)
  expect(w.records()[0].root).toBe(w.b)
  expect(w.records()[0].workspaceId).toBe(w.identity.id)
  expect(w.sync.allowed(w.records()[0])).toBe(true)
})


for (const change of ['delete', 'move', 'detach'] as const) test(`a held copy that is ${change} releases the original without a choice`, async () => {
  const w = await syncWorld()
  await w.sync.refresh(w.a)
  w.open([w.a, w.b]); await w.sync.refresh(w.b)
  expect(w.sync.allowed(w.records()[0])).toBe(false)
  if (change === 'delete') await rm(w.b, { recursive: true })
  if (change === 'move') await rename(w.b, join(scratch, 'moved-away'))
  if (change === 'detach') await sharingWorkspace(w.b, undefined, { fresh: true })
  w.tick(5000)
  await w.sync.touch(w.a) // The expiry-driven background check needs no user action.
  expect(w.sync.conflict(w.a)).toBeNull()
  expect(w.sync.allowed(w.records()[0])).toBe(true)
  expect(w.records()[0].root).toBe(w.a)
})

test('restart derives holds only from open and remembered roots; no hold is persisted', async () => {
  const w = await syncWorld()
  const settings = new SettingsStore(join(scratch, 'app-data/settings.json'))
  let open = [w.a]
  const make = () => createLocalSharingRoots({ store: { read: () => settings.sharingWorkspaceRoots(), write: (v) => settings.setSharingWorkspaceRoots(v) }, openRoots: () => open })
  const local = make()
  await local.identify(w.a)
  open = [w.a, w.b]; await local.identify(w.b)
  expect(local.allowed({ root: w.a, workspaceId: w.identity.id })).toBe(false)
  expect(JSON.stringify(settings.sharingWorkspaceRoots())).not.toContain('pendingRoots')
  open = [w.a]
  const restarted = make()
  await restarted.identify(w.a)
  expect(restarted.conflict(w.a)).toBeNull()
  expect(restarted.allowed({ root: w.a, workspaceId: w.identity.id })).toBe(true)
  open = [w.b]
  await restarted.identify(w.b)
  expect(restarted.conflict(w.b)?.roots).toEqual([w.a, w.b].sort())
})

for (const carriesId of [true, false]) test(`a replacement at the remembered path is read; carries original id: ${carriesId}`, async () => {
  const w = await syncWorld()
  await w.sync.refresh(w.a)
  const moved = join(scratch, 'moved-original')
  await rename(w.a, moved)
  await mkdir(w.a)
  if (carriesId) await cp(join(w.b, '.writeflex'), join(w.a, '.writeflex'), { recursive: true })
  w.open([moved])
  await w.sync.refresh(moved, true)
  if (carriesId) {
    expect(w.sync.conflict(moved)?.roots).toEqual([w.a, moved].sort())
    expect(w.records()[0].root).toBe(w.a)
  } else {
    expect(w.sync.conflict(moved)).toBeNull()
    expect(w.records()[0].root).toBe(moved)
    expect(w.remembered()[w.identity.id]).toMatchObject({ root: moved })
  }
})

test('an unreadable identity holds that root only and recovers when readable', async () => {
  const w = await syncWorld()
  await w.sync.refresh(w.a)
  const identityPath = join(w.a, '.writeflex/sharing-workspace.json')
  const bytes = await readFile(identityPath)
  await writeFile(identityPath, '{truncated')
  w.open([w.a, w.b])
  await w.sync.refresh(w.b, true)
  expect(w.sync.unreadable(w.a)).toBe(true)
  expect(w.sync.allowed({ root: w.a, workspaceId: w.identity.id })).toBe(false)
  expect(w.sync.unreadable(w.b)).toBe(false)
  expect(w.sync.allowed({ root: w.b, workspaceId: w.identity.id })).toBe(true)
  await writeFile(identityPath, bytes)
  await w.sync.refresh(w.b, true)
  expect(w.sync.conflict(w.b)?.roots).toEqual([w.a, w.b].sort())
})

test('allowed uses the identified root cache without identity reads on each view', async () => {
  const w = await syncWorld()
  const local = createLocalSharingRoots({  })
  await local.identify(w.a)
  const read = spyOn(identityReader, 'sharingWorkspace')
  const files = spyOn(storeReader, 'readStoreFile')
  try {
    for (let i = 0; i < 50; i++) expect(local.allowed({ root: w.a, workspaceId: w.identity.id })).toBe(true)
    expect(read).not.toHaveBeenCalled()
    expect(files).not.toHaveBeenCalled()
    await sharingWorkspace(w.a, undefined, { fresh: true })
    // A forced refresh is the same invalidation path as the workspace watcher.
    await local.identify(w.a)
    expect(local.allowed({ root: w.a, workspaceId: w.identity.id })).toBe(false)
  } finally { read.mockRestore(); files.mockRestore() }
})

test('Node filesystem semantics: case-only root rename never offers a copy or rewrites the original', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'wf-sharing-node-case-'))
  const root = join(scratch, 'CaseDir'), lower = join(scratch, 'casedir')
  await mkdir(root)
  await sharingWorkspace(root)
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, '../../src/main/sharing-local-roots.ts')], target: 'node', format: 'esm' })
  expect(build.success).toBe(true)
  const bundle = join(scratch, 'roots.mjs')
  await writeFile(bundle, await build.outputs[0].text())
  const code = `
    const { createLocalSharingRoots } = await import(${JSON.stringify('file://')} + process.argv[1]);
    const fs = await import('node:fs'); const assert = (await import('node:assert/strict')).default;
    const [root, lower] = process.argv.slice(2);
    assert.equal(fs.statSync(root).ino, fs.statSync(lower).ino);
    assert.notEqual(fs.realpathSync(root), fs.realpathSync(lower));
    const file = root + '/.writeflex/sharing-workspace.json'; const bytes = fs.readFileSync(file, 'utf8');
    let remembered = {}; const local = createLocalSharingRoots({store: {read: () => remembered, write: v => { remembered = v; return true }}, openRoots: () => [root, lower]});
    const ids = await local.identify(lower); await local.identify(root);
    assert.equal(ids.length, 1); assert.equal(local.conflict(root), null);
    assert.equal(await local.chooseOriginal(root, lower), false);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal(remembered[ids[0].id].ino, fs.statSync(root).ino);
    // Both case spellings count once, including after a held copy is renamed.
    const copy = root + '-copy'; fs.cpSync(root, copy, {recursive: true});
    let open = [root, lower, copy];
    const again = createLocalSharingRoots({store: {read: () => remembered, write: v => { remembered = v; return true }}, openRoots: () => open});
    await again.identify(copy);
    const renamed = root + '-COPY'; fs.renameSync(copy, renamed); open = [lower, renamed];
    await again.identify(renamed);
    assert.equal(again.conflict(renamed).roots.length, 2);
    assert.equal(again.conflict(lower).roots.length, 2);
    assert.equal(await again.chooseOriginal(renamed, lower), true);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.notEqual(JSON.parse(fs.readFileSync(renamed + '/.writeflex/sharing-workspace.json', 'utf8')).id, ids[0].id);

  `
  const child = Bun.spawn(['node', '--input-type=module', '-e', code, bundle, root, lower], { stdout: 'pipe', stderr: 'pipe' })
  const error = await new Response(child.stderr).text()
  expect({ exit: await child.exited, error }).toEqual({ exit: 0, error: '' })
})


test('allowed keeps the last answer at expiry and invalidation; touch refreshes without query side effects', async () => {
  const w = await syncWorld()
  let clock = 0
  const local = createLocalSharingRoots({ now: () => clock })
  await local.identify(w.a)
  const record = { root: w.a, workspaceId: w.identity.id }
  expect(local.allowed(record)).toBe(true)
  await sharingWorkspace(w.a, undefined, { fresh: true })
  clock = 5000
  const read = spyOn(identityReader, 'sharingWorkspace')
  try {
    expect(local.allowed(record)).toBe(true)
    expect(read).not.toHaveBeenCalled()
  } finally { read.mockRestore() }
  await local.touch(w.a)
  expect(local.allowed(record)).toBe(false)
  await writeFile(join(w.a, '.writeflex/sharing-workspace.json'), JSON.stringify(w.identity))
  local.invalidate(w.a)
  expect(local.allowed(record)).toBe(false)
  await local.touch(w.a)
  expect(local.allowed(record)).toBe(true)
})

test('watcher invalidation during an identity read cannot refill the cache with pre-arrival bytes', async () => {
  const w = await syncWorld()
  const local = createLocalSharingRoots({  })
  let release!: () => void, began!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { began = resolve })
  const read = spyOn(identityReader, 'sharingWorkspace').mockImplementationOnce(async () => { began(); await gate; return [w.identity] })
  try {
    const pending = local.identify(w.a)
    await started
    const fresh = (await sharingWorkspace(w.a, undefined, { fresh: true }))[0]
    local.invalidate(w.a)
    release()
    expect((await pending)[0].id).toBe(fresh.id)
    expect(local.allowed({ root: w.a, workspaceId: w.identity.id })).toBe(false)
  } finally { release(); read.mockRestore() }
})


test('a slow publish completes after expiry and watcher invalidation without another copy check', async () => {
  const w = await syncWorld()
  let clock = 0, images = 0, pages = 0
  const local = createLocalSharingRoots({ now: () => clock })
  await local.identify(w.a)
  const { createPublishOnce } = await import('../../src/main/sharing-publish-once')
  const client = createServiceClient({ fetch: (async (input: unknown) => {
    if (String(input).includes('/images/')) { images++; clock += 6000; local.invalidate(w.a); return Response.json({ kept: true }) }
    pages++; return Response.json({ revision: 1, publishedAt: clock })
  }) as typeof fetch })
  const record = readRecords([{ shareId: 'abcdefghijklmnopqrstuv', root: w.a, path: 'paper.md', on: true, workspaceId: w.identity.id }])[0]
  const publish = createPublishOnce({ access: () => ({ base: 'https://fixture.test', address: 'https://fixture.test', key: 'fixture' }), client,
    tokenFor: () => 'fixture-owner', now: () => clock, timeZone: () => null,
    render: async () => { clock += 6000; return { title: 'Paper', html: '<p>Paper</p>', headings: [], chips: [], savedAt: 1, refusedPictures: 0,
      pictures: [1, 2].map(n => ({ name: String(n).repeat(64) + '.png', bytes: new Uint8Array([1]), mime: 'image/png' })) } },
  })
  expect((await publish.publishOnce(record))?.revision).toBe(1)
  expect(images).toBe(2); expect(pages).toBe(1)
})


test('a link rename after cache expiry completes on its first attempt', async () => {
  const w = await syncWorld()
  await w.sync.refresh(w.a)
  w.tick(6000)
  expect(await w.sync.rename(w.records()[0], 'Renamed')).toBe(true)
  expect(w.records()[0].name).toBe('Renamed')
})

test('discovery and legacy caches never mark registry part keys seen', async () => {
  const w = await syncWorld()
  let records = readRecords([{ shareId: 'abcdefghijklmnopqrstuv', kind: 'folio', path: '', root: w.a, madeAt: 1, workspaceId: w.identity.id,
    on: true, revision: 1, publishedAt: 1000, partKeys: { 'old.md': 'aaaaaa' } }])
  expect(records[0].seenPartKeys).toEqual([]) // A legacy registry cache proves no local render.
  let publishedAt: number | null = null
  let partKey = 'bbbbbb'
  const registry = { workspace: w.identity, kind: 'folio', path: '', name: null, madeAt: 1 }
  const client = createServiceClient({ fetch: (async () => Response.json({ workspace: w.identity, records: [{ ...registry, shareId: records[0].shareId,
    partKeys: { 'new.md': partKey }, parts: [{ path: 'new.md', title: 'New', missing: false }], on: true, revision: publishedAt === null ? 0 : 2, publishedAt }] })) as typeof fetch })
  const sync = createShareSync({ access: () => ({ base: 'https://fixture.test', address: 'https://fixture.test', key: 'fixture' }), client,
    records: () => records, replace: next => { records = next; return true }, tokenFor: () => 'fixture-owner', keepToken: () => true })
  await sync.refresh(w.a)
  expect(records[0].seenPartKeys).toEqual([])
  records[0].seenPartKeys = ['aaaaaa'] // A locally rendered key survives discovery.
  publishedAt = 2000
  await sync.refresh(w.a, true)
  expect(records[0].seenPartKeys).toEqual(['aaaaaa'])
  partKey = 'cccccc'
  await sync.refresh(w.a, true)
  expect(readRecords(JSON.parse(JSON.stringify(records)))[0].seenPartKeys).toEqual(['aaaaaa'])
  expect(records[0].partKeys).toEqual({ 'new.md': 'cccccc' })
})
