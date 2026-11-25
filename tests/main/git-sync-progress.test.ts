import {test,expect} from 'bun:test'
import {join} from 'node:path'
import {rename} from 'node:fs/promises'
import {SnapshotStore} from '@bridle/core'
import {fixture} from './git-vault-sync-fixture'
import { testWithSafeSyncGitAndGitleaks } from './git-sync-prerequisites'
import {SendProgress,pendingFingerprint} from '../../src/main/git-sync-progress'
testWithSafeSyncGitAndGitleaks('G1 failed offline sends keep retrying and manual sends always bypass a genuine stall',async()=>{
 const f=await fixture();try{
  await f.put(f.a,'draft.md','Written offline.\n');const sa=await SnapshotStore.open({dir:join(f.a,'.bridle'),root:f.a});await sa.snapshotFile(join(f.a,'draft.md'),{sessionId:'s'})
  const status=await f.A.status(f.av),paths=[...status.internalPending,...status.pending.map(d=>d.path)],before=await pendingFingerprint(f.a,paths,f.gitEnv),head=f.git(f.a,'rev-parse','HEAD'),guard=new SendProgress()
  await rename(f.remote,f.remote+'.away');const r=await f.A.send(f.av)
  expect(r.reason?.code).toBe('network-unavailable')
  expect(guard.completed(before,await pendingFingerprint(f.a,paths,f.gitEnv),true,!r.reason,head!==f.git(f.a,'rev-parse','HEAD'))).toBe(false)
  expect(guard.shouldSend(before)).toBe(true);await rename(f.remote+'.away',f.remote)
  expect((await f.A.send(f.av)).reason).toBeUndefined();expect(f.git(f.remote,'show','main:draft.md')).toBe('Written offline.')
  expect(guard.completed(before,before,true,true,false)).toBe(true)
  expect(guard.shouldSend(before)).toBe(false);expect(guard.shouldSend(before,true)).toBe(true)
  guard.changed();expect(guard.completed(before,before,true,true,true)).toBe(false)
 }finally{await f.close()}
},120000)
