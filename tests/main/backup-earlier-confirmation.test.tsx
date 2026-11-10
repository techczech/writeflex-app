import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { EarlierLocationsConfirmation } from '../../src/renderer/src/components/settings/BackupSettingsPanel'
import { createEarlierLocations } from '../../src/main/backup-helper/earlier-locations'
import { registerBackupEnrolmentIpc } from '../../src/main/backup-helper/ipc'
import { BACKUP_ENROLMENT_CHANNELS, checkEarlierInput } from '../../src/shared/backup-enrolment'
import { HISTORY_APPROVAL_BASENAME } from '../../src/backup-helper/history-approvals'
import { WRITEFLEX_SCOPE } from '../../src/main/backup-helper/enrolment'
import { historySeams, readHistoryProjection } from '../../src/backup-helper/history-projection'
import { fixture } from './backup-activation-fixture'
import { earlierFixture } from './backup-earlier-fixture'
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { delete historySeams.afterFirstRead; while(cleanups.length) await cleanups.pop()!() })
const unavailable = { name:'writeflex-named-versions',state:'unavailable',reason:'earlier locations need confirmation' }
async function mainFixture() {
  const f = await fixture(cleanups), h = earlierFixture()
  mkdirSync(join(h.root,'.git'));writeFileSync(join(h.root,'.git/HEAD'),'ref: refs/heads/main\n')
  f.setWindow(h.root); f.hooks.history=unavailable
  return { ...f, h, file:join(f.dir,HISTORY_APPROVAL_BASENAME) }
}
test('real enrolment preview and confirmation record only; fresh preview and Turn on remain separate', async () => {
  const f=await mainFixture(),p=await f.e.preview(1)
  expect(p.state).toBe('ready')
  if(p.state!=='ready') throw new Error('not ready')
  expect(p.earlierLocations?.map(r=>r.namedVersions).sort((a,b)=>a-b)).toEqual([3,10])
  expect((await f.e.confirmEarlier(1,{previewId:p.previewId,confirmEarlier:true})).ok).toBe(true)
  expect(existsSync(f.file)).toBe(true)
  expect(await f.registered()).toBeNull()
  expect(f.log.some(x=>x.startsWith('enable:')||x.startsWith('spawn:'))).toBe(false)
  expect((await f.e.enable(1,{previewId:p.previewId,confirmPublic:false})).ok).toBe(false)
  expect(await readHistoryProjection(f.h.root,p=>p.endsWith('.md'),undefined,undefined,f.file)).toMatchObject({state:'complete',summary:{namedVersions:213}})
  f.hooks.history={name:'writeflex-named-versions',state:'complete',files:3,bytes:1,summary:{namedVersions:213}}
  const fresh=await f.e.preview(1)
  expect(fresh.state==='ready' && fresh.history.included).toBe(true)
  expect(fresh.state==='ready' && fresh.earlierLocations).toBeUndefined()
  expect(await f.registered()).toBeNull()
})
for(const mode of ['false','missing','wrong-window','wrong-token','retired','root','history','replay','approval-state','object'] as const) test(`main refuses confirmation without writing: ${mode}`,async()=>{
  const f=await mainFixture(),p=await f.e.preview(1)
  if(p.state!=='ready')throw new Error('not ready')
  let sender=1, token=p.previewId
  if(mode==='wrong-window')sender=2
  if(mode==='wrong-token')token='a'.repeat(32)
  if(mode==='retired')f.e.retireSender(1)
  if(mode==='root')f.setWindow(f.b)
  if(mode==='history')appendFileSync(join(f.h.root,'.writeflex/versions.jsonl'),'\n')
  if(mode==='object') { const row=JSON.parse(readFileSync(join(f.h.root,'.bridle/journal.jsonl'),'utf8').split('\n')[1]!);writeFileSync(join(f.h.root,'.bridle/objects',row.hash),'changed') }
  if(mode==='approval-state')writeFileSync(f.file,'{}\n',{mode:0o600})
  if(mode==='replay')expect((await f.e.confirmEarlier(1,{previewId:token,confirmEarlier:true})).ok).toBe(true)
  const before=existsSync(f.file)?readFileSync(f.file):null
  const input=mode==='missing'?{previewId:token}:{previewId:token,confirmEarlier:mode!=='false'}
  const result=await f.e.confirmEarlier(sender,input as never)
  expect(result.ok).toBe(false)
  expect(existsSync(f.file)?readFileSync(f.file):null).toEqual(before)
  expect(await f.registered()).toBeNull()
})
test('expiry, replacement root and binding invalidation refuse at main-owned service',async()=>{
  const f=earlierFixture(),file=join(f.base,'private',HISTORY_APPROVAL_BASENAME)
  let now=100,root=f.root
  const service=createEarlierLocations({file,root:()=>root,now:()=>now,ttl:10})
  const c=await service.inspect(root,WRITEFLEX_SCOPE)
  if(!c)throw new Error('missing candidates')
  service.bind(1,'b'.repeat(32),root,root,WRITEFLEX_SCOPE,c);now=111
  expect(await service.confirm(1,{previewId:'b'.repeat(32),confirmEarlier:true})).toBe(false)
  now=100;service.bind(1,'b'.repeat(32),root,root,WRITEFLEX_SCOPE,c)
  renameSync(root,root+'-previous');mkdirSync(root)
  expect(await service.confirm(1,{previewId:'b'.repeat(32),confirmEarlier:true})).toBe(false)
  expect(existsSync(file)).toBe(false)
})
test('IPC accepts only exact token/boolean and own top frame, never roots or record identities',async()=>{
  const f=await mainFixture(),calls=new Map<string,Function>()
  registerBackupEnrolmentIpc({handle:(channel,fn)=>{calls.set(channel,fn)}},f.e)
  const frame={},good={sender:{id:1,mainFrame:frame},senderFrame:frame},bad={...good,senderFrame:{}}
  const p=await f.e.preview(1);if(p.state!=='ready')throw new Error('not ready')
  const call=calls.get(BACKUP_ENROLMENT_CHANNELS.confirmEarlier)!
  expect(checkEarlierInput([{previewId:p.previewId,confirmEarlier:true,roots:['/arbitrary']}])).toBeNull()
  expect((await call(bad,{previewId:p.previewId,confirmEarlier:true})).ok).toBe(false)
  expect((await call(good,{previewId:p.previewId,confirmEarlier:true,roots:['/arbitrary']})).ok).toBe(false)
  expect(existsSync(f.file)).toBe(false)
  expect((await call(good,{previewId:p.previewId,confirmEarlier:true})).ok).toBe(true)
})
test('renderer shows exact roots/counts, an unchecked acknowledgement and an explicit gated button',()=>{
  const roots=[{root:'/synthetic/earlier one',namedVersions:10},{root:'/synthetic/earlier two',namedVersions:3}]
  const render=(checked:boolean,busy=false)=>renderToStaticMarkup(<EarlierLocationsConfirmation roots={roots} checked={checked} busy={busy} onChecked={()=>{}} onConfirm={()=>{}} />)
  const unchecked=render(false)
  expect(unchecked).toContain('/synthetic/earlier one');expect(unchecked).toContain('10 named versions');expect(unchecked).toContain('3 named versions')
  expect(unchecked).toContain('These were earlier locations of this vault.')
  expect(unchecked).not.toContain('checked=""')
  expect(unchecked).toContain('disabled=""')
  expect(render(true)).not.toContain('disabled=""')
  expect(render(true,true)).toContain('disabled=""')
  expect(unchecked).toContain('Confirm earlier locations and check again')
})

test('history or window binding changed during confirmation is refused before append',async()=>{
  for(const mode of ['binding','history'] as const) {
    const f=await mainFixture(),p=await f.e.preview(1)
    if(p.state!=='ready')throw new Error('not ready')
    historySeams.afterFirstRead=()=>{if(mode==='binding')f.e.retireSender(1);else appendFileSync(join(f.h.root,'.bridle/journal.jsonl'),'\n')}
    expect((await f.e.confirmEarlier(1,{previewId:p.previewId,confirmEarlier:true})).ok).toBe(false)
    delete historySeams.afterFirstRead
    expect(existsSync(f.file)).toBe(false)
  }
})
test('cross-window operations are serial: a second token cannot append over changed approval state',async()=>{
  const f=await mainFixture(),a=await f.e.preview(1),b=await f.e.preview(2)
  if(a.state!=='ready'||b.state!=='ready')throw new Error('not ready')
  const result=await Promise.all([f.e.confirmEarlier(1,{previewId:a.previewId,confirmEarlier:true}),f.e.confirmEarlier(2,{previewId:b.previewId,confirmEarlier:true})])
  expect(result.map(r=>r.ok)).toEqual([true,false])
  expect(readFileSync(f.file,'utf8').trim().split('\n')).toHaveLength(1)
})

test('a token expiring while the fresh history check waits cannot append',async()=>{
  const f=earlierFixture(),file=join(f.base,'private',HISTORY_APPROVAL_BASENAME)
  let now=100
  const service=createEarlierLocations({file,root:()=>f.root,now:()=>now,ttl:10})
  const c=await service.inspect(f.root,WRITEFLEX_SCOPE)
  if(!c)throw new Error('missing candidates')
  service.bind(1,'b'.repeat(32),f.root,f.root,WRITEFLEX_SCOPE,c)
  historySeams.afterFirstRead=()=>{now=111}
  expect(await service.confirm(1,{previewId:'b'.repeat(32),confirmEarlier:true})).toBe(false)
  expect(existsSync(file)).toBe(false)
})
