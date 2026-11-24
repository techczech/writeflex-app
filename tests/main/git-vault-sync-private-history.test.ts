// Git vault sync: Private history.
// Guards ADR-0055 "Live history views after a fork" (parcel 1d) and parcels 4 to 7: each computer keeps its own restore-point journal reader after a fork, through plain Git pulls, opting out, foreign publication, retention and rejoining.
// Real `git`, a bare remote and two clones through the shared fixture; no Electron.
import { test, expect } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { SnapshotStore } from '@bridle/core'
import { sweepSyncedSnapshots } from '../../src/main/git-vault-sync-retention'
import { gatedSnapshots } from '../../src/main/gated-snapshots'
import { setSyncAppendProtection } from '../../src/main/git-vault-sync-private-history'
// These vaults model vault sync switched on at launch, where history appends protect forked journals.
setSyncAppendProtection(true)
import { fixture, tree, snapshot, text, seed, running, hash } from './git-vault-sync-fixture'
import { testWithGitleaks, missingGitleaks } from '../helpers/built-output'

const limit = 120_000
const J='.bridle/journal.jsonl'

async function labels(root:string) {return (await (await SnapshotStore.open({dir:join(root,'.bridle'),root})).entries()).flatMap((e:any)=>e.label?[e.label]:[])}

// fromApp: B's checkpoint is a WriteFlex commit with its computer trailer (the parcel 6 cases).
async function seeded(fromApp=false) {
 const f=await fixture(),sa=await SnapshotStore.open({dir:join(f.a,'.bridle'),root:f.a})
 await sa.beginRestorePoint('Shared','same');f.git(f.a,'add','-A');f.git(f.a,'commit','-m','Seed tracked journal');f.git(f.a,'push');f.git(f.b,'pull','--no-rebase','--no-edit')
 const sb=await SnapshotStore.open({dir:join(f.b,'.bridle'),root:f.b})
 await sb.snapshotFile(join(f.b,'second.md'),{sessionId:'same'});await sb.beginRestorePoint('B own','b');await sb.snapshotFile(join(f.b,'second.md'),{sessionId:'b'})
 f.git(f.b,'add','-A');if(fromApp)f.git(f.b,'-c','user.name=WriteFlex on Mac B','-c','user.email=writeflex@localhost','commit','-m','B checkpoint','-m','WriteFlex-Computer: Mac B');else f.git(f.b,'commit','-m','B checkpoint');f.git(f.b,'push')
 await sa.snapshotFile(join(f.a,'draft.md'),{sessionId:'same'});await sa.beginRestorePoint('A own','a');await sa.snapshotFile(join(f.a,'draft.md'),{sessionId:'a'})
 const a=await text(f.a,J),b=await text(f.b,J)
 await f.put(f.a,'draft.md','A document in fork round.\n');expect((await f.A.send(f.av)).reason).toBeUndefined()
 return {f,sa,sb,a,b}
}

testWithGitleaks('forked restore history keeps both real-reader views, syncs documents, and is stable across three rounds and later appends', async () => {
  const f = await fixture()
  try {
    await seed(f)
    const a = await SnapshotStore.open({ dir: join(f.a, '.bridle'), root: f.a })
    await f.put(f.a,'.bridle/journal.jsonl',JSON.stringify({kind:'restore-point',id:randomUUID(),ts:1,sessionId:'ancient',label:'An old point'})+'\n'+(await text(f.a,'.bridle/journal.jsonl')))
    const point = await a.beginRestorePoint('Shared unfinished point', 'same-session')
    f.git(f.a, 'add', '.bridle/journal.jsonl'); f.git(f.a, 'commit', '-m', 'Fixture shares an unfinished restore point'); f.git(f.a, 'push')
    running(await f.B.fetchAndIntegrate(f.bv))
    const b = await SnapshotStore.open({ dir: join(f.b, '.bridle'), root: f.b })
    await f.put(f.b,'second.md','Writing from B travels.\n')
    const shotB = await b.snapshotFile(join(f.b, 'second.md'), { sessionId: 'same-session' })
    const ownB = await b.beginRestorePoint('B private point','session-b'); await b.snapshotFile(join(f.b,'second.md'),{sessionId:'session-b'})
    running(await f.B.send(f.bv))
    await f.put(f.a,'draft.md','Writing from A travels.\n')
    const shotA = await a.snapshotFile(join(f.a, 'draft.md'), { sessionId: 'same-session' })
    const ownA = await a.beginRestorePoint('A private point','session-a'); await a.snapshotFile(join(f.a,'draft.md'),{sessionId:'session-a'})
    const liveA=await text(f.a,'.bridle/journal.jsonl'), liveB=await text(f.b,'.bridle/journal.jsonl')
    let sweepDeclined=false
    const sent=await f.engineA({checkpoint:async phase=>{if(phase==='before-push'){
      expect(await sweepSyncedSnapshots(join(f.a,'nested-collection/.bridle'),30)).toMatchObject({status:'refused',reason:'sync-in-progress'});sweepDeclined=true
    }}}).send(f.av)
    expect(sweepDeclined).toBe(true)
    expect(sent.reason).toBeUndefined(); expect(sent.pairs).toEqual([])
    expect(sent.warnings.some(w=>w.code==='history-kept')).toBe(true)
    expect((await f.B.fetchAndIntegrate(f.bv)).reason).toBeUndefined()
    expect(await text(f.a,'second.md')).toBe('Writing from B travels.\n'); expect(await text(f.b,'draft.md')).toBe('Writing from A travels.\n')
    const union=new Set((liveA+liveB).trim().split('\n'))
    const canonical=liveB
    expect(f.git(f.remote,'show','main:.bridle/journal.jsonl')).toBe(canonical.trimEnd())
    async function verify() {
      expect(await text(f.a,'.bridle/journal.jsonl')).toBe(liveA); expect(await text(f.b,'.bridle/journal.jsonl')).toBe(liveB)
      for(const [root,own,shot] of [[f.a,ownA,shotA],[f.b,ownB,shotB]] as const) {
        expect(await sweepSyncedSnapshots(join(root,'.bridle'),30)).toMatchObject({status:'refused',reason:'sync-history-fork'})
        const reader=await SnapshotStore.open({dir:join(root,'.bridle'),root})
        const entries=await reader.entries()
        expect(entries.some(e=>e.id===own)).toBe(true)
        expect(entries.slice(entries.findIndex(e=>e.id===point)+1).find(e=>e.kind==='snapshot')?.id).toBe(shot.id)
        const names=(await readdir(join(root,'.bridle'))).filter(n=>/^journal\.from-.*\.jsonl$/.test(n))
        expect(names.length).toBeGreaterThanOrEqual(2)
        const all=new Set((await text(root,'.bridle/journal.jsonl')).trim().split('\n'))
        for(const name of names) for(const line of (await text(root,'.bridle/'+name)).trim().split('\n')) all.add(line)
        expect(all).toEqual(union)
        const objects=(await readdir(join(root,'.bridle/objects'))).sort()
        expect(objects).toEqual((await readdir(join(root===f.a?f.b:f.a,'.bridle/objects'))).sort())
        for(const object of objects) expect(hash(await text(root,'.bridle/objects/'+object))).toBe(object)
      }
      expect((await f.A.status(f.av)).internalPending).toEqual([]); expect((await f.B.status(f.bv)).internalPending).toEqual([])
    }
    await verify()
    const tailsA=(await readdir(join(f.a,'.bridle'))).filter(n=>/^journal\.from-.*\.jsonl$/.test(n)).sort()
    expect(tailsA).toEqual((await readdir(join(f.b,'.bridle'))).filter(n=>/^journal\.from-.*\.jsonl$/.test(n)).sort())
    for(const name of tailsA) expect(await text(f.a,'.bridle/'+name)).toBe(await text(f.b,'.bridle/'+name))
    expect(f.git(f.a,'show','HEAD:.bridle/journal.jsonl')).toBe(f.git(f.b,'show','HEAD:.bridle/journal.jsonl'))
    const treeA=await tree(f.a), treeB=await tree(f.b), remote=f.git(f.remote,'rev-parse','main')
    for(let round=0;round<2;round++) {
      for(const [engine,vault] of [[f.engineA(),f.av],[f.engineB(),f.bv]] as const) {
        expect((await engine.send(vault)).reason).toBeUndefined(); expect((await engine.fetchAndIntegrate(vault)).reason).toBeUndefined()
      }
      await verify(); expect(await tree(f.a)).toEqual(treeA); expect(await tree(f.b)).toEqual(treeB); expect(f.git(f.remote,'rev-parse','main')).toBe(remote)
    }
    const after=await a.beginRestorePoint('A after fork','after-a'); await a.snapshotFile(join(f.a,'draft.md'),{sessionId:'after-a'})
    const newLive=await text(f.a,'.bridle/journal.jsonl')
    const afterB=await b.beginRestorePoint('B after fork','after-b'); await b.snapshotFile(join(f.b,'second.md'),{sessionId:'after-b'})
    const newLiveB=await text(f.b,'.bridle/journal.jsonl')
    expect((await f.B.send(f.bv)).reason).toBeUndefined()
    expect((await f.A.status(f.av)).internalPending).toContain('.bridle/journal.jsonl')
    expect((await f.A.send(f.av)).reason).toBeUndefined(); expect((await f.B.fetchAndIntegrate(f.bv)).reason).toBeUndefined()
    expect(await text(f.a,'.bridle/journal.jsonl')).toBe(newLive); expect(await text(f.b,'.bridle/journal.jsonl')).toBe(newLiveB)
    expect((await (await SnapshotStore.open({dir:join(f.b,'.bridle'),root:f.b})).entries()).some(e=>e.id===afterB)).toBe(true)
    for (const root of [f.a,f.b]) {
      const rows=new Set((await text(root,'.bridle/journal.jsonl')).trim().split('\n'))
      for(const name of (await readdir(join(root,'.bridle'))).filter(n=>/^journal\.from-.*\.jsonl$/.test(n))) for(const row of (await text(root,'.bridle/'+name)).trim().split('\n')) rows.add(row)
      expect(rows).toEqual(new Set((newLive+newLiveB).trim().split('\n')))
    }
    expect((await (await SnapshotStore.open({dir:join(f.a,'.bridle'),root:f.a})).entries()).some(e=>e.id===after)).toBe(true)

    // Prefix/source hashes make the exact foreign order recoverable; timestamps never choose it.
    for (const root of [f.a,f.b]) {
      const marker=JSON.parse(await text(root,'.bridle/journal.jsonl.sync-fork.json'))
      const common=canonical.split('\n').slice(0,marker.prefixLines).map(row=>row+'\n').join('')
      const rebuilt=new Map([[hash(''),''],[hash(common),common]])
      const names=(await readdir(join(root,'.bridle'))).filter(n=>/^journal\.from-.*\.jsonl$/.test(n))
      for(let pass=0;pass<=names.length;pass++) for(const name of names) {
        const metadata=JSON.parse(await text(root,'.bridle/'+name.slice(0,-6)+'.json'))
        const prefix=rebuilt.get(metadata.prefixHash)
        if(prefix===undefined) continue
        expect(Buffer.byteLength(prefix)).toBe(metadata.prefixBytes)
        const restored=prefix+await text(root,'.bridle/'+name)
        expect(hash(restored)).toBe(metadata.sourceHash); rebuilt.set(metadata.sourceHash,restored)
      }
      expect(rebuilt.get(hash(newLive))).toBe(newLive); expect(rebuilt.get(hash(newLiveB))).toBe(newLiveB)
    }
    const stable=await tree(f.a), tip=f.git(f.remote,'rev-parse','main')
    expect((await f.A.send(f.av)).reason).toBeUndefined(); expect(f.git(f.remote,'rev-parse','main')).toBe(tip); expect(await tree(f.a)).toEqual(stable)
    // Recovery tails obey the same rollback/newer-save and fail-closed scanner rails as documents.
    await a.beginRestorePoint('Before failed apply','rollback-a')
    const before=await snapshot(f); let newer: string | undefined
    const failed=await f.engineA({checkpoint:async phase=>{
      if(phase==='after-write' && !newer) {newer=await a.beginRestorePoint('Saved during apply','during-a'); throw Error('Synthetic fork-apply failure')}
    }}).send(f.av)
    expect(newer).toBeDefined(); expect(failed.reason?.code).toBe('operation-failed')
    const held=await snapshot(f)
    expect(held.head).toBe(before.head); expect(held.index).toBe(before.index)
    expect(held.tree).toEqual({...before.tree, '.bridle/journal.jsonl':held.tree['.bridle/journal.jsonl']})
    expect((await (await SnapshotStore.open({dir:join(f.a,'.bridle'),root:f.a})).entries()).some(e=>e.id===newer)).toBe(true)
    expect((await f.A.send(f.av)).reason).toBeUndefined()
    const fake='ghp_'+randomBytes(18).toString('hex')
    await f.put(f.a,'.bridle/journal.jsonl',(await text(f.a,'.bridle/journal.jsonl'))+JSON.stringify({kind:'future-note',id:randomUUID(),ts:Date.now(),token:fake})+'\n')
    const unsent=await snapshot(f), remoteBefore=f.git(f.remote,'rev-parse','main'), blocked=await f.A.send(f.av)
    expect(blocked.reason?.code).toBe('secret-found'); expect(blocked.reason?.document).toMatch(/^\.bridle\/journal\.from-.*\.jsonl$/)
    expect(await snapshot(f)).toEqual(unsent); expect(f.git(f.remote,'rev-parse','main')).toBe(remoteBefore)
    expect(JSON.stringify(blocked)).not.toContain(fake)

  } finally { await f.close() }
}, limit)

test('M2 retention never prunes a vault with sync enabled', async()=>{
 const f=await fixture();try {
  const old=JSON.stringify({kind:'restore-point',id:'old',ts:1,label:'Old'})+'\n'
  await f.put(f.a,'.bridle/journal.jsonl',old)
  const result=await sweepSyncedSnapshots(join(f.a,'.bridle'),30, f.settingsA)
  expect(result.status).toBe('refused');expect(await text(f.a,'.bridle/journal.jsonl')).toBe(old)
  await f.A.send(f.av);const head=f.git(f.remote,'rev-parse','main')
  for(let i=0;i<3;i++){await f.A.send(f.av);expect(f.git(f.remote,'rev-parse','main')).toBe(head)}
 }finally{await f.close()}
},120000)

testWithGitleaks('S3 ordinary whole-repo Git checkpoints and pulls preserve both live readers after a fork',async()=>{
 const f=await fixture();try{
  const {SnapshotStore}=await import('@bridle/core')
  const sa=await SnapshotStore.open({dir:join(f.a,'.bridle'),root:f.a})
  await sa.beginRestorePoint('Shared','same');f.git(f.a,'add','-A');f.git(f.a,'commit','-m','seed');f.git(f.a,'push');await f.B.fetchAndIntegrate(f.bv)
  const sb=await SnapshotStore.open({dir:join(f.b,'.bridle'),root:f.b})
  await sb.snapshotFile(join(f.b,'second.md'),{sessionId:'same'});await sb.beginRestorePoint('B own','b');await sb.snapshotFile(join(f.b,'second.md'),{sessionId:'b'});await f.B.send(f.bv)
  await sa.snapshotFile(join(f.a,'draft.md'),{sessionId:'same'});await sa.beginRestorePoint('A own','a');await sa.snapshotFile(join(f.a,'draft.md'),{sessionId:'a'})
  expect((await f.A.send(f.av)).reason).toBeUndefined();expect((await f.B.send(f.bv)).reason).toBeUndefined();await f.A.fetchAndIntegrate(f.av)
  const a=await text(f.a,'.bridle/journal.jsonl'),b=await text(f.b,'.bridle/journal.jsonl')
  expect(f.git(f.a,'status','--porcelain')).toBe('');expect(f.git(f.b,'status','--porcelain')).toBe('')
  await f.put(f.a,'checkpoint.md','Ordinary Git document.\n');f.git(f.a,'add','-A');f.git(f.a,'commit','-m','Auto-commit checkpoint');f.git(f.a,'push');f.git(f.b,'pull','--no-rebase','--no-edit')
  expect(await text(f.b,'.bridle/journal.jsonl')).toBe(b)
  await f.put(f.a,'another-checkpoint.md','Another document.\n');f.git(f.a,'add','-A');f.git(f.a,'commit','-m','Another checkpoint');f.git(f.a,'push');f.git(f.b,'pull','--no-rebase','--no-edit')
  expect(await text(f.b,'.bridle/journal.jsonl')).toBe(b)
  expect((await (await SnapshotStore.open({dir:join(f.b,'.bridle'),root:f.b})).entries()).some((e:any)=>e.label==='B own')).toBe(true)
  expect((await f.B.send(f.bv)).reason).toBeUndefined();expect((await f.A.fetchAndIntegrate(f.av)).reason).toBeUndefined()
  expect(await text(f.a,'.bridle/journal.jsonl')).toBe(a);expect(await text(f.b,'.bridle/journal.jsonl')).toBe(b)
 }finally{await f.close()}
},180000)

test.skipIf(!!missingGitleaks).each([false,true])(`S3 tracked journal survives first plain pull, unsynced=%s, cascade, deletion and stable rounds${missingGitleaks ? ` [requires: ${missingGitleaks}]` : ''}`,async later=>{
 const {f,sb,a,b}=await seeded();try{
  expect(f.git(f.remote,'ls-tree','--name-only','main',J)).toBe(J)
  let expectedB=b
  if(later){await sb.beginRestorePoint('B later','b2');await sb.snapshotFile(join(f.b,'second.md'),{sessionId:'b2'});expectedB=await text(f.b,J);f.git(f.b,'add','-A');f.git(f.b,'commit','-m','Auto-commit unsynced point')}
  f.git(f.b,'pull','--no-rebase','--no-edit');expect(await text(f.b,J)).toBe(expectedB);expect(await labels(f.b)).toEqual(later?['Shared','B own','B later']:['Shared','B own'])
  expect((await f.B.send(f.bv)).reason).toBeUndefined()
  // A plain pull may safely refuse a changed upstream journal. It must never replace A's bytes.
  try{f.git(f.a,'pull','--no-rebase','--no-edit')}catch{}
  expect(await text(f.a,J)).toBe(a);expect(await labels(f.a)).toEqual(['Shared','A own'])
  expect((await f.A.send(f.av)).reason).toBeUndefined()
  expect(f.git(f.a,'status','--porcelain')).toBe('');expect(f.git(f.b,'status','--porcelain')).toBe('')
  // A true upstream carrier update must be adoptable by WriteFlex without rewriting live bytes.
  const carried=f.git(f.b,'show',`HEAD:${J}`)+'\n'+JSON.stringify({kind:'restore-point',id:'upstream-extra',ts:1,label:'Upstream extra'})+'\n'
  f.git(f.b,'update-index','--no-skip-worktree',J);await f.put(f.b,J,carried);f.git(f.b,'add','-A');f.git(f.b,'commit','-m','Other Git history update');f.git(f.b,'push')
  try{f.git(f.a,'pull','--no-rebase','--no-edit')}catch{}
  expect(await text(f.a,J)).toBe(a)
  expect((await f.A.fetchAndIntegrate(f.av)).reason).toBeUndefined();expect(await text(f.a,J)).toBe(a)
  // B's safety copy recognises replacement, and later restores an externally deleted live journal.
  expect((await f.B.send(f.bv)).reason).toBeUndefined();expect(await text(f.b,J)).toBe(expectedB)
  const protectedB=gatedSnapshots(f.b,sb)
  if(later) {await protectedB.beginRestorePoint('B not yet sent','not-sent');await protectedB.snapshotFile(join(f.b,'second.md'),{sessionId:'not-sent'})}
  else {
   // A separately running command-line writer must refresh the same safety copy.
   const source=`import {SnapshotStore} from '@bridle/core';import {protectSnapshotAppends,setSyncAppendProtection} from ${JSON.stringify(join(process.cwd(),'src/main/git-vault-sync-private-history.ts'))};setSyncAppendProtection(true);const s=await SnapshotStore.open({dir:${JSON.stringify(join(f.b,'.bridle'))},root:${JSON.stringify(f.b)}});protectSnapshotAppends(s);await s.beginRestorePoint('B not yet sent','not-sent');await s.snapshotFile(${JSON.stringify(join(f.b,'second.md'))},{sessionId:'not-sent'});`
   execFileSync(process.execPath,['-e',source],{cwd:process.cwd(),env:{...process.env,...f.gitEnv},timeout:30000,stdio:['ignore','pipe','pipe']})
  }
  expectedB=await text(f.b,J)
  await unlink(join(f.b,J));expect((await f.B.send(f.bv)).reason).toBeUndefined();expect(await text(f.b,J)).toBe(expectedB)
  for(let i=0;i<3;i++){expect((await f.A.send(f.av)).reason).toBeUndefined();expect((await f.B.send(f.bv)).reason).toBeUndefined()}
  const head=f.git(f.remote,'rev-parse','main')
  for(let i=0;i<2;i++){await f.A.send(f.av);await f.B.send(f.bv);expect(f.git(f.remote,'rev-parse','main')).toBe(head)}
  expect(await text(f.a,J)).toBe(a);expect(await text(f.b,J)).toBe(expectedB)
  expect(await labels(f.a)).toEqual(['Shared','A own']);expect(await labels(f.b)).toEqual(later?['Shared','B own','B later','B not yet sent']:['Shared','B own','B not yet sent'])
  expect(f.git(f.a,'status','--porcelain')).toBe('');expect(f.git(f.b,'status','--porcelain')).toBe('')
  for(const root of [f.a,f.b]) {
    const names=(await readdir(join(root,'.bridle'))).filter(n=>/^journal(?:\.from-[a-f0-9]{64})?\.jsonl$/.test(n))
    const rows=new Set((await Promise.all(names.map(n=>text(root,'.bridle/'+n)))).flatMap(t=>t.split('\n').filter(Boolean)))
    for(const row of (a+expectedB+carried).split('\n').filter(Boolean))expect(rows.has(row)).toBe(true)
  }
  expect(await text(f.b,'draft.md')).toBe('A document in fork round.\n')
 }finally{await f.close()}
},240000)

testWithGitleaks('off fork remains pullable and all private bytes remain in a tail',async()=>{const {f,a}=await seeded(true);try{await f.A.setEnabled(f.av,false);f.git(f.b,'pull','--ff-only');await f.put(f.b,J,(await text(f.b,J))+JSON.stringify({kind:'restore-point',id:'later',ts:1,label:'Later'})+'\n');f.git(f.b,'add','-A');f.git(f.b,'commit','-m','later');f.git(f.b,'push');f.git(f.a,'pull','--no-rebase','--no-edit');const names=await readdir(join(f.a,'.bridle'));const rows=new Set((await Promise.all(names.filter(n=>n.endsWith('.jsonl')).map(n=>text(f.a,'.bridle/'+n)))).flatMap(t=>t.split('\n')));for(const row of a.trim().split('\n'))expect(rows.has(row)).toBe(true)}finally{await f.close()}},120000)

testWithGitleaks('k no safety copy: restore own archived reader after foreign private journal is published',async()=>{const {f,a,b}=await seeded(true);try{f.git(f.b,'pull','--ff-only');f.git(f.a,'update-index','--no-skip-worktree',J);f.git(f.a,'add','-A');f.git(f.a,'commit','-m','ordinary private checkpoint');f.git(f.a,'push');f.git(f.b,'pull','--ff-only');expect(await text(f.b,J)).toBe(a);expect((await f.B.send(f.bv)).reason).toBeUndefined();expect(await text(f.b,J)).toBe(b);expect(await labels(f.b)).toEqual(['Shared','B own'])}finally{await f.close()}},120000)

testWithGitleaks('oversized private history never rejects an app snapshot append',async()=>{const {f,sa}=await seeded(true);try{await f.put(f.a,J,JSON.stringify({padding:'x'.repeat(33*1024*1024)})+'\n');const guarded=gatedSnapshots(f.a,sa);await expect(guarded.beginRestorePoint('Large journal save','large')).resolves.toBeString()}finally{await f.close()}},120000)

testWithGitleaks('recovery never assigns the canonical other computer journal to its publisher',async()=>{const {f,a}=await seeded();try{f.git(f.a,'update-index','--no-skip-worktree',J);f.git(f.a,'add','-A');f.git(f.a,'commit','-m','ordinary own checkpoint');f.git(f.a,'push');await (await import('node:fs/promises')).rm(join(f.a,'.git/writeflex-live-history'),{recursive:true,force:true});const r=await f.A.send(f.av);expect(r.reason).toBeUndefined();expect(await text(f.a,J)).toBe(a);expect(await labels(f.a)).toEqual(['Shared','A own'])}finally{await f.close()}},120000)

testWithGitleaks('turn off does not duplicate published tails or mislabel the remote',async()=>{const {f,sa}=await seeded();try{const before=(await readdir(join(f.a,'.bridle'))).filter(n=>n.includes('.from-')).sort();await f.A.setEnabled(f.av,false);expect((await readdir(join(f.a,'.bridle'))).filter(n=>n.includes('.from-')).sort()).toEqual(before);for(const n of (await readdir(join(f.a,'.bridle'))).filter(n=>n.includes('.from-')&&n.endsWith('.json')))expect(JSON.parse(await text(f.a,'.bridle/'+n)).from).not.toBe('this Mac');await f.A.setEnabled(f.av,true);const store=gatedSnapshots(f.a,sa);await store.beginRestorePoint('A not published','new-a');await store.snapshotFile(join(f.a,'draft.md'),{sessionId:'new-a'});const own=await text(f.a,J),hash=(await import('node:crypto')).createHash('sha256').update(own).digest('hex');await f.A.setEnabled(f.av,false);const metadata=await Promise.all((await readdir(join(f.a,'.bridle'))).filter(n=>n.includes('.from-')&&n.endsWith('.json')).map(async n=>JSON.parse(await text(f.a,'.bridle/'+n))));expect(metadata.find(m=>m.sourceHash===hash)?.from).toBe('Mac A')}finally{await f.close()}},120000)

testWithGitleaks('restore points written through the app while off remain in its real reader after rejoin',async()=>{const {f,sa}=await seeded();try{await f.A.setEnabled(f.av,false);f.git(f.b,'pull','--ff-only');await sbLater();async function sbLater(){const store=await SnapshotStore.open({dir:join(f.b,'.bridle'),root:f.b});await store.beginRestorePoint('B later','b-later');await store.snapshotFile(join(f.b,'second.md'),{sessionId:'b-later'});f.git(f.b,'add','-A');f.git(f.b,'commit','-m','B later');f.git(f.b,'push');f.git(f.a,'pull','--no-rebase','--no-edit')}const store=gatedSnapshots(f.a,sa);await store.beginRestorePoint('A while off','off');await store.snapshotFile(join(f.a,'draft.md'),{sessionId:'off'});f.git(f.a,'add','-A');f.git(f.a,'commit','-m','Auto-commit while off');f.git(f.a,'push');await f.A.setEnabled(f.av,true);expect(await labels(f.a)).toEqual(['Shared','A own','A while off']);expect((await f.A.send(f.av)).reason).toBeUndefined();await f.B.fetchAndIntegrate(f.bv);expect(await labels(f.a)).toEqual(['Shared','A own','A while off'])}finally{await f.close()}},120000)

testWithGitleaks('off notice is unique through repeated off on cycles without sends',async()=>{const {f}=await seeded();try{for(let i=0;i<3;i++){const r=await f.A.setEnabled(f.av,false);expect(r.warnings.filter(w=>w.message.includes('while sync is off'))).toHaveLength(1);await f.A.setEnabled(f.av,true)}}finally{await f.close()}},120000)

testWithGitleaks('without ownership proof receiving leaves the existing view and reports kept history',async()=>{const {f,a}=await seeded();try{f.git(f.b,'pull','--ff-only');f.git(f.a,'update-index','--no-skip-worktree',J);f.git(f.a,'add','-A');f.git(f.a,'commit','-m','ordinary publish');f.git(f.a,'push');f.git(f.b,'pull','--ff-only');const r=await f.B.send(f.bv);expect(r.reason).toBeUndefined();expect(await text(f.b,J)).toBe(a);expect(r.warnings.some(w=>w.message.includes('computer could not be confirmed'))).toBe(true)}finally{await f.close()}},120000)

testWithGitleaks('restore points saved while sync is off and the Command Line Tools are missing stay in the reader after rejoin',async()=>{
 const {developerToolsSeams,recheckDeveloperTools}=await import('../../src/main/developer-tools')
 const {mkdtemp,writeFile,chmod}=await import('node:fs/promises'),{tmpdir}=await import('node:os')
 const {f,sa}=await seeded()
 const missing=join(await mkdtemp(join(tmpdir(),'wf-no-tools-')),'xcode-select')
 await writeFile(missing,'#!/bin/sh\necho "xcode-select: error: unable to get active developer directory" >&2\nexit 2\n');await chmod(missing,0o755)
 const saved=developerToolsSeams.command
 try{
  await f.A.setEnabled(f.av,false)
  // The tools go missing: the restore point is saved through the app with no Git available.
  developerToolsSeams.command=missing;expect(await recheckDeveloperTools()).toBe(false)
  const store=gatedSnapshots(f.a,sa);await store.beginRestorePoint('A without tools','no-tools');await store.snapshotFile(join(f.a,'draft.md'),{sessionId:'no-tools'})
  developerToolsSeams.command=saved;expect(await recheckDeveloperTools()).toBe(true)
  f.git(f.a,'add','-A');f.git(f.a,'commit','-m','Auto-commit while off');f.git(f.a,'push')
  await f.A.setEnabled(f.av,true)
  expect(await labels(f.a)).toEqual(['Shared','A own','A without tools'])
  expect((await f.A.send(f.av)).reason).toBeUndefined()
  expect(await labels(f.a)).toEqual(['Shared','A own','A without tools'])
 }finally{developerToolsSeams.command=saved;await recheckDeveloperTools();await f.close()}
},120000)
