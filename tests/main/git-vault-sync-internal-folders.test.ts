// Git vault sync: Internal folders and journals.
// Guards ADR-0055 "Internal folders" and "File-kind classification and source evidence" (parcels 1b, 4): which `.writeflex` and `.bridle` files travel, how their ledgers merge through the real readers, and which stay machine-local.
// Real `git`, a bare remote and two clones through the shared fixture; no Electron.
import { expect } from 'bun:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { SnapshotStore } from '@bridle/core'
import { sweepSyncedSnapshots } from '../../src/main/git-vault-sync-retention'
import { ChangeStore } from '../../src/main/changes'
import { VersionStore } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'
import { sharingWorkspace } from '../../src/main/sharing-workspace'
import { readSnapshotBytes } from '../../src/main/cli/history-store'
import { completedFolioSaveIds } from '../../src/main/folio-save-commit'
import { VaultStore } from '../../src/main/vault-store'
import { newRequestId, idOfFileName } from '../../src/main/cli/request-format'
import { fixture, tree, snapshot, text, seed, running, addChange, hash } from './git-vault-sync-fixture'
import { testWithSafeSyncGitAndGitleaks } from './git-sync-prerequisites'

const limit = 120_000

testWithSafeSyncGitAndGitleaks('intentionally tracked Bridle, changes and versions journals union both Mac tails and load through real readers', async () => {
  const f = await fixture()
  try {
    await seed(f)
    const changesA = new ChangeStore(new Workspace(f.a)), changesB = new ChangeStore(new Workspace(f.b))
    const a = await addChange(changesA, 'Change from A'), b = await addChange(changesB, 'Change from B')
    const snapshotsA = await SnapshotStore.open({ dir: join(f.a, '.bridle'), root: f.a }), snapshotsB = await SnapshotStore.open({ dir: join(f.b, '.bridle'), root: f.b })
    await f.put(f.a, 'draft.md', 'A saved snapshot.\n'); await f.put(f.b, 'second.md', 'B saved snapshot.\n')
    const pa = await snapshotsA.beginRestorePoint('A point', 'session-a'), sa = await snapshotsA.snapshotFile(join(f.a, 'draft.md'), { sessionId: 'session-a' })
    const pb = await snapshotsB.beginRestorePoint('B point', 'session-b'), sb = await snapshotsB.snapshotFile(join(f.b, 'second.md'), { sessionId: 'session-b' })
    await new VersionStore(new Workspace(f.a)).append({ id: 'v_mac_a', path: 'draft.md', name: 'A version', author: { name: 'A' }, ts: 200, snapshotId: sa.id, versionId: pa })
    await new VersionStore(new Workspace(f.b)).append({ id: 'v_mac_b', path: 'second.md', name: 'B version', author: { name: 'B' }, ts: 300, snapshotId: sb.id, versionId: pb })
    const fa = `fv_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`, fb = `fv_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`
    await new VersionStore(new Workspace(f.a)).commitFolioSave(fa); await new VersionStore(new Workspace(f.b)).commitFolioSave(fb)
    running(await f.B.send(f.bv)); running(await f.A.send(f.av)); running(await f.B.fetchAndIntegrate(f.bv))
    for (const root of [f.a, f.b]) {
      expect(await completedFolioSaveIds(root)).toEqual(new Set([fa, fb]))
      const list = await new ChangeStore(new Workspace(root)).list()
      expect(new Set(list.map(c => c.summary))).toEqual(new Set(['Common change', 'Change from A', 'Change from B']))
      expect(list.some(c => c.id === a.id)).toBe(true); expect(list.some(c => c.id === b.id)).toBe(true)
      const versions = await new VersionStore(new Workspace(root)).list()
      expect(versions.map(v => v.id)).toEqual(['v_mac_b', 'v_mac_a', 'v_common'])
      const reader = await SnapshotStore.open({ dir: join(root, '.bridle'), root })
      expect(await reader.readSnapshotContent(sa.id)).toBe('A saved snapshot.\n'); expect(await reader.readSnapshotContent(sb.id)).toBe('B saved snapshot.\n')
      const entries = await reader.entries()
      for (const [point, shot] of [[pa, sa.id], [pb, sb.id]]) {
        const start = entries.findIndex(e => e.id === point)
        expect(entries.slice(start + 1).find(e => e.kind === 'snapshot')?.id).toBe(shot)
      }
      for (const path of ['.writeflex/changes.jsonl', '.writeflex/versions.jsonl', '.bridle/journal.jsonl']) {
        const raw = await text(root, path); expect(raw.endsWith('\n')).toBe(true)
        const lines = raw.trimEnd().split('\n'); expect(new Set(lines).size).toBe(lines.length); lines.forEach(line => expect(() => JSON.parse(line)).not.toThrow())
      }
      expect((await new VaultStore(root).read())?.settings.name).toBe('Shared writing vault')
    }
    expect(await tree(f.a)).toEqual(await tree(f.b))
  } finally { await f.close() }
}, limit)

testWithSafeSyncGitAndGitleaks('mutable changes ledger uses its real decision reconciliation and preserves decisions from both Macs', async () => {
  const f = await fixture()
  try {
    const common = await seed(f)
    await new ChangeStore(new Workspace(f.a)).setStatus(common.id, 'held')
    await new ChangeStore(new Workspace(f.b)).setStatus(common.id, 'rejected')
    running(await f.B.send(f.bv)); running(await f.A.send(f.av)); running(await f.B.fetchAndIntegrate(f.bv))
    for (const root of [f.a, f.b]) expect(new Set((await new ChangeStore(new Workspace(root)).list()).map(c => c.status))).toEqual(new Set(['held', 'rejected']))
  } finally { await f.close() }
}, limit)

testWithSafeSyncGitAndGitleaks('distinct content objects and unique inbox/outbox items from both Macs all travel', async () => {
  const f = await fixture()
  try {
    await seed(f)
    const inboxA = newRequestId(), inboxB = newRequestId(), outA = newRequestId(), outB = newRequestId()
    const copyIds = { A: randomUUID(), B: randomUUID() }
    for (const [root, label, inbox, outbox] of [[f.a, 'A', inboxA, outA], [f.b, 'B', inboxB, outB]]) {
      const content = `Object from ${label}.\n`
      await f.put(root, `.bridle/objects/${hash(content)}`, content)
      await f.put(root, `.bridle/journal (from ${label}).jsonl`, JSON.stringify({ kind: 'snapshot', id: copyIds[label as 'A' | 'B'], ts: 1000, sessionId: label, file: join(root, 'draft.md'), hash: hash(content), origin: 'host' }) + '\n')
      await f.put(root, `.writeflex/inbox/${inbox}.json`, JSON.stringify({ version: 1, id: inbox, operation: 'create', args: { path: `${label}.md`, content: label }, to: ['0'.repeat(32)] }) + '\n')
      await f.put(root, `.writeflex/outbox/${outbox}.json`, JSON.stringify({ version: 1, id: outbox, operation: 'create', outcome: 'applied', at: 1000, mac: '0'.repeat(64) }) + '\n')
    }
    running(await f.B.send(f.bv)); running(await f.A.send(f.av)); running(await f.B.fetchAndIntegrate(f.bv))
    for (const root of [f.a, f.b]) {
      for (const label of ['A', 'B'] as const) {
        expect(await text(root, `.bridle/objects/${hash(`Object from ${label}.\n`)}`)).toBe(`Object from ${label}.\n`)
        expect((await readSnapshotBytes(root, copyIds[label]))?.toString()).toBe(`Object from ${label}.\n`)
      }
      for (const id of [inboxA, inboxB]) { expect(idOfFileName(`${id}.json`)).toBe(id); expect(JSON.parse(await text(root, `.writeflex/inbox/${id}.json`)).id).toBe(id) }
      for (const id of [outA, outB]) expect(JSON.parse(await text(root, `.writeflex/outbox/${id}.json`)).id).toBe(id)
    }
  } finally { await f.close() }
}, limit)

testWithSafeSyncGitAndGitleaks('already tracked machine-local files keep their index entries and local bytes while shared history syncs', async () => {
  const f = await fixture()
  try {
    await seed(f)
    const local = '.writeflex/widget-step-synthetic.json'
    const privateMarker='.writeflex/private/.bridle/journal.jsonl.sync-fork.json'
    await f.put(f.a,privateMarker,'{}\n')
    await f.put(f.a, local, '{"local":"initial"}\n'); f.git(f.a, 'add', local, privateMarker); f.git(f.a, 'commit', '-m', 'Legacy tracked machine state'); f.git(f.a, 'push'); running(await f.B.fetchAndIntegrate(f.bv))
    const lookalike = `${local}.git-incoming-${'a'.repeat(64)}`
    await f.put(f.a, lookalike, 'Private recovery evidence, not a shared object.\n')
    const entry = f.git(f.a, 'ls-files', '--stage', '--', local)
    const markerEntry=f.git(f.a,'ls-files','--stage','--',privateMarker)
    await f.put(f.a, local, '{"local":"A private recovery"}\n'); await addChange(new ChangeStore(new Workspace(f.a)), 'New shared record')
    const sent = await f.A.send(f.av); running(sent)
    expect(sent.warnings.some(w => w.code === 'machine-local-tracked' && w.path === local)).toBe(true)
    expect(f.git(f.a, 'ls-files', '--stage', '--', local)).toBe(entry)
    expect(f.git(f.a,'ls-files','--stage','--',privateMarker)).toBe(markerEntry)
    expect(await text(f.a,privateMarker)).toBe('{}\n')
    expect(f.git(f.a, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain(lookalike)
    expect(f.git(f.a, 'show', `HEAD:${local}`)).toBe('{"local":"initial"}')
    // A foreign committed machine-state update is also ignored without deleting our index entry.
    f.git(f.b, 'fetch', 'origin'); f.git(f.b, 'reset', '--hard', 'origin/main')
    await f.put(f.b, local, '{"local":"B private state"}\n'); f.git(f.b, 'add', local); f.git(f.b, 'commit', '-m', 'Other tool commits machine state'); f.git(f.b, 'push')
    running(await f.A.fetchAndIntegrate(f.av))
    expect(await text(f.a, local)).toBe('{"local":"A private recovery"}\n'); expect(f.git(f.a, 'ls-files', '--stage', '--', local)).toBe(entry)
    expect((await new ChangeStore(new Workspace(f.b)).list()).some(c => c.summary === 'New shared record')).toBe(true)
  } finally { await f.close() }
}, limit)

testWithSafeSyncGitAndGitleaks('immutable same-path corruption preserves both byte versions and warns without a user pair or stop', async () => {
  const f = await fixture()
  try {
    await seed(f)
    const path = `.bridle/objects/${hash('A original bytes')}`
    await f.put(f.a, path, 'A original bytes'); await f.put(f.b, path, 'B different bytes at the same name')
    running(await f.B.send(f.bv)); const result = await f.A.send(f.av); running(result)
    const warning = result.warnings.find(w => w.code === 'internal-content-mismatch' && w.path === path)
    expect(warning?.copy).toBeDefined(); expect(await text(f.a, path)).toBe('A original bytes'); expect(await text(f.a, warning!.copy!)).toBe('B different bytes at the same name')
  } finally { await f.close() }
}, limit)

testWithSafeSyncGitAndGitleaks('vault single-value conflicts keep local without a revision timestamp; stamped values take the newer value', async () => {
  const f = await fixture()
  try {
    await seed(f)
    await f.put(f.a, '.writeflex/vault.json', '{"version":1,"name":"A local","pins":[]}\n')
    await f.put(f.b, '.writeflex/vault.json', '{"version":1,"name":"B remote","pins":[]}\n')
    running(await f.B.send(f.bv)); running(await f.A.send(f.av)); expect((await new VaultStore(f.a).read())?.settings.name).toBe('A local')
    await f.put(f.a, '.writeflex/vault.json', '{"version":1,"name":"Older","updatedAt":100}\n')
    await f.put(f.b, '.writeflex/vault.json', '{"version":1,"name":"Newer","updatedAt":200}\n'); running(await f.B.send(f.bv)); running(await f.A.send(f.av))
    expect((await new VaultStore(f.a).read())?.settings.name).toBe('Newer')
  } finally { await f.close() }
}, limit)

testWithSafeSyncGitAndGitleaks('an internal append during preparation is retained, deferred without stopping, and reconciled on the next round', async () => {
  const f = await fixture()
  try {
    await seed(f)
    await addChange(new ChangeStore(new Workspace(f.a)), 'A initial append')
    await addChange(new ChangeStore(new Workspace(f.b)), 'B remote append'); running(await f.B.send(f.bv))
    let wrote = false
    const result = await f.engineA({ checkpoint: async phase => {
      if (phase === 'before-push' && !wrote) { wrote = true; await addChange(new ChangeStore(new Workspace(f.a)), 'A late append') }
    } }).send(f.av)
    running(result); expect(result.warnings.some(w => w.code === 'internal-write-deferred')).toBe(true)
    expect((await new ChangeStore(new Workspace(f.a)).list()).some(c => c.summary === 'A late append')).toBe(true)
    running(await f.A.send(f.av)); running(await f.B.fetchAndIntegrate(f.bv))
    for (const root of [f.a, f.b]) expect(new Set((await new ChangeStore(new Workspace(root)).list()).map(c => c.summary))).toEqual(new Set(['Common change', 'A initial append', 'B remote append', 'A late append']))
  } finally { await f.close() }
}, limit)

testWithSafeSyncGitAndGitleaks('a previous-hash ledger travels without a false stop and a divergent chained tail is kept separately', async () => {
  const f = await fixture()
  try {
    await seed(f)
    await f.put(f.base,'plain/.bridle/journal.jsonl',JSON.stringify({kind:'restore-point',id:randomUUID(),ts:1,label:'Old plain point'})+'\n')
    await f.put(f.base,'plain/.bridle/objects/'+hash('old object'),'old object')
    expect(await sweepSyncedSnapshots(join(f.base,'plain/.bridle'),30)).toMatchObject({status:'swept',prunedEntries:1,removedObjects:1})
    const common = JSON.stringify({kind:'future-chained-record',id:'common',prevHash:'0'.repeat(64)})+'\n'
    await f.put(f.a, '.bridle/journal.jsonl', common); expect((await f.A.send(f.av)).reason).toBeUndefined()
    expect((await f.B.fetchAndIntegrate(f.bv)).reason).toBeUndefined()
    const ours=common+JSON.stringify({kind:'future-chained-record',id:'a',prevHash:'a'.repeat(64)})+'\n'
    const theirs=common+JSON.stringify({kind:'future-chained-record',id:'b',prevHash:'b'.repeat(64)})+'\n'
    await f.put(f.a,'.bridle/journal.jsonl',ours); await f.put(f.b,'.bridle/journal.jsonl',theirs)
    expect((await f.B.send(f.bv)).reason).toBeUndefined(); expect((await f.A.send(f.av)).reason).toBeUndefined()
    expect((await f.B.fetchAndIntegrate(f.bv)).reason).toBeUndefined()
    expect(await text(f.a,'.bridle/journal.jsonl')).toBe(ours); expect(await text(f.b,'.bridle/journal.jsonl')).toBe(theirs)
    for(const root of [f.a,f.b]) {
      const tails=(await readdir(join(root,'.bridle'))).filter(n=>/^journal\.from-.*\.jsonl$/.test(n))
      const all=new Set((await text(root,'.bridle/journal.jsonl')).trim().split('\n'))
      for(const name of tails) for(const line of (await text(root,'.bridle/'+name)).trim().split('\n')) all.add(line)
      expect(all).toEqual(new Set((ours+theirs).trim().split('\n')))
    }
  } finally { await f.close() }
}, limit)

testWithSafeSyncGitAndGitleaks('shared workspace identities retain both aliases through their actual reader', async () => {
  const f = await fixture()
  try {
    await seed(f)
    const a = (await sharingWorkspace(f.a))[0], b = (await sharingWorkspace(f.b))[0]
    running(await f.B.send(f.bv)); running(await f.A.send(f.av)); running(await f.B.fetchAndIntegrate(f.bv))
    for (const root of [f.a, f.b]) expect(new Set((await sharingWorkspace(root, undefined, { readOnly: true })).map(w => w.id))).toEqual(new Set([a.id, b.id]))
  } finally { await f.close() }
}, limit)

testWithSafeSyncGitAndGitleaks('a torn JSONL tail is preserved as opaque recovery evidence without stopping or writing invalid canonical lines', async () => {
  const f = await fixture()
  try {
    await seed(f)
    const path = '.writeflex/versions.jsonl', damaged = await text(f.a, path) + '{"unfinished":'
    await f.put(f.a, path, damaged)
    await new VersionStore(new Workspace(f.b)).append({ id: 'v_remote', path: 'draft.md', name: 'Remote version', author: { name: 'B' }, ts: 400, snapshotId: 's_remote', versionId: 'bv_remote' })
    running(await f.B.send(f.bv)); const result = await f.A.send(f.av); running(result)
    const warning = result.warnings.find(w => w.code === 'internal-ledger-recovery')
    expect(warning?.copy).toBeDefined(); expect(await text(f.a, warning!.copy!)).toBe(damaged)
    for (const line of (await text(f.a, path)).trimEnd().split('\n')) expect(() => JSON.parse(line)).not.toThrow()
    expect((await new VersionStore(new Workspace(f.a)).list()).map(v => v.id)).toEqual(['v_remote', 'v_common'])
  } finally { await f.close() }
}, limit)

testWithSafeSyncGitAndGitleaks('S7 recovery segments compact and repeated status reuses content-addressed reads',async()=>{
 const f=await fixture();try{
  const {createHash}=await import('node:crypto'), hash=(s:string)=>createHash('sha256').update(s).digest('hex')
  const common=JSON.stringify({id:'common',prevHash:'0'.repeat(64)})+'\n'
  await f.put(f.a,'.bridle/journal.jsonl',common);await f.A.send(f.av);await f.B.fetchAndIntegrate(f.bv)
  await f.put(f.a,'.bridle/journal.jsonl',common+JSON.stringify({id:'a',prevHash:'a'.repeat(64)})+'\n')
  await f.put(f.b,'.bridle/journal.jsonl',common+JSON.stringify({id:'b',prevHash:'b'.repeat(64)})+'\n');await f.B.send(f.bv);await f.A.send(f.av)
  for(let i=0;i<40;i++){
   const data=JSON.stringify({id:'tail-'+i,ts:i})+'\n',meta=JSON.stringify({version:1,from:'Archive Mac',range:'2026-11-20',prefixHash:hash(''),prefixBytes:0,sourceHash:hash(data)})+'\n',stem='.bridle/journal.from-'+hash(meta)
   await f.put(f.a,stem+'.jsonl',data);await f.put(f.a,stem+'.json',meta)
  }
  expect((await f.A.send(f.av)).reason).toBeUndefined()
  const paths=f.git(f.a,'ls-tree','-r','--name-only','HEAD').split('\n').filter(p=>p.includes('journal.from-'))
  expect(paths.length).toBeLessThanOrEqual(64)
  const mod=await import('../../src/main/git-vault-sync-journals')
  await f.A.status(f.av);const before=mod.journalReadStats()
  await f.A.status(f.av);await f.A.status(f.av)
  expect(mod.journalReadStats()).toEqual(before)
  expect((await f.B.fetchAndIntegrate(f.bv)).reason).toBeUndefined()
 }finally{await f.close()}
},180000)
