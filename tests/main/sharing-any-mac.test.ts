import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile, cp, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as service from '../../sharing-service/index.ts'
import { ADMIN_KEY, ORIGIN, fakeService, type ServiceModule } from '../helpers/sharing-service-runtime'
import { memorySecrets } from '../helpers/memory-secrets'
import { createServiceClient } from '../../src/main/sharing-client'
import { createSharingPublisher } from '../../src/main/sharing-publisher'
import { Workspace } from '../../src/main/workspace'
import { ChangeStore } from '../../src/main/changes'
import { collectReaderNotes, guardedDocumentReader } from '../../src/main/sharing-reader-notes'
import { sendReaderOutcomes } from '../../src/main/sharing-reader-replies'
import { WorkspaceAgent } from '../../src/main/agent'
import { setReaderNotesSource } from '../../src/main/sharing-reader-notes-run'
import { createPublishOnce } from '../../src/main/sharing-publish-once'
import { readRecords } from '../../src/main/sharing-share-record'
import { note, secret } from '../helpers/sharing-service-notes-suite'

let scratch = ''
afterEach(async () => { setReaderNotesSource(null); if (scratch) await rm(scratch, { recursive: true, force: true }); scratch = '' })

test('two Macs discover one legacy share, publish conditionally and share review state without duplicate cards', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'wf-two-macs-'))
  const roots = [join(scratch, 'mac-a'), join(scratch, 'mac-b')]
  for (const root of roots) { await mkdir(root); await writeFile(join(root, 'paper.md'), 'They are long, they are ordered by when.') }
  const svc = fakeService(service as unknown as ServiceModule, { ADMIN_SECRET_macb: 'mac-b-admin-key-for-test' })
  let offline = false, loseClaimAnswer = false
  const client = createServiceClient({ fetch: async (input, init) => { if (offline) throw new Error('offline fixture'); const path = new URL(String(input)).pathname; const answer = await svc.call(path, init); if (loseClaimAnswer && path.endsWith('/notes/claim')) { loseClaimAnswer = false; throw new Error('lost claim response fixture') } return answer }, wait: async () => {} })
  const access = (key: string) => ({ address: ORIGIN, base: ORIGIN, key })
  const made = await client.createShare(access(ADMIN_KEY))
  if (made.kind !== 'ok') throw new Error('fixture share failed')
  const { shareId, ownerToken } = made.body
  const aSecrets = memorySecrets(), bSecrets = memorySecrets()
  aSecrets.store.write('sharing-links', JSON.stringify({ format: 1, tokens: { [shareId]: ownerToken } }))
  let aRecords: unknown = [{ shareId, root: roots[0], path: 'paper.md', name: 'Co-author', kind: 'piece', madeAt: 1000, on: true, comments: true, revision: 0 }]
  let bRecords: unknown = []
  let text = ['old text', 'old text'], times = [2000, 1000]
  const render = (i: number) => async () => ({ title: 'Paper', html: `<p>${text[i]}</p>`, chips: [], headings: [], pictures: [], refusedPictures: 0, savedAt: times[i] })
  const a = createSharingPublisher({ records: { read: () => aRecords, write: (v) => { aRecords = v; return true } }, secrets: aSecrets.store, access: () => access(ADMIN_KEY), client, render: render(0), debounceMs: 0 })
  await a.reconcile(roots[0]); await a.idle()
  await mkdir(join(roots[1], '.writeflex'), { recursive: true })
  await cp(join(roots[0], '.writeflex/sharing-workspace.json'), join(roots[1], '.writeflex/sharing-workspace.json'))
  // A sync conflict supplies a later competing id; the earliest identity wins.
  await writeFile(join(roots[1], '.writeflex/sharing-workspace conflict.json'), JSON.stringify({ id: 'workspaceconflictmacb', createdAt: Date.now() + 10000 }))
  const b = createSharingPublisher({ records: { read: () => bRecords, write: (v) => { bRecords = v; return true } }, secrets: bSecrets.store, access: () => access('mac-b-admin-key-for-test'), client, render: render(1), debounceMs: 0 })
  await b.reconcile(roots[1]); await b.idle()
  expect(b.view(roots[1], 'paper.md').links).toMatchObject([{ shareId, name: 'Co-author', comments: true }])
  expect(b.records()).toHaveLength(1)
  expect(b.records()[0].root).toBe(roots[1])
  expect(b.records()[0].revision).toBe(1)
  text[0] = 'new from A'; times[0] = 4000
  a.saved(roots[0], ['paper.md']); await a.idle()
  // B has the old local text; its retry must leave the newer service copy alone.
  await b.retry(shareId)
  expect(b.view(roots[1], 'paper.md').links[0].problem?.reason).toBe('Not published: another Mac has newer text for this link. It will publish once this Mac has the newer file.')
  let state = await client.state(ORIGIN, shareId, ownerToken)
  expect(state.kind === 'ok' && state.body.revision).toBe(2)
  text[1] = 'unsynced newer save on B'; times[1] = 5000
  b.saved(roots[1], ['paper.md']); await b.idle()
  state = await client.state(ORIGIN, shareId, ownerToken)
  expect(state.kind === 'ok' && state.body.revision).toBe(3)
  await b.retry(shareId)
  state = await client.state(ORIGIN, shareId, ownerToken)
  expect(state.kind === 'ok' && state.body.revision).toBe(3)
  await a.setNotes(shareId, 'open')
  await b.opened([shareId])
  expect(b.view(roots[1], 'paper.md').links[0].notes).toBe('open')
  expect(b.shownNotes(roots[1], shareId)).toBe('open')
  await a.setNotes(shareId, 'private')
  await b.opened([shareId])
  expect(b.shownNotes(roots[1], shareId)).toBe('private')
  await a.setNotes(shareId, 'open')
  await b.opened([shareId])
  await b.reconcile(roots[1]); await b.idle()
  expect(b.view(roots[1], 'paper.md').links[0].notes).toBe('open')
  await b.turnOff(shareId); await a.reconcile(roots[0]); await a.idle()
  expect(a.view(roots[0], 'paper.md').links[0].on).toBe(false)
  await b.turnOn(shareId)
  const posted = await svc.call(`/s/${shareId}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reader: secret(), note: note({ visibility: 'open' }) }) })
  expect(posted.status).toBe(201)
  const stores = roots.map((root) => new ChangeStore(new Workspace(root)))
  const collect = (i: number, publisher: typeof a) => collectReaderNotes({ fetchNotes: client.noteState, markCollected: client.collected, readDocument: guardedDocumentReader(new Workspace(roots[i])), changes: stores[i], now: Date.now }, publisher.noteSources(roots[i]))
  await collect(0, a); await collect(1, b)
  expect(await stores[0].list()).toHaveLength(1)
  expect(await stores[1].list()).toHaveLength(1)
  const changeA = (await stores[0].list())[0]
  await stores[0].setStatus(changeA.id, 'accepted')
  await stores[0].addReaderReply(changeA.id, { id: 'author-reply-01', text: 'Thank you', at: Date.now(), by: 'You', visibility: 'open' })
  await sendReaderOutcomes({ sendOutcomes: client.outcomes, changes: stores[0], now: Date.now }, a.noteSources(roots[0]))
  // The service feed alone retains consent before any journal copy arrives.
  await collect(1, b)
  expect((await stores[1].list())[0].readerReplies).toMatchObject([{ text: 'Thank you', visibility: 'open' }])
  // The synced ledger and the service feed can arrive in either order.
  await cp(join(roots[0], '.writeflex/changes.jsonl'), join(roots[1], '.writeflex/changes conflict.jsonl'))
  await collect(1, b)
  const onB = await stores[1].list()
  expect(onB).toHaveLength(1)
  expect(onB[0].status).toBe('accepted')
  expect((onB[0] as any).readerReplies).toMatchObject([{ text: 'Thank you', visibility: 'open' }])
  // A proposed edit and an open-comment reply both arrive on both Macs, even after collection.
  const publicNote = await posted.json() as any
  const postNote = (n: unknown) => svc.call(`/s/${shareId}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reader: secret(), note: n }) })
  expect((await postNote(note({ kind: 'edit', visibility: 'open', text: 'they are grouped' }))).status).toBe(201)
  expect((await postNote(note({ visibility: 'open', text: 'Agreed', replyTo: publicNote.note.threadId }))).status).toBe(201)
  await collect(0, a); await collect(1, b)
  expect(await stores[0].list()).toHaveLength(3)
  expect(await stores[1].list()).toHaveLength(3)
  const editA = (await stores[0].list()).find((c) => (c as any).readerNote.kind === 'edit')!
  const editB = (await stores[1].list()).find((c) => (c as any).readerNote.kind === 'edit')!
  const original = await readFile(join(roots[0], 'paper.md'), 'utf8')
  setReaderNotesSource({ links: (root) => root === roots[0] ? a.noteSources(root) : b.noteSources(root), fetchNotes: client.noteState, markCollected: client.collected, claimAccept: client.claimNote, releaseAccept: client.releaseClaim })
  const agents: WorkspaceAgent[] = []
  try {
    for (let i = 0; i < 2; i++) agents.push(await WorkspaceAgent.create({ mode: 'work', workspace: new Workspace(roots[i]), appDataDir: join(scratch, `agent-${i}`), changes: stores[i], onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {} }))
    loseClaimAnswer = true
    expect((await agents[0].resolveChange(editA.id, 'accept')).applied).toBe(true)
    // B still has the old unsynced file and open card: the atomic service claim blocks its write.
    expect((await agents[1].resolveChange(editB.id, 'accept')).applied).toBe(false)
    expect(await readFile(join(roots[0], 'paper.md'), 'utf8')).toBe(original.replace('they are ordered', 'they are grouped'))
    expect(await readFile(join(roots[1], 'paper.md'), 'utf8')).toBe(original)
    await sendReaderOutcomes({ sendOutcomes: client.outcomes, changes: stores[0], now: Date.now }, a.noteSources(roots[0]))
    await collect(1, b)
    expect((await stores[1].get(editB.id))?.status).toBe('accepted')
    // Receiving an acceptance receipt changes the card, never the local document.
    expect(await readFile(join(roots[1], 'paper.md'), 'utf8')).toBe(original)
  } finally { for (const agent of agents) agent.dispose() }
  offline = true
  await rename(join(roots[0], 'paper.md'), join(roots[0], 'renamed.md'))
  a.moved(roots[0], 'paper.md', 'renamed.md')
  await a.idle()
  offline = false
  await rename(join(roots[1], 'paper.md'), join(roots[1], 'renamed.md'))
  await a.reconcile(roots[0]); await a.idle()
  await b.reconcile(roots[1]); await b.idle()
  expect(a.view(roots[0], 'renamed.md').links[0]?.shareId).toBe(shareId)
  expect(b.view(roots[1], 'renamed.md').links[0]?.shareId).toBe(shareId)
  expect(b.records()).toHaveLength(1)
  expect((await readFile(join(roots[1], '.writeflex/sharing-workspace.json'), 'utf8'))).not.toContain(ownerToken)
})


test('a revision refusal re-reads the source and publishes only its newer local save', async () => {
  const svc = fakeService(service as unknown as ServiceModule)
  const client = createServiceClient({ fetch: (input, init) => svc.call(new URL(String(input)).pathname, init) })
  const access = { address: ORIGIN, base: ORIGIN, key: ADMIN_KEY }
  const made = await client.createShare(access)
  if (made.kind !== 'ok') throw new Error('fixture failed')
  const { shareId, ownerToken } = made.body
  const initial = readRecords([{ shareId, kind: 'piece', root: '/fixture', path: 'paper.md', madeAt: 1000, on: true, comments: true, workspaceId: 'workspaceaaaaaaaa' }])[0]
  let text = 'initial', savedAt = 1000, reads = 0
  const render = async () => { reads++; return { title: 'Paper', html: `<p>${text}</p>`, savedAt, chips: [], headings: [], pictures: [], refusedPictures: 0 } }
  const publisher = (withClient = client) => createPublishOnce({ access: () => access, client: withClient, render, tokenFor: () => ownerToken, now: Date.now, timeZone: () => 'UTC' }).publishOnce
  const first = await publisher()(initial)
  const base = { ...initial, ...first }
  let raced = false
  const racing = { ...client, putPage: async (...args: Parameters<typeof client.putPage>) => {
    if (!raced) {
      raced = true
      text = 'new on A'; savedAt = 2000
      await publisher()(base)
      text = 'fresh unsynced on B'; savedAt = 3000
    }
    return client.putPage(...args)
  } }
  text = 'B render before the race'; savedAt = 1500
  const result = await publisher(racing)(base)
  expect(result?.revision).toBe(3)
  expect(result?.publishedSavedAt).toBe(3000)
  expect(reads).toBeGreaterThanOrEqual(5)
  const page = await (await svc.call(`/s/${shareId}`)).text()
  expect(page).toContain('fresh unsynced on B')
  expect(page).not.toContain('B render before the race')
})

test('two Macs keep one Folio link and the same part identities after a part is added', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'wf-two-mac-folio-'))
  const roots = [join(scratch, 'a'), join(scratch, 'b')]
  for (const root of roots) {
    await mkdir(root)
    await writeFile(join(root, '_report-structure.json'), JSON.stringify({ files: [{ path: 'one.md' }] }))
    await writeFile(join(root, 'one.md'), '# One\n\nThe first part.\n')
  }
  const { renderPieceForSharing } = await import('../../src/main/sharing-render')
  const { renderFolioLink } = await import('../../src/main/sharing-folio')
  const svc = fakeService(service as unknown as ServiceModule, { ADMIN_SECRET_macb: 'folio-mac-b-admin-key-test' })
  const client = createServiceClient({ fetch: (input, init) => svc.call(new URL(String(input)).pathname, init) })
  const records: unknown[] = [[], []]
  const publishers = roots.map((root, i) => createSharingPublisher({ records: { read: () => records[i], write: (r) => { records[i] = r; return true } }, secrets: memorySecrets().store, access: () => ({ address: ORIGIN, base: ORIGIN, key: i ? 'folio-mac-b-admin-key-test' : ADMIN_KEY }), client, render: renderPieceForSharing, renderFolio: renderFolioLink, debounceMs: 0 }))
  const [a, b] = publishers
  const made = await a.make(roots[0], '', { name: 'Our Folio', comments: true }, 'folio')
  expect(made.ok).toBe(true)
  const id = made.view.links[0].shareId
  await mkdir(join(roots[1], '.writeflex'))
  await cp(join(roots[0], '.writeflex/sharing-workspace.json'), join(roots[1], '.writeflex/sharing-workspace.json'))
  await b.reconcile(roots[1]); await b.idle()
  expect(b.view(roots[1], '', 'folio').links[0].shareId).toBe(id)
  expect(b.records()[0].partKeys).toEqual(a.records()[0].partKeys)
  expect(b.records()[0].revision).toBe(1)
  for (const root of roots) {
    await writeFile(join(root, 'two.md'), '# Two\n\nThe second part.\n')
    await writeFile(join(root, '_report-structure.json'), JSON.stringify({ files: [{ path: 'one.md' }, { path: 'two.md' }] }))
  }
  a.saved(roots[0], ['two.md', '_report-structure.json']); await a.idle()
  await b.reconcile(roots[1]); await b.idle()
  expect(b.records()).toHaveLength(1)
  expect(b.records()[0].partKeys).toEqual(a.records()[0].partKeys)
  expect(Object.keys(b.records()[0].partKeys)).toEqual(['one.md', 'two.md'])
  expect(b.noteSources(roots[1])[0].paths).toEqual(['one.md', 'two.md'])
  expect(b.records()[0].revision).toBe(2)
})


test('an explicit copy choice on A stops B without changing the service directory identity', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'wf-copy-choice-macs-'))
  const aRoot = join(scratch, 'a'), copy = join(scratch, 'a-copy'), bRoot = join(scratch, 'b')
  for (const root of [aRoot, bRoot]) { await mkdir(root); await writeFile(join(root, 'paper.md'), '# Paper\n\nFixture text.\n') }
  const svc = fakeService(service as unknown as ServiceModule, { ADMIN_SECRET_macb: 'copy-mac-b-admin-key-fixture' })
  const calls: string[] = []
  const client = createServiceClient({ fetch: (input, init) => { const path = new URL(String(input)).pathname; calls.push(`${init?.method} ${path}`); return svc.call(path, init) } })
  let openA = [aRoot]
  const caches: unknown[] = [[], []]
  const make = (i: number) => createSharingPublisher({ records: { read: () => caches[i], write: (r) => { caches[i] = r; return true } }, secrets: memorySecrets().store,
    access: () => ({ address: ORIGIN, base: ORIGIN, key: i ? 'copy-mac-b-admin-key-fixture' : ADMIN_KEY }), client,
    openRoots: () => i ? [bRoot] : openA,
    render: async () => ({ title: 'Paper', html: '<p>Fixture text.</p>', chips: [], headings: [], pictures: [], refusedPictures: 0, savedAt: 1000 }), debounceMs: 0 })
  const a = make(0), b = make(1)
  try {
    const made = await a.make(aRoot, 'paper.md', { name: null, comments: true })
    expect(made.ok).toBe(true)
    const id = made.view.links[0].shareId
    await cp(join(aRoot, '.writeflex'), join(bRoot, '.writeflex'), { recursive: true })
    await b.reconcile(bRoot); await b.idle()
    expect(b.records()[0].workspaceId).toBe(a.records()[0].workspaceId)
    const directory = svc.registry.states.get('writeflex-sharing-registry')!.db
    const entry = () => directory.query('SELECT workspace_id FROM share_directory WHERE share_id = ?').get(id)
    const originalEntry = entry()
    await cp(aRoot, copy, { recursive: true })
    openA = [aRoot, copy]
    await a.refresh(copy)
    expect(a.noteSources(aRoot)).toEqual([])
    expect(a.noteSources(copy)).toEqual([])
    const beforeHold = calls.length
    await a.retry(id)
    expect(a.records()[0].problem).toBeNull() // A derived hold must never become a saved publication problem.
    expect(calls.slice(beforeHold).some((call) => call.endsWith('/page'))).toBe(false)
    expect(entry()).toEqual(originalEntry)
    expect(await a.chooseSharedOriginal(copy, aRoot)).toBe(true)
    // The copied identity file reaches the replica which B had first encountered as this workspace.
    await cp(join(copy, '.writeflex/sharing-workspace.json'), join(bRoot, '.writeflex/sharing-workspace.json'))
    b.invalidateSharingIdentity(bRoot) // Stale answers remain until the background check completes.
    await b.refresh(bRoot)
    expect(b.noteSources(bRoot)).toEqual([])
    const before = calls.length
    await b.reconcile(bRoot); await b.idle(); await b.retry(id)
    expect(b.view(bRoot, 'paper.md').links[0].problem).toMatchObject({ kind: 'workspace-copy', reason: 'This folder was marked as a copy on another Mac. Its links stay with the original.' })
    expect(calls.slice(before).some((call) => call.endsWith('/record') || call.endsWith('/page'))).toBe(false)
    expect(entry()).toEqual(originalEntry)
    expect(a.noteSources(aRoot)).toHaveLength(1)
  } finally { await a.idle(); await b.idle() }
})
