// Git vault sync: Documents.
// Guards ADR-0055 "Repository-wide incoming changes" and "Ordering, collisions and live writes" (parcels 1, 1c, 4): what a send or receive does to a document. Same-document conflicts, rename pairs and delete/edit keep both exact versions; unsaved paths and saves during a round keep the newest local bytes.
// Real `git`, a bare remote and two clones through the shared fixture; no Electron.
import { test, expect } from 'bun:test'
import { rm } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGitVaultSync } from '../../src/main/git-vault-sync'
import { SettingsStore } from '../../src/main/settings'
import { Workspace } from '../../src/main/workspace'
import { fixture, tree, snapshot, text, mergesWithoutRenames } from './git-vault-sync-fixture'
import { testWithSafeSyncGit, testWithSafeSyncGitAndGitleaks, missingSyncPrerequisite } from './git-sync-prerequisites'

const timeout = 60_000

testWithSafeSyncGitAndGitleaks('send from Mac A arrives at Mac B; ignored files and both machine-state directories stay local', async () => {
  const f = await fixture()
  try {
    await f.put(f.a, 'draft.md', 'Writing from A.\n'); await f.put(f.a, 'ignored.md', 'Ignored writing.\n')
    await f.put(f.a, '.writeflex/state.json', '{"local":true}'); await f.put(f.a, '.bridle/session.json', '{"local":true}')
    expect((await f.A.status(f.av)).state).toBe('waiting-to-send')
    expect((await f.A.send(f.av)).state).toBe('up-to-date')
    expect(f.git(f.a, 'log', '-1', '--format=%s')).toBe('WriteFlex: 1 documents from Mac A')
    expect(f.git(f.a, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toMatch(/ignored.md|\.writeflex|\.bridle/)
    const result = await f.B.fetchAndIntegrate(f.bv)
    expect(result.state).toBe('incoming'); expect(result.incoming).toContainEqual({ path: 'draft.md', kind: 'changed' })
    expect(await text(f.b, 'draft.md')).toBe('Writing from A.\n')
    expect((await f.B.status(f.bv)).state).toBe('incoming')
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('different documents changed on both Macs merge and converge', async () => {
  const f = await fixture()
  try {
    await f.put(f.a, 'draft.md', 'A changed the draft.\n'); await f.put(f.b, 'second.md', 'B changed the second.\n')
    expect((await f.B.send(f.bv)).state).toBe('up-to-date')
    expect((await f.A.send(f.av)).state).toBe('up-to-date')
    await f.B.fetchAndIntegrate(f.bv)
    expect(await tree(f.a)).toEqual(await tree(f.b))
    expect(await text(f.a, 'draft.md')).toBe('A changed the draft.\n'); expect(await text(f.a, 'second.md')).toBe('B changed the second.\n')
    expect(f.git(f.a, 'log', '-1', '--format=%P').split(' ')).toHaveLength(2)
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('same-document conflict keeps both exact versions, persists the pair, and both Macs converge', async () => {
  const f = await fixture()
  try {
    await f.put(f.a, 'draft.md', 'A version that must survive.\n'); await f.put(f.b, 'draft.md', 'B version that must survive.\n')
    await f.B.send(f.bv)
    const result = await f.A.send(f.av)
    expect(result.state).toBe('needs-you'); expect(result.pairs).toHaveLength(1)
    const pair = result.pairs[0]
    expect(pair.local).toBe('draft.md'); expect(pair.other).toMatch(/^draft \(from Mac B \d{4}-\d{2}-\d{2}(?: \d+)?\)\.md$/)
    expect(await text(f.a, pair.local)).toBe('A version that must survive.\n'); expect(await text(f.a, pair.other)).toBe('B version that must survive.\n')
    expect((await createGitVaultSync({ settings: new SettingsStore(join(f.base, 'a-settings.json')), gitEnv: f.gitEnv, renameProbe: mergesWithoutRenames }).status(f.av)).pairs).toEqual(result.pairs)
    await f.B.fetchAndIntegrate(f.bv)
    expect(await tree(f.b)).toEqual(await tree(f.a))
    for (const value of Object.values(await tree(f.a))) expect(Buffer.from(value.split(':')[1] ?? '', 'base64').toString()).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m)
    await f.A.dismissPair(f.av, pair.id); expect((await f.A.status(f.av)).state).toBe('up-to-date')
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('caller-provided unsaved paths keep this Mac disk content in place and put the incoming version beside it', async () => {
  const f = await fixture()
  try {
    await f.put(f.b, 'draft.md', 'Incoming while A is typing.\n'); await f.B.send(f.bv)
    const result = await f.A.fetchAndIntegrate(f.av, { unsavedPaths: ['draft.md'] })
    expect(result.state).toBe('needs-you'); expect(await text(f.a, 'draft.md')).toBe('The initial draft.\n')
    expect(await text(f.a, result.pairs[0].other)).toBe('Incoming while A is typing.\n')
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('delete versus edit keeps the edited document in both directions', async () => {
  for (const localDeletes of [true, false]) {
    const f = await fixture()
    try {
      if (localDeletes) { await rm(join(f.a, 'draft.md')); await f.put(f.b, 'draft.md', 'The edit wins over deletion.\n') }
      else { await f.put(f.a, 'draft.md', 'The edit wins over deletion.\n'); await rm(join(f.b, 'draft.md')) }
      await f.B.send(f.bv); const result = await f.A.send(f.av)
      expect(result.state).not.toBe('stopped'); expect(await text(f.a, 'draft.md')).toBe('The edit wins over deletion.\n')
      await f.B.fetchAndIntegrate(f.bv); expect(await text(f.b, 'draft.md')).toBe('The edit wins over deletion.\n')
    } finally { await f.close() }
  }
}, timeout)

testWithSafeSyncGit('a staged vault version distinct from disk is preserved rather than silently replaced', async () => {
  const f = await fixture()
  try {
    await f.put(f.a, 'draft.md', 'The separate staged version.\n'); f.git(f.a, 'add', 'draft.md'); await f.put(f.a, 'draft.md', 'The later disk version.\n')
    const before = await snapshot(f), result = await f.A.send(f.av)
    expect(result.reason?.code).toBe('local-changes'); expect(result.reason?.document).toBe('draft.md'); expect(await snapshot(f)).toEqual(before)
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('a later save during preparation is kept instead of being overwritten by the prepared version', async () => {
  const f = await fixture()
  try {
    await f.put(f.a, 'draft.md', 'The version sync first sees.\n')
    const before = await snapshot(f), remoteBefore = f.git(f.base, '--git-dir', f.remote, 'rev-parse', 'main')
    const result = await f.engineA({ checkpoint: async phase => { if (phase === 'before-push') await f.put(f.a, 'draft.md', 'The later save must win.\n') } }).send(f.av)
    expect(result.reason?.code).toBe('local-changes'); expect(await text(f.a, 'draft.md')).toBe('The later save must win.\n')
    const after = await snapshot(f); expect(after.head).toBe(before.head); expect(after.index).toBe(before.index)
    expect(f.git(f.base, '--git-dir', f.remote, 'rev-parse', 'main')).toBe(remoteBefore)
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('R1 different-line edits in the same document keep both exact versions and converge', async () => {
  const f = await fixture()
  try {
    await f.put(f.a, 'draft.md', 'L1\nL2\nL3\nL4\nL5\nL6\n'); await f.A.send(f.av); await f.B.fetchAndIntegrate(f.bv)
    await f.put(f.a, 'draft.md', 'L1 from A\nL2\nL3\nL4\nL5\nL6\n')
    await f.put(f.b, 'draft.md', 'L1\nL2\nL3\nL4\nL5\nL6 from B\n')
    await f.B.send(f.bv)
    const r = await f.A.send(f.av)
    expect(r.reason).toBeUndefined(); expect(r.pairs).toHaveLength(1)
    expect(await text(f.a, 'draft.md')).toBe('L1 from A\nL2\nL3\nL4\nL5\nL6\n')
    expect(await text(f.a, r.pairs[0].other)).toBe('L1\nL2\nL3\nL4\nL5\nL6 from B\n')
    await f.B.fetchAndIntegrate(f.bv); expect(await tree(f.a)).toEqual(await tree(f.b))
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('R2 remote rename/edit retains the old local path and incoming new path as a convergent pair', async () => {
  const f = await fixture()
  try {
    await f.put(f.a, 'draft.md', 'Para one.\nPara two.\nPara three.\n'); await f.A.send(f.av); await f.B.fetchAndIntegrate(f.bv)
    f.git(f.b, 'mv', 'draft.md', 'renamed.md'); await f.put(f.b, 'renamed.md', 'Para one.\nPara two B.\nPara three.\n')
    f.git(f.b, 'add', '-A'); f.git(f.b, 'commit', '-m', 'rename'); f.git(f.b, 'push')
    await f.put(f.a, 'draft.md', 'Para one.\nPara two LOCAL A WRITING.\nPara three.\n')
    const r = await f.A.send(f.av)
    expect(r.reason).toBeUndefined(); expect(r.pairs).toHaveLength(1)
    expect(await text(f.a, 'draft.md')).toBe('Para one.\nPara two LOCAL A WRITING.\nPara three.\n')
    expect(await text(f.a, 'renamed.md')).toBe('Para one.\nPara two B.\nPara three.\n')
    expect(r.pairs[0]).toMatchObject({ local: 'draft.md', other: 'renamed.md' })
    await f.B.fetchAndIntegrate(f.bv); expect(await tree(f.a)).toEqual(await tree(f.b))
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGit('R4 leftover sync temporary files and .DS_Store are never committed', async () => {
  const f = await fixture()
  try {
    await f.put(f.a, '.writeflex-sync-1234.tmp', 'stale temp\n'); await f.put(f.a, '.DS_Store', 'x')
    const r = await f.A.send(f.av)
    expect(r.reason).toBeUndefined()
    const tracked = f.git(f.a, 'ls-tree', '-r', '--name-only', 'HEAD')
    expect(tracked).not.toContain('.writeflex-sync-'); expect(tracked).not.toContain('.DS_Store')
  } finally { await f.close() }
}, timeout)

test.skipIf(!!missingSyncPrerequisite).each(['fetch','send'] as const)(`M1 newest save at the rename boundary survives and is reported (%s)${missingSyncPrerequisite ? ` [requires: ${missingSyncPrerequisite}]` : ''}`, async mode => {
 const f=await fixture(); try {
  await f.put(f.b,'draft.md','Incoming B.\n'); await f.B.send(f.bv)
  let injected=false
  const engine=f.engineA({ownWrite:p=>{if(!injected&&p.endsWith('/draft.md')){injected=true;writeFileSync(p,'Newest saved A.\n')}}})
  const r=await (mode==='send'?engine.send(f.av):engine.fetchAndIntegrate(f.av))
  expect(injected).toBe(true); expect(await text(f.a,'draft.md')).toBe('Newest saved A.\n')
  expect(r.reason?.document ?? r.pairs[0]?.local).toBe('draft.md')
  expect(r.pairs.some(p=>p.local==='draft.md')).toBe(true)
 }finally{await f.close()}
},120000)

testWithSafeSyncGitAndGitleaks('S1 a save during push stays ordinary pending writing and never becomes a self-pair',async()=>{
 const f=await fixture();try{
  await f.put(f.a,'draft.md','First A.\n');let saved=false
  const first=await f.engineA({checkpoint:async phase=>{if(phase==='before-apply'&&!saved){saved=true;await f.put(f.a,'draft.md','Newest A.\n')}}}).send(f.av)
  expect(first.reason).toBeUndefined();expect(await text(f.a,'draft.md')).toBe('Newest A.\n')
  const second=await f.A.send(f.av);expect(second.reason).toBeUndefined();expect(second.pairs).toHaveLength(0)
  expect(f.git(f.remote,'show','main:draft.md')).toBe('Newest A.')
 }finally{await f.close()}
},120000)

testWithSafeSyncGitAndGitleaks('M1 apply waits for the actual Workspace save turn and rechecks after acquiring it',async()=>{
 const f=await fixture();try{
  const {Workspace}=await import('../../src/main/workspace'),ws=new Workspace(f.a)
  await f.put(f.b,'draft.md','Incoming B.\n');await f.B.send(f.bv)
  let release!:()=>void,locked!:()=>void,prepared!:()=>void
  const lockReady=new Promise<void>(r=>locked=r),prepareReady=new Promise<void>(r=>prepared=r),gate=new Promise<void>(r=>release=r)
  const writer=ws.exclusiveAll(async()=>{locked();await gate;await ws.saveFile('draft.md','Newest real Workspace save.\n')})
  await lockReady
  const receiving=f.engineA({withFileLock:(_p,work)=>ws.exclusiveAll(work),checkpoint:async phase=>{if(phase==='before-apply')prepared()}}).fetchAndIntegrate(f.av)
  await prepareReady
  for(let i=0;i<300&&ws.writersWaiting===0;i++)await new Promise(r=>setTimeout(r,10))
  const waiting=ws.writersWaiting;release();await writer
  const result=await receiving;expect(waiting).toBeGreaterThan(0)
  expect(await text(f.a,'draft.md')).toBe('Newest real Workspace save.\n');expect(result.pairs.some(p=>p.local==='draft.md')).toBe(true)
 }finally{await f.close()}
},120000)

testWithSafeSyncGitAndGitleaks('S1 a newer save after a pushed round and later foreign commit never pairs with our old text',async()=>{
 const f=await fixture();try{
  await f.put(f.a,'draft.md','A first pushed.\n')
  const first=await f.engineA({checkpoint:async phase=>{if(phase==='before-apply'){await f.put(f.a,'draft.md','A newest writing.\n');throw new Error('simulated failed local install')}}}).send(f.av)
  expect(first.reason).toBeDefined();await f.B.fetchAndIntegrate(f.bv)
  await f.put(f.b,'second.md','B later writing.\n');await f.B.send(f.bv)
  const next=await f.A.send(f.av)
  expect(next.reason).toBeUndefined();expect(next.pairs.some(p=>p.local==='draft.md')).toBe(false)
  expect(await text(f.a,'draft.md')).toBe('A newest writing.\n');expect(await text(f.a,'second.md')).toBe('B later writing.\n')
 }finally{await f.close()}
},120000)

// The 'Sync now' race: a receive that brings nothing new (a follow-up or periodic check) must not hide an arrival the
// writer has not seen. The next send clears the list, as it always has.
testWithSafeSyncGitAndGitleaks('arrivals stay listed through an empty receive until the next send', async () => {
  const f = await fixture()
  try {
    await f.put(f.b, 'draft.md', 'Writing from B.\n'); await f.B.send(f.bv)
    expect((await f.A.fetchAndIntegrate(f.av)).incoming).toEqual([{ path: 'draft.md', kind: 'changed' }])
    const again = await f.A.fetchAndIntegrate(f.av)
    expect(again.state).toBe('incoming'); expect(again.incoming).toEqual([{ path: 'draft.md', kind: 'changed' }])
    expect((await f.A.status(f.av)).state).toBe('incoming')
    await f.put(f.a, 'second.md', 'Writing from A.\n')
    const sent = await f.A.send(f.av)
    expect(sent.incoming).toEqual([]); expect(sent.state).toBe('up-to-date')
  } finally { await f.close() }
}, timeout)
