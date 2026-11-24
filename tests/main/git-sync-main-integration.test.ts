import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fixture, text } from './git-vault-sync-fixture'
import { testWithSafeSyncGitAndGitleaks } from './git-sync-prerequisites'
import { createGitVaultSync } from '../../src/main/git-vault-sync'
import { OwnWriteTracker } from '../../src/main/workspace-watcher'
import { migratedSyncPreferences, syncVaultPreferences } from '../../src/shared/git-sync-settings'

test('legacy switch and wait migrate together without importing runtime receipts', () => {
  const id = 'a'.repeat(64)
  const entries = syncVaultPreferences(migratedSyncPreferences({['git-vault-sync.enabled.'+id]:true,['git-sync.wait.'+id]:10,['git-vault-sync.record.'+id]:'private receipt'}))
  expect(entries).toEqual({[id]:{enabled:true,wait:10}})
})

testWithSafeSyncGitAndGitleaks('sync apply registers identity for outside-review dedupe; later foreign write is still delivered', async () => {
 const f = await fixture()
 try {
  const tracker = new OwnWriteTracker(p => join(f.b,p))
  const B = f.engineB({ownWrite:(p,identity)=>tracker.record(p.slice(f.b.length+1),identity)})
  await f.put(f.a,'draft.md','Incoming writing\n'); await f.A.send(f.av)
  await B.fetchAndIntegrate(f.bv)
  expect(tracker.isRecent('draft.md')).toBe(true)
  await f.put(f.b,'draft.md','Later outside writing\n')
  expect(tracker.isRecent('draft.md')).toBe(false)
 } finally {await f.close()}
},60000)

testWithSafeSyncGitAndGitleaks('own rename, move and bin send as delete/add without a clash', async () => {
 const f=await fixture()
 try {
  f.git(f.a,'mv','draft.md','Named piece.md')
  expect((await f.A.send(f.av)).pairs).toHaveLength(0)
  await f.B.fetchAndIntegrate(f.bv)
  expect(await text(f.b,'Named piece.md')).toBe(await text(f.a,'Named piece.md'))
  f.git(f.a,'rm','Named piece.md'); await f.A.send(f.av); await f.B.fetchAndIntegrate(f.bv)
  expect(f.git(f.b,'ls-tree','--name-only','HEAD')).not.toContain('Named piece.md')
 }finally{await f.close()}
},60000)

test('shared Settings and Sync Change use one persisted preference, legacy data untouched', async () => {
 const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
 const { tmpdir } = await import('node:os')
 const { SettingsStore } = await import('../../src/main/settings')
 const { openPreferences } = await import('../../src/main/shared-preferences')
 const dir = await mkdtemp(join(tmpdir(),'wf-sync-settings-'))
 const id=createHash('sha256').update('/temporary/vault').digest('hex')
 const file=join(dir,'settings.json'), original=JSON.stringify({values:{['git-vault-sync.enabled.'+id]:true,['git-sync.wait.'+id]:10}})
 await writeFile(file,original)
 let shared: Awaited<ReturnType<typeof openPreferences>> | undefined
 try {
  const legacy=new SettingsStore(file)
  shared=await openPreferences(legacy,dir,'0.29.0',()=>{})
  expect(legacy.get('git-vault-sync.enabled.'+id)).toBe(true)
  expect(legacy.get('git-sync.wait.'+id)).toBe(10)
  await legacy.set('git-sync.wait.'+id,1,'Sync wait')
  expect(syncVaultPreferences(legacy.get('sync.vaults'))[id]?.wait).toBe(1)
  await legacy.set('sync.vaults',JSON.stringify({[id]:{enabled:false,wait:3}}),'Settings page')
  expect(legacy.get('git-vault-sync.enabled.'+id)).toBe(false)
  expect(legacy.get('git-sync.wait.'+id)).toBe(3)
  expect(await readFile(file,'utf8')).toBe(original)
 }finally {await shared?.close();await rm(dir,{recursive:true,force:true})}
},60000)
